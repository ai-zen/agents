/**
 * `ChatRunner` —— 一段对话一条**常驻桥**（PLAN §5）。
 *
 * ## 这里没有「轮」
 *
 * 事件驱动的 agent 是**乱序受理**多方输入的：用户、别的会话、定时器、外部程序，谁都能在任何
 * 时刻往它的队列里塞。所以不存在「轮」这种东西 —— 没有一次运行可以被开始、被产出、被结算、
 * 被领结果。凡是需要先回答「谁发起的 / 什么时候算完 / 结果交给谁」才能成立的代码，在这里一句
 * 都没有；它们不是被改了名，是被删了。
 *
 * 于是本文件的结构小得反常：
 *
 * ```
 * 投递进来  → 判两件（对话在不在、agent 活不活）→ 塞进队列 → 回执只有消息 id
 * 事件到了  → 来一条处理一条：写库 + 推出去（不攒、不等「一圈收口」再统一写）
 * 变闲那一刻 → 先把写挂干净 → 让注册表看一眼要不要换人 → 报「闲了」→ onIdle 读一次当下事实
 * ```
 *
 * ## 三个口（对外只有这三个）
 *
 * | 口 | 干什么 | 不等什么 |
 * |---|---|---|
 * | {@link ChatRunner.deliver} | 把一条内容塞进某段对话的队列 | 不等它被处理（`await` 的边界就是「已入队」） |
 * | {@link ChatRunner.abort} | 掐掉活着的 agent 手上那一批（落在「暂停」格，不是杀死） | —— |
 * | {@link ChatRunner.state} | 现读四格 + 待办 | 不落库、不推算、不存镜像 |
 *
 * 另外三件是**结构性**的，不属于「投递 / 中断 / 观测」那条路：`forget`（对话或项目被删）、
 * `killScope`（整个 Scope 被处置）、`reconcile`（装载即修复）。
 *
 * ## 状态只有四格，而且全是读出来的
 *
 * 忙 / 闲 / 暂停是 agent 身上那一格（core 的 `AgentNS.AgentState`），**死 = 连 agent 对象都
 * 没有、手上也没有排着的投递**。宿主不维护「请求中 / 思考中 / 输出中」，不算用量、不算速率 ——
 * 那些由客户端按到达的事件自己推（PRD 硬规矩 7）。
 *
 * 装配窗口是唯一的例外：那一刻 agent 还没装好，但已经缓冲了 N 条投递 —— 它们确实排着，所以
 * 报 `busy`（不是 `dead`）。真的没有 agent、也没有缓冲，才是死。
 *
 * ## 常驻桥（{@link ConversationBridge}）：生与灭
 *
 * 一段对话一个 agent，一个 agent 一条桥。桥只做两件事：**把订在 agent 上的事件照着写库、照着
 * 推出去**，以及**把握在手上的那几条投递推进队列**。它没有 `done` promise、没有 `settle()`、
 * 没有「这一轮的产出清单」—— 那些都是「轮」的零件。
 *
 * - **生**：{@link ChatRunner.deliver} 第一次需要它时（那段对话还没有 agent，或者手里那个已经
 *   换了人）创建，就地（同步）把监听订在 agent 上 —— agent 一被叫醒就立刻广播消息，迟一拍
 *   就漏。
 * - **灭**：agent 退役（`AgentRegistry` 的 `retired`）/ 被 kill / `forget` / `killScope` 时，
 *   先 `flushWrites()` 再摘监听、丢引用，**并且补报一条 `state: dead`**。灭 = 这段对话没有
 *   agent 了，客户端必须知道：`stopped` / `killed` 是 core 自己说的那两种，退役（`retired`
 *   的五种理由）也一样让 agent 从账上消失 —— 不补这一条，界面就一直停在上一格「闲」。
 *   同一次死亡只发一条。
 *
 * `bridges` 是**唯一**一张现场表：它记的恰好是「这段对话此刻有没有桥」，而桥在不在 = agent
 * 在不在（两者严丝合缝，所以不需要第二份账）。
 *
 * ## 投递的两样东西由调用方给
 *
 * `deliver` 收的是 `{ content, source, storedContent?, mayStart? }`：
 *
 * - `content` 是**发给模型的那一份**、`storedContent` 是**落库的那一份**（`__asset_id` 形态）；
 * - 两样都由**调用方**（`handlers/conversationHandlers.ts`）准备好再交进来 —— 本文件不自己做
 *   素材准备（选路要问模型与端点，那是素材层的事）。
 *
 * 回执**只有 `userMessageId`**：每张附件最后是怎么走的，由准备它的调用方回报给客户端 ——
 * 同一句话不在这里出第二处。
 *
 * 本文件保留的注入点只剩两个，它们都不是「这一次发送」的事：`prepareHistory`（装配 agent 时
 * 把历史里的 `__asset_id` 按**当前**模型还原）与 `linkMessageAssets`（消息落库那一刻登记素材
 * 关系行）。
 *
 * ## 写库 = 同一个镜子的另一份
 *
 * `messageAdded` / `messageChanged` / `responseFinished` 到了就写那一行，`messageRemoved` 到了
 * 就删。边流边写只是**节流**，不是「提前写」；**没有「最后统一写一遍」** —— 那等于假设有一个
 * 终局。崩溃恢复靠 {@link ChatRunner.reconcile}（装载即修复），不靠终局那一笔。
 *
 * 两处**不写库**，各有各的理由：
 *
 * - **子 agent 的消息一律不落库**（`CORE.md` §17 / PLAN §7）。子 agent 本质是一次同步工具
 *   调用，「恢复它」等于恢复一个跑到一半的工具调用 —— 副作用已经发生、不能重滚也不能重放，
 *   而工具调用这个抽象里没有「恢复」。所以它的话只在它自己那个对象里，要查就顺
 *   {@link ChatRunner.messagesOf} 的 `toolCallId` 那条路取；事件照推，客户端那几栏照样拼
 *   得起来（事件是客户端重建的唯一来源）。
 * - **交接态下只跳过写库**（PLAN §5.3）：写文档期间产生的消息不进库（它们马上要随旧记忆
 *   一起被替掉），但 `message.added` / `message.delta` / `message.changed` / `message.removed`
 *   **照推** —— 用户得看得见它在写。开关是 {@link ChatRunner.beginHandoff} /
 *   {@link ChatRunner.endHandoff}。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import {
  AgentError,
  AgentNS as AgentNSValue,
  inboxEntryContent,
  reconcileAbortedMessages,
  reconcileAbortedToolRounds,
} from "@ai-zen/agents-core";
import type { Agent, AgentEvents } from "@ai-zen/agents-core";
import type {
  AgentDefinition,
  AppConfig,
  HandoffService,
  Model,
  ModelParams,
  ReasoningPresets,
  Scope,
} from "@ai-zen/agents-sdk";
import {
  AgentRepository,
  AutoMigratePlugin,
  AutoRefreshToolsPlugin,
  ContextGuardPlugin,
  createAgent,
  SubAgentGuardInstallerPlugin,
  UnknownToolHintPlugin,
} from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language, MessageKey } from "../i18n/index.js";
import type { Conversation, MessageUpsertInput, StoredMessage } from "../storage/types.js";
import { HostError } from "../wire/errors.js";
import type { EventMap, EventName } from "../wire/events.js";
import type {
  AttachmentOutcome,
  CompactionMode,
  ConversationStatus,
  InboxItem,
  MessageInput,
  ProblemFact,
} from "../wire/states.js";
import type { AgentRegistry } from "./AgentRegistry.js";
import type { Clock, ScopeRegistry } from "./ScopeRegistry.js";
import { systemClock } from "./ScopeRegistry.js";

// ---------------------------------------------------------------------------
// 注入点（形状即契约，测试与接线层都按它做替身）
// ---------------------------------------------------------------------------

/** 消息仓储里本文件用到的部分（`MessageRepository` 结构上满足） */
export interface MessageStore {
  upsert(input: MessageUpsertInput): Promise<void>;
  upsertMany(inputs: MessageUpsertInput[]): Promise<void>;
  /**
   * 物理删掉一条消息（core 的「丢」= 真删，`CORE.md` §6）。
   *
   * `messageRemoved` 的落点：core 在一圈开头修历史时删掉的残局，库里也必须消失 ——
   * 否则用户会看见一条模型那边已经不存在的消息。
   */
  delete(id: string): Promise<void>;
  /**
   * 按对话取主线消息。
   *
   * 历史装载传 `includeHidden`（`hidden` 的消息也在模型的上下文里，只是不给人看）；
   * 其余用途默认只要用户看得到的那部分。
   */
  listByConversation(
    conversationId: string,
    after?: string,
    options?: { includeHidden?: boolean },
  ): Promise<StoredMessage[]>;
}

/** 对话仓储里本文件用到的部分（`ConversationRepository` 结构上满足） */
export interface ConversationStore {
  get(id: string): Promise<Conversation | undefined>;
}

/** 推事件：接线层把它变成 JSON-RPC 通知（`WsHub.push`） */
export type ChatEventEmitter = <E extends EventName>(name: E, payload: EventMap[E]) => void;

/**
 * 装配 agent 时交给工厂的事实。
 *
 * 模型和助手的解析口径在 SDK 里（`createAgent` 三级解析：会话级 > 助手定义 > 全局兜底），
 * 所以这里只给 id 与 Scope，不给「用哪个模型」的结论。
 */
export interface AgentBuildContext {
  conversationId: string;
  workspaceId: string;
  /** 这段对话创建时定死的助手（PRD L7） */
  agentId: string;
  /** 这段会话现在用的模型（存在会话行上）；`null` 时交给 SDK 三级解析 */
  modelId: string | null;
  /**
   * 这段会话选的思考档位名（存在会话行上）；`null` = 跟随助手定义上的那份参数。
   *
   * 存名不存参数：档位属于模型，同名档位在不同模型的策略表里对应不同参数，展开在装配这一刻做。
   */
  thinkingLevel: string | null;
  scope: Scope;
  /** 装配之前的库内历史（core 原样消息），工厂可以把它当作给 agent 的初始消息 */
  history: AgentNS.Message[];
}

/** 造 agent。测试注入假 agent，生产用 `createSdkAgentFactory()` */
export type AgentFactory = (context: AgentBuildContext) => Promise<ChatAgent>;

/**
 * 交接服务（SDK 口径）按装配事实现场取一个。
 *
 * 给 `undefined` 就是「这段对话不装交接线插件」（装卸点会推一条警告，不静默）。
 */
export type HandoffProvider = (context: AgentBuildContext) => HandoffService | undefined;

/**
 * 三格变化（core 的 `state:busy` / `state:idle` / `state:paused`）的观察形状。
 *
 * core 的载荷是 `{ agent, from }`：`agent` 有了，但「哪段对话」只有宿主知道 —— 于是由
 * `AgentRegistry`（它按 conversationId 登记）在转达时补上这一格。
 *
 * 它**不表达死没死**：死 = 没有 agent 对象（`state()` 现读）。
 */
export interface AgentStateEvent {
  conversationId: string;
  agent: ChatAgent;
  /** 变化前的三格 */
  from: AgentNS.AgentState;
  /** 变化后的三格（`busy` / `idle` / `paused`） */
  to: AgentNS.AgentState;
}

/**
 * 本文件驱动的那个 agent —— **就是 core 的 `Agent` 本身**（`SdkAgent` extends 它）。
 *
 * 从前这里是一份宿主自己写的窄接口，把 core 的 `Agent` 挡在后面：于是 `agent.push()` /
 * `agent.on()` 这些调用**根本不受类型检查**，`tsc` 一条也报不出来。那一层挡板就是这类 bug
 * 的温床，现在去掉了：宿主只认 core 的真实形状，假件（`TestSupport.FakeAgent`）也必须是真
 * `Agent`。
 */
export type ChatAgent = Agent;

