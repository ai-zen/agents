/**
 * 消息服务：按对话读消息，以及把库里的一行还原成 core 的消息对象。
 *
 * 对应能力编号：A12 / L5（按消息 id 续拉：命中则从它开始且含它自身的最新内容，不命中返回全部）、
 * F-I7（`toolCallId` 取子 Agent 自己的消息）、F-D9（会话创建时那条 `hidden` 的 cwd 消息默认不出网）、
 * R21 / R22（消息原样用 core 的 `AgentNS.Message`，不额外挂时间戳这类外壳字段）。
 *
 * `toAgentMessage` 是这个仓库里「存储行 → core 消息」的唯一一份实现：对话服务算用量、判断
 * 历史里有没有图也要走它，免得同一行在两处被读出两个样子。
 *
 * 正文不做转换（R30）：仓储反序列化出来的就是 core 的 `AgentNS.MessageContent`，这里原样
 * 搬上消息。剩下要做的是把「列里的字符串」收敛成 core 的取值（角色 / 状态 / 结束原因）
 * 与把 `data` 列的 JSON 逐字段收窄到 core 的类型。
 */

import { AgentNS } from "@ai-zen/agents-core";

import type { ConversationRepository } from "../storage/ConversationRepository.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { Conversation, StoredMessage } from "../storage/types.js";
import { ServerError } from "../wire/errors.js";
import type { MessageListParams, MessageListResult } from "../wire/index.js";

/**
 * 草稿（R56）：刚建出来、还没发过消息的对话在库里没有行。
 *
 * 只暴露「按 id 取」，取到的就是存储层的行形状 —— 它没有消息可读，但存在本身足以让
 * 读取路径不把一段刚建好的对话当成「不存在」。
 */
export interface MessageDraftLookup {
  get(conversationId: string): Conversation | undefined;
}

/** 消息服务依赖 */
export interface MessageServiceDeps {
  conversations: ConversationRepository;
  messages: MessageRepository;
  /** 草稿注册表（R56）；不注入时只认库里已有的行 */
  drafts?: MessageDraftLookup;
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
 * 库里一行 → core 的消息对象。
 *
 * 正文原样透传（R30）：仓储反序列化出来的就是 core 的 `MessageContent`，逐段重建会把 core
 * 新增的段类型 / 字段丢掉，也会让同一条消息在不同读取路径上读出两个样子。
 *
 * 其余字段名与取值也全部照 core（R21）：`role` / `status` / `finish_reason` 从列里的字符串
 * 收敛成 core 的取值，`data` 列的 JSON 逐字段收窄，认不出的不往消息上搬。
 */
export function toAgentMessage(row: StoredMessage): AgentNS.Message {
  const data = row.data ?? {};
  const message: AgentNS.Message = {
    id: row.id,
    role: toCoreRole(row.role),
    status: toStatus(row.status),
    omit: row.omit,
  };

  // `null` 在库里表示「这条消息没有正文」，core 的 `content` 是可选的，所以不搬空值
  if (row.content !== null) message.content = row.content;

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
  private readonly drafts?: MessageDraftLookup;

  constructor(deps: MessageServiceDeps) {
    this.conversations = deps.conversations;
    this.messages = deps.messages;
    this.drafts = deps.drafts;
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
   * `toolCallId` 取某个子 Agent 自己的消息（PRD F-I7）：它按消息落库时记下的
   * `parentToolCallId` 取（那次委派的工具调用 id），走的是另一条查询 —— 子 Agent 的消息不在
   * 主线历史里（`listByConversation` 只给主线），所以两个参数同时给时 `after` 只用来定 `anchor`，
   * 结果集仍是那个子 Agent 的全部消息。
   *
   * `hidden` 的消息（会话创建时那条 cwd 消息、交接摘要）默认不回：core 的这个字段就是
   * 「这条不给人看」。要看到它们（排查、或客户端显式要）就传 `includeHidden`。
   */
  async list(params: MessageListParams): Promise<MessageListResult> {
    const conversation = await this.requireConversation(params.conversationId);
    const options = { includeHidden: params.includeHidden === true };

    let anchor: string | null = null;
    if (params.after !== undefined && params.after.length > 0) {
      const anchorRow = await this.messages.get(params.after);
      if (anchorRow && anchorRow.conversationId === conversation.id) {
        anchor = anchorRow.id;
      }
    }

    const toolCallId = params.toolCallId;
    if (toolCallId !== undefined && toolCallId.length > 0) {
      const delegated = await this.messages.listByParentToolCallId(
        conversation.id,
        toolCallId,
        options,
      );
      return {
        conversationId: conversation.id,
        anchor,
        messages: delegated.map((row) => toAgentMessage(row)),
      };
    }

    const rows = await this.messages.listByConversation(conversation.id, params.after, options);
    return {
      conversationId: conversation.id,
      anchor,
      messages: rows.map((row) => toAgentMessage(row)),
    };
  }

  /**
   * 这段对话存不存在：库里那一行，或者一份还没落库的草稿（R56）。
   *
   * 草稿还没有任何消息，所以读它总是得到空集 —— 但它不该被读成「找不到这段对话」：
   * 客户端刚 `create` 完就会拉一次消息与现场。
   */
  private async requireConversation(conversationId: string) {
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    const row = id.length === 0 ? undefined : await this.conversations.get(id);
    if (row) return row;
    const draft = id.length === 0 ? undefined : this.drafts?.get(id);
    if (draft) return draft;
    throw new ServerError("not_found", {
      params: { entity: "conversation" },
      detail: { conversationId },
    });
  }
}
