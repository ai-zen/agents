/**
 * 消息服务：按对话读消息，以及把库里的一行还原成 core 的消息对象。
 *
 * 对应能力编号：A12 / L5（按消息 id 续拉：命中则从它开始且含它自身的最新内容，不命中返回全部）、
 * F-I7（`toolCallId` 取子 Agent 自己的消息）、R21 / R22（消息原样用 core 的 `AgentNS.Message`，
 * 不额外挂时间戳这类外壳字段）。
 *
 * `toAgentMessage` 是这个仓库里「存储行 → core 消息」的唯一一份实现：对话服务算用量、判断
 * 历史里有没有图也要走它，免得同一行在两处被读出两个样子。
 */

import { AgentNS } from "@ai-zen/agents-core";

import type { ConversationRepository } from "../storage/ConversationRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { MessageContent, StoredMessage } from "../storage/types.js";
import { ServerError } from "../wire/errors.js";
import type { MessageListParams, MessageListResult } from "../wire/index.js";

/** 消息服务依赖 */
export interface MessageServiceDeps {
  conversations: ConversationRepository;
  messages: MessageRepository;
}

/** 角色取值表：库里的字符串认不出来时归 `Unknown`，不猜 */
const ROLES: readonly string[] = [
  AgentNS.Role.Unknown,
  AgentNS.Role.System,
  AgentNS.Role.User,
  AgentNS.Role.Assistant,
  AgentNS.Role.Function,
  AgentNS.Role.Tool,
];

/** 状态取值表（D15：`status` 落盘，读回来要还原成 core 的那一套） */
const STATUSES: readonly string[] = [
  AgentNS.MessageStatus.Unknown,
  AgentNS.MessageStatus.Pending,
  AgentNS.MessageStatus.Completed,
  AgentNS.MessageStatus.Error,
  AgentNS.MessageStatus.Aborted,
  AgentNS.MessageStatus.Writing,
];

/** 结束原因取值表 */
const FINISH_REASONS: readonly string[] = [
  AgentNS.FinishReason.Unknown,
  AgentNS.FinishReason.Stop,
  AgentNS.FinishReason.Length,
  AgentNS.FinishReason.ContentFilter,
  AgentNS.FinishReason.FunctionCall,
  AgentNS.FinishReason.ToolCalls,
];

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** 用量：三个字段都是数字才算数（core 的 `Usage` 只有这三个字段） */
function asUsage(value: unknown): AgentNS.Usage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const prompt = source.prompt_tokens;
  const completion = source.completion_tokens;
  const total = source.total_tokens;
  if (typeof prompt !== "number" || typeof completion !== "number" || typeof total !== "number") {
    return undefined;
  }
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function asFunctionCall(value: unknown): AgentNS.FunctionCall | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const call: AgentNS.FunctionCall = {};
  const name = asString(source.name);
  const args = asString(source.arguments);
  if (name !== undefined) call.name = name;
  if (args !== undefined) call.arguments = args;
  return call;
}

/** 工具调用数组：逐项按 core 的字段抄，认不出的字段直接丢（不往消息上塞未知键） */
function asToolCalls(value: unknown): AgentNS.ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: AgentNS.ToolCall[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const source = item as Record<string, unknown>;
    const call: AgentNS.ToolCall = {};
    if (typeof source.index === "number") call.index = source.index;
    const id = asString(source.id);
    const type = asString(source.type);
    const fn = asFunctionCall(source.function);
    if (id !== undefined) call.id = id;
    if (type !== undefined) call.type = type;
    if (fn !== undefined) call.function = fn;
    calls.push(call);
  }
  return calls;
}

/** 库里的角色字符串 → core 的角色；搜索命中项也要用它，故对外导出 */
export function toCoreRole(value: string): AgentNS.Role {
  return ROLES.includes(value) ? (value as AgentNS.Role) : AgentNS.Role.Unknown;
}

function toStatus(value: string): AgentNS.MessageStatus {
  return STATUSES.includes(value)
    ? (value as AgentNS.MessageStatus)
    : AgentNS.MessageStatus.Unknown;
}

function toFinishReason(value: string): AgentNS.FinishReason {
  return FINISH_REASONS.includes(value)
    ? (value as AgentNS.FinishReason)
    : AgentNS.FinishReason.Unknown;
}

/**
 * 库里的一段内容 → core 的内容段。
 *
 * 三种段按 core 的字段逐个抄（`text` / `image_url` / `file`）；认不出的段类型原样透传 ——
 * 写进去的东西读回来时丢掉，比多留一个字段更糟。非对象（坏数据）才被滤掉。
 */