/**
 * 把已上传的素材变成真正发出去的内容段（PRD F-H7）。
 *
 * **本文件不再用这个口**（那一步搬到了调用方：发一次话的素材选路在
 * `handlers/conversationHandlers.ts` 那一层，它拿着这份产物里的 `content` / `storedContent`
 * 投递进来，`attachments` 那份结局由它自己回报给客户端）。类型留在这里，是因为它还描述着
 * 「一次发送的素材产物」那个形状，`AssetService.prepareAttachments` 的返回值就是它。
 */
export interface AttachmentPreparation {
  /** 真正发给模型的内容（已按实发模型换成文件引用 / 内联 / 文字） */
  content: AgentNS.MessageContent;
  attachments: AttachmentOutcome[];
  /**
   * 落库用的内容（消息里只存我们自己的引用：段上的 `__asset_id`）。
   *
   * 不给时落库的就是 `content`：不是每个注入方都有「厂商产物不能进库」这回事。
   */
  storedContent?: AgentNS.MessageContent;
}

/** 素材准备（F-H7 的选路）—— 调用方那一侧的口子，本文件只留类型 */
export type AttachmentPreparer = (context: {
  conversationId: string;
  agentId: string;
  modelId: string | null;
  input: MessageInput;
}) => Promise<AttachmentPreparation>;

/**
 * 历史里的素材引用还原成当前模型能吃的内容段（PRD F-H7）：**装配 agent 之前**跑一次。
 *
 * 为什么每次装配都要跑：能不能吃跟着实发模型 / 端点变，而历史里存的是与端点无关的
 * `__asset_id`。不给就原样把历史交给 agent。
 */
export type AttachmentHistoryResolver = (context: {
  conversationId: string;
  modelId: string | null;
  messages: AgentNS.Message[];
}) => Promise<AgentNS.Message[]>;

/**
 * 消息落库那一刻登记「这条消息引用了哪些素材」（`conversation_assets` 关系行）。
 *
 * 扫的是**落库的那一份内容**（段上的 `__asset_id`），所以调用点紧跟用户消息的 upsert；
 * 不注入时关系行就不记（引用计数少一份，删字节会晚一步）。
 */
export type MessageAssetLinker = (context: {
  conversationId: string;
  messageId: string;
  content: AgentNS.MessageContent | undefined;
}) => Promise<number>;

/**
 * 一次投递的入参。
 *
 * 只有两样是必给的：`content`（发给模型的那一份）与 `source`（谁说的）。其余两样都是特定那条
 * 路的产物：
 *
 * - `storedContent`：**落库那一份**（`__asset_id` 形态）。不给就用 `content`；
 * - `mayStart`：**允许把它叫起来**（给这段对话装上驱动者）。只有两个创建者给 `true` ——
 *   界面上的发送按钮、刚建出来的那段会话的第一句；其它来源给了也白给（这里只认 `true`，
 *   不认「真值」）。
 *
 * **这里没有 `attachments`**：回执只有 `userMessageId`，每张附件最后是怎么走的由准备它的调用方
 * （`conversation.send` 的 handler）回报给客户端 —— 同一句话不许有两个出处。
 */
export interface DeliveryInput {
  content: AgentNS.MessageContent;
  /** core 的判别结构：`{kind:"user"}` = 用户本人（不加来源注释），其余由 core 落地时加注释 */
  source: AgentNS.MessageSource;
  /** 落库那一份（`__asset_id` 形态）；不给就用 content。注释同样要过 `withSourceNote` */
  storedContent?: AgentNS.MessageContent;
  /**
   * **允许把它叫起来**（给这段对话装上驱动者）。
   *
   * 只有两个创建者给 `true`：界面上的发送按钮、刚建出来的那段会话的第一句。其它来源
   * （`postMessage`、定时器、外部程序）一律不给 —— 死对话叫不醒。
   */
  mayStart?: boolean;
}

/** 装载/重启后的修复结果 */
export interface ReconcileResult {
  /** 修好之后的消息（顺序即对话顺序，core 原样） */
  messages: AgentNS.Message[];
  /** 被改写的消息 id（状态或 `omit` 变了） */
  repairedIds: string[];
}

/**
 * 子 agent 那一栏的一行（{@link ConversationReadout.subAgents}）。
 *
 * `state` 取子 agent 自己的三格（`busy` / `idle` / `paused`），或者 `ended` —— 两者取后者更诚实：
 * 一次性子 agent 跑完后那个格会停在 `idle`，把已经散场的东西报成「闲」等于告诉界面它还在。
 * 所以只要名册上有了 `endedAt`，这里就是 `ended`。
 */
export interface SubAgentReadout {
  /** 委派那次工具调用的 id（客户端靠它分栏，也是 `messagesOf` 的入参） */
  toolCallId: string;
  /** 这次委派用的工具名 */
  name: string;
  state: AgentNS.AgentState | "ended";
}

/**
 * 一段对话此刻的读数（{@link ChatRunner.state} 的返回）。
 *
 * 四个字段全是**现读**：三格读 agent、待办读队列、名册读 core 的登记、交接读本文件那张标记表。
 * 没有一份是对别的什么东西的副本，所以也没有「什么时候刷新」这回事。
 */
export interface ConversationReadout {
  status: ConversationStatus;
  inbox: InboxItem[];
  /** 本批派出去的子 agent（现读 core 名册：派遣加项、结束只填 `endedAt`、外循环每批开头清空） */
  subAgents: SubAgentReadout[];
  /** 在交接态就是开始时刻；不在就是 `null` */
  handoff: { since: string } | null;
}

export interface ChatRunnerOptions {
  messages: MessageStore;
  conversations: ConversationStore;
  /**
   * Scope 的持有者（能力容器）。
   *
   * 本文件只用它的 `create`（装配 agent 之前确保这段对话的 Scope 存在）。销毁 Scope 不是投递
   * 的事：它活到显式 `dispose` 或进程退出。
   */
  scopes: ScopeRegistry;
  /**
   * agent 存活管理的唯一拥有者（它是「agent 唯一的来源」）。
   *
   * 拿（`acquire`：在且合用就复用，不在 / 不合用就装配）、变闲那一刻（`complete`：陈旧才退役）、
   * 对话被删（`kill`：硬着陆）、配置生效（`invalidate`）、收尾（`disposeAll`）都走它。
   * 本文件既不看别的账本判「在不在跑」，也不自己判「复不复用」。
   */
  agents: AgentRegistry;
  emit: ChatEventEmitter;
  clock?: Clock;
  /** 宿主分配消息 id；缺省用 `crypto.randomUUID` */
  newId?: () => string;
  /** 边流边写的节流时长（毫秒）；0 表示每到一片就写一次 */
  streamWriteIntervalMs?: number;
  /**
   * 历史里的素材引用 → 当前模型能吃的段（F-H7）。不给时历史原样交给 agent。
   *
   * 它只发生在**装配 agent 之前**（「这一次发送」的素材选路不在本文件，见 `DeliveryInput`）。
   */
  prepareHistory?: AttachmentHistoryResolver;
  /** 消息落库那一刻登记素材关系行（`conversation_assets`）。不注入就不记。 */
  linkMessageAssets?: MessageAssetLinker;
  /**
   * 一段变闲了（core 的 `state:idle`）。全宿主**唯一**一处「到点了要考虑点什么」的入口。
   *
   * 里面做一次读当下事实的判断（派生会话？越软线？挂着题？→ 问交接，那件事在 `app.ts`）。
   *
   * **这一跳不是「结算回调」**：它只是「此刻它闲了」，一毫秒后又来一条投递就又是忙。它不带
   * 任何「结果」—— 没有产出清单、没有结局、没有用量。
   */
  onIdle?: (conversationId: string) => void;
  /** 内部错误的去处（写库失败、装配失败等）；缺省忽略 */
  onError?: (error: unknown, context: string) => void;
  /**
   * 三格变化的对外观察口（接线层用它把「这段开始干活了」告诉别人，例如平级会话的状态）。
   *
   * 这一项只是**多一路旁听**：本文件内部不靠它做任何判断（事件自己会走桥）。
   */
  onState?: (event: AgentStateEvent) => void;
}

/** 边流边写的缺省节流：200ms 一次，兼顾「客户端断了丢得少」与「写盘次数」 */
export const DEFAULT_STREAM_WRITE_INTERVAL_MS = 200;

// ---------------------------------------------------------------------------
// 来源（core 的判别结构）
// ---------------------------------------------------------------------------

/** 唯一一个不需要加来源注释的 source：用户本人说的话（core 的 `{ kind: "user" }`） */
const SOURCE_USER: AgentNS.MessageSource = { kind: "user" };

/** 这条来源要不要在正文前面加一行「自动推送」注释（`{ kind: "user" }` 不加） */
function needsNote(source: AgentNS.MessageSource | undefined): boolean {
  return source !== undefined && source.kind !== "user";
}

/**
 * 正文按来源包一层：`{ kind: "user" }`（或缺省）原样返回，其他来源在正文最前面加一行
 * `// 这条消息来自 <label> 自动推送（<时间>）`。
 *
 * 拼装不在这里写第二遍：注释的形状（`注释\n\n正文` / 分段内容在最前面插一段 text）归 core 的
 * `inboxEntryContent`，宿主只是把同一个纯函数用在「宿主自己写落库那一份」这条路上 —— 于是
 * 自动推送的消息不论从 inbox 落地还是从库里读回来，读者看到的是同一行话。
 */
function withSourceNote(
  content: AgentNS.MessageContent,
  source: AgentNS.MessageSource | undefined,
  messageId: string,
  createdAt: string,
): AgentNS.MessageContent {
  if (!needsNote(source)) return content;
  return inboxEntryContent({
    messageId,
    source: source!,
    priority: "high",
    content,
    createdAt,
  });
}

// ---------------------------------------------------------------------------
// core 消息 ⇄ 存储行
// ---------------------------------------------------------------------------

const ROLES: ReadonlySet<string> = new Set(Object.values(AgentNSValue.Role));
const STATUSES: ReadonlySet<string> = new Set(Object.values(AgentNSValue.MessageStatus));

function toRole(value: string): AgentNS.Role {
  return ROLES.has(value) ? (value as AgentNS.Role) : AgentNSValue.Role.Unknown;
}

