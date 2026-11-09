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
  /** 按磁盘上的（新）配置与 Agent 定义重建 Agent，**保留消息** */
  reload: "session.reload",
  /** 整份快照：客户端（重）连上来时一次拿全，不用自己拼事件 */
  snapshot: "session.snapshot",
  /** 把当前会话写进工作区存档（并把它设为「上一轮会话」） */
  save: "session.save",
  /** 只产出交接文档：写文档，**不动会话**（不换 id、不剔历史） */
  handoff: "session.handoff",
  /** 交接 + 开新会话：写文档、剔历史、**换 sessionId** */
  migrate: "session.migrate",
} as const;

/**
 * Agent 级方法：改的是**全局的 Agent 定义**，影响所有用这个 Agent 的会话。
 *
 * 因此不挂在 `session.*` 下（那个命名空间只放"对某一段会话做事"的方法）。
 */
export const AGENT_METHODS = {
  /** 换模型：写 `AgentDefinition.modelId` 并清空思考参数 */
  setModel: "agent.model.set",
} as const;

/** 连接级方法（与某个会话无关，所以不放在 `session.*` 里） */
export const EVENT_METHODS = {
  /** 让**这条连接**开始收事件（事件是服务端主动推、无 `id`、不等回执） */
  watch: "events.watch",
} as const;

/**
 * 事件名（服务端主动推，无 `id`，不等回执）。
 *
 * 命名空间写的是**作用范围**，所以通知天然分两个通道：
 *   - `session.notice`：对话内通知，绑在某一段会话上（落盘失败、工具失败、迁移降级…），
 *     跟着会话走 —— 切到别的会话就不该还挂在那儿；
 *   - `global.notice`：全局通知，不属于任何会话（服务本身的事），切会话也不该消失。
 *
 * 将来若出现「属于某个工作区但不属于某段会话」的通知，再加 `workspace.notice`，
 * 不用回头改这两个的语义。
 */
export const SESSION_EVENTS = {
  /** 生成阶段变化（六态 + 工具名） */
  phase: "session.phase",
  /** 正文 / 推理增量 */
  delta: "message.delta",
  /** 一轮结束（成功或失败） */
  turnEnd: "turn.end",
  /** 对话内通知（绑会话） */
  notice: "session.notice",
  /** 全局通知（不绑会话） */
  globalNotice: "global.notice",
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

export interface AgentSetModelParams {
  agentId: string;
  modelId: string;
}

export interface AgentSetModelResult {
  agentId: string;
  modelId: string;
}

export interface SessionReloadParams {
  sessionId: string;
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

/**
 * 交接文档的执行者。
 *
 *   - `self`：原 Agent 在自己的会话里停工后写（默认）。上下文完整、能核实真实状态；
 *     代价是多 1~2 次全量输入；
 *   - `summary`：一次独立模型调用把历史摘要成文档（无工具、无原会话上下文）。
 *     便宜、确定，但保真度低 —— 是**逃生模式**，也是 `self` 失败后的单向降级目标。
 *
 * 由服务端按 SDK 的 `HandoffMode` 定义，不直接引用 SDK 类型：协议是线上契约，
 * 客户端（将来的浏览器 / 手机）不该为了一个枚举去装 SDK。
 */
export type HandoffMode = "self" | "summary";

export interface SessionHandoffParams {
  sessionId: string;
  /** 本次执行者；缺省 `self` */
  mode?: HandoffMode;
}

/**
 * 一次交接的结果。`handoff` 与 `migrate` 共用（迁移就多一件事：`sessionId` 变了）。
 *
 * 为什么连 `messages` 一起回：交接回合会往会话里追加消息、迁移则把历史剔成
 * 「模板 + 交接断点」。客户端拿这一份直接重渲染，不必再要一次快照（两次往返之间
 * 还会有事件插进来）。
 */
export interface SessionHandoffResult {
  /** 交接之后的会话 id：`handoff` 不变，`migrate` 是**新会话**的 id */
  sessionId: string;
  /** 交接文档绝对路径（在服务端的工作区里，客户端未必能直接打开） */
  handoffPath: string;
  /** **实际**使用的执行者：请求 `self` 但降级时会与入参不同 */
  mode: HandoffMode;
  /** 交接之后的消息（客户端直接重渲染） */
  messages: unknown[];
}

export interface SessionMigrateParams extends SessionHandoffParams {}

export interface SessionMigrateResult extends SessionHandoffResult {}

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

/** 通知级别：只要客户端能据此选颜色/语气，不要更细的语义 */
export type NoticeLevel = "info" | "warn" | "error";

/**
 * 对话内通知的 code 表。
 *
 * **只增不改语义**：code 一旦发出去就是协议的一部分，改了等于客户端文案失配。
 * 客户端按 `notice.<code>` 查自己的 i18n 表渲染 —— 服务端不产文案。
 */
export const SESSION_NOTICE_CODES = {
  /** 会话落盘失败（用户以为存了，其实没存） */
  persistFailed: "persistFailed",
  /** 工具执行失败 */
  toolFailed: "toolFailed",
  /** 交接/迁移降级（请求的执行者与实际执行者不一致） */
  migrationDegraded: "migrationDegraded",
  /** 本轮被中止 */
  turnAborted: "turnAborted",
  /** 开始写交接文档（`params.mode` 是请求的执行者） */
  handoffWriting: "handoffWriting",
  /** 交接文档落在这个路径（`params.path`） */
  handoffPath: "handoffPath",
  /** 迁移前把旧会话存进了存档（`params.sessionId` 是**旧**会话） */
  handoffArchived: "handoffArchived",
} as const;

/** 全局通知的 code 表（同上：只增不改语义） */
export const GLOBAL_NOTICE_CODES = {
  /** MCP server 连不上 */
  mcpUnavailable: "mcpUnavailable",
  /** 存档目录不可用（读/写失败） */
  storeUnavailable: "storeUnavailable",
} as const;

export type SessionNoticeCode = (typeof SESSION_NOTICE_CODES)[keyof typeof SESSION_NOTICE_CODES];
export type GlobalNoticeCode = (typeof GLOBAL_NOTICE_CODES)[keyof typeof GLOBAL_NOTICE_CODES];

/** 对话内通知：与某一段会话绑定 */
export type SessionNoticeEvent = {
  event: typeof SESSION_EVENTS.notice;
  sessionId: string;
  level: NoticeLevel;
  code: SessionNoticeCode;
  /** 文案里的可变部分（客户端代入自己的模板） */
  params?: Record<string, unknown>;
};

/** 全局通知：不属于任何会话，切会话也不该消失 */
export type GlobalNoticeEvent = {
  event: typeof SESSION_EVENTS.globalNotice;
  level: NoticeLevel;
  code: GlobalNoticeCode;
  params?: Record<string, unknown>;
};

/** 服务端能推给客户端的全部事件 */
export type ServerEvent =
  | SessionPhaseEvent
  | MessageDeltaEvent
  | TurnEndEvent
  | SessionNoticeEvent
  | GlobalNoticeEvent;
