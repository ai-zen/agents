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
 * 例如「订阅事件」是**连接级**的（`events.watch`），跟具体会话无关；工作区是会话的
 * **父容器**，它的事归 `workspace.*`（见 `WORKSPACE_METHODS`）。
 */

/**
 * 工作区方法名（服务端注册与客户端调用共用同一份字面量）。
 *
 * 为什么要跟 `SESSION_METHODS` 分开：工作区是会话的父容器，两个层级的动作混在一个
 * 常量表里，调用点就得靠眼力分辨「这一步是在认容器，还是在对一段会话做事」。分开之后
 * **线上方法名一个字没变**（仍是 `workspace.resolve`）—— 客户端只改引用的常量名。
 */
export const WORKSPACE_METHODS = {
  /** 路径 → 工作区身份（建目录、写 workspace.json） */
  resolve: "workspace.resolve",
  /** 某个工作区的文件清单（客户端 `@` 补全用；扫的是服务端磁盘） */
  files: "workspace.files",
} as const;

/** 会话方法名（服务端注册与客户端调用共用同一份字面量，避免两边各写一份字符串） */
export const SESSION_METHODS = {
  create: "session.create",
  /**
   * 接上一段**已经存在**的会话（活着就接、盘上有就装回来）。
   *
   * 与 `create` 分开的理由见 `SessionManager.attach`：会话的存活期比客户端连接长，
   * 「接着上次」如果复用 `create`，会撞在它「id 撞了就拒绝」的语义上 —— 用户看到的是
   * 「打不开自己上一轮会话」。`create` 的不静默顶掉语义**不动**，两个动作各说各的。
   */
  attach: "session.attach",
  send: "session.send",
  cancel: "session.cancel",
  /**
   * 回答服务端提出的问题（目前只有自动迁移的「用哪种方式交接」）。
   *
   * 为什么是个**方法**而不是事件：提问要一个确定的答案，而且提问方（服务端）在等它
   * —— 单向事件只能承载「事实」，承载不了「往返」。问题本身仍走事件（见
   * `SESSION_EVENTS.question`），因为它的方向是服务端 → 客户端。
   */
  answer: "session.answer",
  /** 某个工作区下活着的会话（不是盘上的存档） */
  list: "session.list",
  /** 某个工作区下**已存档**的会话（`/load` 的选择器用），按写入时间倒序 */
  listSaved: "session.listSaved",
  /** 某个工作区「上一轮会话」的指针（只有 id；客户端拿它走续接） */
  last: "session.last",
  /** 撤回：删掉下标起的消息，并立即落盘 */
  rollback: "session.rollback",
  /** 按磁盘上的（新）配置与 Agent 定义重建 Agent，**保留消息** */
  reload: "session.reload",
  /** 整份快照：客户端（重）连上来时一次拿全，不用自己拼事件 */
  snapshot: "session.snapshot",
  /** 把当前会话写进工作区存档（并把它设为「上一轮会话」） */
  save: "session.save",
  /** 另存为指定 id：写新档、删旧档、活会话跟着换键（`/save <名字>`） */
  saveAs: "session.saveAs",
  /** 只产出交接文档：写文档，**不动会话**（不换 id、不剔历史） */
  handoff: "session.handoff",
  /** 交接 + 开新会话：写文档、剔历史、**换 sessionId** */
  migrate: "session.migrate",
  /** 取某个子 Agent 到目前为止的完整对话（客户端切到该栏目时对齐用） */
  subAgentSnapshot: "session.subAgent.snapshot",
  /**
   * 换 Agent：按新定义重建 Agent、**保留消息**、更新会话的 `agentId`。
   *
   * 为什么要一条方法：Agent 身份归服务端（Agent 跑在它那边），而 `/agent` 是「同一段
   * 对话换个 Agent 继续」。客户端自己搬消息重建会话是另一条路 —— 那条路要求服务端接受
   * 客户端递来的历史，与「服务端是唯一真相源」直接冲突。
   */
  setAgent: "session.setAgent",
  /**
   * 关闭一段会话：摘事件、让出 Agent 与 Scope 引用，**不删存档**。
   *
   * 只在**明确要求**时关（`/close` 这条命令、以及自动回收的判定）；连接断开不算 ——
   * 会话的存活期比连接长，关掉终端只退订阅，服务端那一轮仍会跑完。
   */
  close: "session.close",
  /**
   * 保活区开关（每段会话一个标记，幂等）。
   *
   * `on: true` = 「这段我现在要，别回收」；`on: false` = 「我不管了，跑完就收」。
   * 回收判据就一条：`turn.end` 收尾之后仍不在保活区 → 关闭（存档已在收尾前写好，
   * 所以再点回来 `attach` 能从盘上装回来）。
   */
  keepAliveSet: "session.keepAlive.set",
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
  /**
   * 服务端向客户端提问：**需要用户决定的事，服务端不替用户选**。
   *
   * 与通知的区别是它要一个回答（有 `questionId`），且服务端那一侧正等着它：自动迁移
   * 「用哪种方式交接」原本是 TUI 进程内的一个三选一，前后端分离之后必须原样回到用户手上
   * —— 否则服务端就是替用户做了「保真还是便宜」这个决定。
   *
   * 回答走 `session.answer`；答案来晚了（超时 / 会话已收）服务端回 `answered: false`，
   * 不报错（那不是参数错）。
   */
  question: "session.question",
  /**
   * 会话换了 id（迁移 / 另存为）。
   *
   * 服务端可以在**一轮进行中**换 id（自动迁移就是如此）：这时客户端没有任何请求
   * 可以拿来“拿到新 id”，所以必须有一条事件说清楚 —— 否则它会在旧 id 上等一个
   * 永远不会到的 `turn.end`。
   *
   * 载荷用 `from` 而不是 `sessionId` 标识“这条是说哪段会话的”（那个 id 已经不存在了），
   * 客户端拿 `from === 自己当前 id` 就能认领。
   */
  idChanged: "session.idChanged",
  /** 一个子 Agent 开始（本轮内 index 从 1 起；subAgentId 稳定，客户端拿它归增量 / 当选中态） */
  subAgentStarted: "session.subAgent.started",
  /** 一个子 Agent 结束：done = 正常跑完，failed = 抛错（**一旦 failed 就不再变**） */
  subAgentEnded: "session.subAgent.ended",
  /** 全局通知（不绑会话） */
  globalNotice: "global.notice",
} as const;