function toStatus(value: string): AgentNS.MessageStatus {
  return STATUSES.has(value) ? (value as AgentNS.MessageStatus) : AgentNSValue.MessageStatus.Unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `events.on(...)` 的返回值 → 取消订阅的函数。
 *
 * core 的 `EventBus.on` 返回一个 `Disposable`（`{ dispose() }`），测试里的记账总线返回函数。
 * 两种都接住：桥是常驻的，「订上去就不能不管」是硬要求，所以这里不假设只有一种形状，但也不把
 * 三种形状写进公开接口。
 */
function toUnsubscribe(handle: unknown): (() => void) | undefined {
  if (typeof handle === "function") return handle as () => void;
  if (isRecord(handle) && typeof handle.dispose === "function") {
    const disposable = handle as { dispose: () => void };
    return () => disposable.dispose();
  }
  return undefined;
}

/** 从 `data` 列里认出 core 的用量（三个数字都在才算） */
function toUsage(value: unknown): AgentNS.Usage | undefined {
  if (!isRecord(value)) return undefined;
  const { prompt_tokens, completion_tokens, total_tokens } = value;
  if (
    typeof prompt_tokens !== "number" ||
    typeof completion_tokens !== "number" ||
    typeof total_tokens !== "number"
  ) {
    return undefined;
  }
  return { prompt_tokens, completion_tokens, total_tokens };
}

/**
 * 会话创建时那条 cwd 消息的正文（PRD F-D9：告诉模型「当前目录是哪儿」）。
 *
 * 这条消息在对话落库时写一次，之后不再重写、也不随每条消息拼接（说了两遍模型会以为目录变了）。
 * 目录取的是这个对话所属项目的 cwd（不是进程工作目录）；句子用的是「这是宿主加的，不是用户
 * 输入的」那条文案（R21：不新造消息类型）。
 */
export function injectedContextOf(cwd: string, language: Language): string {
  const summary = render(language, "message.injectedContext.cwd", { cwd });
  return render(language, "message.injectedContext", { summary });
}

/**
 * 消息 → 一行库。
 *
 * `content` 走 JSON 列：存储层的 `content` 列就是 core 内容段的 JSON，两边的形状一致，
 * 只差存储层为了「不 import core」而声明的索引签名，故此处做一次显式转换。
 *
 * `data.error` 是**回显用的失败事实**（`ProblemFact`：码 + 文案键 + 参数 + 一句现成的话）：
 * 它跟着消息行落库，活得比进程长（PRD 4.15）；完整错误对象走 `error` 事件，两路不互相替代。
 */
function toRow(
  message: AgentNS.Message,
  conversationId: string,
  createdAt: number,
  extra: { parentToolCallId?: string; problem?: ProblemFact } = {},
): MessageUpsertInput {
  const data: Record<string, unknown> = {};
  if (message.tool_calls) data.tool_calls = message.tool_calls;
  if (message.function_call) data.function_call = message.function_call;
  if (message.tool_call_id !== undefined) data.tool_call_id = message.tool_call_id;
  if (message.name !== undefined) data.name = message.name;
  if (message.reasoning_content !== undefined) data.reasoning_content = message.reasoning_content;
  if (message.usage) data.usage = message.usage;
  if (message.subAgentUsage) data.subAgentUsage = message.subAgentUsage;
  if (message.finish_reason !== undefined) data.finish_reason = message.finish_reason;
  if (message.hidden !== undefined) data.hidden = message.hidden;
  if (extra.problem !== undefined) data.error = extra.problem;

  return {
    id: message.id,
    conversationId,
    role: message.role,
    status: (message.status ?? AgentNSValue.MessageStatus.Unknown) as string,
    omit: message.omit === true,
    content: (message.content ?? null) as unknown as MessageUpsertInput["content"],
    // 来源是 core 的判别结构：仓储那边序列化成 JSON 存在 `source` 列里
    source: message.source ?? null,
    data: Object.keys(data).length > 0 ? data : null,
    parentToolCallId: extra.parentToolCallId ?? null,
    createdAt,
  };
}

/** 存储行 → core 消息（缺的字段让它缺，不补空值：core 用 `undefined` 表示「没有」） */
function fromRow(row: StoredMessage): AgentNS.Message {
  const data = row.data ?? {};
  const message: AgentNS.Message = {
    id: row.id,
    role: toRole(row.role),
    status: toStatus(row.status),
  };
  if (row.content !== null) {
    message.content = row.content as unknown as AgentNS.MessageContent;
  }
  if (Array.isArray(data.tool_calls)) {
    message.tool_calls = data.tool_calls as AgentNS.ToolCall[];
  }
  if (isRecord(data.function_call)) {
    message.function_call = data.function_call as AgentNS.FunctionCall;
  }
  if (typeof data.tool_call_id === "string") message.tool_call_id = data.tool_call_id;
  if (typeof data.name === "string") message.name = data.name;
  if (typeof data.reasoning_content === "string") {
    message.reasoning_content = data.reasoning_content;
  }
  const usage = toUsage(data.usage);
  if (usage) message.usage = usage;
  const subAgentUsage = toUsage(data.subAgentUsage);
  if (subAgentUsage) message.subAgentUsage = subAgentUsage;
  if (typeof data.finish_reason === "string") {
    message.finish_reason = data.finish_reason as AgentNS.FinishReason;
  }
  if (typeof data.hidden === "boolean") message.hidden = data.hidden;
  // `source` 是判别结构（不是字符串）：仓储已经把那一列反序列化好了，这里原样搬
  if (row.source) message.source = row.source;
  message.omit = row.omit;
  return message;
}

// ---------------------------------------------------------------------------
// 失败事实（ProblemFact：码 + 文案键 + 参数 + 一句已渲染的话）
// ---------------------------------------------------------------------------

/**
 * 造一条失败事实。
 *
 * `message` 用缺省语言渲染一份：落库/推送里总要有一句现成的话给日志和排查用；
 * 真正面向某个连接的语言由接线层按 `code` / `messageKey` / `params` 重新渲染（PLAN §8）。
 */
function problem(
  code: string,
  messageKey: MessageKey,
  params: Record<string, unknown> = {},
  detail?: unknown,
): ProblemFact {
  const fact: ProblemFact = {
    code,
    messageKey,
    params,
    message: render(DEFAULT_LANGUAGE, messageKey, params),
  };
  if (detail !== undefined) fact.detail = detail;
  return fact;
}

/**
 * `denied` 的 `detail` 里认一下上下文护栏的结构事实（`promptTokens` / `guardTokens`）。
 *
 * 为什么不能只看 `reason`：那一格是写给**模型或人**读的文案。护栏到底因为哪两个数字拒的，
 * 只能从结构化的 `detail` 里读 —— 去 parse 句子就是 `CORE.md` §10 明确说的那条邪路。
 */
function asContextOverflowDetail(
  detail: unknown,
): { promptTokens: number; guardTokens: number } | undefined {
  if (!isRecord(detail)) return undefined;
  const { promptTokens, guardTokens } = detail;
  if (typeof promptTokens !== "number" || typeof guardTokens !== "number") return undefined;
  return { promptTokens, guardTokens };
}

/** 任意抛出物 → 失败事实：core 的 `AgentError` 带上它的 `code`，其余都归为内部错误 + 原始原因 */
function toProblem(error: unknown): ProblemFact {
  if (error instanceof AgentError) {
    return problem("internal", "error.internal", {}, { reason: error.message, code: error.code });
  }
  const reason = error instanceof Error ? error.message : String(error);
  return problem("internal", "error.internal", {}, { reason });
}

/**
 * 一个钩子拒了这一圈 → 失败事实（core 的 `denied` 事件）。
 *
 * 两格分开读：`reason` 是写给模型 / 人读的文案，`detail` 才是给程序看的结构化事实。
 * 宿主按「是不是上下文溢出」分流 —— 判据是 `detail` 里的两个数字，不是文案里那几个词。
 *
 * `detail` 里没有那两个数字时（例如护栏只交回了一句现成的话）落到 `denied`：
 * 这一条说的是「这一次压根没发出去，被拦下了」，不是「宿主内部出错」。
 */
function toDeniedProblem(reason: string, detail: unknown): ProblemFact {
  const overflow = asContextOverflowDetail(detail);
  if (overflow) {
    return problem(
      "context_guard",
      "error.contextGuard",
      { limit: overflow.guardTokens, used: overflow.promptTokens },
      { ...overflow, reason },
    );
  }
  return problem("denied", "error.denied", { reason }, detail ?? { reason });
}

// ---------------------------------------------------------------------------
// 排队区（现读）
// ---------------------------------------------------------------------------

/** 排队条目摘要的长度上限（`preview` 是一行，客户端不滚动） */
const INBOX_PREVIEW_LIMIT = 120;

/** 一条真实的入参 → 排队区那一行（每一条都带正文：钥匙不往这里塞） */
function toInboxItem(input: DeliveryEntryInput, createdAt: string): InboxItem {
  return {
    messageId: input.messageId ?? "",
    source: input.source,
    createdAt,
    preview: inboxPreview(input.content),
  };
}

/**
 * 排队条目的一行摘要：文本按顺序拼接，非文本段记成 `[图片]` / `[文件]`，最后折叠空白 + 截断。
 *
 * 排队区里不能带 `content` 原文：段里可能装着图片/文件的原始数据，搬原文等于每读一次状态就
 * 重发一遍附件。钥匙（没有正文的条目）不进来 —— 它不是一句话。
 */
function inboxPreview(content: AgentNS.MessageContent): string {
  if (typeof content === "string") return clampPreview(content);
  const parts: string[] = [];
  for (const section of content) {
    if (section.type === "text") parts.push(section.text);
    else if (section.type === "image_url") parts.push("[图片]");
    else parts.push("[文件]");
  }
  return clampPreview(parts.join(" "));
}

/** 连续空白折叠成单空格并 trim；超过上限截断并补 `…` */
function clampPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const chars = [...collapsed];
  return chars.length > INBOX_PREVIEW_LIMIT
    ? `${chars.slice(0, INBOX_PREVIEW_LIMIT).join("")}…`
    : collapsed;
}

/**
 * 排队区：**当场问 core 要**（`agent.inboxPending`：按入队顺序给出此刻还没被取走的条目，一个都
 * 不取走），不存任何镜像。
 *
 * 为何不存镜像：core 在**取走**条目时发的 `inboxTaken` 也能接，但钥匙被取走时没有正文、没有
 * 消息可对 —— 只要丢一条事件，镜像就与真队列永久分叉，而它又没法重读自愈（真相只在 core 手里）。
 *
 * **钥匙（`InboxKey`）不列进来**：`InboxItem` 的每一格都是一句「还没落地的话」—— 钥匙不落地、
 * 没有正文、也没有 `source`，硬塞进去只能给它编一个假 id，客户端就会画出一条永远不会落地的
 * 空气消息。
 */
function inboxItemsOf(agent: ChatAgent): InboxItem[] {
  const items: InboxItem[] = [];
  for (const entry of agent.inboxPending) {
    // `InboxEntry` 是联合类型：先收窄，才能取 `messageId` / `source` / 正文
    if (entry.content === undefined) continue;
    items.push({
      messageId: entry.messageId ?? "",
      source: entry.source,
      createdAt: entry.createdAt,
      preview: inboxPreview(entry.content),
    });
  }
  return items;
}

/** 宿主分配 id 的缺省实现（Node 19+ 有 `crypto.randomUUID`） */
function defaultNewId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** core 广播的原始 chunk 里本文件用到的部分（`choices[0].delta` 就是 `AgentNS.Delta`） */
interface RawChunk {
  choices?: Array<{ delta?: AgentNS.Delta; finish_reason?: string | null }>;
}

// ---------------------------------------------------------------------------
// 一条投递
// ---------------------------------------------------------------------------

/**
 * 推进 core 队列的那份入参（`createdAt` 由 core 在 `push` 那一刻盖）。
 *
 * 这里刻意不用 `AgentNS.InboxInput`：那是「带正文 / 拧钥匙」的联合类型，而本文件推的每一条都
 * 带着正文（钥匙是 core 自己的事，宿主从不拧）。收窄之后才读得到 `messageId` / `source`。
 */
type DeliveryEntryInput = Omit<AgentNS.InboxEntryWithContent, "createdAt">;

/**
 * 一条等着被取走的投递：推进 core 的入参 + 宿主替它记的那两样。
 *
 * `createdAt` 单独存一份是因为 `AgentNS.InboxInput` 没这一格（core 在 `push` 那一刻才盖时间戳），
 * 而排队区每一行都带着「入队时刻」。它**不是**排队区的镜像：条目进了 core 的队列之后，
 * 排队区一律现读 `agent.inboxPending`。
 */
interface QueuedEntry {
  input: DeliveryEntryInput;
  createdAt: string;
  /** 落库那一份（`__asset_id` 形态，已过 `withSourceNote`）；只在这条消息落地时用一次 */
  storedContent?: AgentNS.MessageContent;
}

// ---------------------------------------------------------------------------
// 一段对话的桥
// ---------------------------------------------------------------------------

/**
 * 一段对话的常驻桥：**订在 agent 上的监听** + **它自己那条写库链**。
 *
 * 一条桥活多久 = 那个 agent 活多久（agent 常驻，桥就常驻）。它没有「这一次」的概念：
 *
 * - 没有 `done` promise / `settle()` / `finished` / 产出清单 —— 只有两个布尔记着「这条桥被拆了没
 *   有」与「『死』那一格报过没有」，那是它自己的生死，不是任何一次「运行」的生死；
 * - 没有历史副本、没有开始时刻、没有计数 —— 那些都得先有一个「一次运行」才说得通；
 * - 不存排队区：要报排队区就读 `agent.inboxPending`。
 *
 * 它只记两样宿主自己算出来的东西：**写库节流的时间戳**与**投递时定下的那两个映射**
 * （消息 id → 落库那份内容、core 自造的消息 → 宿主分配的 id）。
 */
