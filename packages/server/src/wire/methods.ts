import type {
  AbortedMessageStrategy,
  AbortedToolRoundStrategy,
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
  InputPart,
  LocalizedText,
  MessageSegment,
  MessageView,
  NoticeLevel,
  NoticeView,
  ProblemFact,
  QuestionState,
  QuestionView,
  RunState,
  SubAgentSnapshot,
  ThinkingState,
  UsageSnapshot,
} from "./states.js";

/**
 * 方法表：方法名 → 入参 / 出参。
 *
 * 命名按 `<域>.<动作>`（architecture §6）。每一段前的注释写清它服务 PRD §4 的哪条能力
 * 编号，以及那条能力的落点为什么在服务端 —— 这是接线与前端对齐时唯一的索引。
 *
 * 两条贯穿全表的口径：
 *   1. 出参只给**结构化事实**，需要句子时给 `LocalizedText`；不把句子当数据结构（PRD §3 尺子 ④⑤）。
 *   2. 各域的「读」返回完整对象、「写」返回写后的完整对象，这样客户端拿到响应就能直接替换本地状态。
 */

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/** 协议版本：服务端与客户端同一版发布（PRD L1），版本号用来挡掉错配的连接 */
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
 * 能力清单里的一项（PRD F-E5 帮助由能力清单渲染、F-E6 阻塞是能力属性、F-F9 二次确认）。
 *
 * `id` 用 PRD 的能力编号（如 `F-C8`），因为那份清单是「要为用户做到什么」的唯一真相；
 * 客户端据此接线，不必再维护第三份清单。
 */
export interface CapabilityView {
  /** 稳定能力编号（PRD §4 的编号，如 `F-C8`） */
  id: string;
  domain: MethodDomain;
  title: LocalizedText;
  description: LocalizedText;
  /** 对应的方法名；纯事实类能力（如生成六态）没有方法，为空 */
  method: MethodName | null;
  /** 执行期间会阻塞对话（PRD F-E6：界面要能显示「正在执行什么」） */
  blocking: boolean;
  /** 有不可撤销的后果（PRD F-F9：需要二次确认） */
  destructive: boolean;
}

/** 方法的域（方法名的第一段） */
export type MethodDomain =
  | "server"
  | "workspace"
  | "conversation"
  | "message"
  | "question"
  | "notice"
  | "config"
  | "agent"
  | "model"
  | "credential"
  | "asset"
  | "completion"
  | "handoff"
  | "search";

/**
 * 一次删除的代价（PRD D11「删前明说代价」/ D17「先警告」/ F-F9「二次确认」）。
 *
 * 客户端把 `dryRun: true` 的结果摆给用户看，用户确认后再发一次真删 —— 代价是服务端算的
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
// server.*
// ---------------------------------------------------------------------------

/**
 * `hello` 入参（architecture §6：首帧 `hello`，凭证不放 URL 查询串）。
 *
 * `language` 挂在连接上、断开即忘（PRD D8）；缺省用配置里的默认语言。
 */
export interface ServerHelloParams {
  token: string;
  /** 可选语言，认不出来回落默认语言（`normalizeLanguage`） */
  language?: string;
  clientInfo: ClientInfo;
}

/**
 * `hello` 出参。
 *
 * 除了握手成功本身，还把「这条连接以后说哪种语言」「服务端是什么版本」「有哪些能力」
 * 一次给全：客户端连上就能把界面语言定下来（D8），帮助页也能直接渲染（F-E5）。
 */
