import type {
  AbortedMessageStrategy,
  AbortedToolRoundStrategy,
  AgentNS,
} from "@ai-zen/agents-core";
import type {
  AgentDefinition,
  McpServerConfig,
  TokenThresholds,
} from "@ai-zen/agents-sdk";

import type { Language } from "../i18n/index.js";
import type {
  AssetRef,
  AttachmentOutcome,
  ContextState,
  ConversationState,
  FolderFact,
  LocalizedText,
  MessageInput,
  ModelState,
  NoticeLevel,
  NoticeView,
  ProblemFact,
  QuestionState,
  QuestionView,
  RunState,
  SubAgentSnapshot,
  ThinkingState,
} from "./states.js";

/**
 * 方法表：方法名 → 入参 / 出参。
 *
 * 命名按 `<域>.<动作>`（architecture §6）。每一段前的注释写清它服务 PRD §4 的哪条能力
 * 编号，以及那条能力的落点为什么在宿主 —— 这是接线与前端对齐时唯一的索引。
 *
 * 两条贯穿全表的口径：
 *   1. 出参只给**结构化事实**，需要句子时给 `LocalizedText`；不把句子当数据结构（PRD §3 尺子 ④⑤）。
 *   2. 各域的「读」返回完整对象、「写」返回写后的完整对象，这样客户端拿到响应就能直接替换本地状态。
 *
 * 消息相关的出参用的就是 core 的类型：消息本体 `AgentNS.Message`、内容 `AgentNS.MessageContent` /
 * `AgentNS.MessageContentSection`、增量 `AgentNS.Delta`、用量 `AgentNS.Usage`。这里只包外壳
 * （哪个对话、哪个工作站、受理了什么）。
 */

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/** 协议版本：宿主与客户端同一版发布（PRD L1），版本号用来挡掉错配的连接 */
export const PROTOCOL_VERSION = "1";

/** 无入参的方法用这个类型；调用时 `params` 可以省 */
export type NoParams = Record<string, never>;

/** 客户端自报的身份（`hello` 带上来，用于连接列表与日志） */
export interface ClientInfo {
  /** 客户端名，如 `cli`、`desktop` */
  name: string;
  version: string;
  /** 运行平台（可选，仅供展示） */
  platform?: string;
}



/**
 * 一次删除的代价（PRD D11「删前明说代价」/ D17「先警告」/ F-F9「二次确认」）。
 *
 * 客户端把 `dryRun: true` 的结果摆给用户看，用户确认后再发一次真删 —— 代价是宿主算的
 * 账，客户端不需要自己拼。
 */
export interface RemovalConsequences {
  conversations: number;
  messages: number;
  assets: number;
}