class ConversationBridge {
  readonly conversationId: string;
  readonly agent: ChatAgent;
  private readonly options: ChatRunnerOptions;
  private readonly clock: Clock;
  private readonly newId: () => string;

  /** 订在 agent 上的监听（桥灭时逐个摘掉） */
  private readonly listeners: Array<() => void> = [];
  /** 写库串行链：事件是同步回调，接不住 Promise；串起来才保证落盘顺序 = 事件顺序 */
  private writeChain: Promise<void> = Promise.resolve();
  /** 边流边写的节流计时器（到点把 `streaming` 那一笔写下去） */
  private writeTimer?: () => void;
  private lastWriteAt = 0;
  /** 最近一条正在流式增长的消息（节流到点时写它） */
  private streaming?: AgentNS.Message;

  /** 每条消息内的增量序号（客户端靠它发现漏片） */
  private readonly deltaSeq = new Map<string, number>();
  /** 每条消息第一次出现的时间（库里的 `createdAt`，同一 id 只定一次） */
  private readonly createdAtOf = new Map<string, number>();
  /** 宿主已经认下来的 id（投递带来的 + 自己分配的），再见到就原样用 */
  private readonly knownIds = new Set<string>();
  /** 投递进来、还没落地的消息 id（落地那一刻要用 `queuedStored` 那一份内容写行） */
  private readonly queuedIds = new Set<string>();
  /** 投递条目的**落库那一份**内容（`__asset_id` 形态）：核心看到的是厂商产物，库里要留引用 */
  private readonly queuedStored = new Map<string, AgentNS.MessageContent>();
  /**
   * 子 Agent 的消息 → 宿主分配的 id。
   *
   * 子 agent 的话**不落库**了，但这个映射照旧保留：客户端的 `message.delta` / `message.added`
   * 都是按宿主 id 挂的，`message.removed` 也得按同一个 id 才删得对。id 在第一次见到那条消息时
   * 定死，之后一路用这一个（另给一个，客户端就会把同一条当成两条）。
   */
  private readonly subAgentIds = new WeakMap<AgentNS.Message, string>();

  /** 桥已经被拆了：之后到达的事件一概不再处理（拆到一半还在飞的那些） */
  private closed = false;
  /** 「死」这一格已经报过了（同一次死亡只发一条：`killed` 报过就不重报） */
  private deadAnnounced = false;
  /**
   * 这条桥自己发现「我已经死了」（投递撞上已关门的 agent）时叫它：由持有者丢掉引用。
   *
   * 为什么要叫持有者：桥不在表里，丢引用这件事只有 `ChatRunner` 做得；而桥自己已经把“死”报
   * 出去了（{@link announceDead}），再让两边各记一份「还在不在」就是第二份事实。
   */
  private readonly onDeath: () => void;
  /**
   * 这段对话此刻在不在交接态（问 `ChatRunner`，不在桥里另存一份）。
   *
   * 为什么问外面：交接态是**对话**的属性，而桥会换（agent 被换掉、装配事实变了）。存在桥上的
   * 话，换一条桥就把「正在交接」这一格弄丢了 —— 于是交接写文档期间的那些消息就开始进库。
   */
  private readonly handoffActive: () => boolean;

  constructor(
    options: ChatRunnerOptions,
    conversationId: string,
    agent: ChatAgent,
    onDeath: () => void,
    handoffActive: () => boolean,
  ) {
    this.options = options;
    this.conversationId = conversationId;
    this.agent = agent;
    this.onDeath = onDeath;
    this.handoffActive = handoffActive;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? defaultNewId;
    this.listen();
  }

  /** 桥还在不在（`ChatRunner` 靠它判「这条还能不能推」） */
  get alive(): boolean {
    return !this.closed;
  }

  /**
   * 把一条投递推进 core 的队列。
   *
   * 三件事，顺序不能换：
   *   1. 记下 id 与「落库那一份」—— 落地时 core 会带着同一个 id 回来（D5：客户端先画的那条与
   *      落地的是同一条），那时才知道要写哪一份内容；
   *   2. `push`：**同步入队，立刻返回**；
   *   3. 起来：**`idle` 且还没 `start()` 过**才 `start()`。暂停中不 `resume` —— 暂停是用户的
   *      显式动作，投递只收不取（PRD 4.4）。已经在跑的自己会从队列里取，这里什么都不用做。
   *
   * 关门的 agent 抛的是 core 的 `AgentError("closed")`。那件事在宿主这里只意味着一种处境：
   * **这段对话死了**（已经关门 = 死）。所以它不往投递方手上塞 core 的内部码，而是翻译成
   * `HostError("conversation_dead")`，并顺手把这条桥当已死处理掉（丢引用 + 补一格 `dead`）。
   */
  push(entry: QueuedEntry): void {
    const messageId = entry.input.messageId;
    if (messageId !== undefined) {
      this.knownIds.add(messageId);
      this.queuedIds.add(messageId);
      this.createdAtOf.set(messageId, this.clock.now());
      if (entry.storedContent !== undefined) {
        // 落库那一份也要过**同一个**注释函数：不过这一道，「非 user 来源 + 带附件」的条目就会
        // 分叉 —— 模型看到的那份带注释、库里那份是原始内容。`{kind:"user"}` 时它原样返回。
        this.queuedStored.set(
          messageId,
          withSourceNote(entry.storedContent, entry.input.source, messageId, entry.createdAt),
        );
      }
    }

    try {
      this.agent.push(entry.input);
    } catch (error) {
      if (error instanceof AgentError && error.code === "closed") {
        // 它已经关门 = 死了：投递方该拿到的是「对话不在了」这个码，不是 core 的 `closed`
        this.onDeath();
        throw new HostError("conversation_dead", { cause: error });
      }
      throw error;
    }

    if (this.agent.state === "idle" && !this.agent.started) void this.agent.start();
  }

  /**
   * 灭火：报「死」（还没报过的话），再把挂着的那一笔写干净，最后摘监听、丢引用。
   *
   * 为什么先报「死」：桥灭 = 这段对话没有 agent 了。core 的 `stopped` / `killed` 那条路
   * （{@link onTerminated}）自己会报，同一次死亡不重发；剩下那些灭点（`AgentRegistry` 的
   * `retired`：`stale-on-settle` / `config-changed` / `assembly-facts-changed` /
   * `conversation-deleted` / `shutdown`，以及投递撞上已关的门）没有任何人报过 —— 客户端那一刻
   * 看见的还是「闲」，不补这一条，界面就一直停在那一格。
   *
   * `closed` 先置位是不省的一步：否则「flush 完 → 摘监听」之间到达的事件会排进一条再没人
   * flush 的链上，那一笔就永远停在内存里。
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.announceDead();
    void this.flushWrites()
      .catch((error: unknown) => this.options.onError?.(error, "bridge-flush"))
      .then(() => this.detachListeners());
  }

  /** 排队区（现读 `agent.inboxPending`，一个都不取走） */
  inboxItems(): InboxItem[] {
    return inboxItemsOf(this.agent);
  }

  // -------------------------------------------------------------------------
  // 订阅
  // -------------------------------------------------------------------------

  /**
   * 把 core 的事件接到这条桥上（构造时就订，agent 一被叫醒就会广播）。
   *
   * 订的全是 core 的真事件名：
   *   - `messageAdded` / `messageChanged` / `messageRemoved`：**逐条** upsert / delete；
   *   - `responseFinished`：一次回应结束（那条 assistant 的 status / tool_calls / finish_reason /
   *     usage 都在上面）→ 整条覆盖写 + `message.changed`；
   *   - `delta`：原始片（带着来源：自己的消息 / 某个子 agent 的某个工具调用）；
   *   - `subAgentStarted`：委派边界。子 agent 开局手里的那几条（装好的历史 / 模板）由这里补推
   *     一遍 `message.added` —— 它们不会再触发事件，而事件现在是客户端重建子 agent 那一栏的
   *     **唯一**来源（那些话不落库了，`PLAN §7`）；
   *   - `subAgentFinished` **不订**：结束只改 core 名册上的 `endedAt`，宿主这边没有任何要写、
   *     要推的东西（子 agent 最后那句话已经随着 `message.changed` / `delta` 走过了）。
   *   - `failed` / `denied`：失败与被拒；
   *   - `state:busy` / `state:paused` / `state:idle`：四格里的三格（「死」在桥灭的那一刻报：
   *     `stopped` / `killed` 是其中两种理由，退役 / 关门另两种理由由 `close` 补上）；
   *   - `stopped` / `killed`：agent 没了。
   */
  private listen(): void {
    const agent = this.agent;
    this.on(agent, "messageAdded", (event) =>
      this.onMessageAdded(event.message, event.subAgent, event.via),
    );
    this.on(agent, "messageChanged", (event) =>
      this.onMessageChanged(event.message, event.subAgent, event.via),
    );
    this.on(agent, "messageRemoved", (event) =>
      this.onMessageRemoved(event.message, event.subAgent, event.via),
    );
    this.on(agent, "responseFinished", (event) => this.onResponseFinished(event.message));
    this.on(agent, "delta", (event) => this.onDelta(event));
    this.on(agent, "subAgentStarted", (event) =>
      this.onSubAgentStart(event.subAgent, event.toolCall),
    );
    this.on(agent, "failed", (event) => this.onFailed(event.error, event.message));
    this.on(agent, "denied", (event) => this.onDenied(event));
    this.on(agent, "state:busy", () => this.emitState("busy"));
    this.on(agent, "state:paused", () => this.emitState("paused"));
    this.on(agent, "state:idle", () => this.onIdle());
    this.on(agent, "stopped", () => this.onTerminated());
    this.on(agent, "killed", () => this.onTerminated());
  }

  /** 订一个 core 事件，把「取消订阅」收在 {@link listeners} 里 */
  private on<K extends keyof AgentEvents>(
    agent: ChatAgent,
    type: K,
    handler: (payload: AgentEvents[K]) => void,
  ): void {
    const off = toUnsubscribe(agent.on(type, handler));
    if (off) this.listeners.push(off);
  }

  /** 摘掉全部监听（桥灭的最后一步） */
  private detachListeners(): void {
    for (const off of this.listeners.splice(0)) {
      try {
        off();
      } catch (error) {
        this.options.onError?.(error, "detach-listeners");
      }
    }
  }

  // -------------------------------------------------------------------------
  // 事件 → 动作
  // -------------------------------------------------------------------------

  /**
   * 多了一条消息（`message.added` 的落点）。
   *
   * 认领 id 的规矩只有一条：**宿主已经定过的原样用，core 自造的换一个并登记**（消息 id 由宿主
   * 分配，PRD L6）。投递进来那条 id 是入队时定死的（客户端先按它画了一条），换掉会让同一条
   * 内容在界面上画两遍。
   */
  private onMessageAdded(
    message: AgentNS.Message,
    subAgent?: ChatAgent,
    via?: AgentNS.ToolCall,
  ): void {
    if (this.closed) return;
    if (subAgent) {
      const toolCallId = via?.id ?? "";
      // 子 Agent 的消息**不落库**（`CORE.md` §17）：它的话只在子 agent 自己那个对象里，要查就顺
      // `messagesOf(conversationId, { toolCallId })`。这一路由推事件 —— 事件是客户端重建那一栏的
      // 唯一来源。core 的对象原样不动：出网用一份换了 id 的副本（`hostCopyOf`）
      this.options.emit("message.added", {
        conversationId: this.conversationId,
        message: this.hostCopyOf(message),
        toolCallId,
        at: this.nowIso(),
      });
      return;
    }

    if (!this.knownIds.has(message.id)) {
      message.id = this.newId();
      this.knownIds.add(message.id);
    }
    if (!this.createdAtOf.has(message.id)) this.createdAtOf.set(message.id, this.clock.now());

    // 落地的是投递进来的那条：库里的正文用「投递时给的那一份」，紧跟着登记素材关系行。
    // 别的一律按 core 此刻的样子写一行（落库即镜像）。
    if (this.queuedIds.delete(message.id)) this.persistLanded(message);
    else this.enqueueWrite(message);

    if (
      message.role === AgentNSValue.Role.Assistant &&
      message.status === AgentNSValue.MessageStatus.Pending
    ) {
      // 占位出现了：接下来要流进这条，节流写就认它
      this.streaming = message;
    }

    this.options.emit("message.added", {
      conversationId: this.conversationId,
      message,
      at: this.nowIso(),
    });
  }