export interface ServerHelloResult {
  /** 这条连接协商出的语言；后续这条连接上的文案都按它渲染 */
  language: Language;
  serverVersion: string;
  protocolVersion: string;
  /** 服务端进程启动时间 */
  startedAt: string;
  /** 能力清单（PRD F-E5 / F-E6 / F-F9） */
  capabilities: CapabilityView[];
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
export interface ServerVersionResult {
  version: string;
  protocolVersion: string;
  startedAt: string;
  /** 进程 id（发现文件里也有，客户端排查时方便对齐） */
  pid: number;
}

/**
 * `upgrade` 入参。
 *
 * `targetVersion` 不传表示「升到磁盘上装好的那个版本」：服务端只读到磁盘版本变了就重启，
 * 不自己装包（PRD D4 / F-E3）。
 */
export interface ServerUpgradeParams {
  targetVersion?: string;
}

/** `upgrade` 的三种结论：已经最新 / 已安排重启 / 没有可升的东西 */
export type ServerUpgradeState = "already_latest" | "restart_scheduled" | "not_available";

/** `upgrade` 出参（PRD F-E3：确认升级真的完成后立即重启，不等在跑的轮次） */
export interface ServerUpgradeResult {
  state: ServerUpgradeState;
  /** 当前运行的版本 */
  currentVersion: string;
  /** 磁盘上的版本（读不到时为空） */
  diskVersion: string | null;
  /** 这次要升到的版本 */
  targetVersion: string | null;
}

/** `shutdown` 入参（PRD F-E1 里的「退出」能力） */
export interface ServerShutdownParams {
  reason?: string;
}

/** `shutdown` 出参：已受理（进程随后按 L4 的条件收尾） */
export interface ServerShutdownResult {
  accepted: boolean;
}

/** `usage` 入参：给哪个范围算（都不给就是这台服务端的累计） */
export interface ServerUsageParams {
  conversationId?: string;
  workspaceId?: string;
}

/** `usage` 出参：用量快照 + 它覆盖的范围（PRD F-I5） */
export interface ServerUsageResult {
  scope: "conversation" | "workspace" | "server";
  usage: UsageSnapshot;
}

/** `capabilities` 出参（PRD F-E5：帮助与指令菜单都从这一份渲染） */
export interface ServerCapabilitiesResult {
  capabilities: CapabilityView[];
}

/**
 * `setLanguage` 入参（PRD D8 / F-E4：`/lang` 是连接级动作）。
 *
 * 语言挂在连接上，所以这是「这条连接以后说哪种语言」，不是账号偏好。
 */
export interface ServerSetLanguageParams {
  language: string;
}

/** `setLanguage` 出参 */
export interface ServerSetLanguageResult {
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
 * `dryRun: true` 只算代价不动手，供客户端做二次确认；目录本身服务端不碰（D11）。
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
  /** 这段对话的模型（创建时定死，PRD L7） */
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  /** 现在是否在跑一轮（PRD F-I3） */
  running: boolean;
  /** 是否有问题挂着没答（PRD F-I9） */
  hasPendingQuestion: boolean;
}

/**
 * 一段对话的当前模型事实（PRD L7 / F-B4 / F-B8）。
 *
 * `overriddenThisSession` 说明「现在是临时换过的模型」：临时换只活在内存里，重开回默认。
 */
export interface ConversationModelState {
  modelId: string;
  name: string;
  /** 这个模型能不能看图（PRD D20 / F-B8 的判定依据） */
  vision: boolean;
  overriddenThisSession: boolean;
}

/** 一段对话的完整样子 */
export interface ConversationView extends ConversationSummary {
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
 * `conversation.create` 入参（PRD F-A3「开新会话、别续接」/ F-C7 / D9 / L7）。
 *
 * 助手与模型在创建时定死（PRD L7）：换默认走 `agent.setModel`，改的是「以后的对话」用哪个模型，
 * 这段对话的身份不动。
 */
export interface ConversationCreateParams {
  workspaceId: string;
  agentId: string;
  /** 缺省用助手绑定的模型（PRD F-B1：模型真相在助手定义上） */
  modelId?: string;
}

/** `conversation.create` 出参 */
export interface ConversationCreateResult {
  conversation: ConversationView;
}

/** `conversation.get` 入参（PRD F-A6：服务端只提供「按 id 打开」） */
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
}

/** `conversation.state` 出参：一段对话的现场（六态、阈值、问题、用量、状态栏块） */
export interface ConversationStateResult {
  state: ConversationState;
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
 * 一轮的开始：服务端先占位（在跑则 `busy`），再分配用户消息与助手消息的 id（L6：助手消息 id
 * 在请求发出之前就有），然后开始流式。用户输入由文本段与附件段拼成，图片的传输路径由服务端定（F-H7）。
 * 有问题在挡着这段对话时会被拒（`question_pending`，D23 / F-D10）。
 */
export interface ConversationSendParams {
  conversationId: string;
  parts: InputPart[];
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
 * 撤回到某条用户消息**之前**：其后消息硬删，被撤回的内容回填输入框（回填内容由服务端给事实）。
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
  /** 回填到输入框的内容（文本 + 附件引用，PRD F-C8） */
  restoredInput: InputPart[];
}

/**
 * `conversation.setModel` 入参（PRD F-B4 / F-B8 / D20 / L7）。
 *
 * 这是**临时换模型**：只活在内存、不进库、重开回默认。历史里有图而新模型读不了图时拒绝
 * （业务码 `model_unsupported`）。改助手默认模型是另一个动作，见 `agent.setModel`。
 */
export interface ConversationSetModelParams {
  conversationId: string;
  /** `null` 表示回到这段对话创建时定的模型 */
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
 * `conversation.setThinking` 入参（PRD F-B6：用户说「多想一点」，写进去的是参数不是档位名）。
 *
 * 会话级临时调整，与 `agent.setThinking`（改助手的默认）分开。
 */
export interface ConversationSetThinkingParams {
  conversationId: string;
  /** 档位名（来自 `ThinkingState.levels`） */
  level: string;
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
  parts: InputPart[];
  agentId?: string;
  modelId?: string;
}

/** `conversation.transient` 出参：这一轮产出的段、正文、用量（不产生任何可回看的 id） */
export interface ConversationTransientResult {
  segments: MessageSegment[];
  /** 正文拼好的那一份，方便脚本直接取用 */
  text: string;
  usage: UsageSnapshot;
  subagents: SubAgentSnapshot[];
  problem: ProblemFact | null;
}

// ---------------------------------------------------------------------------
// message.*
// ---------------------------------------------------------------------------

/**
 * `message.list` 入参（architecture A12 / PRD L5 / F-I7）。
 *
 * - 不给 `after`：返回这段对话的全部消息；
 * - 给了且该 id 存在：**从这条开始**（含它本身，内容是**最新**的）+ 其后全部；
 * - 给了但该 id 不存在：返回全部。
 *
 * 「从这条开始而不是它的下一条」是故意的：重连的客户端上次拿到的最后一条可能正是流式中那条，
 * 它的内容已经变了；从它自己重新拿，就天然是「最新内容 + 之后的」。
 *
 * `toolCallId` 用来取某个子 Agent 自己的消息（PRD F-I7：子 Agent 的消息可回看）。
 */
export interface MessageListParams {
  conversationId: string;
  after?: string;
  toolCallId?: string;
}

/** `message.list` 出参：按 `seq` 升序的消息 */
export interface MessageListResult {
  conversationId: string;
  /** 被 `after` 命中的那条消息 id（没命中或没给则为空，客户端据此判断这是全量还是续传） */
  anchor: string | null;
  messages: MessageView[];
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
  tokenThresholds: TokenThresholds;
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
 * 只在助手没绑模型时起作用。
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
}

/** 配置层面的上限（PRD F-F8 / D5） */
export interface ConfigLimits {
  /** 工具输出上限（字符数，PRD F-F8） */
  maxToolOutput: number;
  maxAssetBytes: number;
  maxAssetsPerMessage: number;
}

/** 中断修复与工具刷新的行为开关（SDK 口径，服务端只做透传与生效） */
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
 * 一条配置问题（PRD F-A8：配错了要能当场修 —— 服务端给结构化原因）。
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

/** `config.get` 出参（PRD F-F1 / D21：配置的读写都走服务端 API） */
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

/** 发现出来的一个条目 */
export interface DiscoveryEntryView {
  id: string;
  name: string;
  description: string | null;
  /** 来自哪个文件/目录 */
  source: string;
  /** 是否启用（MCP 有 `disabled` 字段；其它种类目前恒为 true） */
  enabled: boolean;
  /** 条目自身的问题（如 MCP 连不上，PRD F-F6） */
  problem: ProblemFact | null;
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
 */
export type McpServerEntryInput = McpServerConfig & {
  extra?: Record<string, unknown>;
};

/** `config.patchMcps` 入参 */
export interface ConfigPatchMcpsParams {
  scope: McpEditableScope;
  /** `scope === "workspace"` 时必填 */
  workspaceId?: string;
  entries: McpServerEntryInput[];
}

/** `config.patchMcps` 出参：写回后的那一层（含坏文件状态是否已修好） */
export interface ConfigPatchMcpsResult {
  layer: DiscoveryLayerView;
  applied: ConfigApplyReport;
}

// ---------------------------------------------------------------------------
// agent.*
// ---------------------------------------------------------------------------

/**
 * 助手的样子（PRD F-B2 / F-B5 / F-B7 / F-B1）。
 *
 * 提示词 + 模型 + 权限四维（tools / skills / mcps / subagents）+ 自定义标记，形状沿用 SDK；
 * 不可用的助手也列出来并说明原因（F-B5：「藏起来」会让人以为它没了）。
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
 * 与 `conversation.setModel`（临时换、只活在内存）是两个动作、两个入口。
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
 */
export interface AgentSetThinkingParams {
  agentId: string;
  level: string;
}

/** `agent.setThinking` 出参 */
export interface AgentSetThinkingResult {
  agent: AgentView;
  thinking: ThinkingState;
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

/** `model.create` 入参（建出来就是自定义，PRD F-F3） */
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
// credential.*
// ---------------------------------------------------------------------------

/**
 * 一串凭证（PRD L11：可以有多串、创建时带备注、权限相同、可单独吊销）。
 *
 * 库里存的是哈希；`token` 明文只在 `credential.create` 的响应里出现一次。
 */
export interface CredentialView {
  id: string;
  /** 创建时写的备注 */
  note: string;
  createdAt: string;
  revokedAt: string | null;
}

/** `credential.list` 出参（PRD L11） */
export interface CredentialListResult {
  credentials: CredentialView[];
}

/** `credential.create` 入参（PRD L11 / F-E4：创作者自己起、自己分发） */
export interface CredentialCreateParams {
  note: string;
}

/** `credential.create` 出参：明文只此一次 */
export interface CredentialCreateResult {
  credential: CredentialView;
  /** 明文凭证；服务端此后只存哈希 */
  token: string;
}

/** `credential.revoke` 入参（PRD L11：可单独吊销） */
export interface CredentialRevokeParams {
  credentialId: string;
}

/** `credential.revoke` 出参 */
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
 * 声明总长、用途、类型。超限在这里就拒（PRD D5：20MB/张，不接收完再说不行）。
 */
export interface AssetBeginParams {
  purpose: AssetPurpose;
  /** MIME 类型，如 `image/png` */
  mime: string;
  /** 总字节数 */
  bytes: number;
  /** 原始文件名（可缺） */
  name?: string;
  /** 打算用在哪个对话上（可缺；给了就便于按引用清理，PRD D17） */
  conversationId?: string;
}

/** `asset.begin` 出参：上传句柄与这次的上限 */
export interface AssetBeginResult {
  uploadId: string;
  /** 这个句柄能收多少字节（等于 `maxAssetBytes`，超了会在 `end` 被拒） */
  maxBytes: number;
  /** 服务端已收到的字节数（刚开时为 0） */
  receivedBytes: number;
}

/**
 * `asset.end` 入参（三段式的第三段 / PRD F-H8）。
 *
 * 中间的字节走同一条 WS 上的二进制帧，不攒进内存（A11）。
 */
export interface AssetEndParams {
  uploadId: string;
  /** 客户端算的摘要；服务端校验长度与摘要后才改名为正式引用 */
  sha256: string;
}

/** `asset.end` 出参：可放进消息的引用 */
export interface AssetEndResult {
  asset: AssetRef;
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
 * 20000 条上限、5s 超时、15s 缓存 —— 这些是服务端的实现事实，客户端只需要知道「现在能不能用」。
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
 * 少于 3 字符的短查询会退化到 `LIKE`（FTS5 trigram 的下限），这个取舍由服务端承担。
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
  /** 命中消息的角色 */
  role: MessageView["role"];
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
 * 这是服务端与客户端之间唯一的方法清单：接线层按它分发（architecture §6），
 * 客户端按它接线，帮助与指令菜单按能力清单渲染（PRD F-E5）。
 */
export interface MethodMap {
  // ---- server.*：进程、握手、语言、升级、退出、全局用量、能力清单 ----
  /**
   * F-A1：人用与脚本用两条路要分开。服务端判定「这次调用算不算一段对话」，
   * 握手这一帧是这条连接的起点（凭证 + 语言 + 客户端身份）。
   */
  "server.hello": { params: ServerHelloParams; result: ServerHelloResult };
  /** F-E3 / D4：升级要能确认「磁盘上的版本已更新」，所以先得能报版本。 */
  "server.version": { params: NoParams; result: ServerVersionResult };
  /** F-E3 / D4：检测版本号 → 确认升级完成 → 立即重启，不等在跑的轮次。 */
  "server.upgrade": { params: ServerUpgradeParams; result: ServerUpgradeResult };
  /** F-E1：命令清单里的「退出」在服务端这一侧的动作。 */
  "server.shutdown": { params: ServerShutdownParams; result: ServerShutdownResult };
  /** F-I5：用量要能按对话 / 项目 / 整机分别看。 */
  "server.usage": { params: ServerUsageParams; result: ServerUsageResult };
  /** F-E5 / F-E6 / F-F9：帮助由能力清单渲染；阻塞与不可撤销是能力属性。 */
  "server.capabilities": { params: NoParams; result: ServerCapabilitiesResult };
  /** D8 / F-E4：`/lang` 是连接级动作，语言挂在连接上、断开即忘。 */
  "server.setLanguage": { params: ServerSetLanguageParams; result: ServerSetLanguageResult };

