import type { AgentNS } from "@ai-zen/agents-core";

import type { ConversationStatus, NoticeView, QuestionView } from "./states.js";

/**
 * 事件（宿主 → 客户端的推送，见 PLAN §5.3 / §6）。
 *
 * 推送是 JSON-RPC 通知（无 id），`params` 里带事件名与数据；不重放、不需要 ack —— 断线即作废，
 * 重连由客户端自己拉状态与消息。所以这里的每个事件都只是「在线时的一脚提醒」：
 * 真正的事实要能从 `conversation.state` / `message.list` 再拉出来（PRD L5）。
 *
 * 一条约定：事件只描述「发生了什么变化」，客户端需要完整对象时回宿主拉 ——
 * 这样多端同时在线时不会出现「一份数据在推送里长成另一种形状」。
 *
 * 九个事件分三种粒度（PLAN §5.3）：
 *   - 一条消息的生死：`message.added` / `message.changed` / `message.removed`（每次都带**当时那条消息的完整对象**）；
 *   - 流式一片：`message.delta`（core 的 `AgentNS.Delta` 原样）；
 *   - 四格与出错：`state` / `error`；
 *   - 另外三个是别的域的结构变化：`conversation.changed` / `notice` / `question`。
 *
 * 这里**没有**用量事件、没有「请求中 / 思考中 / 输出中」这类阶段事件：用量在每条消息的
 * `usage` 上，阶段由客户端按上面这批事件的到达自己推（PRD 硬规矩 7）。
 *
 * 流式增量的载荷是 core 的 `AgentNS.Delta` 原样：它描述的正是一片 chunk 带来了什么
 * （`content` / `reasoning_content` / `tool_calls` / …），`applyChunk` 吃的是同一份，
 * 所以客户端攒出来的消息与宿主存下来的那条逐字一致。
 */

// ---------------------------------------------------------------------------
// 载荷
// ---------------------------------------------------------------------------

/**
 * `message.added`：多了一条消息（`PLAN §5.3` 的「追加一条」）。
 *
 * 落地的用户消息、core 追加的那条 `status: pending` 的助手消息、工具结果、注入的 cwd /
 * 交接摘要，都从同一个口出。客户端先有这一条，才挂得上后面那些 `message.delta`。
 *
 * `message` 就是 core 的 `AgentNS.Message` **原样整条带**：`hidden` / `status` / `usage` /
 * `tool_calls` / `omit` / `error` 一个不挑（PRD 4.15）。`hidden` 的语义只是「客户端不显示」，
 * 它照样发给模型、照样推过来。
 */