  /** core 就地改了一条消息（定型、出错、被中断）：整条覆盖写 + `message.changed` */
  private onMessageChanged(
    message: AgentNS.Message,
    subAgent?: ChatAgent,
    via?: AgentNS.ToolCall,
  ): void {
    if (this.closed) return;
    if (subAgent) {
      const toolCallId = via?.id ?? "";
      // 同上：不落库，只推事件
      this.options.emit("message.changed", {
        conversationId: this.conversationId,
        message: this.hostCopyOf(message),
        toolCallId,
        at: this.nowIso(),
      });
      return;
    }
    this.enqueueWrite(message);
    this.options.emit("message.changed", {
      conversationId: this.conversationId,
      message,
      at: this.nowIso(),
    });
  }

  /** core 删了一条消息（「丢」= 真删，`CORE.md` §6）：库里也必须消失 */
  private onMessageRemoved(
    message: AgentNS.Message,
    subAgent?: ChatAgent,
    via?: AgentNS.ToolCall,
  ): void {
    if (this.closed) return;
    const toolCallId = subAgent ? via?.id ?? "" : undefined;
    // 子 Agent 的消息 id 在 WeakMap 里：没见过的那条（压根没落过库）不必删
    const id = subAgent ? this.subAgentIds.get(message) : message.id;
    if (id === undefined) return;
    this.queuedStored.delete(id);
    this.writeChain = this.writeChain
      .then(() => this.options.messages.delete(id))
      .catch((error: unknown) => this.options.onError?.(error, "message-remove"));
    this.options.emit("message.removed", {
      conversationId: this.conversationId,
      messageId: id,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      at: this.nowIso(),
    });
  }

  /** 一次回应结束：整条 upsert + `message.changed`（这一刻那条消息上的字段都齐了） */
  private onResponseFinished(message: AgentNS.Message): void {
    if (this.closed) return;
    this.enqueueWrite(message);
    this.options.emit("message.changed", {
      conversationId: this.conversationId,
      message,
      at: this.nowIso(),
    });
  }

  /** 一片原始片：只负责节流写那一行 + 推 `message.delta`（`seq` 每条消息自增） */
  private onDelta(event: AgentEvents["delta"]): void {
    if (this.closed) return;
    const delta = (event.chunk as RawChunk | undefined)?.choices?.[0]?.delta;
    // 只有外层字段的收尾片（带 usage / finish_reason）不产生增量
    if (!delta) return;

    const source = event.source;
    if ("subAgent" in source) {
      const toolCallId = source.toolCall?.id ?? "";
      const receiver = source.subAgent.messages.at(-1);
      if (!receiver) return;
      this.onSubAgentChunk(toolCallId, receiver, delta);
      return;
    }

    const receiver = source.message;
    this.streaming = receiver;
    const seq = this.deltaSeq.get(receiver.id) ?? 0;
    this.deltaSeq.set(receiver.id, seq + 1);
    this.options.emit("message.delta", {
      conversationId: this.conversationId,
      messageId: receiver.id,
      seq,
      delta,
      at: this.nowIso(),
    });
    this.scheduleStreamWrite(receiver);
  }

  /**
   * core 报了一条 `failed`：**两路各走各的**（PRD 4.15）。
   *
   * - 回显用的失败事实（码 + 文案键 + 参数 + 一句现成的话）写进那一行的 `data.error`，活得比
   *   进程长；
   * - 完整的错误对象（core 的 `AgentError`：码 + 原文）走 `error` 事件，只在线时存在。
   */
  private onFailed(error: unknown, message?: AgentNS.Message): void {
    if (this.closed) return;
    const fact = toProblem(error);
    if (message) this.enqueueWrite(message, fact);
    this.options.emit("error", {
      conversationId: this.conversationId,
      messageId: message?.id ?? null,
      code: error instanceof AgentError ? error.code : "internal",
      message: error instanceof Error ? error.message : String(error),
      at: this.nowIso(),
    });
  }

  /**
   * core 报了一条 `denied`：某个钩子拒了，这一次压根没发出去。
   *
   * 它**不挂在某条消息上**（core 的载荷里没有消息：能拒的三个钩子分别发生在占位之前、工具之前、
   * 委派之前），所以「回显用的失败事实」在这一条上没有行可写 —— 只有完整对象走 `error` 事件。
   */
  private onDenied(event: AgentEvents["denied"]): void {
    if (this.closed) return;
    const fact = toDeniedProblem(event.reason, event.detail);
    this.options.emit("error", {
      conversationId: this.conversationId,
      messageId: null,
      code: fact.code,
      message: event.reason,
      detail: event.detail ?? fact.detail,
      at: this.nowIso(),
    });
  }

  // ---- 子 Agent（委派） ----

  /**
   * 委派那一拍要补的事：子 agent 开局手里那几条消息（装好的历史 / 模板）**推一遍 `message.added`**。
   *
   * 为什么要补这一推：它们不会再触发任何事件（模板是直接装进 `agent.messages` 的，比如
   * `AgentToolLazy.injectArgs` 换引用那一步），而子 agent 的话现在**不入库** —— 不补的话，
   * 客户端那一栏就只剩下它后来吐的字，它开局拿到的任务描述永远看不见。
   *
   * 这三条一起说明了本文件对子 agent 的口径：**事件给界面重建，库是这条对话的转录**，
   * 子 agent 的话只进前者（`CORE.md` §17）。
   */
  private onSubAgentStart(subAgent: ChatAgent, toolCall?: AgentNS.ToolCall): void {
    if (this.closed) return;
    const toolCallId = toolCall?.id ?? "";
    for (const message of subAgent.messages) {
      this.options.emit("message.added", {
        conversationId: this.conversationId,
        message: this.hostCopyOf(message),
        toolCallId,
        at: this.nowIso(),
      });
    }
  }

  /** 子 Agent 的一片增量：推成 `message.delta`（带 `toolCallId`，客户端据此分栏）；不写库 */
  private onSubAgentChunk(
    toolCallId: string,
    receiver: AgentNS.Message,
    delta: AgentNS.Delta,
  ): void {
    const messageId = this.subAgentIdOf(receiver);
    const seq = this.deltaSeq.get(messageId) ?? 0;
    this.deltaSeq.set(messageId, seq + 1);
    this.options.emit("message.delta", {
      conversationId: this.conversationId,
      messageId,
      seq,
      delta,
      at: this.nowIso(),
      toolCallId,
    });
  }

  /**
   * 子 Agent 那条消息的 id：第一次见就定下来，之后一直用这一个。
   *
   * 与主线同一条规矩（消息 id 由宿主分配）：子 agent 的消息在**它自己的内存**里，而客户端要按
   * id 才拼得起来；id 必须在第一次见到这条消息时定死 —— 否则「流式时推出去的那个 id」与「后面
   * 那条改事件里的 id」会是两个，客户端就把同一句话当成两条消息。
   *
   * 定下来的只是**宿主这个 id**：`message.id` 一个字不动（那是 core 的财产，见 `hostCopyOf`）。
   * 映射记在 {@link subAgentIds} 里（`WeakMap`：core 的对象 ↔ 宿主 id）。
   */
  private subAgentIdOf(message: AgentNS.Message): string {
    const existing = this.subAgentIds.get(message);
    if (existing !== undefined) return existing;
    const id = this.newId();
    this.subAgentIds.set(message, id);
    this.knownIds.add(id);
    this.createdAtOf.set(id, this.clock.now());
    return id;
  }

  /**
   * 子 Agent 的消息 → 一份**换了 id 的副本**（发事件与落库都用它）。
   *
   * 为什么不就地改写 `message.id`：那个对象是 core 的财产（装在子 agent 自己的历史里，
   * `subAgent.messages` 交回来的也是同一个引用）。宿主就地改 id，等于替 core 改了它自己的消息 ——
   * core 哪一天按 id 做匹配（重试 / 去重 / 修历史），那就是一个只在这里才存在的错。副本只借
   * 宿主需要的那一格，映射照旧记在 {@link subAgentIds}。
   */
  private hostCopyOf(message: AgentNS.Message): AgentNS.Message {
    return { ...message, id: this.subAgentIdOf(message) };
  }

  // ---- 四格 ----

  /**
   * 变闲了（core 的 `state:idle`）：**全宿主唯一一处「到点了要考虑点什么」**。
   *
   * 四步，顺序有理由：
   *   1. 把节流里挂着的那一笔写干净 —— 「它闲了」是一个读库的时点，读到落后一片的样子会奇怪；
   *   2. `agents.complete`：配置改过就换人（那件事的判据只在注册表里）；
   *   3. 报「闲了」这一格；
   *   4. `onIdle`：读一次当下事实（派生会话？越软线？挂着题？），那件事在 `app.ts`。
   *
   * 这一跳**不是结算**：一毫秒后又来一条投递就又是忙。
   */
  private onIdle(): void {
    if (this.closed) return;
    void (async () => {
      try {
        await this.flushWrites();
      } catch (error) {
        this.options.onError?.(error, "idle-flush");
      }
      // flush 是一次 await：这期间它可能已经被杀掉（用户按杀死 / 对话被删）。桥都没了就不该再
      // 往回报「闲了」，更不该去问一个已经不存在的对话要不要交接。
      if (this.closed) return;
      this.options.agents.complete(this.conversationId);
      // 陈旧（`stale-on-settle`）就是在这一跳兑现的：登记被丢掉 → 桥跟着灭，那一刻已经报过
      // 「死」了。再报一格「闲」会把客户端拉回那一格，反而让它一直停在那里。
      if (this.closed) return;
      this.emitState("idle");
      this.options.onIdle?.(this.conversationId);
    })();
  }

  /**
   * agent 自己说没了（core 的 `stopped` / `killed`）：桥自己灭，`close` 顺手报「死」。
   *
   * 不在这里直接 `emitState("dead")`：报「死」只有一个口（{@link announceDead}），否则
   * 「killed 报了、退役又报一遍」这种重发就没地方防。
   */
  private onTerminated(): void {
    if (this.closed) return;
    this.close();
  }

  /**
   * 报一格「死」并记下已经报过 —— **同一次死亡只发一条**。
   *
   * 两条路会走到这里：core 说的那两种（`stopped` / `killed`），以及桥灭的其余理由（`retired`
   * 的五种、投递撞上已关的门）。后一种是客户端看不见的，得由这里补上。
   */
  private announceDead(): void {
    if (this.deadAnnounced) return;
    this.deadAnnounced = true;
    this.emitState("dead");
  }

  /** 推一格（四格之一）。更细的阶段不在这里 —— 客户端按到达的事件自己推 */
  private emitState(status: ConversationStatus): void {
    this.options.emit("state", {
      conversationId: this.conversationId,
      status,
      at: this.nowIso(),
    });
  }

  // -------------------------------------------------------------------------
  // 写库
  // -------------------------------------------------------------------------

  /**
   * 一条消息 → 一行。
   *
   * 落库正文优先用**投递时记下的那一份**（与端点无关的 `__asset_id` 形态）：核心看到的是厂商的
   * `file_id` / base64，那些都是「这一次发送的产物」，不该进库。
   *
   * 子 agent 的消息走不到这里：它们不落库（`CORE.md` §17）。`parentToolCallId` 那一列于是永远
   * 是 `null` —— 列与它的读取口留着是为了已经存下来的旧行，不是给新写入用的。
   */
  private rowOf(message: AgentNS.Message, problem?: ProblemFact): MessageUpsertInput {
    const row = toRow(
      message,
      this.conversationId,
      this.createdAtOf.get(message.id) ?? this.clock.now(),
      problem === undefined ? {} : { problem },
    );
    const stored = this.queuedStored.get(message.id);
    if (stored !== undefined) row.content = stored as unknown as MessageUpsertInput["content"];
    return row;
  }