  // ---- workspace.*：项目是一等公民（D9 / D10 / D11 / D12）----
  /** D9 / D12 / D13（PRD §4 未给 Workspace 单列能力编号）：项目列表，含「目录已不存在」这个事实。 */
  "workspace.list": { params: WorkspaceListParams; result: WorkspaceListResult };
  /** D9 / D10（§4 未单列）：显式添加项目；未登记 cwd 被用户确认登记后也走这里。 */
  "workspace.create": { params: WorkspaceCreateParams; result: WorkspaceCreateResult };
  /** D9（§4 未单列）：按 id 取一个项目。 */
  "workspace.get": { params: WorkspaceGetParams; result: WorkspaceGetResult };
  /** D9（§4 未单列）：id 与 cwd 不可变，名字可改。 */
  "workspace.rename": { params: WorkspaceRenameParams; result: WorkspaceRenameResult };
  /** D11 / F-F9：连带删名下对话，删前给出代价；目录本身服务端不碰。 */
  "workspace.remove": { params: WorkspaceRemoveParams; result: WorkspaceRemoveResult };

  // ---- conversation.*：一段对话的身份、历史、一轮的运行 ----
  /** F-C5 / D13：默认创建时间倒序 + 手动置顶。 */
  "conversation.list": { params: ConversationListParams; result: ConversationListResult };
  /** F-A3 / F-C7 / L7：开新会话；项目、助手、模型在创建时定死。 */
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
  /** F-B4 / F-B8 / D20 / L7：临时换模型（只在内存）+ 拒绝降级。 */
  "conversation.setModel": { params: ConversationSetModelParams; result: ConversationSetModelResult };
  /** F-B6 / F-B7：临时调思考强度，写入的是参数。 */
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
  /** A12 / L5 / F-I7：按 id 取（含自身最新内容），可指定某个子 Agent 的消息。 */
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
  /** F-F1 / D21：配置的读写都走服务端 API；密钥掩码，同时报出配置问题。 */
  "config.get": { params: ConfigGetParams; result: ConfigGetResult };
  /** F-F1 / F-E2 / F-F9：改完即生效，回报重载了哪些东西。 */
  "config.patch": { params: ConfigPatchParams; result: ConfigPatchResult };
  /** F-F7 / D2 / D6：默认项（助手、迁移模型、图片模型、取名模型、自动命名开关）。 */
  "config.setDefaults": { params: ConfigSetDefaultsParams; result: ConfigSetDefaultsResult };
  /** F-G1 / F-G2 / F-F6：5 层 MCP 链、Skill / 工具 / 子 Agent 的分层与坏文件状态。 */
  "config.getDiscovery": { params: ConfigGetDiscoveryParams; result: ConfigGetDiscoveryResult };
  /** F-G1 / F-F6：两个可编辑作用域的 MCP 条目写回（未知字段与 `oauth` 原样保留）。 */
  "config.patchMcps": { params: ConfigPatchMcpsParams; result: ConfigPatchMcpsResult };
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
  /** F-B4 / F-B1：改助手默认模型（另一个动作：与临时换模型分开）。 */
  "agent.setModel": { params: AgentSetModelParams; result: AgentSetModelResult };
  /** F-B6：把思考档位展开成参数写进助手定义。 */
  "agent.setThinking": { params: AgentSetThinkingParams; result: AgentSetThinkingResult };