// ==================== 方法参数与结果 ====================

export interface WorkspaceResolveParams {
  /**
   * 工作目录的绝对路径（服务端负责规范化与建目录）。
   *
   * **可选**：cwd 归属服务端 —— 客户端（终端 / 桌面 / 将来的浏览器）不指定时，用服务端
   * 进程的工作目录（由组装根注入，不是这一层去读进程级全局）。不带参数的 `workspace.resolve`
   * 才是「我的工作区在哪」这个问题的正解：客户端把自己进程的当前工作目录送上来，等于让
   * 客户端替服务端决定会话跑在哪个目录。
   */
  path?: string;
}

export interface WorkspaceResolveResult {
  workspaceId: string;
  /** 规范化之后的绝对路径 */
  path: string;
}

export interface WorkspaceFilesParams {
  workspaceId: string;
}

/**
 * 与客户端 `PathEntry` 逐字对齐：`dir` 决定补全后是否补一个 `/`。
 *
 * 清单里**既有文件、也有它们的祖先目录**（目录条目排在文件之前），不仅是一堆文件路径：
 * 客户端靠 `dir: true` 渲染“可继续往里钻”的目录行、并在选中后补上末尾的 `/`。
 * 只给文件的话，远程模式下“钻目录”这个能力就不存在了。
 */
export interface WorkspaceFileEntry {
  /** 相对工作区根目录的路径，`/` 分隔，不带 `./` 前缀 */
  path: string;
  /** 是否目录（目录条目的 `path` 不带末尾 `/`，那个斜杠由客户端插入时补） */
  dir: boolean;
}

export interface WorkspaceFilesResult {
  entries: WorkspaceFileEntry[];
}

export interface SessionCreateParams {
  workspaceId: string;
  /**
   * 工作区路径。**可选**：不给就由服务端按 `workspaceId` 反查（`workspace.json`）。
   *
   * 为什么干脆不该给：路径是服务端的磁盘事实，而客户端手上那份是**它自己**那边的路径 ——
   * 两机部署时那个路径在服务端可能根本不存在。客户端只持有 id，这才叫 cwd 归服务端。
   * 留这个口子是为了兼容「同一个路径想跑两遍」以外的旧调用，等鉴权落地时它会彻底消失：
   * 客户端不该有能力决定自己跑在哪个目录。
   */
  path?: string;
  /** 用哪个 Agent（缺省 `default`；**续接已有存档时不给就沿用存档里记的那个**） */
  agentId?: string;
  /**
   * 会话 id。**不给则服务端分配**（给了就用它，存档里同 id 的记录会被装进 Agent）。
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

export interface SessionLastParams {
  workspaceId: string;
}

export interface SessionLastResult {
  /**
   * 上一轮会话的 id。
   *
   * 两种情况下为 `null`，客户端一律走新会话：没有指针，以及**指针指向的存档已经不在了**
   * （改名 / 手删）。后者不能直接回 id —— `session.create` 对“存档里没这个 id”是静默开
   * 一段空会话，用户会以为历史丢了。
   */
  sessionId: string | null;
}