  /** 节流：到点就写一条，不到点就排一个「到点再写」 */
  private scheduleStreamWrite(message: AgentNS.Message): void {
    const interval = this.options.streamWriteIntervalMs ?? DEFAULT_STREAM_WRITE_INTERVAL_MS;
    const now = this.clock.now();
    if (interval <= 0 || now - this.lastWriteAt >= interval) {
      this.enqueueWrite(message);
      return;
    }
    if (this.writeTimer) return;
    this.writeTimer = this.clock.setTimeout(() => {
      this.writeTimer = undefined;
      if (this.streaming) this.enqueueWrite(this.streaming);
    }, interval - (now - this.lastWriteAt));
  }

  /**
   * 写一条（串进写库链）。
   *
   * 行的内容**在真正写的这一刻**才从活消息上取：core 是先发 `delta` 再把那一片攒进消息的
   * （`emit` 之后才 `applyChunk`），同步取快照会写下一份比内存落后一片的行。
   *
   * **交接态下整条跳过**（PLAN §5.3）：写文档期间产生的消息不进库 —— 它们马上要随旧记忆一起被
   * 替掉。但事件照推（调用方在调本方法之前已经推过了），所以用户看得见它在写。
   */
  private enqueueWrite(message: AgentNS.Message, problem?: ProblemFact): void {
    if (this.handoffActive()) return;
    this.lastWriteAt = this.clock.now();
    this.writeChain = this.writeChain
      .then(() => this.options.messages.upsert(this.rowOf(message, problem)))
      .catch((error: unknown) => this.options.onError?.(error, "message-write"));
  }

  /**
   * 投递进来的那条落地了：**落地这一刻**写它的行，紧跟着登记素材关系行。
   *
   * 为什么必须是这一刻而不是「以后某个统一写的时点」：`seq` 由存储层按插入顺序给
   * （`MAX(seq)+1`），而助手消息是边流边写的 —— 这一句若要等到某个收尾时点才第一次写，它的
   * `seq` 就排在**它引出的那条回答之后**，重开这段对话时读到的转录成了「助手说完 → 用户冒一句」。
   *
   * 为什么写行与记素材关系绑在一起：`conversation_assets.messageId` 的外键指着 `messages.id`，
   * 所以只能「先写行、再记关系」。
   *
   * **交接态下同样整条跳过**：交接期间投进来的那几句话属于「关于交接的那场对话」，它们与写文档
   * 的助手消息一样要随旧记忆一起被替掉（PLAN §5.3）。它们仍然落进了 `messages`、仍然推了
   * `message.added` —— 用户看得见，只是不入库。
   */
  private persistLanded(message: AgentNS.Message): void {
    if (this.handoffActive()) return;
    this.lastWriteAt = this.clock.now();
    this.writeChain = this.writeChain
      .then(async () => {
        // 同一 id 再写是覆盖（仓储 `ON CONFLICT (id) DO UPDATE`：`seq` / `createdAt` 保留第一次
        // 写入时的值），所以后面那些整条覆盖写不会把这条换成两行、也不会改掉它的 `seq`
        await this.options.messages.upsert(this.rowOf(message));
        await this.linkLandedAssets(message);
      })
      .catch((error: unknown) => this.options.onError?.(error, "landed-write"));
  }

  /**
   * 落地那条消息的素材引用 → 关系行（F-H7）。
   *
   * 记不下来不算这一条投递失败（话已经进去了）：打一条日志继续 —— 后果只是这份素材的引用计数
   * 少一行，删字节会晚一步。
   */
  private async linkLandedAssets(message: AgentNS.Message): Promise<void> {
    const link = this.options.linkMessageAssets;
    if (!link) return;
    const content = this.queuedStored.get(message.id);
    if (content === undefined) return;
    try {
      await link({ conversationId: this.conversationId, messageId: message.id, content });
    } catch (error) {
      this.options.onError?.(error, "link-message-assets");
    }
  }

