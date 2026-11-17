/**
 * 消息服务：按对话读消息，以及把库里的一行还原成 core 的消息对象。
 *
 * 对应能力编号：A12 / L5（按消息 id 续拉：命中则从它开始且含它自身的最新内容，不命中返回全部）、
 * F-C6（`around` 定位取窗，供客户端把搜索命中的那条摆到眼前）、
 * F-I7（`toolCallId` 取子 Agent 自己的消息 —— 子 Agent 说过的话就在消息里，按委派工具调用的
 * id 取，不另拼一份快照）、F-D9（会话创建时那条 `hidden` 的 cwd 消息默认不出网）、
 * R21 / R22（消息原样用 core 的 `AgentNS.Message`，不额外挂时间戳这类外壳字段）。
 *
 * ## 列表读取只有一个来源：活着读内存，死了读库（PLAN §7）
 *
 * 有驱动者就从它的 `messages` 现读（那才是真身，库里那份可能滞后几百毫秒、也可能压根没有 ——
 * 比如交接正在写的那几条），没有驱动者才读数据库（那时库就是它的全部）。**没有「正在交接
 * 所以改读库」这种例外**：交接期间的草稿照样看得见，那正是「在做什么要正常回显」。
 *
 * `after` / `around` / `includeHidden` 这三种取法因此要在**两个来源上算同一套语义**：
 * 主线的取法在 `StoredMessage[]` 与 `AgentNS.Message[]` 上各算一次（`windowAround` 与
 * {@link MemoryView}），子 Agent 那一栏同理 —— 但它的内存来源是「父的名册 → 那个子 agent」。
 *
 * **读路径上什么都不写**：不补、不删、不修 —— 修复只在装配那一刻（`ChatRunner.reconcile`）做。
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
import { HostError } from "../wire/errors.js";
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
  /**
   * 「这段对话此刻在内存里长什么样」的口（`ChatRunner.messagesOf`，结构上满足）。
   *
   * 不注入 = 一律读库（用例里的窄替身）。生产一定注入：一段对话活着的时候，库里的那份是
   * 滞后的一份，内存里那份才是真身。
   */
  live?: LiveMessageLookup;
}

/**
 * 读内存的那一个口（{@link MessageServiceDeps.live}）。
 *
 * 返回值是**数组本身**（`agent.messages`），不是拷贝；`null` 表示「我这边没有」——
 * 没有驱动者，或者名册上没有这个子 agent —— 调用方据此回落到库里。
 */
export interface LiveMessageLookup {
  messagesOf(
    conversationId: string,
    options?: { toolCallId?: string },
  ): AgentNS.Message[] | null;
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

/** 可选的消息 id 参数：没给 / 空串一律当「没给」 */
function idParam(value: unknown): string | undefined {
  const id = asString(value)?.trim() ?? "";
  return id.length > 0 ? id : undefined;
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
  const hidden = asBoolean(data.hidden);
  if (hidden !== undefined) message.hidden = hidden;

  return message;
}

/** 从消息的其余字段里读最近一次请求的用量；没有就是 `null`（硬线判定读的就是它） */
export function readUsage(data: Record<string, unknown> | null | undefined): AgentNS.Usage | null {
  return asUsage(data?.usage) ?? null;
}

/**
 * `around` 取的窗口条数（PRD F-C6 的定位）。
 *
 * `message.list` 没有 `limit`：它一直是「一段对话全给」，`around` 只是把这一段收成一窗，
 * 40 条足够看够上下文而不会把屏刷满。消费者是桌面端的搜索命中跳转（PLAN W4）。
 */
const AROUND_WINDOW = 40;

/**
 * 以某条消息为中心取一窗（PRD F-C6 的定位）。
 *
 * `rows` 是这段对话（或这个子 Agent）的全部消息、已按先后排序。命中那条一定在窗口里：
 * 前面先给一半（`floor((size-1)/2)` 条），剩下的额度全给后面；命中靠近两端时窗口自然短一些。
 * 命中不在 `rows` 里时回 `null` —— 调用方给空页（这条可能刚被撤回/换过库）。
 */
function windowAround<T extends { id: string }>(
  rows: T[],
  around: string,
  size: number,
): T[] | null {
  const index = rows.findIndex((row) => row.id === around);
  if (index < 0) return null;
  const before = Math.floor((size - 1) / 2);
  const start = Math.max(0, index - before);
  const end = Math.min(rows.length, index + (size - before));
  return rows.slice(start, end);
}

/** 内存那一份的取法（与库那一份的语义逐条相同，只是算在 `AgentNS.Message[]` 上） */
interface MemoryView {
  includeHidden: boolean;
  after: string | undefined;
  around: string | undefined;
  /**
   * 这一份是不是某个子 Agent 的全部消息。
   *
   * 是的话 `after` 只用来定 `anchor`：子 Agent 那一栏的取法一直是「那个子 agent 的全部消息」，
   * `after` 不切它。
   */
  column: boolean;
}

export class MessageService {
  private readonly conversations: ConversationRepository;
  private readonly messages: MessageRepository;
  private readonly drafts?: MessageDraftLookup;
  private readonly live?: LiveMessageLookup;

  constructor(deps: MessageServiceDeps) {
    this.conversations = deps.conversations;
    this.messages = deps.messages;
    this.drafts = deps.drafts;
    this.live = deps.live;
  }