  // ---- model.*：模型与图片模型（F-F3 / F-F4 / F-F7 / F-B8）----
  /** F-F3 / F-B7：模型清单（出厂托管 vs 自定义、两条阈值、思考档位、可用性）。 */
  "model.list": { params: ModelListParams; result: ModelListResult };
  /** F-F4 / D6：图片模型与默认图片模型。 */
  "model.listImages": { params: NoParams; result: ModelListImagesResult };
  /** F-F3：新建模型（建出来即自定义）。 */
  "model.create": { params: ModelCreateParams; result: ModelCreateResult };
  /** F-F3：编辑模型（编辑即转自定义）。 */
  "model.update": { params: ModelUpdateParams; result: ModelUpdateResult };
  /** F-F2 / F-F7：删除模型；被引用时禁删并列出引用者。 */
  "model.delete": { params: ModelDeleteParams; result: ModelDeleteResult };
  /** F-F3：恢复出厂（整条替换）。 */
  "model.restoreFactory": { params: ModelRestoreFactoryParams; result: ModelRestoreFactoryResult };
  /** F-F4：图片模型的创建与修改。 */
  "model.saveImage": { params: ModelSaveImageParams; result: ModelSaveImageResult };
  /** F-F4 / F-F7：删除图片模型；被默认项引用时禁删。 */
  "model.deleteImage": { params: ModelDeleteImageParams; result: ModelDeleteImageResult };