/** 「还有谁引用它」：删除被拦住时列出引用者（PRD F-F2 / F-F5 / F-F7） */
export interface ReferenceList {
  /** 是否有引用（有则不能删） */
  referenced: boolean;
  /** 引用者：类型 + id + 显示名 */
  items: { kind: string; id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// host.*
// ---------------------------------------------------------------------------

/**
 * `hello` 入参（architecture §6：首帧 `hello`，凭证不放 URL 查询串）。
 *
 * `language` 挂在连接上、断开即忘（PRD D8）；缺省用配置里的默认语言。
 */
export interface HostHelloParams {
  token: string;
  /** 可选语言，认不出来回落默认语言（`normalizeLanguage`） */
  language?: string;
  clientInfo: ClientInfo;
}

/**
 * `hello` 出参。
 *
 * 除了握手成功本身，还把「这条连接以后说哪种语言」「宿主是什么版本」「附件上限是多少」
 * 一次给全：客户端连上就能把界面语言定下来（D8），也能在发图之前就知道上限（PRD D5）。
 *
 * 这里**不列能力**。曾经有过一份 `capabilities`，唯一的读者是 TUI 的 `/help`，而 `/help`
 * 本来就有一份本地命令表 —— 两份清单必然漂（宿主说「项目」、CLI 说「工作区」）。客户端
 * 需要什么事实就单独问，握手不背整张表。
 */
export interface HostHelloResult {
  /** 这条连接协商出的语言；后续这条连接上的文案都按它渲染 */
  language: Language;
  hostVersion: string;
  protocolVersion: string;
  /** 宿主进程启动时间 */
  startedAt: string;
  /** 附件上限等客户端要先知道的事实（PRD D5） */
  limits: TransferLimits;
}

/** 与传输有关的固定上限（PRD D5 / F-H8） */
export interface TransferLimits {
  /** 单张图片字节上限 */
  maxAssetBytes: number;
  /** 一条消息最多几张图片 */
  maxAssetsPerMessage: number;
}

/** `version` 出参：版本与运行事实（升级判定要用磁盘版本对比，PRD D4 / F-E3） */
export interface HostVersionResult {
  version: string;
  protocolVersion: string;
  startedAt: string;
  /** 进程 id（发现文件里也有，客户端排查时方便对齐） */
  pid: number;
}

/**
 * `upgrade` 入参。
 *
 * `targetVersion` 不传表示「升到磁盘上装好的那个版本」：宿主只读到磁盘版本变了就重启，
 * 不自己装包（PRD D4 / F-E3）。
 */
export interface HostUpgradeParams {
  targetVersion?: string;
}

/** `upgrade` 的三种结论：已经最新 / 已安排重启 / 没有可升的东西 */
export type HostUpgradeState = "already_latest" | "restart_scheduled" | "not_available";

/** `upgrade` 出参（PRD F-E3：确认升级真的完成后立即重启，不等在跑的轮次） */
export interface HostUpgradeResult {
  state: HostUpgradeState;
  /** 当前运行的版本 */
  currentVersion: string;
  /** 磁盘上的版本（读不到时为空） */
  diskVersion: string | null;
  /** 这次要升到的版本 */
  targetVersion: string | null;
}

/** `shutdown` 入参（PRD F-E1 里的「退出」能力） */
export interface HostShutdownParams {
  reason?: string;
}

/** `shutdown` 出参：已受理（进程随后按 L4 的条件收尾） */
export interface HostShutdownResult {
  accepted: boolean;
}

/**
 * `host.reload` 出参：与 `config.patch` 同一份形状（`config` + `applied`）。
 *
 * `config` 是重载之后读到的配置（密钥仍是掩码），`applied` 说明重载了什么、哪些项目的 Scope
 * 被回收（随后按需重建）、合成的那一条通知是谁。客户端因此可以用与改配置同一套提示。
 */
export interface HostReloadResult {
  config: ConfigView;
  applied: ConfigApplyReport;
}

/**
 * `setLanguage` 入参（PRD D8 / F-E4：`/lang` 是连接级动作）。
 *
 * 语言挂在连接上，所以这是「这条连接以后说哪种语言」，不是账号偏好。
 */
export interface HostSetLanguageParams {
  language: string;
}

/** `setLanguage` 出参 */
export interface HostSetLanguageResult {
  language: Language;
}

// ---------------------------------------------------------------------------
// workspace.*
// ---------------------------------------------------------------------------

/**
 * 一个 Workspace（PRD D9 / D12）。
 *
 * `folder.exists` 是「目录还在不在」这个事实；目录没了对话照常能看，是否只读由客户端判断（D12）。
 */
export interface WorkspaceView {
  id: string;
  name: string;
  /** cwd 不可变（PRD D9）：创建时定死，这里只读 */
  folder: FolderFact;
  createdAt: string;
  updatedAt: string;
  conversationCount: number;
  /** 最近一次有对话活动的时间（没有则为空） */
  lastActivityAt: string | null;
}

/** `workspace.list` 入参 */
export interface WorkspaceListParams {
  /** 是否连目录已不存在的也列出来（默认列，PRD D12：照常可看） */
  includeMissingFolders?: boolean;
}

/** `workspace.list` 出参（PRD D9 / D12） */
export interface WorkspaceListResult {
  workspaces: WorkspaceView[];
}

/**
 * `workspace.create` 入参（PRD D9 / D10）。
 *
 * `cwd` 可以是未登记的目录 —— 普通对话遇到未登记 cwd 时问一次要不要登记（D10），
 * 用户答「是」就走这个方法；`name` 不传则由目录名起一个可改的名字。
 */
export interface WorkspaceCreateParams {
  cwd: string;
  name?: string;
}

/** `workspace.create` 出参 */
export interface WorkspaceCreateResult {
  workspace: WorkspaceView;
}

/** `workspace.get` 入参 */
export interface WorkspaceGetParams {
  workspaceId: string;
}

/** `workspace.get` 出参 */
export interface WorkspaceGetResult {
  workspace: WorkspaceView;
}

/** `workspace.rename` 入参（名字可改，id 与 cwd 不变，PRD D9） */
export interface WorkspaceRenameParams {
  workspaceId: string;
  name: string;
}

/** `workspace.rename` 出参 */
export interface WorkspaceRenameResult {
  workspace: WorkspaceView;
}

/**
 * `workspace.remove` 入参（PRD D11 / F-F9）。
 *
 * `dryRun: true` 只算代价不动手，供客户端做二次确认；目录本身宿主不碰（D11）。
 */
export interface WorkspaceRemoveParams {
  workspaceId: string;
  dryRun?: boolean;
}

/** `workspace.remove` 出参 */
export interface WorkspaceRemoveResult {
  removed: boolean;
  consequences: RemovalConsequences;
}

// ---------------------------------------------------------------------------
// conversation.*
// ---------------------------------------------------------------------------

/**
 * 对话在列表里的样子（PRD F-C5 / D13）。
 *
 * `pinned` 与 `createdAt` 一起决定侧栏顺序：默认创建时间倒序、置顶优先；活动/打开/改名都不改顺序（D13）。
 */
export interface ConversationSummary {
  id: string;
  workspaceId: string;
  /** 可改的名字（PRD D1：改名不碰 id，名字是独立字段） */
  name: string;
  /** 名字还是「创建时间」这个原名，即用户没改过（PRD D2） */
  nameIsAuto: boolean;
  pinned: boolean;
  /** 这段对话的助手（创建时定死，PRD L7） */
  agentId: string;
  /** 这段对话现在用的模型（存会话行上，可改，PRD F-B4） */
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  /** 现在是否在跑一轮（PRD F-I3） */
  running: boolean;
  /**
   * 这段对话此刻的运行状态：`null` = 没在跑，在跑就是 `{ status: "running", startedAt }`。
   *
   * 与 `running` 是同一件事实的两种说法，但条目不重：活跃会话列表要按「什么时候开始的」
   * 排，而一个布尔说不出时间。`status` 用 `RunState` 的那一组取值（客户端不必为列表再造一套
   * 取值表），`startedAt` 是这一轮的开始时刻（与 `RunState.startedAt` 同口径）。
   *
   * 只有「此刻在跑」这一种情况会给出非 `null` 值：跑完的轮次在宿主里已经没有了（`RunRegistry`
   * 结算即删），那些历史事实在 `conversation.state` / `run.state` 里，不在列表里。
   */
  run: { status: RunState["status"]; startedAt: string | null } | null;
  /** 是否有问题挂着没答（PRD F-I9） */
  hasPendingQuestion: boolean;
}

/**
 * 一段对话的当前模型事实（PRD F-B4 / F-B8）。
 *
 * `source` 说这个模型是谁定的：`agent` = 助手定义上那个（这段会话没换过）；
 * `conversation` = 这段会话自己定的（创建时点名或 `conversation.setModel` 改过）。
 */
export type ConversationModelState = ModelState;

/** 一段对话的完整样子 */
/**
 * 这段对话的助手事实（PRD F-I6 的助手块要的就是这三格）。
 *
 * `agentId` 是这段对话的身份（创建时定死，L7）；`name` 与 `available` 现读助手定义得出
 * （`AgentService.describe`）。定义已经没了（助手被删，L7 允许对话留着旧 id）或文件读不出来时
 * 这两项都是 `null` —— 说「不知道」而不是编一个看起来像真的名字。
 */
export interface ConversationAgentState {
  agentId: string;
  name: string | null;
  available: boolean | null;
}

export interface ConversationView extends ConversationSummary {
  agent: ConversationAgentState;
  model: ConversationModelState;
  thinking: ThinkingState;
  /** 对话所属 Workspace 的目录事实（PRD D12） */
  folder: FolderFact;
}

/** `conversation.list` 入参（PRD F-C5 / D13：按 Workspace 列表、按置顶筛） */
export interface ConversationListParams {
  workspaceId?: string;
  /** true 只看置顶，false 只看未置顶，不传全要 */
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

/** `conversation.list` 出参：按侧栏顺序排好的结果 + 总数 */
export interface ConversationListResult {
  conversations: ConversationSummary[];
  total: number;
}

/**
 * `conversation.create` 入参（PRD F-A3「开新会话、别续接」/ F-C7 / D9 / D10 / L7）。
 *
 * 项目与助手在创建时定死（PRD L7）；模型先取助手定义上那个（也可在这里点名），之后归这段会话
 * —— 换它走 `conversation.setModel`，改「以后的对话」用哪个模型走 `agent.setModel`。
 *
 * 定位项目两条路（D10）：`workspaceId` 是「已经登记过的项目」；`cwd` 是从目录出发
 * —— 那个目录还没登记成项目时，宿主不建对话，而是问一次要不要登记（见出参）。
 */
export interface ConversationCreateParams {
  /** 已经登记的项目 id */
  workspaceId: string;
  agentId: string;
  /** 缺省用助手绑定的模型（PRD F-B1：模型真相在助手定义上） */
  modelId?: string;
}

/**
 * `conversation.create` 出参。
 *
 * 一定建出了草稿（R56：这行还没落库，首次 `send` 才写）。
 */
export interface ConversationCreateResult {
  conversation: ConversationView;
}

/** `conversation.get` 入参（PRD F-A6：宿主只提供「按 id 打开」） */
export interface ConversationGetParams {
  conversationId: string;
}

/** `conversation.get` 出参 */
export interface ConversationGetResult {
  conversation: ConversationView;
}

/** `conversation.state` 入参（PRD L5：重连先拉状态） */
export interface ConversationStateParams {
  conversationId: string;
  /**
   * 连消息本体一起回（默认 `false`）。
   *
   * 客户端打开一段对话时本来就要「现场 + 消息」两件事，分两次调会在两份快照之间留一道缝
   * （第二次请求发出前又落了一条消息，现场说的用量就对不上消息）；带上这个开关一次拿齐。
   * 只要现场、不要消息的调用方（状态栏轮询）不必为消息付费。
   */
  includeMessages?: boolean;
}

/** `conversation.state` 出参：一段对话的现场（六态、阈值、问题、用量、状态栏块） */
export interface ConversationStateResult {
  state: ConversationState;
  /**
   * `includeMessages: true` 时的整段消息，与 `message.list` 同一形状、同一顺序（含流式中那条的最新内容）。
   * 没要的时候这个键不出现 —— 不是空数组，空数组的含义是「对话里没有消息」。
   */
  messages?: AgentNS.Message[];
}

/** `conversation.rename` 入参（PRD D1 / F-C3：改名不改身份、不改排序） */
export interface ConversationRenameParams {
  conversationId: string;
  name: string;
}

/** `conversation.rename` 出参 */
export interface ConversationRenameResult {
  conversation: ConversationView;
}

/** `conversation.pin` 入参（PRD F-C5 / D13：手动置顶） */
export interface ConversationPinParams {
  conversationId: string;
  pinned: boolean;
}

/** `conversation.pin` 出参 */
export interface ConversationPinResult {
  conversation: ConversationView;
}

/**
 * `conversation.delete` 入参（PRD F-C10 / D17 / F-F9）。
 *
 * 硬删，图片按引用清理；`dryRun: true` 先算代价，供「删除前警告」使用。
 */
export interface ConversationDeleteParams {
  conversationId: string;
  dryRun?: boolean;
}

/** `conversation.delete` 出参 */
export interface ConversationDeleteResult {
  removed: boolean;
  consequences: RemovalConsequences;
}

/**
 * `conversation.send` 入参（PRD F-C2 / L6 / D14 / F-H7 / F-D10）。
 *
 * 一轮的开始：宿主先占位（在跑则 `busy`），再分配用户消息与助手消息的 id（L6：助手消息 id
 * 在请求发出之前就有），然后开始流式。用户输入用 core 的内容形状（`MessageInput`），
 * 图片的传输路径由宿主定（F-H7）。
 * 有问题在挡着这段对话时会被拒（`question_pending`，D23 / F-D10）。
 */
export interface ConversationSendParams {
  conversationId: string;
  input: MessageInput;
}

/**
 * `conversation.send` 出参：受理即返回两个 id（PRD F-I12：受理了就不会静默丢）。
 *
 * `attachments` 说明每个附件最后是怎么走的（文件引用 / 内联 / 退化成文字 / 没发出去），
 * 失败与降级都带原因，拿不到结果时不报成功（F-H7）。
 */
export interface ConversationSendResult {
  userMessageId: string;
  assistantMessageId: string;
  attachments: AttachmentOutcome[];
  acceptedAt: string;
}

/**
 * `conversation.abort` 入参（PRD D14：中止是用户的显式动作，不排队、不自动打断）。
 */
export interface ConversationAbortParams {
  conversationId: string;
  reason?: string;
}

/** `conversation.abort` 出参：中止后的运行状态（`aborted: false` 表示本来就没在跑） */
export interface ConversationAbortResult {
  aborted: boolean;
  run: RunState;
}

/**
 * `conversation.revert` 入参（PRD F-C8 / D24）。
 *
 * 撤回到某条用户消息**之前**：其后消息硬删，被撤回的内容回填输入框（回填内容由宿主给事实）。
 */
export interface ConversationRevertParams {
  conversationId: string;
  /** 撤回点：这条用户消息及其之后的内容都会被删 */
  beforeMessageId: string;
}

/** `conversation.revert` 出参 */
export interface ConversationRevertResult {
  /** 被删掉的消息 id（按原顺序） */
  removedMessageIds: string[];
  /** 回填到输入框的内容（core 的内容形状 + 素材引用，PRD F-C8） */
  restoredInput: MessageInput;
}

/**
 * `conversation.setModel` 入参（PRD F-B4 / F-B8 / D20）。
 *
 * 换的是**这段会话**的模型：写完就落库，重开、重启都还是它；换模型同时把这段会话的
 * 思考档位清成「跟随助手默认」（档位属于模型）。历史里有图而新模型读不了图时拒绝
 * （业务码 `model_unsupported`）。改助手默认模型是另一个动作，见 `agent.setModel`。
 */
export interface ConversationSetModelParams {
  conversationId: string;
  /** `null` 表示回到助手定义上那个模型 */
  modelId: string | null;
}

/** `conversation.setModel` 出参 */
export interface ConversationSetModelResult {
  conversation: ConversationView;
  model: ConversationModelState;
  /** 换模型后上下文占用要重算（阈值跟着模型走，PRD D27） */
  context: ContextState;
}

/**
 * `conversation.setThinking` 入参（PRD F-B6 / F-B7）。
 *
 * 改的是**这段会话**的思考档位：档位名落库，装配 agent 时按当前模型的思考策略表展开成
 * 参数补丁。与 `agent.setThinking`（改助手的默认）分开。
 */
export interface ConversationSetThinkingParams {
  conversationId: string;
  /** 档位名（来自 `ThinkingState.levels`）；`null` = 回到跟随助手默认 */
  level: string | null;
}

/** `conversation.setThinking` 出参：展开后的参数与来源（PRD F-B7） */
export interface ConversationSetThinkingResult {
  thinking: ThinkingState;
}

/**
 * `conversation.transient` 入参（PRD F-A2 / D3：临时对话）。
 *
 * 一次请求跑一轮、结果返回后内存清空：无 id、不可 attach、不入库、不进列表；只借 Scope，
 * 与 Workspace 无关，所以这里要显式的 `cwd` 而不是 `workspaceId`。
 */
export interface ConversationTransientParams {
  /** 这一轮在哪个目录里跑（相对路径的解析基准） */
  cwd: string;
  input: MessageInput;
  agentId?: string;
  modelId?: string;
}

/**
 * `conversation.transient` 出参：这一轮产出的那条助手消息（不产生任何可回看的 id）。
 *
 * 内容、思考、工具调用、结束原因、用量都在 core 的 `AgentNS.Message` 上；要「这一轮一共花了
 * 多少」用 core 的 `sumUsage([message])`（它把自身用量与子 Agent 用量一起算）。
 */
export interface ConversationTransientResult {
  /** 这一轮产出的助手消息，core 原样 */
  message: AgentNS.Message;
  subagents: SubAgentSnapshot[];
  problem: ProblemFact | null;
}

// ---------------------------------------------------------------------------
// message.*
// ---------------------------------------------------------------------------

/**
 * `message.list` 入参（architecture A12 / PRD L5 / F-I7 / F-C6）。
 *
 * - 不给 `after`、也不给 `around`：返回这段对话的全部消息；
 * - 给了 `after` 且该 id 存在：**从这条开始**（含它本身，内容是**最新**的）+ 其后全部；
 * - 给了 `after` 但该 id 不存在：返回全部。
 *
 * `around` 是另一条取法（PRD F-C6 的定位）：**以某条消息为中心取一窗**，见下。
 *
 * 「从这条开始而不是它的下一条」是故意的：重连的客户端上次拿到的最后一条可能正是流式中那条，
 * 它的内容已经变了；从它自己重新拿，就天然是「最新内容 + 之后的」。
 *
 * `toolCallId` 用来取某个子 Agent 自己的消息（PRD F-I7：子 Agent 的消息可回看）。
 *
 * `hidden` 的消息（会话创建时那条 cwd 消息、交接摘要）默认**不返回**：core 的 `hidden` 就是
 * 「这条不给人看」。要它们就显式要（`includeHidden: true`）。
 */
export interface MessageListParams {
  conversationId: string;
  after?: string;
  toolCallId?: string;
  /**
   * 定位取窗（PRD F-C6）：以这条消息为中心取一窗，供客户端把搜索命中的那条摆到眼前。
   *
   * **消费者是桌面端的搜索命中跳转（PLAN W4）**：`search.messages` 给了一条命中，桌面端拿着它的
   * `messageId` 调 `message.list({ around })` 就能直接渲染命中那条附近的一段对话。
   *
   * 只在一种情形下有一种解释：
   *   - 命中（这条在这段对话里、且在本次可见集里）：返回以它为中心的一窗（默认 40 条，
   *     见 `MessageService` 的 `AROUND_WINDOW`；前后尽量均分，命中那条一定在里面），
   *     `anchor` 报成它；
   *   - 没命中（已撤回 / 换过库 / 是 `hidden` 而这次没要 `includeHidden`）：**空页**
   *     （`messages: []`、`anchor: null`），**不报错** —— 消息可能刚被撤回，那不是一次失败的请求；
   *   - 与 `after` 同时给：**`around` 优先，`after` 被忽略**。两者是两种取法（一个「从这里往下」、
   *     一个「围绕这里」），混在一起没有唯一答案，所以只认 `around`；
   *   - 与 `toolCallId` 同时给：`toolCallId` 决定读哪一段消息（子 Agent 自己那一段），`around`
   *     只在这一段里定位 —— 与 `after` 无关。
   */
  around?: string;
  /** 连 `hidden` 的消息一起返回（默认 false） */
  includeHidden?: boolean;
}

/**
 * `message.list` 出参：消息本体就是 core 的 `AgentNS.Message`，这里只包一层定位外壳。
 *
 * 顺序即对话里的先后顺序；「这条是否还在上下文里」看消息自己的 `omit`，「这条是不是不给人看」
 * 看 `hidden`（PRD F-D9），内容与工具调用看 `content` / `tool_calls` / `reasoning_content`。
 */
export interface MessageListResult {
  conversationId: string;
  /**
   * 被 `after` / `around` 命中的那条消息 id（没命中或没给则为空）。
   *
   * 客户端据此判断这是全量还是续传、以及这次 `around` 找没找到（`around` 没命中时是空页 + `null`）。
   */
  anchor: string | null;
  messages: AgentNS.Message[];
}

// ---------------------------------------------------------------------------
// question.*
// ---------------------------------------------------------------------------

/** `question.list` 入参（PRD D22：多端看到同一个问题） */
export interface QuestionListParams {
  conversationId?: string;
  /** 只看某个状态；不传则全部 */
  state?: QuestionState;
}

/** `question.list` 出参 */
export interface QuestionListResult {
  questions: QuestionView[];
}

/**
 * `question.answer` 出参里的后续动作（PRD D22：答完就接着往下走，客户端不必再发一次请求）。
 */
export interface QuestionEffects {
  /** 这道题答完后开始交接（D22：交接在对话停下之后触发） */
  handoffStarted: boolean;
  /** 交接顺带开出来的新对话（PRD D18：同 Workspace、同助手） */
  newConversationId: string | null;
}

/** `question.answer` 入参（PRD D22 / F-I9：问题能被回答） */
export interface QuestionAnswerParams {
  questionId: string;
  /** 候选里的值（`QuestionView.options[].value`） */
  value: string;
}

/** `question.answer` 出参 */
export interface QuestionAnswerResult {
  question: QuestionView;
  effects: QuestionEffects;
}

// ---------------------------------------------------------------------------
// notice.*
// ---------------------------------------------------------------------------

/** `notice.list` 入参（PRD L3 / F-I8：通知是独立通道，持久化、可手动清） */
export interface NoticeListParams {
  conversationId?: string;
  level?: NoticeLevel;
}

/** `notice.list` 出参 */
export interface NoticeListResult {
  notices: NoticeView[];
}

/** `notice.dismiss` 入参：清掉一条 */
export interface NoticeDismissParams {
  noticeId: string;
}

/** `notice.dismiss` 出参 */
export interface NoticeDismissResult {
  dismissed: boolean;
}

/** `notice.clear` 入参：清掉一批（不给 `conversationId` 就清全部） */
export interface NoticeClearParams {
  conversationId?: string;
}

/** `notice.clear` 出参 */
export interface NoticeClearResult {
  cleared: number;
}

// ---------------------------------------------------------------------------
// config.*
// ---------------------------------------------------------------------------

/** 端点：密钥掩码显示（PRD F-F2） */
export interface EndpointView {
  id: string;
  name: string;
  baseUrl: string;
  /** 掩码后的密钥，例如 `sk-…9f3a`；明文不出网 */
  apiKeyMasked: string;
  /** 是否配了密钥（PRD F-A7 的「这个端点配好了没」） */
  apiKeySet: boolean;
  description: string | null;
  capabilities: { filesApi: boolean };
}

/**
 * 端点写入（PRD F-F2）。
 *
 * `apiKey` 省略表示「保留原密钥」：读出来的密钥是掩码（`sk-…9f3a` 这种值），回写它会把掩码
 * 当成密钥存起来，所以「不改密钥」用省略表达，而不是传空串。
 */
export interface EndpointInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  description?: string;
  capabilities?: { filesApi?: boolean };
}

/** 模型：编辑即转自定义，恢复出厂是整条替换（PRD F-F3） */
export interface ModelView {
  id: string;
  name: string;
  endpointId: string;
  /** 发给 API 的模型名（不填则用 id） */
  modelName: string | null;
  /** 两条阈值（PRD F-D1 / D27：交接线与硬线） */
  tokenThresholds: TokenThresholds;
  defaultParams: Record<string, unknown>;
  /** 思考策略名 */
  reasoningPreset: string | null;
  /** 这个策略下可选的档位名（PRD F-B7：能不能调、能调哪几档） */
  thinkingLevels: string[];
  /** 能不能看图（PRD D20 / F-B8） */
  vision: boolean;
  description: string | null;
  /** 是不是用户自定义的（false = 出厂托管，PRD F-F3） */
  custom: boolean;
  /** 现在能不能用；不能用时 `unavailableReason` 说明原因（PRD F-B5） */
  available: boolean;
  unavailableReason: LocalizedText | null;
}

/** 模型写入（PRD F-F3） */
export interface ModelInput {
  id: string;
  name: string;
  endpointId: string;
  modelName?: string;
  /**
   * 两条上下文阈值。**省略 = 用出厂默认**（SDK `DEFAULT_APP_CONFIG` 里那份），不是「不设阈值」：
   * 没有阈值的模型既不会触发交接、也没有硬线保护。
   *
   * `model.create` 省略时套出厂默认；`model.update` 省略时不动（局部更新的既有语义）。
   */
  tokenThresholds?: TokenThresholds;
  defaultParams?: Record<string, unknown>;
  reasoningPreset?: string;
  vision?: boolean;
  description?: string;
}

/** 图片模型（PRD F-F4 / D6） */
export interface ImageModelView {
  id: string;
  name: string;
  endpointId: string;
  modelName: string;
  description: string | null;
  defaultSize: string | null;
  defaultQuality: string | null;
  custom: boolean;
}

/** 图片模型写入（PRD F-F4） */
export interface ImageModelInput {
  id: string;
  name: string;
  endpointId: string;
  modelName: string;
  description?: string;
  defaultSize?: string;
  defaultQuality?: string;
}

/**
 * 默认项（PRD F-F7 / D2 / D6）。
 *
 * 模型只有一个真相源在助手定义上（PRD F-B1），这里的 `defaultModel` 是 SDK 的兜底那一层，
 * 只在助手没绑模型时起作用。`language` 是这一组里唯一的非「选哪个实体」项：它是缺省语言
 * （裁定 R58），与 SDK `AppConfig.language` 同源。
 */
export interface DefaultSelection {
  /** 默认助手（PRD F-B3 / F-B5） */
  defaultAgent: string | null;
  /** 兜底模型（助手没绑模型时才用） */
  defaultModel: string | null;
  /** 默认迁移模型（PRD F-F7） */
  defaultMigrationModel: string | null;
  /** 默认图片模型（PRD F-F7 / D6） */
  defaultImageModel: string | null;
  /** 自动命名用的「取名模型」（PRD D2） */
  namingModel: string | null;
  /** 自动命名开关（PRD D2：带独立开关） */
  autoTitle: boolean;
  /**
   * 缺省语言（PRD D8 / 裁定 R58）：`hello` 没声明语言时算哪一种。
   *
   * 它不是「这个客户端现在用哪种语言」（那是连接的事，断开即忘），而是「没声明时用哪一种」。
   * 省略 = 这次不改；写 `null` = 清掉这一项（回落英文）；`config.get` 读回时没设置就是 `null`。
   */
  language?: Language | null;
}

/** 配置层面的上限（PRD F-F8 / D5） */
export interface ConfigLimits {
  /** 工具输出上限（字符数，PRD F-F8） */
  maxToolOutput: number;
  maxAssetBytes: number;
  maxAssetsPerMessage: number;
}

/** 中断修复与工具刷新的行为开关（SDK 口径，宿主只做透传与生效） */
export interface ConfigBehavior {
  /** 被中断的助手消息怎么处置（PRD D15 的修复口径） */
  abortedMessageStrategy: AbortedMessageStrategy;
  /** 被中断的工具轮次怎么归一（PRD D15） */
  abortedToolRoundStrategy: AbortedToolRoundStrategy;
  /** 每轮刷新工具的时机（PRD F-E2：改完配置即生效的那条链） */
  autoRefreshTools: "off" | "outer-loop-start" | "inner-loop-start";
}

/** 整个配置的只读形状（PRD F-F1：一处管完所有配置；密钥掩码，PRD F-F2） */
export interface ConfigView {
  endpoints: EndpointView[];
  models: ModelView[];
  imageModels: ImageModelView[];
  defaults: DefaultSelection;
  limits: ConfigLimits;
  behavior: ConfigBehavior;
  /** 配置文件所在目录（数据根），便于用户知道改的是哪一份 */
  configDir: string;
}

/**
 * 一条配置问题（PRD F-A8：配错了要能当场修 —— 宿主给结构化原因）。
 *
 * `path` 指到具体字段（如 `models[2].endpointId`），客户端据此把光标放到那一栏。
 */
export interface ConfigIssue {
  severity: "error" | "warning";
  /** 稳定码，客户端据此分支 */
  code: string;
  text: LocalizedText;
  /** 出问题的字段路径 */
  path: string | null;
}

/** `config.get` 入参 */
export type ConfigGetParams = NoParams;

/** `config.get` 出参（PRD F-F1 / D21：配置的读写都走宿主 API） */
export interface ConfigGetResult {
  config: ConfigView;
  /** 现在读到的这份配置有没有问题（有问题时相关动作会以 `config_invalid` 拒绝） */
  issues: ConfigIssue[];
}

/**
 * 配置写入（PRD F-F1 / D21：改完即生效，没有全局「保存」键）。
 *
 * 端点、模型、助手各有自己的写方法（它们要做引用检查与掩码处理）；这里管的是
 * 默认项、上限与行为开关这些「散落的小设置」。
 */
export interface ConfigPatch {
  defaults?: Partial<DefaultSelection>;
  limits?: Partial<Pick<ConfigLimits, "maxToolOutput">>;
  behavior?: Partial<ConfigBehavior>;
}

/**
 * 改完配置后「做了什么」（PRD F-E2：改完不用重启就生效）。
 *
 * 哪些东西被重载、哪些 Scope 被回收重连 MCP，都作为事实回报 —— 界面据此提示「已生效」，
 * 用户不必去猜要不要重启。
 */
export interface ConfigApplyReport {
  appliedAt: string;
  reloaded: {
    config: boolean;
    tools: boolean;
    skills: boolean;
    agents: boolean;
    mcp: boolean;
  };
  /** 因为配置变化被回收（随后会重建）的 Workspace Scope */
  recycledWorkspaceIds: string[];
  /** 是否还需要重启才生效（配置变更走重连，PRD F-E2） */
  restartRequired: boolean;
  /** 这次改动合成的一条通知（PRD F-F9：一次改动合成一条通知） */
  noticeId: string | null;
}

/** `config.patch` 入参 */
export interface ConfigPatchParams {
  patch: ConfigPatch;
}

/** `config.patch` 出参 */
export interface ConfigPatchResult {
  config: ConfigView;
  applied: ConfigApplyReport;
}

/** `config.setDefaults` 入参（PRD F-F7 / D2 / D6） */
export interface ConfigSetDefaultsParams {
  defaults: Partial<DefaultSelection>;
}

/** `config.setDefaults` 出参 */
export interface ConfigSetDefaultsResult {
  config: ConfigView;
  applied: ConfigApplyReport;
}

/**
 * `config.saveEndpoint` 入参（PRD F-F2）。
 *
 * 同一个方法兼创建与修改：`id` 已存在则改，不存在则建。密钥省略表示保留原值。
 */
export interface ConfigSaveEndpointParams {
  endpoint: EndpointInput;
}

/** `config.saveEndpoint` 出参 */
export interface ConfigSaveEndpointResult {
  endpoint: EndpointView;
  applied: ConfigApplyReport;
}

/**
 * `config.deleteEndpoint` 入参（PRD F-F2：被引用时禁删并列出引用者）。
 *
 * 被模型引用时以 `config_invalid` 拒绝，`detail.references` 里列出「还有谁指它」+
 * 「我该先做什么」。
 */
export interface ConfigDeleteEndpointParams {
  endpointId: string;
  dryRun?: boolean;
}

/** `config.deleteEndpoint` 出参 */
export interface ConfigDeleteEndpointResult {
  removed: boolean;
  references: ReferenceList;
}

/** 发现的种类（PRD F-G1 / F-G2：MCP 5 层链、Skill 4 层、工具与子 Agent 各 2 层） */
export type DiscoveryKind = "mcps" | "skills" | "tools" | "subagents";

/**
 * MCP 的 oauth 视图：形状就是 SDK 的 `McpServerConfig["oauth"]`，只把密钥那一项换掉。
 *
 * `clientSecret` → `clientSecretMasked` + `clientSecretSet`，与 `EndpointView` 的
 * `apiKeyMasked` / `apiKeySet` 完全同一套口径（F-F2：明文不出网）。掩码由宿主用同一个函数
 * 生成（`services/secretMask.ts` 的 `maskSecret`），客户端只负责显示。
 */
export type McpOauthView = Omit<NonNullable<McpServerConfig["oauth"]>, "clientSecret"> & {
  /** 掩码后的密钥，例如 `abc…9f3a`；没配时为 `""` */
  clientSecretMasked: string;
  /** 是否配了密钥（配了才有东西需要保管） */
  clientSecretSet: boolean;
};

/**
 * 发现出来的一个条目（PRD F-F6：条目字段齐全）。
 *
 * MCP 条目把「这条服务器是怎么起的」整份摊开：传输方式与它的参数（命令 / 参数 / 环境变量 /
 * 地址 / 请求头），这样客户端不必凭 `id` 重建一条就能改它（F-F6「按 id 增删改」）。
 * 已知字段的形状就是 SDK 的 `McpServerConfig`；`extra` 收留这一版不认识的键，
 * 客户端原样带回（F-F6「未知字段原样保留」）。唯一的例外是 oauth 的 `clientSecret`：
 * 它跟端点密钥一样只给掩码（{@link McpOauthView}，F-F2）。
 *
 * 只有启用状态留了一个开关：视图给 `enabled`，写入端收 SDK 的 `disabled`，两者互为取反。
 *
 * 非 MCP 的那三类（Skill / 工具 / 子 Agent）没有传输这一层：那几个字段恒为 `null`、`extra` 恒为
 * `Record` 里的空对象。
 */
export interface DiscoveryEntryView {
  id: string;
  name: string;
  description: string | null;
  /** 来自哪个文件/目录 */
  source: string;
  /**
   * 是否启用（= SDK `McpServerConfig.disabled` 取反；其它种类目前恒为 true）。
   *
   * CLI 的 MCP 详情屏用它画「启用 / 已禁用」那一行，写入时折回 `disabled`。
   */
  enabled: boolean;
  /** 条目自身的问题（如 MCP 连不上，PRD F-F6） */
  problem: ProblemFact | null;
  /**
   * 传输方式（`stdio` / `http` / `sse`）；文件里没有、也推不出来时为 `null`。
   *
   * CLI 的 MCP 列表与详情屏据此决定显示命令还是地址（`mcp-helpers.ts`），
   * 并把整条错误条目修成能用的那一条。
   */
  transport: McpServerConfig["transport"] | null;
  /** stdio：起什么程序 */
  command: string | null;
  /** stdio：程序参数 */
  args: string[] | null;
  /** stdio：环境变量 */
  env: Record<string, string> | null;
  /** http / sse：地址 */
  url: string | null;
  /** http / sse：请求头 */
  headers: Record<string, string> | null;
  /**
   * oauth 配置（http）：{@link McpOauthView}，`clientSecret` 只给掩码。
   *
   * 消费者是 CLI 的 MCP 详情屏（`step-mcp.tsx` 把它渲染成一行「客户端密钥：sk-…9f3a」）。
   * 回写时 `clientSecret` 省略 = 保留磁盘原值（与 `config.saveEndpoint` 的 `apiKey` 同口径）。
   */
  oauth: McpOauthView | null;
  /**
   * 这一版不认识的键（原样一条不多一条不少）。
   *
   * CLI 的 `mcp-helpers.ts` 把它塞回 `McpServerEntryInput.extra`，写回时逐字带回（F-F6）。
   */
  extra: Record<string, unknown>;
}

/**
 * 一层发现来源（PRD F-G1 / F-G2 / F-F6）。
 *
 * `state` 把「文件不存在」与「文件坏了」分开（PRD F-F6：以前都当空配置，一保存就覆盖）；
 * `editable` 说明这一层能不能写 —— MCP 是 5 层链但只有 2 个作用域可编辑（PRD F-G1）。
 */
export interface DiscoveryLayerView {
  kind: DiscoveryKind;
  /** 层序：0 最靠近项目，数字越大越远（合并时近的优先） */
  depth: number;
  /** 这一层对应的文件或目录绝对路径 */
  path: string;
  editable: boolean;
  /**
   * 这一层归哪个可编辑作用域；写不了（或不是 MCP）时为 `null`（PRD F-G1 / F-F6）。
   *
   * 客户端拿它直接认「哪一层是 `user`、哪一层是 `workspace`」，不必按 `editable` + `depth`
   * 反推（CLI 的 `/mcp` 入口与 MCP 屏都按它取层）。
   */
  scope: McpEditableScope | null;
  state: "missing" | "ok" | "broken";
  /** 坏在哪（`state === "broken"` 时给） */
  problem: ProblemFact | null;
  entries: DiscoveryEntryView[];
}

/**
 * 一份完整的发现视图（PRD F-G2 / F-F6 / F-G1）。
 *
 * 客户端拿它渲染「MCP 屏 / Skill 屏 / 工具屏 / 子 Agent 屏」，也能看见坏掉的配置文件。
 */
export interface DiscoveryView {
  workspaceId: string | null;
  mcps: DiscoveryLayerView[];
  skills: DiscoveryLayerView[];
  tools: DiscoveryLayerView[];
  subagents: DiscoveryLayerView[];
}

/** `config.getDiscovery` 入参 */
export interface ConfigGetDiscoveryParams {
  /** 给了就带上这一层的 Workspace 侧来源 */
  workspaceId?: string;
}

/** `config.getDiscovery` 出参 */
export interface ConfigGetDiscoveryResult {
  discovery: DiscoveryView;
}

/** MCP 可编辑的两个作用域（PRD F-G1：只有 2 个） */
export type McpEditableScope = "user" | "workspace";

/**
 * MCP 条目写入（PRD F-F6：字段齐全、`oauth` 与未知字段原样保留）。
 *
 * SDK 的 `McpServerConfig` 覆盖已知字段；`extra` 收留这个版本不认识的键，写回时原样带上。
 * 与 {@link DiscoveryEntryView} 是同一份事实的两个方向：视图用 `enabled`，这里用 SDK 的
 * `disabled`；视图里 `null` 的字段在这边省略即可（省略 = 这一项不动）。
 *
 * `oauth.clientSecret` 与 `config.saveEndpoint` 的 `apiKey` 同口径（F-F2）：
 *   - 省略 → 保留磁盘原值（这是「不改密钥」的唯一写法）；
 *   - 传回来的值正好等于当前掩码（`clientSecretMasked`）→ 当作没改，同样保留原值；
 *   - 空串 → 把密钥清掉。
 * 于是「客户端把掩码当密钥写回去」不会发生。`oauth` 里其余几项给了就覆盖。
 */
export type McpServerEntryInput = McpServerConfig & {
  extra?: Record<string, unknown>;
};

/**
 * `config.saveMcp` 入参（PRD F-F6：按 id 增删改）。
 *
 * 形状与 `config.saveEndpoint` 对齐：`entry.id` 已在这一层里就改那一条，没有就建。
 * 一次只动一条 —— 客户端因此不必先读整层再拼回去，也不会因为有一条读不全就把别的条目覆盖掉。
 */
export interface ConfigSaveMcpParams {
  scope: McpEditableScope;
  /** `scope === "workspace"` 时必填 */
  workspaceId?: string;
  entry: McpServerEntryInput;
}

/** `config.saveMcp` 出参：写回后的那一层（含坏文件状态是否已修好） */
export interface ConfigSaveMcpResult {
  layer: DiscoveryLayerView;
  applied: ConfigApplyReport;
}

/**
 * `config.deleteMcp` 入参（PRD F-F6：另有一条删除）。
 *
 * `id` 本来就不在这一层里时不算失败：`removed: false` 如实回答「本来就没有」，
 * 与 `config.deleteEndpoint` 的 `removed` 同口径（「本来就没有」不是错误）。
 */
export interface ConfigDeleteMcpParams {
  scope: McpEditableScope;
  /** `scope === "workspace"` 时必填 */
  workspaceId?: string;
  id: string;
}

/** `config.deleteMcp` 出参：删完之后的那一层 + 到底删掉了没有 */
export interface ConfigDeleteMcpResult {
  layer: DiscoveryLayerView;
  applied: ConfigApplyReport;
  removed: boolean;
}

// ---------------------------------------------------------------------------
// agent.*
// ---------------------------------------------------------------------------

/**
 * 助手的样子（PRD F-B2 / F-B5 / F-B7 / F-B1）。
 *
 * 提示词 + 模型 + 权限四维（tools / skills / mcps / subagents）+ 自定义标记，形状沿用 SDK；
 * 不可用的助手也列出来并说明原因（F-B5：「藏起来」会让人以为它没了）。
 *
 * 提示词（`messages`）与子 Agent 定义（`function`）也在视图里：`agent.update` 收得到它们，
 * 视图就必须读得回来，否则「能写不能读」等于编辑不了助手定义（F-F5）。
 */
export interface AgentView {
  id: string;
  name: string;
  description: string | null;
  /** 这个助手默认用哪个模型（PRD F-B1：模型只有这一个真相源） */
  modelId: string | null;
  /** 助手级模型参数覆盖（思考强度写在这里，PRD F-B6） */
  modelParams: Record<string, unknown>;
  permissions: AgentDefinition["permissions"] | null;
  /**
   * 提示词（预设对话），形状就是 SDK 的 `AgentDefinition["messages"]`（PRD F-B2 / F-F5）。
   *
   * 定义是「能写就能读」的：这份原样交给 `agent.update` 的 `messages` 等于没改。
   * 定义文件读不出来时是 `null` —— 那时没有「它的提示词是什么」这个事实可说。
   * 文件读得出来但里面没写 `messages` 时也是 `null`：`null` 只表示「没有这份提示词」，
   * 不区分是文件缺了还是字段缺了（要分清就去看 `agent.get` 报没报问题）。
   */
  messages: AgentDefinition["messages"] | null;
  /**
   * 子 Agent 的函数定义，形状沿用 SDK 的 `AgentDefinition["function"]`（PRD F-B2 / F-F5）。
   *
   * 非子 Agent 为 `null`；定义文件读不出来时也是 `null`。
   */
  function: AgentDefinition["function"] | null;
  /** 有 `function` 字段即子 Agent（PRD F-B2） */
  isSubAgent: boolean;
  /** 是不是用户自定义的（PRD F-G3：一实体一文件，可进 git、可手改） */
  custom: boolean;
  /** 是不是当前的默认助手（PRD F-B3） */
  isDefault: boolean;
  available: boolean;
  /** 不可用的原因（PRD F-B5：要说明原因，不是藏起来） */
  unavailableReason: LocalizedText | null;
  /** 思考强度的当前状态与可选档位（PRD F-B7） */
  thinking: ThinkingState;
  createdAt: string;
  updatedAt: string;
}

/** 助手写入（PRD F-B2 / F-G3） */
export interface AgentInput {
  id: string;
  name: string;
  description?: string;
  /** 预设对话（至少一条 system） */
  messages: AgentDefinition["messages"];
  modelId?: string;
  modelParams?: Record<string, unknown>;
  permissions?: AgentDefinition["permissions"];
  /** 有则视为子 Agent */
  function?: AgentDefinition["function"];
}

/** `agent.list` 入参 */
export interface AgentListParams {
  /** 给了就把「在这个项目里能不能用」一起算进去 */
  workspaceId?: string;
}

/** `agent.list` 出参（PRD F-B2 / F-B3 / F-B5） */
export interface AgentListResult {
  agents: AgentView[];
  /** 默认助手 id（PRD F-B3：有默认，为空时有回落） */
  defaultAgentId: string | null;
}

/** `agent.get` 入参 */
export interface AgentGetParams {
  agentId: string;
}

/** `agent.get` 出参 */
export interface AgentGetResult {
  agent: AgentView;
}

/** `agent.create` 入参 */
export interface AgentCreateParams {
  agent: AgentInput;
}

/** `agent.create` 出参 */
export interface AgentCreateResult {
  agent: AgentView;
}

/** `agent.update` 入参（局部更新） */
export interface AgentUpdateParams {
  agentId: string;
  patch: Partial<AgentInput>;
}

/** `agent.update` 出参 */
export interface AgentUpdateResult {
  agent: AgentView;
}

/**
 * `agent.delete` 入参（PRD F-F5：删之前问「还有谁指它」；删默认助手时连带清默认）。
 */
export interface AgentDeleteParams {
  agentId: string;
  dryRun?: boolean;
}

/** `agent.delete` 出参 */
export interface AgentDeleteResult {
  removed: boolean;
  references: ReferenceList;
  /** 默认助手指向是否被清掉（PRD F-F5） */
  defaultsCleared: boolean;
}

/**
 * `agent.setModel` 入参（PRD F-B4 / F-B1：改助手默认模型，影响以后的对话）。
 *
 * 与 `conversation.setModel`（改这一段会话的模型、存会话行）是两个动作、两个入口。
 */
export interface AgentSetModelParams {
  agentId: string;
  modelId: string;
}

/** `agent.setModel` 出参 */
export interface AgentSetModelResult {
  agent: AgentView;
}

/**
 * `agent.setThinking` 入参（PRD F-B6：写入的是参数不是档位名）。
 *
 * 档位在这里被展开成具体参数写进 `AgentDefinition.modelParams`，之后运行时不再查表。
 * `level: null` 是撤回设值：把定义里的思考参数删掉，助手的思考回到「参数即真相」的那份来源
 * （模型的默认参数），`ThinkingState.source` 跟着回落到 `following_default`。
 *
 * 与会话那一侧的 `conversation.setThinking(null)` 是两件事：那边改的是会话行上的档位名
 * （这段对话回到跟随助手定义），这边改的是**助手的定义文件**（以后的对话都跟着变）。
 */
export interface AgentSetThinkingParams {
  agentId: string;
  /** 档位名（来自 `ThinkingState.levels`）；`null` = 删掉定义上的思考参数 */
  level: string | null;
}

/** `agent.setThinking` 出参 */
export interface AgentSetThinkingResult {
  agent: AgentView;
  thinking: ThinkingState;
}

/**
 * `agent.restoreFactory` 入参（PRD F-F5：与 `model.restoreFactory` 同族，可以先预演不落盘）。
 *
 * 只是同族不是同形：模型那边没有 `dryRun`，也没有 `restored`。
 *
 * 只有出厂清单里的助手（SDK 的出厂定义）才有「出厂版本」可恢复；恢复是整条替换，
 * 引用关系不动（这里不删任何东西）。
 */
export interface AgentRestoreFactoryParams {
  agentId: string;
  /** 只算「恢复之后会是什么样」，不落盘 */
  dryRun?: boolean;
}

/**
 * `agent.restoreFactory` 出参。
 *
 * `restored: false` 表示它本来就是出厂状态（没有可恢复的改动），不是失败。
 */
export interface AgentRestoreFactoryResult {
  agent: AgentView;
  restored: boolean;
}

// ---------------------------------------------------------------------------
// model.*
// ---------------------------------------------------------------------------

/** `model.list` 入参 */
export interface ModelListParams {
  /** 连不可用的也列（默认列，PRD F-B5 的口径） */
  includeUnavailable?: boolean;
}

/** `model.list` 出参（PRD F-F3：出厂托管 vs 自定义、思考策略、两条阈值、视觉、描述） */
export interface ModelListResult {
  models: ModelView[];
}

/** `model.listImages` 出参（PRD F-F4 / D6：图片模型与默认图片模型） */
export interface ModelListImagesResult {
  imageModels: ImageModelView[];
  defaultImageModel: string | null;
}

/** `model.create` 入参（建出来就是自定义，PRD F-F3）；`tokenThresholds` 省略时套出厂默认 */
export interface ModelCreateParams {
  model: ModelInput;
}

/** `model.create` 出参 */
export interface ModelCreateResult {
  model: ModelView;
}

/** `model.update` 入参（编辑即转自定义，PRD F-F3） */
export interface ModelUpdateParams {
  modelId: string;
  patch: Partial<Omit<ModelInput, "id">>;
}

/** `model.update` 出参 */
export interface ModelUpdateResult {
  model: ModelView;
}

/** `model.delete` 入参（被助手引用时禁删并列出引用者，PRD F-F2 / F-F7） */
export interface ModelDeleteParams {
  modelId: string;
  dryRun?: boolean;
}

/** `model.delete` 出参 */
export interface ModelDeleteResult {
  removed: boolean;
  references: ReferenceList;
}

/** `model.restoreFactory` 入参（PRD F-F3：恢复出厂是整条替换） */
export interface ModelRestoreFactoryParams {
  modelId: string;
}

/** `model.restoreFactory` 出参 */
export interface ModelRestoreFactoryResult {
  model: ModelView;
}

/** `model.saveImage` 入参（PRD F-F4：图片模型的创建与修改） */
export interface ModelSaveImageParams {
  imageModel: ImageModelInput;
}

/** `model.saveImage` 出参 */
export interface ModelSaveImageResult {
  imageModel: ImageModelView;
}

/** `model.deleteImage` 入参（被默认项引用时禁删，PRD F-F7 / F-F4） */
export interface ModelDeleteImageParams {
  imageModelId: string;
  dryRun?: boolean;
}

/** `model.deleteImage` 出参 */
export interface ModelDeleteImageResult {
  removed: boolean;
  references: ReferenceList;
}

// ---------------------------------------------------------------------------
// 凭证的形状（宿主内部，不在契约面上）
// ---------------------------------------------------------------------------

/*
 * `credential.list|create|revoke` 三个方法已从契约面删除（裁定 2026-11-13：凭证归宿主自己管理，
 * 客户端只有「连接管理 + 记住密码」）。下面的形状留着，因为能力本身还在：
 * `CredentialService` 与 `agents-host token create|list|revoke` 的返回值用的就是这几个类型。
 */

/**
 * 一串凭证（PRD L11：可以有多串、创建时带备注、权限相同、可单独吊销）。
 *
 * 库里存的是哈希；`token` 明文只在 `agents-host token create` 的那一次输出里出现。
 */
export interface CredentialView {
  id: string;
  /** 创建时写的备注 */
  note: string;
  createdAt: string;
  revokedAt: string | null;
}

/** 凭证清单（PRD L11） */
export interface CredentialListResult {
  credentials: CredentialView[];
}

/** 新建凭证的入参（PRD L11：创作者自己起、自己分发） */
export interface CredentialCreateParams {
  note: string;
}

/** 新建凭证的出参：明文只此一次 */
export interface CredentialCreateResult {
  credential: CredentialView;
  /** 明文凭证；宿主此后只存哈希 */
  token: string;
}

/** 吊销凭证的入参（PRD L11：可单独吊销） */
export interface CredentialRevokeParams {
  credentialId: string;
}

/** 吊销凭证的出参 */
export interface CredentialRevokeResult {
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// asset.*
// ---------------------------------------------------------------------------

/** 附件的用途（PRD D5：图片走上传入口） */
export type AssetPurpose = "message_image";

/**
 * `asset.begin` 入参（architecture A11 三段式的第一段 / PRD F-H8）。
 *
 * 声明总长、用途、类型与归属的对话。超限在这里就拒（PRD D5：20MB/张，不接收完再说不行）。
 */
export interface AssetBeginParams {
  purpose: AssetPurpose;
  /** MIME 类型，如 `image/png` */
  mime: string;
  /** 总字节数 */
  bytes: number;
  /** 原始文件名（可缺） */
  name?: string;
  /**
   * 内容的 sha256（客户端本来就算过一次，传上来即可）。
   *
   * 带上它之后，同一段对话里同一张图第二次上传会在 `begin` 就短路（`deduped: true`）：
   * 客户端不必再发二进制帧、也不必调 `asset.end`。不带就按一次全新上传处理。
   */
  sha256?: string;
  /**
   * 这段素材归属哪段对话（必填）。
   *
   * 素材行在库里按 `conversationId` 挂外键，落定那一刻这段对话必须已经存在；草稿对话
   * （`conversation.create` 之后还没发过消息，R56）在 `asset.begin` 这一步落库，
   * 与「第一次 `conversation.send`」同义。
   */
  conversationId: string;
}

/**
 * `asset.begin` 出参：上传句柄与这次的上限（或「已经有了，不用传」）。
 *
 * 两种形态：
 *   - 新上传：`deduped: false`，`uploadId` 是一个句柄，`asset` 为 `null`；
 *   - 命中「同一段对话里同一个 sha256」：`deduped: true`，`uploadId` 为 `null`，`asset` 是既有
 *     素材的引用（客户端直接拿它放进消息，既不发二进制帧也不调 `asset.end`）。
 */
export interface AssetBeginResult {
  /** 是否命中了对话内的去重（命中时客户端跳过 `chunk` 与 `asset.end`） */
  deduped: boolean;
  /** 上传句柄；`deduped: true` 时为 `null` */
  uploadId: string | null;
  /** 这个句柄能收多少字节（等于 `maxAssetBytes`，超了会在 `end` 被拒） */
  maxBytes: number;
  /** 宿主已收到的字节数（刚开时为 0） */
  receivedBytes: number;
  /** `deduped: true` 时是既有素材的引用，否则为 `null` */
  asset: AssetRef | null;
}

/**
 * `asset.end` 入参（三段式的第三段 / PRD F-H8）。
 *
 * 中间的字节走同一条 WS 上的二进制帧，不攒进内存（A11）。
 */
export interface AssetEndParams {
  uploadId: string;
  /** 客户端算的摘要；宿主校验长度与摘要后才改名为正式引用 */
  sha256: string;
}

/** `asset.end` 出参：可放进消息的引用 */
export interface AssetEndResult {
  asset: AssetRef;
}

/** `asset.get` 的取哪一档：原图，还是缩略图 */
export type AssetVariant = "original" | "thumb";

/**
 * `asset.get` 入参（PRD F-H7 / F-H8）：按素材 id 取回内容。
 *
 * `assets` 是资源的唯一真相，所以宿主重启、换模型、换设备之后，任何一段历史里的图都能靠
 * 段上的 `__asset_id`（本地扩展字段）重新取回来。
 */
export interface AssetGetParams {
  assetId: string;
  /**
   * 取哪一档；缺省 `original`。
   *
   * `thumb` 目前**等同原图**：宿主这一波不引入原生图像库，缩略图只是「原图直出 + 宽高」，
   * 客户端需要小图时自己按 `width` / `height` 缩放（宽高未知时为 `null`）。
   */
  variant?: AssetVariant;
}

/**
 * `asset.get` 出参：内容本体 + 它的类型与尺寸。
 *
 * 内容走同一条 WS 上的 JSON 响应（base64），而不是另开一条二进制下行帧：
 *   - 上传的二进制帧是「按 `uploadId` 认路的、没有回执的流」，下行复用它得再定一套
 *     「这条帧对应哪个请求」的关联规则；JSON 响应的 id 天然就是那个关联；
 *   - 请求/响应天然是原子的（不会与别的请求的下行数据交错），客户端也不用维护下行状态机。
 * 代价是 base64 多出三分之一体积，单张上限仍是 20MB（PRD D5），一次一张。
 */
export interface AssetGetResult {
  asset: AssetRef;
  /** 实际给出的档（`thumb` 目前等同原图） */
  variant: AssetVariant;
  /** 内容本体，base64 编码（`mime` 说它是什么） */
  data: string;
}

// ---------------------------------------------------------------------------
// completion.*
// ---------------------------------------------------------------------------

/** 补全用的文件条目（PRD F-H5：`@` 菜单的数据来源） */
export interface FileEntryView {
  /** 相对 Workspace 的路径（`@` 菜单显示与插入都用它） */
  path: string;
  name: string;
  kind: "file" | "directory";
}

/** 文件清单的三种状态（PRD D7：未就绪要说话） */
export type CompletionState = "ready" | "scanning" | "unavailable";

/**
 * `completion.files` 入参（PRD F-H5 / D7）。
 *
 * 按需扫描：git `ls-files` 优先，非 git 用 glob 并排除 `node_modules/.git/dist`；
 * 20000 条上限、5s 超时、15s 缓存 —— 这些是宿主的实现事实，客户端只需要知道「现在能不能用」。
 */
export interface CompletionFilesParams {
  workspaceId: string;
  /** 已输入的前缀（可能是路径形式，如 `src/co`） */
  prefix: string;
  limit?: number;
}

/** `completion.files` 出参：条目 + 现在这个清单处在什么状态 */
export interface CompletionFilesResult {
  state: CompletionState;
  entries: FileEntryView[];
  /** 是否被条目上限截断（PRD D7：20000 条） */
  truncated: boolean;
  /** 清单建好的时刻；还在扫时为空 */
  scannedAt: string | null;
  /** 拿不到清单或清单不完整时的说明（PRD D7：未就绪要说话） */
  problem: ProblemFact | null;
}

// ---------------------------------------------------------------------------
// handoff.*
// ---------------------------------------------------------------------------

/** 交接执行者：原 agent 自己写，或独立调用摘要（形状沿用 SDK） */
export type HandoffMode = "self" | "summary";

/** 交接之后做什么：只产出文档，还是顺带开一段新对话（PRD F-D4 / F-D5 / D18） */
export type HandoffThen = "document_only" | "new_conversation";

/** 交接文档（PRD F-D6 / D19：写进项目 `<cwd>/.ai-zen/handoffs/`） */
export interface HandoffDocument {
  /** 绝对路径 */
  path: string;
  bytes: number;
  writtenAt: string;
  /** 实际用的执行者 */
  mode: HandoffMode;
}

/** 一份交接文档的元信息（用于列表回看） */
export interface HandoffDocumentInfo {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: string;
}

/**
 * `handoff.start` 入参（PRD F-D3 / F-D4 / F-D5 / F-D7 / D22）。
 *
 * `questionId` 用于「用户刚回答了交接问题」这条路径：带上它，答案与这次交接就对得上。
 */
export interface HandoffStartParams {
  conversationId: string;
  /** 执行者（PRD F-D2 的「自交接」= self，「独立摘要」= summary） */
  mode: HandoffMode;
  /** 后面接什么（PRD F-D4：只产文档；F-D5：一步完成交接 + 开新会话） */
  then: HandoffThen;
  questionId?: string;
}

/**
 * `handoff.start` 出参（PRD F-D7：降级要说明，取消不等于失败）。
 *
 * `degraded` 说明这次实际退到了哪个执行者、为什么；`newConversationId` 是 `then ===
 * "new_conversation"` 时开出来的新对话（PRD D18：同 Workspace、同助手；旧对话完整保留）。
 */
export interface HandoffStartResult {
  document: HandoffDocument;
  /** 用户选的那一档 */
  requestedMode: HandoffMode;
  /** 实际用的那一档 */
  usedMode: HandoffMode;
  degraded: boolean;
  /** 降级/取消的原因（成功且未降级时为空） */
  problem: ProblemFact | null;
  /** 交接完的旧对话（完整保留，PRD D18） */
  conversation: ConversationView;
  newConversationId: string | null;
}

/** `handoff.listDocuments` 入参（PRD F-D6：文档写进项目，可反复打磨同一份） */
export interface HandoffListDocumentsParams {
  workspaceId: string;
}

/** `handoff.listDocuments` 出参 */
export interface HandoffListDocumentsResult {
  documents: HandoffDocumentInfo[];
}

// ---------------------------------------------------------------------------
// search.*
// ---------------------------------------------------------------------------

/** `search.conversations` 入参（PRD F-C6 / D16：按名称搜 + Workspace 过滤） */
export interface SearchConversationsParams {
  query: string;
  workspaceId?: string;
  limit?: number;
}

/** 按名搜到的一段对话 */
export interface ConversationHit {
  conversation: ConversationSummary;
  /** 名字里命中的那一段（供高亮） */
  matchedName: string;
}

/** `search.conversations` 出参 */
export interface SearchConversationsResult {
  hits: ConversationHit[];
}

/**
 * `search.messages` 入参（PRD F-C6 / D16：按聊天内容全文搜，中文分词成本接受）。
 *
 * 少于 3 字符的短查询会退化到 `LIKE`（FTS5 trigram 的下限），这个取舍由宿主承担。
 */
export interface SearchMessagesParams {
  query: string;
  workspaceId?: string;
  conversationId?: string;
  limit?: number;
  offset?: number;
}

/** 一条消息命中 */
export interface MessageHit {
  conversationId: string;
  conversationName: string;
  messageId: string;
  /** 命中消息的角色，core 原样 */
  role: AgentNS.Role;
  /** 命中处前后的一小段原文（供高亮） */
  snippet: string;
  createdAt: string;
}

/** `search.messages` 出参 */
export interface SearchMessagesResult {
  hits: MessageHit[];
  total: number;
}

// ---------------------------------------------------------------------------
// 方法表
// ---------------------------------------------------------------------------

/**
 * 方法名 → `{ params, result }`。
 *
 * 这是宿主与客户端之间唯一的方法清单：接线层按它分发（architecture §6），
 * 客户端按它接线。（帮助与指令菜单归客户端自己，理由见 `HostHelloResult` 的注释。）
 */
export interface MethodMap {
  // ---- host.*：进程、握手、语言、升级、退出 ----
  /**
   * F-A1：人用与脚本用两条路要分开。宿主判定「这次调用算不算一段对话」，
   * 握手这一帧是这条连接的起点（凭证 + 语言 + 客户端身份）。
   */
  "host.hello": { params: HostHelloParams; result: HostHelloResult };
  /** F-E3 / D4：升级要能确认「磁盘上的版本已更新」，所以先得能报版本。 */
  "host.version": { params: NoParams; result: HostVersionResult };
  /** F-E3 / D4：检测版本号 → 确认升级完成 → 立即重启，不等在跑的轮次。 */
  "host.upgrade": { params: HostUpgradeParams; result: HostUpgradeResult };
  /** F-E1：命令清单里的「退出」在宿主这一侧的动作。 */
  "host.shutdown": { params: HostShutdownParams; result: HostShutdownResult };
  /**
   * F-E1：命令清单里的「重载」在宿主这一侧的动作。
   *
   * 改完配置本来就会自动生效（F-E2）；这一条是给人一个「我现在就说一遍」的入口 ——
   * 手改了磁盘上的助手定义 / 技能目录 / MCP 文件之后不必重启。
   */
  "host.reload": { params: NoParams; result: HostReloadResult };
  /** D8 / F-E4：`/lang` 是连接级动作，语言挂在连接上、断开即忘。 */
  "host.setLanguage": { params: HostSetLanguageParams; result: HostSetLanguageResult };

  // ---- workspace.*：项目是一等公民（D9 / D10 / D11 / D12）----
  /** D9 / D12 / D13（PRD §4 未给 Workspace 单列能力编号）：项目列表，含「目录已不存在」这个事实。 */
  "workspace.list": { params: WorkspaceListParams; result: WorkspaceListResult };
  /** D9 / D10（§4 未单列）：显式添加项目；未登记 cwd 被用户确认登记后也走这里。 */
  "workspace.create": { params: WorkspaceCreateParams; result: WorkspaceCreateResult };
  /** D9（§4 未单列）：按 id 取一个项目。 */
  "workspace.get": { params: WorkspaceGetParams; result: WorkspaceGetResult };
  /** D9（§4 未单列）：id 与 cwd 不可变，名字可改。 */
  "workspace.rename": { params: WorkspaceRenameParams; result: WorkspaceRenameResult };
  /** D11 / F-F9：连带删名下对话，删前给出代价；目录本身宿主不碰。 */
  "workspace.remove": { params: WorkspaceRemoveParams; result: WorkspaceRemoveResult };

  // ---- conversation.*：一段对话的身份、历史、一轮的运行 ----
  /** F-C5 / D13：默认创建时间倒序 + 手动置顶。 */
  "conversation.list": { params: ConversationListParams; result: ConversationListResult };
  /** F-A3 / F-C7 / L7：开新会话；项目与助手在创建时定死（模型与档位归会话）。 */
  "conversation.create": { params: ConversationCreateParams; result: ConversationCreateResult };
  /** F-A6：按 id 打开（「接着上次聊」的记住工作归客户端）。 */
  "conversation.get": { params: ConversationGetParams; result: ConversationGetResult };
  /** L5 / F-I3 / F-I5 / F-I6 / F-D1：重连拉状态（六态、阈值、问题、用量、状态栏块）。 */
  "conversation.state": { params: ConversationStateParams; result: ConversationStateResult };
  /** D1 / F-C3：改名不改身份、不改排序。 */
  "conversation.rename": { params: ConversationRenameParams; result: ConversationRenameResult };
  /** F-C5 / D13：手动置顶。 */
  "conversation.pin": { params: ConversationPinParams; result: ConversationPinResult };
  /** F-C10 / D17：硬删，图片按引用清理；删除前给出代价。 */
  "conversation.delete": { params: ConversationDeleteParams; result: ConversationDeleteResult };
  /** F-C2 / L6 / D14 / F-H7 / F-D10：一轮的起点（忙则拒、id 先分配、问题挡着则拒）。 */
  "conversation.send": { params: ConversationSendParams; result: ConversationSendResult };
  /** D14（§4 未单列，能力落在「一段对话同时只跑一轮」上）：中止是用户的显式动作。 */
  "conversation.abort": { params: ConversationAbortParams; result: ConversationAbortResult };
  /** F-C8 / D24：撤回到某条用户消息之前，其后硬删，内容回填输入框。 */
  "conversation.revert": { params: ConversationRevertParams; result: ConversationRevertResult };
  /** F-B4 / F-B8 / D20：换这段会话的模型（存会话行）+ 拒绝降级。 */
  "conversation.setModel": { params: ConversationSetModelParams; result: ConversationSetModelResult };
  /** F-B6 / F-B7：调这段会话的思考档位（存档位名）；展开成参数在装配 agent 那一刻。 */
  "conversation.setThinking": {
    params: ConversationSetThinkingParams;
    result: ConversationSetThinkingResult;
  };
  /** F-A2 / D3：临时对话，一次请求跑一轮、零痕迹。 */
  "conversation.transient": {
    params: ConversationTransientParams;
    result: ConversationTransientResult;
  };

  // ---- message.*：历史 ----
  /**
   * A12 / L5 / F-I7：按 id 取（含自身最新内容），可指定某个子 Agent 的消息。
   *
   * F-C6 的定位（`around`）在这里：消费者是桌面端的搜索命中跳转（PLAN W4）—— 由
   * `search.messages` 拿到命中后，用它把命中那条摆到眼前。CLI 不消费 `around`。
   */
  "message.list": { params: MessageListParams; result: MessageListResult };

  // ---- question.*：问题对象（D22 / D23 / F-D2 / F-I9）----
  /** D22 / F-I9：多端看到同一批问题。 */
  "question.list": { params: QuestionListParams; result: QuestionListResult };
  /** F-I9 / D22 / D23：回答问题；答完的后续动作（交接、开新会话）一并回。 */
  "question.answer": { params: QuestionAnswerParams; result: QuestionAnswerResult };

  // ---- notice.*：通知（L3 / F-I8 / F-J2）----
  /** L3 / F-I8：通知持久化，可随时列出。 */
  "notice.list": { params: NoticeListParams; result: NoticeListResult };
  /** F-I8 / L3：不带时长的通知靠手动清除。 */
  "notice.dismiss": { params: NoticeDismissParams; result: NoticeDismissResult };
  /** F-I8 / L3：一次清掉一批通知。 */
  "notice.clear": { params: NoticeClearParams; result: NoticeClearResult };

  // ---- config.*：配置（F-F1 / F-F2 / F-F6 / F-F7 / F-E2 / F-A8）----
  /** F-F1 / D21：配置的读写都走宿主 API；密钥掩码，同时报出配置问题。 */
  "config.get": { params: ConfigGetParams; result: ConfigGetResult };
  /** F-F1 / F-E2 / F-F9：改完即生效，回报重载了哪些东西。 */
  "config.patch": { params: ConfigPatchParams; result: ConfigPatchResult };
  /** F-F7 / D2 / D6：默认项（助手、迁移模型、图片模型、取名模型、自动命名开关）。 */
  "config.setDefaults": { params: ConfigSetDefaultsParams; result: ConfigSetDefaultsResult };
  /** F-G1 / F-G2 / F-F6：5 层 MCP 链、Skill / 工具 / 子 Agent 的分层与坏文件状态。 */
  "config.getDiscovery": { params: ConfigGetDiscoveryParams; result: ConfigGetDiscoveryResult };
  /** F-G1 / F-F6：两个可编辑作用域的 MCP 条目写入（有 id 则改、无则建；未知字段与 `oauth` 原样保留）。 */
  "config.saveMcp": { params: ConfigSaveMcpParams; result: ConfigSaveMcpResult };
  /** F-F6：删掉那一层里的一条（本来就没有时 `removed: false`）。 */
  "config.deleteMcp": { params: ConfigDeleteMcpParams; result: ConfigDeleteMcpResult };
  /** F-F2：端点写入（密钥可省略表示保留）。 */
  "config.saveEndpoint": { params: ConfigSaveEndpointParams; result: ConfigSaveEndpointResult };
  /** F-F2：被引用时禁删并列出引用者。 */
  "config.deleteEndpoint": {
    params: ConfigDeleteEndpointParams;
    result: ConfigDeleteEndpointResult;
  };

  // ---- agent.*：助手与子 Agent 定义（F-B1…F-B7 / F-F5 / F-G3）----
  /** F-B2 / F-B3 / F-B5：助手清单，不可用的也列出并说明原因。 */
  "agent.list": { params: AgentListParams; result: AgentListResult };
  /** F-B2：按 id 取一个助手。 */
  "agent.get": { params: AgentGetParams; result: AgentGetResult };
  /** F-B2 / F-G3：新建助手定义（一实体一文件）。 */
  "agent.create": { params: AgentCreateParams; result: AgentCreateResult };
  /** F-B2 / F-G3：编辑助手定义。 */
  "agent.update": { params: AgentUpdateParams; result: AgentUpdateResult };
  /** F-F5：删除（含子 Agent），删前问「还有谁指它」；删默认助手时连带清默认。 */
  "agent.delete": { params: AgentDeleteParams; result: AgentDeleteResult };
  /** F-B4 / F-B1：改助手默认模型（另一个动作：与改这段会话的模型分开），并清掉旧模型的档位参数。 */
  "agent.setModel": { params: AgentSetModelParams; result: AgentSetModelResult };
  /** F-B6：把思考档位展开成参数写进助手定义（`null` = 把那份参数删掉）。 */
  "agent.setThinking": { params: AgentSetThinkingParams; result: AgentSetThinkingResult };
  /** F-F5：恢复出厂（整条替换；可以先预演不落盘）。 */
  "agent.restoreFactory": {
    params: AgentRestoreFactoryParams;
    result: AgentRestoreFactoryResult;
  };

  // ---- model.*：模型与图片模型（F-F3 / F-F4 / F-F7 / F-B8）----
  /** F-F3 / F-B7：模型清单（出厂托管 vs 自定义、两条阈值、思考档位、可用性）。 */
  "model.list": { params: ModelListParams; result: ModelListResult };
  /** F-F4 / D6：图片模型与默认图片模型。 */
  "model.listImages": { params: NoParams; result: ModelListImagesResult };
  /** F-F3：新建模型（建出来即自定义；不传阈值就用出厂默认那一档）。 */
  "model.create": { params: ModelCreateParams; result: ModelCreateResult };
  /** F-F3：编辑模型（编辑即转自定义；没给的字段不动，阈值省略也不清空）。 */
  "model.update": { params: ModelUpdateParams; result: ModelUpdateResult };
  /** F-F2 / F-F7：删除模型；被引用时禁删并列出引用者。 */
  "model.delete": { params: ModelDeleteParams; result: ModelDeleteResult };
  /** F-F3：恢复出厂（整条替换）。 */
  "model.restoreFactory": { params: ModelRestoreFactoryParams; result: ModelRestoreFactoryResult };
  /** F-F4：图片模型的创建与修改。 */
  "model.saveImage": { params: ModelSaveImageParams; result: ModelSaveImageResult };
  /** F-F4 / F-F7：删除图片模型；被默认项引用时禁删。 */
  "model.deleteImage": { params: ModelDeleteImageParams; result: ModelDeleteImageResult };

  // ---- asset.*：上传入口（D5 / F-H8 / A11）与取回（F-H7）----
  /** D5 / F-H8 / A11：上传第一段，声明总长与类型，超限当场拒；带 sha256 时可命中去重。 */
  "asset.begin": { params: AssetBeginParams; result: AssetBeginResult };
  /** F-H8 / A11：上传第三段，校验长度与摘要后变成可引用的素材。 */
  "asset.end": { params: AssetEndParams; result: AssetEndResult };
  /** F-H7 / F-H8：按素材 id 取回内容（原图 / 缩略图两档），历史里的图因此能被重放。 */
  "asset.get": { params: AssetGetParams; result: AssetGetResult };

  // ---- completion.*：`@` 补全的数据来源（F-H5 / D7）----
  /** F-H5 / D7：按需扫描的文件清单；未就绪要说话。 */
  "completion.files": { params: CompletionFilesParams; result: CompletionFilesResult };

  // ---- handoff.*：交接与迁移（F-D3 / F-D4 / F-D5 / F-D6 / F-D7 / D18 / D19）----
  /** F-D4 / F-D5 / F-D3：写交接文档；可选顺带开新对话，旧对话完整保留。 */
  "handoff.start": { params: HandoffStartParams; result: HandoffStartResult };
  /** F-D6 / D19：项目里的交接文档清单（可反复打磨同一份）。 */
  "handoff.listDocuments": {
    params: HandoffListDocumentsParams;
    result: HandoffListDocumentsResult;
  };

  // ---- search.*：找得到旧对话（F-C6 / D16）----
  /** F-C6 / D16：按名称搜对话，可按项目过滤。 */
  "search.conversations": {
    params: SearchConversationsParams;
    result: SearchConversationsResult;
  };
  /** F-C6 / D16：按聊天内容全文搜。 */
  "search.messages": { params: SearchMessagesParams; result: SearchMessagesResult };
}

/** 方法名 */
export type MethodName = keyof MethodMap;

/** 取某个方法的入参类型 */
export type MethodParams<M extends MethodName> = MethodMap[M]["params"];

/** 取某个方法的出参类型 */
export type MethodResult<M extends MethodName> = MethodMap[M]["result"];

/**
 * 全部方法名（分发注册、帮助渲染、测试遍历用）。
 *
 * 用 `as const satisfies` 是为了让「表里漏了一个方法」在编译期就能被抓到：
 * 测试里做 `Exclude<MethodName, (typeof METHOD_NAMES)[number]>` 时，漏掉的名字会留在
 * 那个差集里而不是被抹成 `never`。
 */
export const METHOD_NAMES = [
  "host.hello",
  "host.version",
  "host.upgrade",
  "host.shutdown",
  "host.reload",
  "host.setLanguage",
  "workspace.list",
  "workspace.create",
  "workspace.get",
  "workspace.rename",
  "workspace.remove",
  "conversation.list",
  "conversation.create",
  "conversation.get",
  "conversation.state",
  "conversation.rename",
  "conversation.pin",
  "conversation.delete",
  "conversation.send",
  "conversation.abort",
  "conversation.revert",
  "conversation.setModel",
  "conversation.setThinking",
  "conversation.transient",
  "message.list",
  "question.list",
  "question.answer",
  "notice.list",
  "notice.dismiss",
  "notice.clear",
  "config.get",
  "config.patch",
  "config.setDefaults",
  "config.getDiscovery",
  "config.saveMcp",
  "config.deleteMcp",
  "config.saveEndpoint",
  "config.deleteEndpoint",
  "agent.list",
  "agent.get",
  "agent.create",
  "agent.update",
  "agent.delete",
  "agent.setModel",
  "agent.setThinking",
  "agent.restoreFactory",
  "model.list",
  "model.listImages",
  "model.create",
  "model.update",
  "model.delete",
  "model.restoreFactory",
  "model.saveImage",
  "model.deleteImage",
  "asset.begin",
  "asset.end",
  "asset.get",
  "completion.files",
  "handoff.start",
  "handoff.listDocuments",
  "search.conversations",
  "search.messages",
] as const satisfies readonly MethodName[];

/** 运行时判断一个字符串是不是已知方法名 */
export function isMethodName(value: unknown): value is MethodName {
  return typeof value === "string" && (METHOD_NAMES as readonly string[]).includes(value);
}
