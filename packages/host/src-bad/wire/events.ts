import type { AgentNS } from "@ai-zen/agents-core";

import type { SessionActivity, NoticeView, QuestionView } from "./states.js";

/**
 * 事件（宿主 → 客户端的推送，见 PLAN §5.3 / §6）。
 *
 * 推送是 JSON-RPC 通知（无 id），`params` 里带事件名与数据；不重放、不需要 ack —— 断线即作废，
 * 重连由客户端自己拉状态与消息。所以这里的每个事件都只是「在线时的一脚提醒」：
 * 真正的事实要能从 `session.state` / `message.list` 再拉出来（PRD L5）。
 *
 * 一条约定：事件只描述「发生了什么变化」，客户端需要完整对象时回宿主拉 ——
 * 这样多端同时在线时不会出现「一份数据在推送里长成另一种形状」。
 *
 * 十三个事件分四组（粒度见 PLAN §5.4）：
 *   - 一条消息的生死：`message.added` / `message.changed` / `message.removed`（每次都带**当时那条消息的完整对象**）；
 *   - 流式一片：`message.delta`（core 的 `AgentNS.Delta` 原样）；
 *   - 忙闲、两道闸与出错：`state` / `output:paused` / `output:resumed` / `input:paused` /
 *     `input:resumed` / `error`；
 *   - 另外三个是别的域的结构变化：`session.changed` / `notice` / `question`。
 *
 * **四件事各走各的事件**（PRD 4.4）：忙闲只有 `state` 一条，两道闸各有自己的开/关两条，
 * 死活（有没有 agent 实例）走 `session.changed` 的 `agent_started` / `agent_gone` —— 它
 * **不**挤在 `state` 里，因为「没有 agent」不是「手上没活」。
 *
 * 这里**没有**用量事件、没有「请求中 / 思考中 / 输出中」这类阶段事件：用量在每条消息的
 * `usage` 上，阶段由客户端按上面这批事件的到达自己推。
 *
 * 流式增量的载荷是 core 的 `AgentNS.Delta` 原样：它描述的正是一片 chunk 带来了什么
 * （`content` / `reasoning_content` / `tool_calls` / …），`applyChunk` 吃的是同一份，
 * 所以客户端攒出来的消息与宿主存下来的那条逐字一致。
 */

// ---------------------------------------------------------------------------
// 载荷
// ---------------------------------------------------------------------------

/**
 * `message.added`：多了一条消息（`PLAN §5.4` 的「追加一条」）。
 *
 * 落地的用户消息、core 追加的那条 `status: pending` 的助手消息、工具结果、注入的 cwd /
 * 交接摘要，都从同一个口出。客户端先有这一条，才挂得上后面那些 `message.delta`。
 *
 * `message` 就是 core 的 `AgentNS.Message` **原样整条带**：`hidden` / `status` / `usage` /
 * `tool_calls` / `omit` / `error` 一个不挑（PRD 4.15）。`hidden` 的语义只是「客户端不显示」，
 * 它照样发给模型、照样推过来。
 */
export interface MessageAddedPayload {
  sessionId: string;
  /** 新出现的那条消息，core 原样 */
  message: AgentNS.Message;
  /** 这条消息属于哪个 subagent（见 {@link MessageDeltaPayload.toolCallId}）；不给就是主线 */
  toolCallId?: string;
  /** 这条推送的时刻 */
  at: string;
}

/**
 * `message.delta`：一条消息的流式增量（PRD L5：在线时推送；断线后靠 `message.list` 补拉）。
 *
 * 增量本体是 core 的 `AgentNS.Delta`，这一片属于哪一段由它自己带的字段说明：`content` 是
 * 正文、`reasoning_content` 是思考、`tool_calls` 是工具调用（PRD F-I2 的那三段）。
 * 外壳只带定位信息：哪个会话、哪条消息。
 *
 * **这里没有「这一片是第几片」**：连接是一条有序 WS，同一段会话的增量按发出顺序到达；
 * 漏片只可能来自断线，而断线即作废（见文件开头），客户端靠 `resync`（`message.list` 全量，
 * 或带本地最后一条 id 起的增量）把整段重新对齐 —— 序号没有判断依据，也没有用得上的地方。
 */
export interface MessageDeltaPayload {
  sessionId: string;
  messageId: string;
  /** 这一片增量，core 原样 */
  delta: AgentNS.Delta;
  /** 这次推送的时刻 */
  at: string;
  /**
   * 这条消息属于哪个 subagent（挂在那次委派的工具调用 id 上，PRD F-I7）。
   *
   * **不给就是主线**：主线消息的增量一直是主线。subagent 的话不并进主转录，
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
  sessionId: string;
  /** 变化之后的那条消息，core 原样 */
  message: AgentNS.Message;
  /** 这条消息属于哪个 subagent（见 {@link MessageDeltaPayload.toolCallId}）；不给就是主线 */
  toolCallId?: string;
  /** 这条推送的时刻 */
  at: string;
}

/** `message.removed`：某条消息被删了（中止、出错、`drop`、撤回）。 */
export interface MessageRemovedPayload {
  sessionId: string;
  messageId: string;
  /** 这条消息属于哪个 subagent（见 {@link MessageDeltaPayload.toolCallId}）；不给就是主线 */
  toolCallId?: string;
  /** 这条推送的时刻 */
  at: string;
}

