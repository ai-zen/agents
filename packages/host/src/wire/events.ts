import type { AgentNS } from "@ai-zen/agents-core";

import type { NoticeView, QuestionView, RunState, UsageSnapshot } from "./states.js";

/**
 * 事件（宿主 → 客户端的推送，见 architecture §7）。
 *
 * 推送是 JSON-RPC 通知（无 id），`params` 里带事件名与数据；不重放、不需要 ack —— 断线即作废，
 * 重连由客户端按 D5 自己拉状态与消息。所以这里的每个事件都只是「在线时的一脚提醒」：
 * 真正的事实要能从 `conversation.state` / `message.list` 再拉出来（PRD L5）。
 *
 * 一条约定：事件只描述「发生了什么变化」，客户端需要完整对象时回宿主拉 ——
 * 这样多端同时在线时不会出现「一份数据在推送里长成另一种形状」。
 *
 * 流式增量的载荷是 core 的 `AgentNS.Delta` 原样：它描述的正是一片 chunk 带来了什么
 * （`content` / `reasoning_content` / `tool_calls` / …），`applyChunk` 吃的是同一份，
 * 所以客户端攒出来的消息与宿主存下来的那条逐字一致。
 */

// ---------------------------------------------------------------------------
// 载荷
// ---------------------------------------------------------------------------

/**
 * `run.state`：一段对话的运行状态变化（六态见 `states.ts` 的 `GenerationState`）。
 *
 * 发全量快照而不是「变成第几态」的差量：客户端任何时刻拿到一条就能直接替换本地状态，
 * 不必先对齐历史（重连时尤其要紧，PRD L5）。
 */
export interface RunStatePayload {
  conversationId: string;
  run: RunState;
  /** 生成这份快照的时刻 */
  at: string;
}

/**
 * `message.delta`：一条消息的流式增量（PRD L5：在线时推送；断线后靠 `message.list` 补拉）。
 *
 * 增量本体是 core 的 `AgentNS.Delta`，这一片属于哪一段由它自己带的字段说明：`content` 是
 * 正文、`reasoning_content` 是思考、`tool_calls` 是工具调用（PRD F-I2 的那三段）。
 * 外壳只带定位信息：哪个对话、哪条消息、这条消息内的第几片。
 *
 * `seq` 是这条消息内的递增序号，客户端用它发现「漏了一片」并在重连后重拉整条。
 */
export interface MessageDeltaPayload {
  conversationId: string;
  messageId: string;
  /** 这条消息内的序号，从 0 开始递增 */
  seq: number;
  /** 这一片增量，core 原样 */
  delta: AgentNS.Delta;
  /** 这次推送的时刻 */
  at: string;
  /**
   * 这条消息属于哪个子 Agent（挂在那次委派的工具调用 id 上，PRD F-I7）。
   *
   * **不给就是主线**：主线消息的增量一直是主线。子 Agent 的话不并进主转录，
   * 客户端按这个键把它归到自己那一栏去（`message.list { toolCallId }` 能取回同一批）。
   */
  toolCallId?: string;
}

/**
 * 结构变化的种类。客户端看到它就去拉对应的东西（PRD L5 / `conversation.changed`）。
 *
 * 事件的用途是「告诉客户端该去拉了」，所以这里只给变化的名字与够用的定位信息，
 * 不试图把变化后的整个对象塞进推送里。
 */
export type ConversationChangeKind =
  | "created"
  | "renamed"
  | "pinned"
  | "messages_persisted"
  | "message_removed"
  | "settings_changed"
  | "deleted";

/** `conversation.changed`：改名、置顶、新增消息已落库、删除等结构变化 */
export interface ConversationChangedPayload {
  conversationId: string;
  /** 所属 Workspace；对话被删后仍带上，便于客户端把它从对应列表里摘掉 */
  workspaceId: string | null;
  change: ConversationChangeKind;
  /** 变化后这段对话的消息条数（删掉整段对话时为空） */
  messageCount: number | null;
  at: string;
}

/** `notice`：新通知（三档语气 + `duration`，PRD L3 / F-I8） */
export interface NoticePayload {
  notice: NoticeView;
  at: string;
}

/** `question`：问题对象被创建或被回答（多端看到同一个，PRD D22 / F-I9） */
export interface QuestionPayload {
  question: QuestionView;
  at: string;
}

/** `usage`：用量变化（本轮 / 累计 / 速率，PRD F-I5） */
export interface UsagePayload {
  conversationId: string;
  usage: UsageSnapshot;
  at: string;
}

// ---------------------------------------------------------------------------
// 事件表
// ---------------------------------------------------------------------------

/**
 * 事件名 → 载荷。
 *
 * 名称按 architecture §7 定：`run.state`、`message.delta`、`conversation.changed`、
 * `notice`、`question`、`usage`。
 */
export interface EventMap {
  "run.state": RunStatePayload;
  "message.delta": MessageDeltaPayload;
  "conversation.changed": ConversationChangedPayload;
  notice: NoticePayload;
  question: QuestionPayload;
  usage: UsagePayload;
}

/** 事件名 */
export type EventName = keyof EventMap;

/** 取某个事件的载荷类型 */
export type EventPayload<E extends EventName> = EventMap[E];

/** 全部事件名（接线层注册推送、测试遍历用） */
export const EVENT_NAMES = [
  "run.state",
  "message.delta",
  "conversation.changed",
  "notice",
  "question",
  "usage",
] as const satisfies readonly EventName[];

/** 运行时判断一个字符串是不是已知事件名 */
export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}