  /**
   * 读一段对话的消息（PLAN A12 / PRD F-C6）。
   *
   * 取法只有一套，**两个来源各算一次**（活着读内存、死了读库），语义逐条相同：
   *
   * - 不给 `after`、也不给 `around`：整段历史；
   * - 给了 `after` 且该 id 就在这段对话里：**从这条开始**（含它，内容是最新的，可能是流式中那条的
   *   部分内容）+ 其后全部，并把 `anchor` 报成它；
   * - 给了 `after` 但这段对话里没有这个 id（已删、或换过库）：退回整段历史，`anchor` 为空 ——
   *   客户端据此知道这是一次全量；
   * - 给了 `around`：以这条为中心取 {@link AROUND_WINDOW} 条（命中那条一定在里面），
   *   `anchor` 报成它；命中不在可见集里时给空页 + 空 `anchor`，**不报错**（消息可能刚被撤回）。
   *   `around` 与 `after` 同时给时**只认 `around`**：两者是两种取法（一个「从这里往下」、一个
   *   「围绕这里」），混在一起没有唯一答案。
   *
   * `toolCallId` 取某个子 Agent 自己的消息（PRD F-I7）：子 Agent 的消息不在主线历史里，所以
   * 两个参数同时给时 `after` 只用来定 `anchor`，结果集仍是那个子 Agent 的全部消息。`around`
   * 同此：`toolCallId` 决定读哪一段，`around` 只在那一段里定位。
   *
   * `hidden` 的消息（会话创建时那条 cwd 消息、交接摘要）默认不回：core 的这个字段就是
   * 「这条不给人看」。要看到它们（排查、或客户端显式要）就传 `includeHidden`。
   */
  async list(params: MessageListParams): Promise<MessageListResult> {
    const conversation = await this.requireConversation(params.conversationId);
    const options = { includeHidden: params.includeHidden === true };
    const around = idParam(params.around);
    const after = idParam(params.after);
    const toolCallId = idParam(params.toolCallId);

    // 内存优先（PLAN §7）：活着读内存，死了读库。`null` = 我这边没有 —— 没有驱动者，
    // 或者名册上已经没有这个子 agent（那一批翻过去了 / 进程重启过）
    const live =
      this.live?.messagesOf(
        conversation.id,
        toolCallId === undefined ? undefined : { toolCallId },
      ) ?? null;
    if (live !== null) {
      return this.fromMemory(live, conversation.id, {
        includeHidden: options.includeHidden,
        after,
        around,
        column: toolCallId !== undefined,
      });
    }

    // `around` 优先：它给了就完全不管 `after`（连 `anchor` 也不由 `after` 定）
    let anchor: string | null = null;
    if (around === undefined && after !== undefined) {
      const anchorRow = await this.messages.get(after);
      if (anchorRow && anchorRow.conversationId === conversation.id) {
        anchor = anchorRow.id;
      }
    }

    if (toolCallId !== undefined) {
      // 子 Agent 的话**不入库**（`CORE.md` §17）：这一段没有驱动者（或者名册上已经没有那个子
      // agent）时，那一栏就是空的。库里没有第二份可读（`parentToolCallId` 随 v5 删了）。
      return this.respond(conversation.id, [], anchor, around);
    }

    // `around` 要的是「整段之后再取窗」，所以这一跳不带 `after`（带了就只剩后半段）
    const rows = await this.messages.listByConversation(
      conversation.id,
      around === undefined ? after : undefined,
      options,
    );
    return this.respond(conversation.id, rows, anchor, around);
  }

  /**
   * 内存那一份的取法：与库那一份逐条同义，只是算在 `agent.messages` 上。
   *
   * 顺序就是数组顺序（内存里没有第二份顺序，不排 `seq`）；`hidden` 默认滤掉；`after` 给
   * 「它 + 之后全部」，那条不在就给全量；`around` 给一窗，不在就给空页 + 空 `anchor`。
   */
  private fromMemory(
    messages: AgentNS.Message[],
    conversationId: string,
    view: MemoryView,
  ): MessageListResult {
    const visible = view.includeHidden
      ? messages
      : messages.filter((message) => message.hidden !== true);

    if (view.around !== undefined) {
      const window = windowAround(visible, view.around, AROUND_WINDOW);
      if (window === null) return { conversationId, anchor: null, messages: [] };
      return { conversationId, anchor: view.around, messages: [...window] };
    }

    if (view.after !== undefined) {
      const index = visible.findIndex((message) => message.id === view.after);
      if (index >= 0) {
        return {
          conversationId,
          anchor: view.after,
          messages: view.column ? [...visible] : visible.slice(index),
        };
      }
    }
    return { conversationId, anchor: null, messages: [...visible] };
  }

  /** 把一次读到的行拼成出参；`around` 给了就收成一窗（命中不在里面就是空页） */
  private respond(
    conversationId: string,
    rows: StoredMessage[],
    anchor: string | null,
    around: string | undefined,
  ): MessageListResult {
    if (around === undefined) {
      return { conversationId, anchor, messages: rows.map((row) => toAgentMessage(row)) };
    }
    const window = windowAround(rows, around, AROUND_WINDOW);
    if (window === null) {
      return { conversationId, anchor: null, messages: [] };
    }
    return { conversationId, anchor: around, messages: window.map((row) => toAgentMessage(row)) };
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
    throw new HostError("not_found", {
      params: { entity: "conversation" },
      detail: { conversationId },
    });
  }
}
