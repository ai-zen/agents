/**
 * 消息服务：按对话读消息，以及把库里的一行还原成 core 的消息对象。
 *
 * 对应能力编号：A12 / L5（按消息 id 续拉：命中则从它开始且含它自身的最新内容，不命中返回全部）、
 * F-C6（`around` 定位取窗，供客户端把搜索命中的那条摆到眼前）、F-I7（`toolCallId` 取子 Agent
 * 自己的消息；`subAgents` 把历次委派从库里拼回子 Agent 快照）、
 * F-D9（会话创建时那条 `hidden` 的 cwd 消息默认不出网）、
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
import { HostError } from "../wire/errors.js";
import type {
  MessageListParams,
  MessageListResult,
  SubAgentSnapshot,
  SubAgentStatus,
} from "../wire/index.js";

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

/**
 * 子 Agent 的名字认不出来时的通用名。
 *
 * 与运行器那一侧同一个兜底（`ChatRunner` 的 `subAgentName`）：库里只留下委派工具的名字，
 * 子 Agent 自己的显示名从来没落过库，认不出就报通用名，不编一个像真的。
 */
const FALLBACK_SUB_AGENT_NAME = "sub-agent";

/**
 * 主线上与一次委派有关的三样事实（按工具调用 id 索引）。
 *
 * 三样都只在主线消息里：工具调用的 `function.name` 是这次委派的工具名，工具结果那条消息的
 * 状态是这次委派最硬的终态证据，它上面的 `subAgentUsage` 是 core 在收尾时钉上去的这次委派
 * （含其孙级）用量。
 */
interface DelegationCall {
  /** 委派工具的名字；认不出来时为 `null` */
  name: string | null;
  /** 这次委派的工具结果消息；还没落库（那一轮没写完就没了）时为 `null` */
  result: AgentNS.Message | null;
  /** 发起这次委派的那条助手消息是否被中止过 */
  aborted: boolean;
}

/**
 * 从主线那一页里捞出与委派有关的三样事实（按工具调用 id 索引）。
 *
 * 只扫调用方已经读到的那一页：工具调用在助手消息的 `tool_calls` 上，工具结果是一条
 * `role === tool` 的消息，两者用 `tool_call_id` 对上同一个 id。
 */
function delegationCallsOf(
  messages: readonly AgentNS.Message[],
): Map<string, DelegationCall> {
  const calls = new Map<string, DelegationCall>();
  const entry = (id: string): DelegationCall => {
    const existing = calls.get(id);
    if (existing !== undefined) return existing;
    const created: DelegationCall = { name: null, result: null, aborted: false };
    calls.set(id, created);
    return created;
  };

  for (const message of messages) {
    for (const toolCall of message.tool_calls ?? []) {
      const id = toolCall.id;
      if (id === undefined || id.length === 0) continue;
      const call = entry(id);
      const name = toolCall.function?.name;
      if (name !== undefined) call.name = name;
      // 发起委派的那条助手消息被中止过：这次委派是被叫停的，不是自己跑完的
      if (message.status === AgentNS.MessageStatus.Aborted) call.aborted = true;
    }
    if (message.role === AgentNS.Role.Tool && message.tool_call_id !== undefined) {
      const call = entry(message.tool_call_id);
      call.result = message;
      // 工具结果那条消息上也带工具名：早期数据里工具调用本身没落下来时用它兜底
      if (call.name === null && message.name !== undefined) call.name = message.name;
    }
  }
  return calls;
}

/**
 * 一次委派空闲时的状态：只从库里的事实推，推不出来就按最弱的那一档给。
 *
 * 顺序是**从硬到软**：
 *   1. 子 Agent 自己吐过一条 `error` 消息 → `error`（与运行器 `ChatRunner.onSubAgentEnd`
 *      同一口径：子 Agent 内部出过错，父工具结果说什么都盖不过它）；
 *   2. 父工具结果那条消息的状态 → 完成 / 出错 / 中止；
 *   3. 结果不在（那一轮没写完就没了）：发起它的助手消息被中止过就是 `aborted`，否则 `error`
 *      —— 契约里没有「悄悄消失」这一档（与 `ChatRunner.finalizedSubagents` 同口径）。
 *
 * 「听起来还行就当 done」那种推法在这里是禁止的：`done` 是一句结论，拿不到证据就说到不了。
 */
function subAgentStatusOf(
  group: readonly StoredMessage[],
  call: DelegationCall | undefined,
): SubAgentStatus {
  if (group.some((row) => row.status === AgentNS.MessageStatus.Error)) return "error";
  const result = call?.result;
  if (result?.status === AgentNS.MessageStatus.Error) return "error";
  if (result?.status === AgentNS.MessageStatus.Aborted) return "aborted";
  if (result?.status === AgentNS.MessageStatus.Completed) return "done";
  return call?.aborted === true ? "aborted" : "error";
}