/**
 * 接上一段已有会话。
 *
 * `sessionId` 必填：attach 的语义就是「我知道是哪一段，别给我开新的」。它可能在内存里活着
 * （客户端刚崩、会话还在跑），也可能只在存档里 —— 客户端无从判断，所以判断放在服务端。
 */
export interface SessionAttachParams {
  workspaceId: string;
  sessionId: string;
  /** 同 `create`：可省，省了由服务端按 `workspaceId` 反查 */
  path?: string;
  /** 只在「存档里没有这个 id」时无关；活着的会话以自己的 `agentId` 为准 */
  agentId?: string;
}

export type SessionAttachResult = SessionCreateResult;

export interface SessionSendParams {
  sessionId: string;
  content: MessageContent;
}

export interface SessionSendResult {
  /** 本轮编号（从 1 开始，每轮 +1）：事件靠它归轮 */
  turnId: number;
}

/**
 * 会话 id 变化事件。
 *
 * 迁移（`session.migrate`）与另存为（`session.saveAs`）都会换 id，自动迁移还会在
 * **一轮进行中**换 —— 客户端靠这条事件把之后的请求与事件过滤切到新 id 上。
 */
export type SessionIdChangedEvent = {
  event: typeof SESSION_EVENTS.idChanged;
  /** 旧 id（客户端用 `from === 当前 id` 认领这条） */
  from: string;
  /** 新 id */
  sessionId: string;
};

/**
 * 服务端向客户端提问（见 `SESSION_EVENTS.question` 的「为什么」）。
 *
 * 载荷只有可判别的事实：`kind` 说明问的是哪件事，两个 token 数是**触发上下文**
 * —— 客户端选择器的标题要显示「已用 X / 上限 Y」，这个数只有服务端手里有（用量是
 * Agent 那边的事实），客户端自己算不出来，服务端也不替它拼成一句文案。
 */
export type SessionQuestionEvent = {
  event: typeof SESSION_EVENTS.question;
  sessionId: string;
  /** 本次提问的 id（回答时带回来；服务端据此认领，过期的回答一律拒） */
  questionId: string;
  kind: SessionQuestionKind;
  /** 触发上下文（客户端选择器的标题要显示「已用 X / 上限 Y」） */
  promptTokens: number;
  handoffTokens: number;
};

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
  /**
   * 是否在保活区里（`turn.end` 之后不被回收的就是它们）。
   *
   * 客户端靠它「区分」：将来 desktop / web 的 pin 列表直接读这个字段，不用另走一条查询。
   */
  keepAlive: boolean;
}

/** 一屏所需的全部事实：客户端拿它直接渲染，不必先从事件流里攒 */
export interface SessionSnapshotParams {
  sessionId: string;
}

export interface SessionSnapshotResult {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  /**
   * 当前 Agent 绑定的模型 id（状态栏显示用）。
   *
   * 真相源是 `AgentDefinition.modelId`，不是会话 —— 会话不记模型。定义里没绑模型时为
   * 空串（客户端不显示），服务端不替它猜一个。
   */
  modelId: string;
  /**
   * 实发模型名（端点上真正写的那个名字）。
   *
   * 与 `modelId`（配置里的身份）不一定相同：用户可以在配置里给模型起别名。客户端拼
   * 图片内容块时要按**实发名**反查端点与视觉能力（`file_id` 是端点维度资源），所以它
   * 是个必要的事实，不是元数据。
   */
  apiModel: string;
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

/** 换 Agent：`agentId` 必须是已存在的 Agent 定义（否则 `unknown-agent`） */
export interface SessionSetAgentParams {
  sessionId: string;
  agentId: string;
}

export type SessionSetAgentResult = SessionSnapshotResult;

export interface SessionCloseParams {
  sessionId: string;
}

export interface SessionCloseResult {
  /** `false` = 这段会话本来就没在跑（幂等：客户端可以重复调） */
  closed: boolean;
}

export interface SessionKeepAliveSetParams {
  sessionId: string;
  /** `true` = 放进保活区，`false` = 移出 */
  on: boolean;
}

export interface SessionKeepAliveSetResult {
  sessionId: string;
  keepAlive: boolean;
}

export interface SessionSaveParams {
  sessionId: string;
}

export interface SessionSaveResult {
  saved: boolean;
  sessionId: string;
}

export interface SessionSaveAsParams {
  sessionId: string;
  /** 新 id（客户端给的名字，如 `chat_debug_login`） */
  id: string;
}

export interface SessionSaveAsResult {
  saved: boolean;
  /** 另存之后的新 id：之后的请求都得用它（旧 id 已退场） */
  sessionId: string;
}

export interface SessionListResult {
  sessions: SessionSummary[];
}

export interface SessionListSavedParams {
  workspaceId: string;
}

/**
 * 用户消息的内容：纯文本，或「文本 + 图片」的内容块数组。
 *
 * 服务端**不解释**它 —— 与它对待 `messages` 一样，原样交给 Agent。内容块该怎么拼
 * （内联 data URL 还是 Files API 的 `file_id`）取决于端点能力与模型是否支持视觉，
 * 那是**客户端**在有配置、有实发模型名的情况下做的决定；服务端再判断一遍只会多出
 * 第二份会漂移的规则。
 *
 * 形状就是 OpenAI 兼容的那种内容块（模型端点要的原样结构）：
 *   - `text`：文本段；
 *   - `image_url`：内联 data URL（带可选的 `detail` 档位）；
 *   - `file`：Files API 引用 —— `file_id`（已上传）或 `file_data`（base64 内联）。
 *
 * 将来的二进制旁路（`artifact.*`）会让客户端只传字节、由服务端转换。
 */
export type MessageContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "file"; file_id?: string; file_data?: string; filename?: string };