  // ---- credential.*：凭证多串（L11 / F-E4）----
  /** L11 / F-E4（§4 未单列）：凭证可列出（带备注与吊销状态）。 */
  "credential.list": { params: NoParams; result: CredentialListResult };
  /** L11 / F-E4（§4 未单列）：新建一串（明文只回这一次，权限相同）。 */
  "credential.create": { params: CredentialCreateParams; result: CredentialCreateResult };
  /** L11 / F-E4（§4 未单列）：单独吊销一串。 */
  "credential.revoke": { params: CredentialRevokeParams; result: CredentialRevokeResult };

  // ---- asset.*：上传入口（D5 / F-H8 / A11）----
  /** D5 / F-H8 / A11：上传第一段，声明总长与类型，超限当场拒。 */
  "asset.begin": { params: AssetBeginParams; result: AssetBeginResult };
  /** F-H8 / A11：上传第三段，校验长度与摘要后变成可引用的素材。 */
  "asset.end": { params: AssetEndParams; result: AssetEndResult };

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
  "server.hello",
  "server.version",
  "server.upgrade",
  "server.shutdown",
  "server.usage",
  "server.capabilities",
  "server.setLanguage",
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
  "config.patchMcps",
  "config.saveEndpoint",
  "config.deleteEndpoint",
  "agent.list",
  "agent.get",
  "agent.create",
  "agent.update",
  "agent.delete",
  "agent.setModel",
  "agent.setThinking",
  "model.list",
  "model.listImages",
  "model.create",
  "model.update",
  "model.delete",
  "model.restoreFactory",
  "model.saveImage",
  "model.deleteImage",
  "credential.list",
  "credential.create",
  "credential.revoke",
  "asset.begin",
  "asset.end",
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

/** 方法名属于哪个域（`conversation.send` → `conversation`） */
export function methodDomain(method: MethodName): MethodDomain {
  return method.slice(0, method.indexOf(".")) as MethodDomain;
}