export interface MessageAddedPayload {
  conversationId: string;
  /** 新出现的那条消息，core 原样 */
  message: AgentNS.Message;
  /** 这条消息属于哪个子 Agent（见 {@link MessageDeltaPayload.toolCallId}）；不给就是主线 */
  toolCallId?: string;
  /** 这条推送的时刻 */
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
 * `message.changed`：某条消息变了，整条重发。
 *
 * 三种场合共用它：流式收尾后那条消息定下来（此刻的 `status` / `tool_calls` /
 * `finish_reason` / `usage` 都在上面）、工具结果回填、事后改写（中止 / 出错 / 打 `omit`）。
 * 客户端整条替换，不做字段级合并 —— 消息上的字段一律整条带，也就不必为「某个字段变了」
 * 再发一个事件（PLAN §5.3）。
 */
export interface MessageChangedPayload {
  conversationId: string;
  /** 变化之后的那条消息，core 原样 */
  message: AgentNS.Message;
  /** 这条消息属于哪个子 Agent（见 {@link MessageDeltaPayload.toolCallId}）；不给就是主线 */
  toolCallId?: string;
  /** 这条推送的时刻 */
  at: string;
}

/** `message.removed`：某条消息被删了（中止、出错、`drop`、撤回）。 */
export interface MessageRemovedPayload {
  conversationId: string;
  messageId: string;
  /** 这条消息属于哪个子 Agent（见 {@link MessageDeltaPayload.toolCallId}）；不给就是主线 */
  toolCallId?: string;
  /** 这条推送的时刻 */
  at: string;
}

/**
 * `state`：一段对话换了一格（忙 / 闲 / 暂停 / 死）。
 *
 * **变了才发**，载荷就是那一格本身：客户端据此把侧栏与输入框摆对（闲会理你、暂停不会、
 * 死要先复活）。更细的阶段不在这里 —— 想知道「在想还是在输出」，读那条助手消息的内容与
 * `delta`（CORE §4「其余一律读活对象」）。
 */
export interface StatePayload {
  conversationId: string;
  /** 此刻那一格；死 = 宿主那边连 agent 对象都没有 */
  status: ConversationStatus;
  /** 这一格定下来的时刻 */
  at: string;
}

/**
 * `error`：宿主那边出错了（完整的错误对象）。
 *
 * 与消息上那条失败事实（`states.ts` 的 `ProblemFact`）分工不同，两者不互相替代
 * （PRD 4.15）：这一条是**当下在线才有**的完整对象，给日志与排查；消息上那一条跟着行落库，
 * 活得比进程长，给界面标红并说清为什么。
 */
export interface ErrorPayload {
  conversationId: string;
  /** 这个错挂在哪条消息上；`null` = 不挂消息（例如装配、读库这类还没碰到消息的失败） */
  messageId: string | null;
  /** 稳定的错误码（排查与分支用它，不解析句子） */
  code: string;
  /** 已按连接语言渲染好的一句人话 */
  message: string;
  /** 结构化事实：哪个工具、哪次请求、厂商原文（形状随 `code` 而定） */
  detail?: unknown;
  /** 这次出错的时刻 */
  at: string;
}

/**
 * 结构变化的种类。客户端看到它就去拉对应的东西（PRD L5 / `conversation.changed`）。
 *
 * 事件的用途是「告诉客户端该去拉了」，所以这里只给变化的名字与够用的定位信息，
 * 不试图把变化后的整个对象塞进推送里。
 *
 * 消息的增删改**不在这里**：那三件事有自己的事件（带整条消息），所以这里没有
 * 「消息落库了」「消息删了」这两格，也不带消息条数 —— 条数客户端自己数。
 *
 * - `created` / `renamed` / `pinned` / `settings_changed` / `deleted`：会话**行**上的事；
 * - `handoff_started`：交接**开始**这一拍。界面上要直说「正在交接」（输入框不给发、只留
 *   中断），而那条 `memory_replaced` 是**收口**才有的 —— 所以开始这一拍必须自己说一声，
 *   否则客户端在交接期间一直以为这段还是普通的一格。
 * - `memory_replaced`：这段对话的**记忆**被换过 —— 交接提交（记忆已经换掉）与交接回滚
 *   （记忆回到交接前）两处都推它。交接期间产生的那批消息只在内存里、从不落库（PLAN §5.3），
 *   所以客户端收到它就去 `message.list` 全量整段替换镜像，把那些痕迹清掉。
 *   它**不是** `settings_changed`：那个说的是会话这一行变了，与记忆无关。
 */
export type ConversationChangeKind =
  | "created"
  | "renamed"
  | "pinned"
  | "settings_changed"
  | "handoff_started"
  | "memory_replaced"
  | "deleted";

/** `conversation.changed`：改名、置顶、改设置、交接开始、换过记忆、删除这类会话上的结构变化 */
export interface ConversationChangedPayload {
  conversationId: string;
  /** 所属 Workspace；对话被删后仍带上，便于客户端把它从对应列表里摘掉 */
  workspaceId: string | null;
  change: ConversationChangeKind;
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

// ---------------------------------------------------------------------------
// 事件表
// ---------------------------------------------------------------------------

/**
 * 事件名 → 载荷。
 *
 * 名称按 PLAN §6 定：`message.added` / `message.delta` / `message.changed` / `message.removed` /
 * `state` / `error` / `conversation.changed` / `notice` / `question`。
 *
 * 前四个是客户端重建 `messages` 的全部原料，`state` 给那四格，`error` 给排查；
 * 宿主不在这之上再加聚合（没有 `run.state`，没有 `usage`）。
 */
export interface EventMap {
  "message.added": MessageAddedPayload;
  "message.delta": MessageDeltaPayload;
  "message.changed": MessageChangedPayload;
  "message.removed": MessageRemovedPayload;
  state: StatePayload;
  error: ErrorPayload;
  "conversation.changed": ConversationChangedPayload;
  notice: NoticePayload;
  question: QuestionPayload;
}

/** 事件名 */
export type EventName = keyof EventMap;

/** 取某个事件的载荷类型 */
export type EventPayload<E extends EventName> = EventMap[E];

/** 全部事件名（接线层注册推送、测试遍历用） */
export const EVENT_NAMES = [
  "message.added",
  "message.delta",
  "message.changed",
  "message.removed",
  "state",
  "error",
  "conversation.changed",
  "notice",
  "question",
] as const satisfies readonly EventName[];

/** 运行时判断一个字符串是不是已知事件名 */
export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}