  /**
   * 把挂着的节流写收干净（桥灭之前、「变闲那一刻」、开始交接之前都要做）。
   *
   * 公开是因为「开始交接」那一拍需要它：交接前已经发生的消息属于转录，得先写下去；
   * 交接期间的不属于，挂上标记后一律不写。
   */
  async flushWrites(): Promise<void> {
    this.writeTimer?.();
    this.writeTimer = undefined;
    await this.writeChain;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

// ---------------------------------------------------------------------------
// ChatRunner
// ---------------------------------------------------------------------------

/**
 * 一段对话 ⇄ 它的 agent 之间的那层：**投递 / 中断 / 现读**，外加三件结构性的动作。
 *
 * 它自己不长记性：手上只有三张表 ——
 *   - {@link bridges}：这段对话此刻有没有桥（桥在不在 = agent 在不在，严丝合缝）；
 *   - {@link assemblingBuffers}：装配窗口里收着的那几条投递（还没推进 core 的队列，装好按到达
 *     顺序一次推给它）。那是**真的缓冲**，不是排队区的镜像；
 *   - {@link handoffs}：哪几段对话在交接态（`beginHandoff` / `endHandoff` 两个口）。
 *
 * 三张表都是「此刻的现场」，没有一张是另一份事实的副本。
 */
export class ChatRunner {
  private readonly options: ChatRunnerOptions;
  private readonly clock: Clock;
  /** 活着的那几条桥（对话 id → 桥） */
  private readonly bridges = new Map<string, ConversationBridge>();
  /**
   * 在交接态的对话（对话 id → 开始时刻）。
   *
   * 存在这里而不是 agent 上：交接是**对话**的处境，而 agent 会换（配置改了、装配事实变了）。
   * 它的唯一作用是让桥「不写库」（{@link ConversationBridge} 的 `handoffActive`）—— 不参与任何
   * 流程判断：照样收件、照样取件、照样跑，只是那些消息不进库。
   */
  private readonly handoffs = new Map<string, { since: string }>();
  /**
   * 装配窗口里收着的投递（对话 id → 条目，保持到达顺序）。
   *
   * 只有一条路会往里放东西：agent 不在、调用方又允许把它叫起来（`mayStart`：两个创建者）。装好之后
   * 「按到达顺序一次推给它」—— 不等待、没有超时、不丢。
   */
  private readonly assemblingBuffers = new Map<string, QueuedEntry[]>();
  /**
   * 同一段对话的装配串行链：同时进来三条投递，只会装配一次，而且三条的顺序 = 到达顺序。
   *
   * 链尾自我清理：没有在途装配时把登记删掉，免得一张 Map 跟着对话数一直长。
   */
  private readonly assembling = new Map<string, Promise<void>>();

  constructor(options: ChatRunnerOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;

    // 三格变化的旁听口：注册表那一侧才知道「这个 agent 是哪段对话的」（它是 agent 唯一的来源）
    options.agents.observeState((event) => this.options.onState?.(event));
    // 生灭决定：`retired` 这一跳就是桥的灭点（agent 换了人 / 被退役 / 被硬着陆都在这里）——
    // 那一刻核心可能已经报过 `killed`，也可能什么都没报（退役不 kill）：桥灭时统一补一格「死」
    options.agents.observeLifecycle((event) => {
      if (event.action === "retired") this.dropBridge(event.conversationId);
    });
  }

  /** 宿主分配消息 id（PRD L6）：缺省 `crypto.randomUUID`，测试可注入递增 id */
  private newId(): string {
    return (this.options.newId ?? defaultNewId)();
  }

  // ---- 投递 ----

  /**
   * 投一条内容给某段对话 —— **投递唯一的入口**（PLAN §5.1 / A15）。
   *
   * 只判两件事：**对话在不在**（不在 → `not_found`）、**agent 活不活**（不在 → 只有
   * `mayStart` 才装上驱动者把它叫起来，否则 `conversation_dead`）。不判「有没有资格发给我」
   * （投递不看关系）、不判「它忙不忙」（忙不是拒绝的理由，队列本来就收）、不判「这条会不会
   * 被处理」（不承诺）。
   *
   * 回执里**没有状态、没有「叫醒了没有」、没有结果**：那三样都是对未来的断言，而未来只能靠
   * 观测（`state()` / 事件）。`await` 的边界就是「已入队」。
   */
  async deliver(
    conversationId: string,
    input: DeliveryInput,
  ): Promise<{ userMessageId: string }> {
    const conversation = await this.options.conversations.get(conversationId);
    if (!conversation) {
      throw new HostError("not_found", { params: { entity: "conversation" } });
    }

    const userMessageId = this.newId();
    const createdAt = this.nowIso();
    const entry: QueuedEntry = {
      input: {
        messageId: userMessageId,
        // 来源照抄投递方：`{ kind: "user" }` 不带「这条消息来自…自动推送」那行注释，其他来源由
        // core 在落地那一刻加上 —— 这里不自己拼那句话
        source: input.source,
        // 高优先：落点是「工具跑完的那个边界」—— 不打断模型正在吐的那条回答，又能尽快接住
        priority: "high",
        content: input.content,
      },
      createdAt,
      ...(input.storedContent === undefined ? {} : { storedContent: input.storedContent }),
    };

    const live = this.options.agents.get(conversationId);
    if (live) {
      this.bridgeFor(conversationId, live).push(entry);
      return { userMessageId };
    }

    // 走到这里就是「死」：除了创建者（`mayStart`）不许把它叫起来，一律拒
    if (input.mayStart !== true) {
      throw new HostError("conversation_dead");
    }
    this.bufferOf(conversationId).push(entry);
    await this.assembleAndDrain(conversationId, conversation);
    return { userMessageId };
  }

  /**
   * 装配出 agent 并把装配窗口里收着的投递一次推给它。
   *
   * 同一段对话串成一条链：三条同时到达的投递只会装配一次，推的顺序 = 到达顺序。
   * 装配失败就把缓冲清掉再把错抛回去 —— 留着只会在下一次装配之后凭空多推一遍。
   */
  private assembleAndDrain(
    conversationId: string,
    conversation: Conversation,
  ): Promise<void> {
    const previous = this.assembling.get(conversationId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined) // 前一条装配失败不挡这一条：每一批各自交代自己的成败
      .then(async () => {
        try {
          const agent =
            this.options.agents.get(conversationId) ??
            (await this.ensureAgent(conversationId, conversation));
          const bridge = this.bridgeFor(conversationId, agent);
          for (const entry of this.takeBuffered(conversationId)) bridge.push(entry);
        } catch (error) {
          this.assemblingBuffers.delete(conversationId);
          throw error;
        }
      });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.assembling.set(conversationId, tail);
    void tail.then(() => {
      if (this.assembling.get(conversationId) === tail) this.assembling.delete(conversationId);
    });
    return run;
  }

  /**
   * 中断：打到**活着的** agent 上，返回打到没有。
   *
   * 它是「掐在途」，不是「杀死」：core 的 `abort()` 掐掉在途请求与工具，并顺带挂上暂停（掐完
   * 不能再往下走）。于是中断完落在「暂停」格 —— 还能继续，待办一条不丢（PRD 4.4）。
   *
   * 不收 `reason`：core 的 `abort()` 本来就不收原因（它只说「掐断」）。契约面那侧
   * （`conversation.abort`）的 `reason` 由接线层写日志，不上行到这里 —— 没有去处的参数不该
   * 出现在签名里（它只会让人以为它干了什么）。
   */
  abort(conversationId: string): boolean {
    const agent = this.options.agents.get(conversationId);
    if (!agent) return false;
    agent.abort();
    return true;
  }

  /**
   * 清空这段对话的待办，返回清掉几条（core 的 `agent.clearInbox()`）。
   *
   * 待办只有两处，与 {@link ChatRunner.state} 读的是同一对：agent 身上那个队列，以及装配
   * 窗口里还没推进去的那几条。两处一起清 —— 读完马上清与清完再看是同一件事。
   *
   * 没有 agent 就没有队列可清：回 `0`，不是错误（那段对话真的一条待办都没有）。
   */
  clearInbox(conversationId: string): number {
    const buffered = this.assemblingBuffers.get(conversationId)?.length ?? 0;
    if (buffered > 0) this.assemblingBuffers.delete(conversationId);
    const agent = this.options.agents.get(conversationId);
    const pending = agent ? agent.clearInbox().length : 0;
    return buffered + pending;
  }

  // ---- 现读 ----

  /**
   * 现读：四格 + 待办 + 子 agent 名册 + 交接态。**不落库、不推算、不存镜像**。
   *
   * - 没有 agent 对象、手上也没有缓冲的投递 = `dead`，待办报空；
   * - 没有 agent 但**装配窗口里缓冲了几条** = `busy`：agent 还没装好，但那几条确实排着 ——
   *   报 `dead` 等于跟客户端说「这些投递没有去处」，而它们马上就要被推进去；
   * - 有就报 agent 身上那一格（`busy` / `idle` / `paused` 原样映射）；
   * - 待办现读 `agent.inboxPending`（顺序即取件顺序），再加上装配窗口里还没推进 core 的那几条。
   *
   * 钥匙（没有正文的条目）不列进来：它不落地、没有来源，硬塞进一行只能给它编一个假 id。
   *
   * `subAgents` / `handoff` 两格同样是**现读**：前者读 core 名册（`agent.subAgents`），后者
   * 读本文件那张交接标记表（不是 agent 的事 —— 交接是对话在这一刻的处境）。
   */
  state(conversationId: string): ConversationReadout {
    const agent = this.options.agents.get(conversationId);
    // 交接态与 agent 在不在无关：标记是这段对话的，读完就丢，不存第二份
    const handoff = this.handoffs.get(conversationId);
    const handoffReadout = handoff === undefined ? null : { since: handoff.since };
    // 装配窗口里那几条（装好之后按到达顺序一次推给 agent，顺序即取件顺序）
    const buffered = (this.assemblingBuffers.get(conversationId) ?? []).map((entry) =>
      toInboxItem(entry.input, entry.createdAt),
    );

    if (!agent) {
      // 真的没有 agent、也没有缓冲，才是死。死了就没有名册：子 agent 的话只在它自己那个对象
      // 里，agent 都没了，那些话也就一起没了（`CORE.md` §17）
      if (buffered.length === 0) {
        return { status: "dead", inbox: [], subAgents: [], handoff: handoffReadout };
      }
      // 装配窗口：agent 还没装好，但这几条确实排着
      return { status: "busy", inbox: buffered, subAgents: [], handoff: handoffReadout };
    }

    const bridge = this.bridges.get(conversationId);
    const pending =
      bridge && bridge.agent === agent
        ? bridge.inboxItems()
        : // 桥还没有（装配窗口）或者手里那个 agent 已经换了人：同样现读 core 的真队列
          inboxItemsOf(agent);

    return {
      status: agent.state,
      inbox: [...buffered, ...pending],
      subAgents: agent.subAgents.map((entry) => ({
        toolCallId: entry.toolCallId,
        name: entry.name,
        // 子 agent 的三格直读；但「跑完了」是本文件比它自己那个格更诚实的一格：
        // 一次性子 agent 死透了 state 也还是 `idle`，把它报成「闲」等于告诉界面它还在。
        // 所以只要名册上有了 `endedAt`，就报 `ended`。
        state: entry.endedAt === null ? entry.agent.state : ("ended" as const),
      })),
      handoff: handoffReadout,
    };
  }

  /**
   * 这段对话此刻的消息 —— **列表读取只有一个来源**（PLAN §7）：活着读内存，死了读库。
   *
   * - 没有 agent → `null`。那不是「空」，是「我这边没有」：调用方据此去读库（这段对话已经没有
   *   驱动者了，库就是它的全部）；
   * - 给了 `toolCallId` → 顺「父的名册 → 那一个子 agent → 它的 `messages`」取。名册上没有那一项
   *   （这一批已经翻过去了、或者进程重启过）同样回 `null` —— 子 agent 不落库，它的话只在它自己
   *   那个对象里（`CORE.md` §17）；
   * - 否则就是 `agent.messages`，**顺序即数组顺序**（不再排 `seq`：内存里没有第二份顺序）。
   *
   * 返回的是 `agent.messages` **本身**，不是拷贝：它是唯一真相，交出去的那一份就是正在长的那一份
   * （`CORE.md` §12）。
   */
  messagesOf(
    conversationId: string,
    options?: { toolCallId?: string },
  ): AgentNS.Message[] | null {
    const agent = this.options.agents.get(conversationId);
    if (!agent) return null;

    const toolCallId = options?.toolCallId;
    if (toolCallId === undefined) return agent.messages;

    const entry = agent.subAgents.find((candidate) => candidate.toolCallId === toolCallId);
    return entry?.agent.messages ?? null;
  }

  // ---- 交接态 ----

  /**
   * 进入交接态：从此这段对话的消息**不写库**，但事件照推（PLAN §5.3）。
   *
   * 三件事：
   *   1. 幂等：已在交接态就什么也不做 —— `since` 保留第一次那一拍（重入不该把「什么时候开始的」
   *      抹掉）；
   *   2. 先把**已经发生**的那一笔写干净（交接前的消息属于转录，交接期间的不属于）。顺序很要紧：
   *      先挂牌、再冲写 —— 否则冲写期间新到的消息会挤进来，变成「交接期间也进了库」；
   *   3. 冲写不等（本方法是同步的）：它是收尾动作，没有调用方需要等它；失败只记日志。
   *
   * 为什么不把标记存到 agent 上：交接是**对话**在这一刻的处境，不是 agent 的属性 —— agent 中途被
   * 换掉（配置改了、装配事实变了）时标记不该跟着消失。
   */
  beginHandoff(conversationId: string): void {
    if (this.handoffs.has(conversationId)) return;
    this.handoffs.set(conversationId, { since: this.nowIso() });
    void this.bridges
      .get(conversationId)
      ?.flushWrites()
      .catch((error: unknown) => this.options.onError?.(error, "handoff-flush"));
  }

  /**
   * 退出交接态：清掉标记，之后的消息照旧写库。
   *
   * 不需要补写：交接期间那些消息本来就不该进库（它们随旧记忆一起被替掉，客户端靠一条
   * `memory_replaced` 全量重拉）。
   */
  endHandoff(conversationId: string): void {
    this.handoffs.delete(conversationId);
  }

  // ---- 桥的生灭 ----

  /**
   * 拿到这段对话的桥（没有就造一条，就地订上 agent 的事件）。
   *
   * 手里那条如果是**上一个** agent 的（装配事实变了被重建、配置改过被换掉），就地换一条：
   * 旧的那条先灭（它订的是一个已经退役的 agent，再也不会有人往里推东西）。
   */
  private bridgeFor(conversationId: string, agent: ChatAgent): ConversationBridge {
    const existing = this.bridges.get(conversationId);
    if (existing && existing.alive && existing.agent === agent) return existing;
    if (existing) {
      this.bridges.delete(conversationId);
      // 旧的那条要灭：它订的是一个已经退役（或者是刚被顶掉的）agent，这一段也得报一格「死」
      existing.close();
    }
    const bridge = new ConversationBridge(
      this.options,
      conversationId,
      agent,
      () => this.dropBridge(conversationId),
      // 交接态问 `ChatRunner`（标记是对话的，桥会换）：换一条桥不把「正在交接」弄丢
      () => this.handoffs.has(conversationId),
    );
    this.bridges.set(conversationId, bridge);
    return bridge;
  }

  /** 拆掉一段对话的桥（agent 退役 / 被 kill / 对话被删 / Scope 被处置 / 投递撞上已关的门都走这里） */
  private dropBridge(conversationId: string): void {
    const bridge = this.bridges.get(conversationId);
    if (!bridge) return;
    this.bridges.delete(conversationId);
    // 桥灭 = 这段对话没有 agent 了：`close` 会补报一格「死」（`stopped` / `killed` 已报过的不重报）
    bridge.close();
  }

  private bufferOf(conversationId: string): QueuedEntry[] {
    const existing = this.assemblingBuffers.get(conversationId);
    if (existing) return existing;
    const created: QueuedEntry[] = [];
    this.assemblingBuffers.set(conversationId, created);
    return created;
  }

  /** 取走装配窗口里收着的那几条（顺序即到达顺序），并且不再留一张空表 */
  private takeBuffered(conversationId: string): QueuedEntry[] {
    const buffered = this.assemblingBuffers.get(conversationId);
    if (!buffered) return [];
    this.assemblingBuffers.delete(conversationId);
    return buffered;
  }

  /**
   * 拿到这段会话现在该用的 agent —— 不在（或不合用）就按库里的事实**重新装配**。
   *
   * 走的是「装载即修复 + 按当前模型还原素材 + `acquire`」这一条：历史读一遍库（`reconcile`
   * 修掉上一次进程崩在写它路上的那些行），`resolveHistory` 把 `__asset_id` 换成本模型能吃的段，
   * 然后交给注册表（在且合用就复用，不在 / 不合用就装配）。新装配的那个手里还是空的，历史要
   * push 进去 —— 复用的那个不 push（它的 `messages` 就是这段对话的真相）。
   */
  private async ensureAgent(
    conversationId: string,
    conversation: Conversation,
  ): Promise<ChatAgent> {
    const live = this.options.agents.get(conversationId);
    const history =
      live === undefined
        ? await this.storedHistory(conversationId, conversation, { repair: true })
        : [...live.messages];

    const agent = await this.options.agents.acquire(
      {
        conversationId,
        workspaceId: conversation.workspaceId,
        agentId: conversation.agentId,
        modelId: conversation.modelId,
        thinkingLevel: conversation.thinkingLevel,
        history: [...history],
      },
      conversation,
    );
    // 交回来的不是原来那个 = 真的装了一个新的：它手里是空的，历史得 push 进去。
    // 活着但不合用那一路上面没读库 —— 那一份是按旧事实还原的，这里按现在的事实重读一次
    // （这一刻这段对话没有在跑的活，`reconcile` 安全）。
    if (agent !== live && agent.messages.length === 0) {
      const assembled =
        live === undefined
          ? history
          : await this.storedHistory(conversationId, conversation, { repair: true });
      agent.messages.push(...assembled);
    }
    return agent;
  }

  // ---- 结构性的三件 ----

  /**
   * 对话（或它所在的项目）被删：**硬着陆**它那个 agent，丢掉桥。
   *
   * 为什么是 `kill` 而不是 `stop`：`stop` 是「关门，存量走完」—— 而这段对话已经不在了，把队列
   * 里那几句跑完等于对着一片空地烧 token、往库里写没人会读的行。`kill` 把存量直接作废，正好
   * 是「用户删了它」的意思。它从注册表上消失之后，紧接着的 `scopes.dispose`（删项目）也就不会
   * 被一个还活着的 agent 挡下来。
   */
  forget(conversationId: string): void {
    // 装配窗口里那几条也没有去处了：留着只会在下一次（不可能的）装配之后凭空跑出来
    this.assemblingBuffers.delete(conversationId);
    // 硬着陆：core 会同步广播 `killed`，桥据此报「死」并自己灭；注册表随后报 `retired` 两处都走到
    // `dropBridge`（幂等），而「死」那一格已经发过，不重发
    this.options.agents.kill(conversationId);
    this.dropBridge(conversationId);
  }

  /**
   * 一整个 Scope 被显式处置（项目被删）：它下面的 agent 全部硬着陆。
   *
   * 为何要单独有这一跳（逐段 `forget` 已经会见一个杀一个）：`ScopeRegistry.dispose` 的拒绝判据
   * 是「这个 Scope 上还挂着 agent」，而那个账在 `AgentRegistry` 里。逐段忘掉是调用方的自觉，
   * 而「拆 Scope 之前先把它下面的东西都弄死」应该是结构性的 —— 这一跳让你无论漏了哪一段，
   * Scope 也不会因为一只还在烧 token 的 agent 而拆不掉。
   */
  killScope(workspaceId: string): void {
    this.options.agents.killAll(workspaceId);
  }

  /**
   * 装载/重启后修复（PRD D15）。
   *
   * 两步：
   *   1. 在途（`pending` / `writing`）消息当作被中断 —— 进程是在写它们的时候没的；
   *   2. 交 core 的两支归一：`reconcileAbortedToolRounds` 用 `fill`（半截工具调用补上未完成
   *      的原因）、`reconcileAbortedMessages` 用 `keep`（已输出的内容留在上下文里，模型下一条
   *      消息能接着半截说）。
   *
   * 只写回状态/`omit` 真的变了的那些行，于是「启动时扫一遍」不会把整段历史重写一次。
   *
   * 它是**崩溃恢复**的全部：本文件没有「收尾统一写一遍」那种终局，库里的行就是当时那一刻的
   * 样子，坏掉的那些由这一跳修。
   */
  async reconcile(conversationId: string): Promise<ReconcileResult> {
    // 历史要连 `hidden` 的一起取：那些消息只是不给人看，模型照样得看到它们
    // （会话创建时那条 cwd 消息、交接摘要）
    const rows = await this.options.messages.listByConversation(conversationId, undefined, {
      includeHidden: true,
    });
    const messages = rows.map(fromRow);

    for (const message of messages) {
      if (
        message.status === AgentNSValue.MessageStatus.Pending ||
        message.status === AgentNSValue.MessageStatus.Writing
      ) {
        message.status = AgentNSValue.MessageStatus.Aborted;
      }
    }

    reconcileAbortedToolRounds(messages, "fill");
    reconcileAbortedMessages(messages, "keep");

    const changed: MessageUpsertInput[] = [];
    messages.forEach((message, index) => {
      const row = rows[index];
      if (!row) return;
      if (row.status === message.status && row.omit === (message.omit === true)) return;
      changed.push(toRow(message, conversationId, row.createdAt));
    });
    if (changed.length > 0) await this.options.messages.upsertMany(changed);

    return { messages, repairedIds: changed.map((row) => row.id) };
  }

  // ---- 历史 ----

  /**
   * 库里这段对话的历史 + 按当前模型还原过的素材（F-H7）。
   *
   * `repair`：读之前先跑一次 `reconcile`（装载即修复，PRD D15）。它只用在「装配之前」——
   * 那一刻 agent 都还没有，库里不该有正在写的行。
   */
  private async storedHistory(
    conversationId: string,
    conversation: Conversation,
    options: { repair: boolean },
  ): Promise<AgentNS.Message[]> {
    const messages = options.repair
      ? (await this.reconcile(conversationId)).messages
      : // 历史要连 `hidden` 的一起取：那些消息只是不给人看，模型照样得看到它们
        (
          await this.options.messages.listByConversation(conversationId, undefined, {
            includeHidden: true,
          })
        ).map(fromRow);
    return await this.resolveHistory(conversationId, messages, conversation.modelId);
  }

  /**
   * 历史装载完之后的第一件事情：把里面的 `__asset_id` 还原成当前模型能吃的段（F-H7）。
   *
   * 还原失败不让装配失败：打一条日志、带着原样的历史继续。
   */
  private async resolveHistory(
    conversationId: string,
    messages: AgentNS.Message[],
    modelId: string | null,
  ): Promise<AgentNS.Message[]> {
    const resolve = this.options.prepareHistory;
    if (!resolve) return messages;
    try {
      return await resolve({ conversationId, modelId, messages });
    } catch (error) {
      this.options.onError?.(error, "resolve-history");
      return messages;
    }
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

// ---------------------------------------------------------------------------
// 真实工厂：按 SDK 口径装配 agent（含硬线、孙级递归、交接线）
// ---------------------------------------------------------------------------

export interface SdkAgentFactoryOptions {
  /**
   * 交接服务（写交接文档 + 迁移）。给了才装交接线插件（`AutoMigratePlugin`）；
   * 交接服务自己会在交接回合往 agent 上装工具守卫。
   */
  handoff?: HandoffProvider;
  /**
   * 这段对话是不是**派生会话**（`PeerSessionService` 认得的那一段）——「要不要自己压」的唯一判据。
   *
   * 不传 = 一律当用户会话（越线之后交还给宿主的提问路径）。判据只能由接线层给：派生关系的
   * 唯一真相是 `PeerSessionService` 的进程内记录（不落库），本文件不另记一份。
   */
  isDerivedSession?: (context: AgentBuildContext) => boolean;
  /**
   * 压缩完成之后的回声（`mode` 说压的是哪一种）：宿主用它落会话行上的压缩标记。
   *
   * 只有插件压的那条路会叫它（`auto`）；用户答完问题之后压的那条在 `HandoffService` 里
   * 自己写（`manual`）。不传则不记（用例里的装配不需要观测）。
   */
  onCompacted?: (context: AgentBuildContext, mode: CompactionMode) => void | Promise<void>;
  /**
   * 工具刷新时机；缺省读 SDK 配置的 `autoRefreshTools`，再缺省 `inner-loop-start`。
   *
   * 取值直接用 SDK `AppConfig` 里那一字段的类型，不在这里再定义一份（`off` 表示不装插件）。
   */
  autoRefreshTools?: AppConfig["autoRefreshTools"];
  /**
   * 思考策略表（档位名 → 参数补丁）的现读入口。
   *
   * 装配是异步的，所以这里给一个取快照的函数而不是快照本身：接线层在配置变更后会重新
   * 读一次表（`refreshThinkingPresets`），拿旧快照会把已删掉的档位展开成空补丁。
   */
  thinkingPresets?: () => ReasoningPresets | null;
}

/**
 * 这段会话该带哪些模型参数（PRD F-B6）。
 *
 * 两件事合在这里：
 *   1. 助手定义上的 `modelParams`（用户给这个助手配的参数，也是「跟随默认」所指的那份）；
 *   2. 会话行上的思考档位展开出的补丁（档位名 → 参数），盖在 1 上面。
 *
 * 只在「会话定的模型就是助手定义那个模型」时才叠上 1：会话把模型换掉之后，定义上那份参数
 * 是配给旧模型的（可能带着旧模型才认的键），发给新模型只会换来一句 400。换模型时档位会被
 * 清空，所以那之后这里通常什么都不带，让模型走自己的出厂参数。
 */
export function conversationModelParams(input: {
  /** 会话行上的模型（从 `scope.config` 里找到的那个；找不到时为空） */
  model: Model | undefined;
  /** 助手定义上的模型 id（未绑定时为 `undefined`） */
  agentModelId: string | undefined;
  /** 配置里的兜底模型（`AppConfig.defaultModel`） */
  defaultModelId: string | undefined;
  /** 助手定义上的参数（`AgentDefinition.modelParams`） */
  agentParams: ModelParams | undefined;
  /** 会话行上的思考档位名；`null` = 跟随助手定义 */
  thinkingLevel: string | null;
  presets: ReasoningPresets | null;
}): ModelParams | undefined {
  const agentModelId = input.agentModelId ?? input.defaultModelId;
  const sameModel = input.model !== undefined && input.model.id === agentModelId;
  const base = sameModel ? input.agentParams : undefined;

  const patch = thinkingPatchOf(input.model, input.thinkingLevel, input.presets);
  if (!patch) return base;
  return { ...(base ?? {}), ...patch };
}

/** 档位名 → 参数补丁（模型没配策略表、表里没这个档、或没选档位时都是 `undefined`） */
function thinkingPatchOf(
  model: Model | undefined,
  thinkingLevel: string | null,
  presets: ReasoningPresets | null,
): ModelParams | undefined {
  if (!model || thinkingLevel === null || !presets) return undefined;
  const presetName = model.reasoningPreset;
  if (!presetName) return undefined;
  const preset = presets[presetName];
  if (!preset || !Object.prototype.hasOwnProperty.call(preset.levels, thinkingLevel)) {
    return undefined;
  }
  return preset.levels[thinkingLevel];
}

/**
 * 读一次助手定义（只为拿它绑定哪个模型、带哪些参数）。
 *
 * SDK 的 `createAgent` 自己也会读一次定义；这里多这一遍是因为会话档位展开的参数要叠在
 * 定义那份参数上，而只有定义在手才知道该叠什么。读不出来就当作没有（真正的报错由
 * `createAgent` 那句给出）。
 */
async function readAgentDefinition(
  context: AgentBuildContext,
): Promise<AgentDefinition | null> {
  try {
    return await new AgentRepository(context.scope.agentsDir).read(context.agentId);
  } catch {
    return null;
  }
}

/**
 * 造一个按 SDK 口径装配的 agent 工厂。
 *
 * 装的东西与阈值来源（PRD D27：阈值属 SDK 的 `AppConfig` / 模型配置，不在这里另起一套）：
 *   - `ContextGuardPlugin`：硬线，`tokenThresholds.guard`；
 *   - `SubAgentGuardInstallerPlugin`：同一个硬线递归装到子 Agent 与孙级（PRD F-D8）；
 *   - `AutoMigratePlugin`：交接线，`tokenThresholds.handoff`（需注入交接服务）。
 *     越线自压的只有**派生会话**（`isDerivedSession`）；用户会话交还给宿主的提问路径；
 *   - `AutoRefreshToolsPlugin`：改完能力不用重启（PRD F-E2）；
 *   - `UnknownToolHintPlugin`：未知工具时给出 MCP 场景的引导。
 */
export function createSdkAgentFactory(options: SdkAgentFactoryOptions = {}): AgentFactory {
  return async (context: AgentBuildContext): Promise<ChatAgent> => {
    // 会话行上的模型就是这段对话的模型（`conversation.setModel` 写的就是它），
    // 再往下的三级解析（助手定义 → 全局兜底）仍由 SDK 那一处算
    const modelId = context.modelId ?? undefined;
    const sessionModel = context.scope.config.models.find(
      (candidate) => candidate.id === modelId,
    );
    const definition = await readAgentDefinition(context);
    const agent = await createAgent(context.scope, context.agentId, {
      modelId,
      modelParams: conversationModelParams({
        model: sessionModel,
        agentModelId: definition?.modelId,
        defaultModelId: context.scope.config.defaultModel,
        agentParams: definition?.modelParams,
        thinkingLevel: context.thinkingLevel,
        presets: options.thinkingPresets?.() ?? null,
      }),
    });

    // 生效的模型写在 `agent.definition.modelId` 上（SDK 三级解析之后的那一份）
    const model = context.scope.config.models.find(
      (candidate) => candidate.id === agent.definition.modelId,
    );
    const thresholds = model?.tokenThresholds;
    const handoff = options.handoff?.(context);
    // 交接回合本身就是上下文最满的时刻：硬线要对它让行，否则「交接触发拦截 → 拦截又触发交接」
    const isSuspended = handoff ? () => handoff.busy : undefined;

    if (thresholds) {
      agent.use(new ContextGuardPlugin({ guardTokens: thresholds.guard, isSuspended }));
      agent.use(
        new SubAgentGuardInstallerPlugin({ guardTokens: thresholds.guard, isSuspended }),
      );
      if (handoff) {
        agent.use(
          new AutoMigratePlugin({
            service: handoff,
            handoffTokens: thresholds.handoff,
            // 归一规则按**会话类型**分：派生会话没人盯着它，越线就自己压（`"self"`）；
            // 用户会话把「要不要压」交还给宿主（变闲那一刻问用户），这里回 `null` = 本次不迁移。
            resolveMode: () => (options.isDerivedSession?.(context) === true ? "self" : null),
            // 压完记一笔：宿主写会话行上的 `compactedAt` / `compactionMode = "auto"`
            ...(options.onCompacted === undefined
              ? {}
              : { onMigrated: () => options.onCompacted?.(context, "auto" as const) }),
          }),
        );
      }
    }

    const refreshWhen =
      options.autoRefreshTools ??
      context.scope.config.autoRefreshTools ??
      "inner-loop-start";
    if (refreshWhen !== "off") {
      agent.use(new AutoRefreshToolsPlugin({ when: refreshWhen }));
    }

    agent.use(new UnknownToolHintPlugin({ scope: context.scope }));

    // 插件在第一次请求之前 init（例如工具刷新插件的首次准备）
    await agent.init();
    return agent;
  };
}
