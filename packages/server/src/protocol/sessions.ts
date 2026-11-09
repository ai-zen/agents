/**
 * 会话层线上契约 —— 方法名、参数/结果、事件名。
 *
 * 与 `messages.ts` 的分工：那边定义**帧**（怎么在一条连接上运字节），这边定义**会话**
 * （在帧里说什么）。客户端只认这里的字面量与类型，服务端实现不得私自约定别的字段。
 *
 * ## 为什么事件是「事实」而不是「文案」
 *
 * 事件载荷只有可判别的枚举与数据（阶段 kind、工具名、正文字符串）。渲染成
 * 「连接中…」还是「Connecting…」由客户端决定 —— 否则一个服务端同时接中文终端和英文
 * 浏览器时，只能挑一个语言撒谎。
 *
 * ## 为什么 `send` 立刻返回 `turnId`
 *
 * 一轮对话可能跑几分钟，中间要推几十上百条事件。若 `send` 等到跑完才回，客户端就没有
 * 任何东西可渲染，超时也没法定（工具执行动辄数分钟）。所以：`send` 只确认「这一轮开始了」，
 * 后续全部走事件；`turnId` 用来把事件归到具体的一轮（用户可能中途连按两次）。
 */

import type { PhaseInfo } from "../service/progress/PhaseTracker.js";
import type { SessionRef } from "../service/store/SessionStore.js";

/**
 * 词汇表（名字就这三个，不再多造）：
 *
 *   workspace  工作目录（会话的父容器）
 *   session    **与某个 Agent 进行的一段会话**，属于某个 workspace；有 id，可以活着也可以已落盘
 *   turn       session 里的一轮 `send → 结束`，用 `turnId` 归轮
 *
 * `session.*` 只用于「对一个会话做事」。不属于某个会话的动作不往这个命名空间里塞：
 * 例如「订阅事件」是**连接级**的（`events.watch`），跟具体会话无关。
 */

/** 会话方法名（服务端注册与客户端调用共用同一份字面量，避免两边各写一份字符串） */
export const SESSION_METHODS = {
  /** 路径 → 工作区身份（建目录、写 `workspace.json`） */
  workspaceResolve: "workspace.resolve",
  create: "session.create",
  send: "session.send",
  cancel: "session.cancel",
  /** 某个工作区下活着的会话（不是盘上的存档） */
  list: "session.list",
  /** 某个工作区下**已存档**的会话（`/load` 的选择器用），按写入时间倒序 */
  listSaved: "session.listSaved",
  /** 撤回：删掉下标起的消息，并立即落盘 */
  rollback: "session.rollback",
  /** 整份快照：客户端（重）连上来时一次拿全，不用自己拼事件 */
  snapshot: "session.snapshot",
  /** 把当前会话写进工作区存档（并把它设为「上一轮会话」） */
  save: "session.save",
} as const;

/** 连接级方法（与某个会话无关，所以不放在 `session.*` 里） */
export const EVENT_METHODS = {
  /** 让**这条连接**开始收事件（事件是服务端主动推、无 `id`、不等回执） */
  watch: "events.watch",
} as const;

/** 事件名（服务端主动推，无 `id`，不等回执） */
export const SESSION_EVENTS = {
  /** 生成阶段变化（六态 + 工具名） */
  phase: "session.phase",
  /** 正文 / 推理增量 */
  delta: "message.delta",
  /** 一轮结束（成功或失败） */
  turnEnd: "turn.end",
} as const;

// ==================== 方法参数与结果 ====================

export interface WorkspaceResolveParams {
  /** 工作目录的绝对路径（服务端负责规范化与建目录） */
  path: string;
}

export interface WorkspaceResolveResult {
  workspaceId: string;
  /** 规范化之后的绝对路径 */
  path: string;
}