export type MessageContent = string | MessageContentBlock[];

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

/**
 * 服务端提问的种类。
 *
 * 只增不改语义（与通知 code 表同一条规矩）：客户端按 `kind` 决定弹哪个选择器，
 * 改一个旧值的含义等于让老客户端渲染成别的东西。
 */
export type SessionQuestionKind = "handoff-mode";

/**
 * 回答一次提问。
 *
 * `questionId` 必填且必须原样带回来：服务端靠它认领，**过期的回答一律拒**（见
 * `SessionAnswerResult.answered`）—— 用户在超时之后才点的那个选项，不该作用于
 * 一段已经继续跑下去的会话。
 */
export interface SessionAnswerParams {
  sessionId: string;
  questionId: string;
  /** `null` = 用户选择「不交接」（跳过本次迁移） */
  mode: HandoffMode | null;
}

export interface SessionAnswerResult {
  /** `false` = 这个问题已经不在了（超时 / 会话已收）：客户端不必重试 */
  answered: boolean;
}

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

/**
 * 取某个子 Agent 到目前为止的完整对话。
 *
 * 为什么不走「客户端自己从事件流里攒」：客户端可能是在子 Agent 已经跑了一半时才切到
 * 那个栏目的（甚至是从没收到过 `started` 的连接），攒出来的只能是半截。服务端是唯一
 * 真相源 —— 与 `session.snapshot` 同一个理由。
 */
export interface SubAgentSnapshotParams {
  sessionId: string;
  subAgentId: string;
}

export interface SubAgentSnapshotResult {
  subAgentId: string;
  /** 本轮内从 1 起（与栏目标签的序号一致） */
  index: number;
  status: "running" | "done" | "failed";
  /** 它到目前为止的完整对话（从第 0 条起，服务端原样给，不解释形状） */
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
  /**
   * 有它就属于那个**子 Agent**，没有就是主 Agent。
   *
   * 一条增量通道同时承载两层对话，靠这个字段分流；缺省（不等于空串）表示主 Agent，
   * 于是老客户端不改也能继续把主对话读对。
   */
  subAgentId?: string;
};

/**
 * 一个子 Agent 开始了。
 *
 * `index` 是**展示用的序号**（本轮内从 1 起，栏目标签「子AGENT1」直接印它）；
 * `subAgentId` 是**稳定标识**（客户端拿它当选中态与 React key）。两者分开是因为它们
 * 回答不同的问题：「用户看到的第几栏」与「是哪一次委派」。`index` 每轮都会重来，所以
 * 它不能当 id 用；反过来，id 带上展示含义之后，改一次标签就得动一次 id。
 */
export type SubAgentStartedEvent = {
  event: typeof SESSION_EVENTS.subAgentStarted;
  sessionId: string;
  turnId: number;
  subAgentId: string;
  index: number;
};

/**
 * 一个子 Agent 结束了。
 *
 * `failed` 是**终态**：出错之后即便 SDK 还会发结束事件，也绝不能改回 `done` ——
 * 否则界面上一个真的失败了的子任务会显示成成功。
 */
export type SubAgentEndedEvent = {
  event: typeof SESSION_EVENTS.subAgentEnded;
  sessionId: string;
  turnId: number;
  subAgentId: string;
  status: "done" | "failed";
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
  /** 自动迁移被触发（`params` 带 `used` / `limit` / `mode`） */
  handoffAutoDetected: "handoffAutoDetected",
  /** 交接文档落在这个路径（`params.path`） */
  handoffPath: "handoffPath",
  /** 迁移前把旧会话存进了存档（`params.sessionId` 是**旧**会话） */
  handoffArchived: "handoffArchived",
  /** 子 Agent 出错（`params.message` 是原始错误文本；`params.index` 是本轮序号） */
  subAgentFailed: "subAgentFailed",
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
  | GlobalNoticeEvent
  | SessionIdChangedEvent
  | SessionQuestionEvent
  | SubAgentStartedEvent
  | SubAgentEndedEvent;
