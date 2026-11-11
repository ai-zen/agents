import type {
  MessageStatus,
  NoticeView,
  QuestionView,
  RunState,
  SegmentKind,
  ToolCallStatus,
  UsageSnapshot,
} from "./states.js";

/**
 * 事件（服务端 → 客户端的推送，见 architecture §7）。
 *
 * 推送是 JSON-RPC 通知（无 id），`params` 里带事件名与数据；不重放、不需要 ack —— 断线即作废，
 * 重连由客户端按 D5 自己拉状态与消息。所以这里的每个事件都只是「在线时的一脚提醒」：
 * 真正的事实要能从 `conversation.state` / `message.list` 再拉出来（PRD L5）。
 *
 * 一条约定：事件只描述「发生了什么变化」，客户端需要完整对象时回服务端拉 ——
 * 这样多端同时在线时不会出现「一份数据在推送里长成另一种形状」。
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

/** 思考段的增量：思考内容正在长 */
export interface ThinkingDelta {
  kind: "thinking";
  /** 这一片新增的思考文本 */
  delta: string;
}

/** 正文段的增量：模型正在说 */
export interface TextDelta {
  kind: "text";
  /** 这一片新增的正文 */
  delta: string;
}

/**
 * 工具调用段的增量：参数在拼、状态在变。
 *
 * `name` 与 `argumentsDelta` 可为空，是因为流里可能先到 id、后到名字与参数片段。
 */
export interface ToolCallDelta {
  kind: "tool_call";
  toolCallId: string;
  name: string | null;
  /** 这一片新增的参数文本（可能是半截 JSON，由客户端拼完再解释） */
  argumentsDelta: string | null;
  /** 这一刻这段工具调用的状态 */
  status: ToolCallStatus;
}

/** 一段消息里的增量：它属于哪一段（思考 / 工具调用 / 正文）由 `kind` 指明 */
export type MessageDelta = ThinkingDelta | TextDelta | ToolCallDelta;

/**
 * `message.delta`：一条消息的流式增量（PRD L5：在线时推送；断线后靠 `message.list` 补拉）。
 *
 * `seq` 是这条消息内的递增序号，客户端用它发现「漏了一片」并在重连后重拉整条。
 */
export interface MessageDeltaPayload {
  conversationId: string;
  messageId: string;
  /** 这条消息内的序号，从 0 开始递增 */
  seq: number;
  /** 属于哪一段（与增量类型一致） */
  segment: SegmentKind;
  delta: MessageDelta;
  /** 这条消息此刻的状态 */
  messageStatus: MessageStatus;
  at: string;
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