/**
 * `state`：这一段会话的**忙闲**变了（`working` / `idle`）。
 *
 * **只报一件事实：手上有没有活。** 两道闸各有自己的事件（{@link PauseChangeEventName}），死活走
 * `session.changed` —— 四件事不压成一格。
 *
 * **变了才发**：客户端据此决定「它还会不会马上动」。更细的阶段不在这里 —— 想知道「在想还是在
 * 输出」，读那条助手消息的内容与 `delta`（CORE §4「其余一律读活对象」）。
 */
export interface StatePayload {
  sessionId: string;
  /** 手上有没有活：`working` / `idle`（只读；与两道闸无关） */
  status: SessionActivity;
  /** 这一格定下来的时刻 */
  at: string;
}

/**
 * 两道闸开合的那四个事件名：输出闸 `output:paused` / `output:resumed`、输入闸 `input:paused` /
 * `input:resumed`（与 core 的事件同名同义）。
 *
 * 这一处只写一遍：另外三处（{@link EventMap} / {@link EVENT_NAMES} / 推送那一侧）都从它推出来。
 */
export type PauseChangeEventName =
  "output:paused" | "output:resumed" | "input:paused" | "input:resumed";

/**
 * 一道闸开或关了：载荷只带会话 id（与 `at`）。
 *
 * 是哪一道、开还是关，**已经在事件名里**了（与 core 的 `output:paused` / `input:resumed` 同一个
 * 写法）：载荷再带一份就是第二份事实。要填完整读数就回宿主拉 `session.state`。
 */
export interface PauseChangePayload {
  sessionId: string;
  /** 这一下的时刻 */
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
  sessionId: string;
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
 * 结构变化的种类。客户端看到它就去拉对应的东西（PRD L5 / `session.changed`）。
 *
 * 事件的用途是「告诉客户端该去拉了」，所以这里只给变化的名字与够用的定位信息，
 * 不试图把变化后的整个对象塞进推送里。
 *
 * 消息的增删改**不在这里**：那三件事有自己的事件（带整条消息），所以这里没有
 * 「消息落库了」「消息删了」这两格，也不带消息条数 —— 条数客户端自己数。
 *
 * - `created` / `renamed` / `pinned` / `settings_changed` / `deleted`：会话**行**上的事；
 * - `agent_started` / `agent_gone`：**死活**这一件事（这一段此刻有没有 agent 实例）。前者 =
 *   一个 agent 刚装好、后面有人取件了；后者 = 桥灭了（`stopped` / `killed` / 退役换人 /
 *   会话被删 / 进程收尾）。两者都不带原因：原因在那条 `onDead` 流里（对客户端只需知道「有/没有」）。
 *   *它们不叫 `state` 的那种值*：死活不是「手上没活」，两者必须分得开（PRD 4.4）。
 * - `handoff_started`：交接**开始**这一拍。界面上要直说「正在交接」（输入框不给发、只留
 *   中断），而那条 `memory_replaced` 是**收口**才有的 —— 所以开始这一拍必须自己说一声，
 *   否则客户端在交接期间一直以为这段还是普通的一段。
 * - `memory_replaced`：这段会话的**记忆**被换过 —— 交接提交（记忆已经换掉）与交接回滚
 *   （记忆回到交接前）两处都推它。交接期间产生的那批消息只在内存里、从不落库（PLAN §5.3），
 *   所以客户端收到它就去 `message.list` 全量整段替换镜像，把那些痕迹清掉。
 *   它**不是** `settings_changed`：那个说的是会话这一行变了，与记忆无关。
 */
export type SessionChangeKind =
  | "created"
  | "renamed"
  | "pinned"
  | "settings_changed"
  | "agent_started"
  | "agent_gone"
  | "handoff_started"
  | "memory_replaced"
  | "deleted";

/** `session.changed`：改名、置顶、改设置、agent 起来/没了、交接开始、换过记忆、删除这类会话上的结构变化 */
export interface SessionChangedPayload {
  sessionId: string;
  /** 所属 Workspace；会话被删后仍带上，便于客户端把它从对应列表里摘掉 */
  workspaceId: string | null;
  change: SessionChangeKind;
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
 * 名称按 PLAN §5.4 定：`message.added` / `message.delta` / `message.changed` / `message.removed` /
 * `state` / `output:paused` / `output:resumed` / `input:paused` / `input:resumed` / `error` /
 * `session.changed` / `notice` / `question`（共 **13** 条）。
 *
 * 前四个是客户端重建 `messages` 的全部原料，`state` 给忙闲、四条闸事件给两道闸的开与关、
 * `error` 给排查；宿主不在这之上再加聚合，也不报「这一段跑了多久」或用量。
 */
export interface EventMap {
  "message.added": MessageAddedPayload;
  "message.delta": MessageDeltaPayload;
  "message.changed": MessageChangedPayload;
  "message.removed": MessageRemovedPayload;
  state: StatePayload;
  // 两道闸那四条：名字自己就是「哪一道、开还是关」，载荷只带会话 id（见 `PauseChangePayload`）
  "output:paused": PauseChangePayload;
  "output:resumed": PauseChangePayload;
  "input:paused": PauseChangePayload;
  "input:resumed": PauseChangePayload;
  error: ErrorPayload;
  "session.changed": SessionChangedPayload;
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
  "output:paused",
  "output:resumed",
  "input:paused",
  "input:resumed",
  "error",
  "session.changed",
  "notice",
  "question",
] as const satisfies readonly EventName[];

/** 运行时判断一个字符串是不是已知事件名 */
export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}