/**
 * 「子 Agent 那一半的行」+「主线那一页」→ 子 Agent 快照（F-I7）。
 *
 * 分组的键就是 `parentToolCallId`：一次委派一组，组内那些行就是子 Agent 说过的话。
 * 只从行里拼得出条数与开始时刻，其余三样（名字 / 用量 / 终态）从主线那一页里按工具调用 id 取。
 * 推不出来的两格宁可空着也不编：`finishedAt`（库里没有「委派结束」的时刻）与
 * `problem`（原因要给成按连接语言渲染的句子，那是接线层的事，这里只给状态）。
 */
function subAgentSnapshotsOf(
  messages: readonly AgentNS.Message[],
  rows: readonly StoredMessage[],
): SubAgentSnapshot[] {
  const groups = new Map<string, StoredMessage[]>();
  for (const row of rows) {
    const toolCallId = row.parentToolCallId;
    if (toolCallId === null || toolCallId.length === 0) continue;
    const group = groups.get(toolCallId);
    if (group === undefined) groups.set(toolCallId, [row]);
    else group.push(row);
  }
  if (groups.size === 0) return [];

  const calls = delegationCallsOf(messages);
  const snapshots: SubAgentSnapshot[] = [];
  for (const [toolCallId, group] of groups) {
    const call = calls.get(toolCallId);
    snapshots.push({
      toolCallId,
      name: call?.name ?? FALLBACK_SUB_AGENT_NAME,
      status: subAgentStatusOf(group, call),
      // 子 Agent 的第一条消息就是这次委派的开始：它的创建时刻是库里最接近「开始」的事实
      startedAt: new Date(Math.min(...group.map((row) => row.createdAt))).toISOString(),
      // 库里没有「这次委派结束」的时刻：子 Agent 消息的 `updatedAt` 记的是它自己创建的时刻，
      // 唯一能当结束时刻用的父工具结果创建时刻又不在主线那一页里（`AgentNS.Message` 不带时间戳，R21）
      finishedAt: null,
      messageCount: group.length,
      usage: call?.result?.subAgentUsage ?? null,
      problem: null,
    });
  }
  return snapshots;
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
function windowAround(rows: StoredMessage[], around: string, size: number): StoredMessage[] | null {
  const index = rows.findIndex((row) => row.id === around);
  if (index < 0) return null;
  const before = Math.floor((size - 1) / 2);
  const start = Math.max(0, index - before);
  const end = Math.min(rows.length, index + (size - before));
  return rows.slice(start, end);
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
   * 读一段对话的消息（architecture A12 / PRD F-C6）。
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
   * `toolCallId` 取某个子 Agent 自己的消息（PRD F-I7）：它按消息落库时记下的
   * `parentToolCallId` 取（那次委派的工具调用 id），走的是另一条查询 —— 子 Agent 的消息不在
   * 主线历史里（`listByConversation` 只给主线），所以两个参数同时给时 `after` 只用来定 `anchor`，
   * 结果集仍是那个子 Agent 的全部消息。`around` 同此：`toolCallId` 决定读哪一段，`around`
   * 只在那一段里定位。
   *
   * `hidden` 的消息（会话创建时那条 cwd 消息、交接摘要）默认不回：core 的这个字段就是
   * 「这条不给人看」。要看到它们（排查、或客户端显式要）就传 `includeHidden`。
   */
  async list(params: MessageListParams): Promise<MessageListResult> {
    const conversation = await this.requireConversation(params.conversationId);
    const options = { includeHidden: params.includeHidden === true };
    const around = idParam(params.around);
    const after = idParam(params.after);

    // `around` 优先：它给了就完全不管 `after`（连 `anchor` 也不由 `after` 定）
    let anchor: string | null = null;
    if (around === undefined && after !== undefined) {
      const anchorRow = await this.messages.get(after);
      if (anchorRow && anchorRow.conversationId === conversation.id) {
        anchor = anchorRow.id;
      }
    }

    const toolCallId = idParam(params.toolCallId);
    if (toolCallId !== undefined) {
      const delegated = await this.messages.listByParentToolCallId(
        conversation.id,
        toolCallId,
        options,
      );
      return this.respond(conversation.id, delegated, anchor, around);
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
   * 这段对话历次委派过的子 Agent（F-I7：跑完再打开这段对话，「子代理」页签不该是空的）。
   *
   * 两处读数合成一份快照，理由各占一半：
   *   - **子 Agent 那一半**来自 `messages` 表里 `parentToolCallId` 非空的行（`listDelegated`）：
   *     它才是「这次委派真的派出去过」的确凿证据，也给出条数与开始时刻；
   *   - **主线那一页**由调用方传进来，不在这里再读一遍：调用方（`conversation.state` /
   *     `conversation.abort`）本来就为用量与上下文读过整段，同一段话读两次只会让两份快照
   *     之间多一道缝。工具名 / 这次委派的用量 / 终态证据都在那一页里。
   *
   * `messages` 要的是**整段主线**（`list` 不给 `after` / `around` 的那一份）：给一窗的话，
   * 落在窗外的委派就看不出名字与终态了，而“看漏”在这里比“多读”更难解释。
   */
  async subAgents(
    conversationId: string,
    messages: readonly AgentNS.Message[],
  ): Promise<SubAgentSnapshot[]> {
    const rows = await this.messages.listDelegated(conversationId);
    return subAgentSnapshotsOf(messages, rows);
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