function toSection(value: unknown): AgentNS.MessageContentSection | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const index = typeof source.index === "number" ? source.index : undefined;

  if (source.type === "text") {
    const text = asString(source.text);
    if (text === undefined) return null;
    return index === undefined ? { type: "text", text } : { type: "text", text, index };
  }
  if (source.type === "image_url") {
    const imageUrl = source.image_url;
    if (typeof imageUrl !== "object" || imageUrl === null) return null;
    const url = asString((imageUrl as Record<string, unknown>).url);
    if (url === undefined) return null;
    const detail = asString((imageUrl as Record<string, unknown>).detail);
    const section: AgentNS.ImageUrlContentSection = {
      type: "image_url",
      image_url:
        detail === undefined
          ? { url }
          : { url, detail: detail as "low" | "high" | "original" | "auto" },
    };
    if (index !== undefined) section.index = index;
    return section;
  }
  if (source.type === "file") {
    const section: AgentNS.FileContentSection = { type: "file" };
    const fileId = asString(source.file_id);
    const fileData = asString(source.file_data);
    const filename = asString(source.filename);
    if (fileId !== undefined) section.file_id = fileId;
    if (fileData !== undefined) section.file_data = fileData;
    if (filename !== undefined) section.filename = filename;
    if (index !== undefined) section.index = index;
    return section;
  }
  return source as unknown as AgentNS.MessageContentSection;
}

/** 库里 `content` 列 → core 的内容类型；空值按「没有内容」处理 */
function toContent(value: MessageContent): AgentNS.MessageContent | undefined {
  if (value === null) return undefined;
  if (typeof value === "string") return value;
  const sections: AgentNS.MessageContentSection[] = [];
  for (const section of value) {
    const converted = toSection(section);
    if (converted !== null) sections.push(converted);
  }
  return sections;
}

/**
 * 库里一行 → core 的消息对象。
 *
 * `content` / `tool_calls` / `reasoning_content` / `usage` / `subAgentUsage` / `hidden` /
 * `omit` 这些字段名与取值全部照 core（R21）；认不出的字段不往消息上搬。
 */
export function toAgentMessage(row: StoredMessage): AgentNS.Message {
  const data = row.data ?? {};
  const message: AgentNS.Message = {
    id: row.id,
    role: toCoreRole(row.role),
    status: toStatus(row.status),
    omit: row.omit,
  };

  const content = toContent(row.content);
  if (content !== undefined) message.content = content;

  const name = asString(data.name);
  if (name !== undefined) message.name = name;
  const toolCallId = asString(data.tool_call_id);
  if (toolCallId !== undefined) message.tool_call_id = toolCallId;
  const reasoning = asString(data.reasoning_content);
  if (reasoning !== undefined) message.reasoning_content = reasoning;
  const toolCalls = asToolCalls(data.tool_calls);
  if (toolCalls !== undefined) message.tool_calls = toolCalls;
  const functionCall = asFunctionCall(data.function_call);
  if (functionCall !== undefined) message.function_call = functionCall;
  const finishReason = asString(data.finish_reason);
  if (finishReason !== undefined) message.finish_reason = toFinishReason(finishReason);
  const usage = asUsage(data.usage);
  if (usage !== undefined) message.usage = usage;
  const subAgentUsage = asUsage(data.subAgentUsage);
  if (subAgentUsage !== undefined) message.subAgentUsage = subAgentUsage;
  const hidden = asBoolean(data.hidden);
  if (hidden !== undefined) message.hidden = hidden;

  return message;
}

/** 从消息的其余字段里读最近一次请求的用量；没有就是 `null`（对话服务算上下文占用用） */
export function readUsage(data: Record<string, unknown> | null | undefined): AgentNS.Usage | null {
  return asUsage(data?.usage) ?? null;
}

export class MessageService {
  private readonly conversations: ConversationRepository;
  private readonly messages: MessageRepository;

  constructor(deps: MessageServiceDeps) {
    this.conversations = deps.conversations;
    this.messages = deps.messages;
  }

  /**
   * 读一段对话的消息（architecture A12）。
   *
   * - 不给 `after`：整段历史；
   * - 给了且该 id 就在这段对话里：**从这条开始**（含它，内容是最新的，可能是流式中那条的
   *   部分内容）+ 其后全部，并把 `anchor` 报成它；
   * - 给了但这段对话里没有这个 id（已删、或换过库）：退回整段历史，`anchor` 为空 ——
   *   客户端据此知道这是一次全量。
   *
   * `toolCallId` 取某个子 Agent 自己的消息（PRD F-I7）：它按消息上的 `tool_call_id` 过滤，
   * 两个参数同时给时先按 A12 切出续传段，再在结果里按 `toolCallId` 过滤。
   */
  async list(params: MessageListParams): Promise<MessageListResult> {
    const conversation = await this.requireConversation(params.conversationId);

    let anchor: string | null = null;
    if (params.after !== undefined && params.after.length > 0) {
      const anchorRow = await this.messages.get(params.after);
      if (anchorRow && anchorRow.conversationId === conversation.id) {
        anchor = anchorRow.id;
      }
    }

    const rows = await this.messages.listByConversation(conversation.id, params.after);
    let messages = rows.map((row) => toAgentMessage(row));
    if (params.toolCallId !== undefined && params.toolCallId.length > 0) {
      const toolCallId = params.toolCallId;
      messages = messages.filter((message) => message.tool_call_id === toolCallId);
    }
    return { conversationId: conversation.id, anchor, messages };
  }

  private async requireConversation(conversationId: string) {
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    const row = id.length === 0 ? undefined : await this.conversations.get(id);
    if (!row) {
      throw new ServerError("not_found", {
        params: { entity: "conversation" },
        detail: { conversationId },
      });
    }
    return row;
  }
}