export interface SessionCreateParams {
  workspaceId: string;
  /**
   * 工作区路径。客户端刚从 `workspace.resolve` 拿到，原样带回来 ——
   * 这一版没有鉴权，服务端不去校验 id 与 path 是否配对；等鉴权落地时，校验点在
   * 这里（客户端不该有能力决定自己跑在哪个目录）。
   */
  path: string;
  /** 用哪个 Agent（缺省 `default`） */
  agentId?: string;
  /**
   * 会话 id。**不给则服务端分配**。
   *
   * 活会话与盘上存档共用同一个 id（存档就是这段会话的落盘形态）：续接已有存档时
   * 客户端把它带进来；新会话留空，由服务端按同一套格式生成。
   */
  sessionId?: string;
}

export interface SessionCreateResult {
  sessionId: string;
  agentId: string;
}

export interface SessionSendParams {
  sessionId: string;
  content: string;
}

export interface SessionSendResult {
  /** 本轮编号（从 1 开始，每轮 +1）：事件靠它归轮 */
  turnId: number;
}

export interface SessionCancelParams {
  sessionId: string;
}

export interface SessionCancelResult {
  cancelled: boolean;
}

export interface SessionListParams {
  /** 会话属于工作区，列会话必须指明是哪个工作区的（不提供"全局列"） */
  workspaceId: string;
}

export interface SessionSummary {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  turnId: number;
  /** 当前阶段；空闲为 null */
  phase: PhaseInfo | null;
}

/** 一屏所需的全部事实：客户端拿它直接渲染，不必先从事件流里攒 */
export interface SessionSnapshotParams {
  sessionId: string;
}

export interface SessionSnapshotResult {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  turnId: number;
  phase: PhaseInfo | null;
  /** 当前完整消息列表（服务端是唯一真相源） */
  messages: unknown[];
  /** 最近一轮用量（Agent 提供才带；客户端不知道就别显示） */
  lastUsage?: unknown;
}

export interface SessionSaveParams {
  sessionId: string;
}

export interface SessionSaveResult {
  saved: boolean;
  sessionId: string;
}

export interface SessionListResult {
  sessions: SessionSummary[];
}

export interface SessionListSavedParams {
  workspaceId: string;
}

export interface SessionListSavedResult {
  /** 只有 id：列表不解析存档内容 */
  sessions: SessionRef[];
}

export interface SessionRollbackParams {
  sessionId: string;
  /** 从这个下标起（含）删掉 */
  index: number;
}

export interface SessionRollbackResult {
  /** 删掉了多少条 */
  removed: number;
  /**
   * 被删掉的第一条用户消息的**原始**文本（客户端可拿去预填输入框）。
   *
   * 服务端不剥「工作目录备注」那类装饰：那是客户端拼进去的，也该由客户端还原。
   */
  prompt: string;
  /** 撤回之后剩下的全部消息（客户端直接重渲染，不用再要一次快照） */
  messages: unknown[];
}
// ==================== 事件 ====================
//
// 这些写成 `type` 而不是 `interface`：`interface` 不会隐式获得索引签名，于是
// 无法直接传给 `Connection.send(event: EventFrame)`（`EventFrame` 带 `[key: string]: unknown`）。
// 写成类型别名则天然兼容，不需要在发送处加一次 `as` 断言。

export type SessionPhaseEvent = {
  event: typeof SESSION_EVENTS.phase;
  sessionId: string;
  turnId: number;
  /** null = 本轮已收尾、回到空闲 */
  phase: PhaseInfo | null;
};

export type MessageDeltaEvent = {
  event: typeof SESSION_EVENTS.delta;
  sessionId: string;
  turnId: number;
  /** 正文增量（只带推理内容时为空串） */
  text: string;
  /** 推理增量（推理模型才有） */
  reasoning: string;
};

export type TurnEndEvent = {
  event: typeof SESSION_EVENTS.turnEnd;
  sessionId: string;
  turnId: number;
  ok: boolean;
  /** 失败时的机器可判原因 */
  error?: { code: string; message: string };
};

export type SessionEvent = SessionPhaseEvent | MessageDeltaEvent | TurnEndEvent;
