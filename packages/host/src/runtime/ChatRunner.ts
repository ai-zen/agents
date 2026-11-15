/**
 * `ChatRunner` —— 一轮对话的执行者（architecture §4 那张时序）。
 *
 * ## 一轮的骨架
 *
 * ```
 * RunRegistry.start（这一段对话同时只跑一轮；已经在跑的那一轮由 conversation.send 排队，D14）
 *   → 要 Scope（ScopeRegistry.create：幂等 get-or-create）
 *   → 分配两个消息 id 并落库（用户消息 + 助手占位，PRD L6：id 在请求发出前就有）
 *   → 拿 agent（AgentRegistry.acquire：常驻，同一段对话跨轮复用同一个实例）
 *   → 流式：每片增量推 `message.delta`；同一时刻更新六态并推 `run.state`；同一条消息边流边写（D15）
 *   → 内循环结束：写一次最终版（F-C2）→ 结算（陈旧才退役，配置改过）→ RunRegistry.finish
 *   → 推结算态 `run.state` + `usage`
 * ```
 *
 * ## 三个实例的显式生灭
 *
 * `Scope` / `Agent` / 会话实例（`TurnSession`）都由一对显式 API 管生灭，没有空闲计时、
 * 没有引用计数、没有自动回收：`scopes.create` / `agents.acquire` / `createRuntime` 负责生，
 * `agents.complete`（结算）/ `agents.discard`（对话被删）/ `disposeRuntime` 负责灭
 * （Scope 活到显式 `scopes.dispose` 或进程退出）。agent 生灭的**全部判据**都在
 * `AgentRegistry` 里（见那个文件的判据表），本文件只报事件、不自己判。
 *
 * **agent 是常驻的**：一段对话一个，跨轮复用，结算时**不**销毁（见下一节）。会话实例仍是一轮
 * 一个：它是「这一段的现场」（六态、写库节流、本轮产出），结算完就该摘掉。
 *
 * ## 常驻带来的一对约束（本文件必须自己守住）
 *
 * 1. **历史只能有一份**：agent 的 `messages` 就是这段对话的内存真相。已有 agent 时，历史从它
 *    里面取（`run()` 不再读库），`attach` 也**不再 push** —— 再 push 一遍就是双份。首次装配
 *    （agent 不存在）时行为与从前完全一致：读库（`reconcile` + `resolveHistory`）、push 进去。
 * 2. **订阅与这一轮同寿**：`agent.events` 是常驻对象上的总线，不摘掉的话下一段每次广播都会
 *    叫到这一段（已经结算的）`TurnSession` 上 —— 于是 `settle` 里把订上去的监听一一摘掉
 *    （`detachListeners`）。同理，本轮产出在 `settle` 开头就拍下来（`roundProduced`），
 *    不能再靠「agent 已经消失」这件事。
 * 3. **装配事实变了就不复用**：模型 / 思考档位存在会话行上（`conversation.setModel` /
 *    `setThinking`），而模型客户端是装配那一刻读的 —— 这件事由 `agents.acquire` 内部判
 *    （它要的就是会话行上那三项事实），不合用就丢掉重建（从前一轮一装配，这类改动下一段
 *    自然生效）。本文件只需要知道「这次是不是真装了一个新的」——决定历史要不要 push 进去。
 *
 * ## 配置改过的 agent 什么时候换掉
 *
 * `Scope.refresh()` 刷得动能力，刷不动已经建好的模型客户端（装配时读的），所以配置改动靠
 * 「换掉 agent」生效：`AgentRegistry.invalidate` 给这个 Workspace 下的 agent 打标记（空闲的
 * 当场退役），这里在**结算那一刻**兑现标记 —— 调一次 `agents.complete`，陈旧就退役，下一轮
 * `acquire` 按新配置重新装配。于是「配置改动最迟下一段生效」照旧。
 *
 * ## 跑中发送走 inbox，不走第二轮（PRD D14）
 *
 * `conversation.send` 发现这一段已经有一轮在跑时，调的是 {@link ChatRunner.enqueue}：把那一句
 * 用户输入投给**那一轮的 agent**（core 的 `deliver`），由它在轮末落成一条 User 消息。于是
 * 「不打断」与「不丢」同时成立：流还是原来那条流，用户的话排在工具轮收尾的边界上。
 * 宿主在这里只做两件事：定死那条消息的 id（D5，客户端先画的那条与落地的是同一条），报出
 * `RunState.inbox`（客户端的排队区靠它显示条目本身，不光是个数）。不变量见
 * `TurnSession.enqueue` 的注释。
 *
 * ## 自起的段：agent 被 `deliver()` 叫醒的那一段
 *
 * agent 是常驻的、inbox 在 agent 里，于是 `agent.deliver(entry)` 在静止态会**把 agent 叫醒跑
 * 一段** —— 那一段没有 `conversation.send` 的受理，也就没有受理时落的那两条占位行。但它仍然
 * 是「一段对话里正在跑的那一段」，所以它必须有自己的现场（落库、推 `run.state`、可 abort、
 * 能结算）：
 *
 * ```
 * agent.deliver(entry)
 *   → core 发 status(running)           宿主在这一拍**同步**建现场（turns 里登记 + 订上 agent）
 *   → core 把 inbox 落地（message 事件）  那条 user 消息 id 是投递方定死的那个，认领但不改写
 *   → core 跑完一段 → status(idle | terminated)
 *   → 宿主走同一套结算（写终版、runs.finish、推 run.state、兑现陈旧标记）
 * ```
 *
 * 三处与受理那一轮不同，其余全同：
 *   1. 现场是**同步**建的（上面第二拍紧跟着就广播消息，不能等一次读库），会话行与 Scope 随后补；
 *   2. 不写占位行，两条 id 都是跑着才定（见 `claimId`）；
 *   3. `→ running` 时 `turns` 里已经有现场（`conversation.send` 那一轮）就**什么都不做** ——
 *      那是普通轮次，绝不能再建第二个现场。
 *
 * ## 会话间投递：一个入口（{@link ChatRunner.deliver}）
 *
 * 别的会话跑完之后把结果投回来，走的是 `deliver(conversationId, { content, source })`：调用方
 * 不判断「父对话在不在跑」，那三件事（agent 不在就复活、正在结算就攒着、攒够了一起投）由本
 * 文件自己解决。它必须自己解决的理由在 `deliver` 的注释里，一句话是：**判据只在
 * `turns` / `RunRegistry`**，别处再记一份「在跑」就会与它们分叉。
 *
 * 两段窗口（`turns` 里还有现场、或 `runs` 还说在跑）里投进去的条目不会当场落地，而是进
 * 会话级待投列表（`waitlists`），等那一段结算完（`finishRuntime`）一次性 `deliver([...])` ——
 * 那一次落地既是「一条也不丢」，也是最省的一次请求（N 条同批落成 N 条 user message）。
 *
 * ## 三处刻意交给 core 的事
 *
 * 1. **消息与增量不重新定义**：`AgentNS.Message` / `AgentNS.Delta` / `AgentNS.MessageStatus` /
 *    `Usage` 全部原样用 core 的导出；攒消息用 core 的 `applyChunk`，求和用 core 的 `sumUsage`，
 *    中止修复用 core 的 `reconcileAbortedToolRounds` / `reconcileAbortedMessages`。
 * 2. **agent 循环不重写**：装配好的 agent 由 core 的 `send()` 驱动（内循环、工具并行、中止、
 *    收尾归一都在 core 里）。本文件只订阅它广播出来的事件，把「发生了什么」变成持久化与推送。
 * 3. **状态不存两处**：运行中的消息以内存（core 手里那份 `agent.messages`）为真相，库里的行是
 *    快照；`isRunning` 只在 `RunRegistry` 一处。
 *
 * ## 为什么要认领 core 追加的消息 id
 *
 * 消息 id 由宿主分配（PRD L6），而 assistant 占位是 core 在 `run()` 里自己 `append` 的
 * （它的 `Message` 构造会自己生成 id）。所以本文件在 `message` 事件里把「这一轮头两条」认领成
 * 宿主已经发给客户端的 id —— 客户端的 `message.delta` 与 `message.list` 才接得上同一条消息。
 * 后续工具轮次里 core 追加的消息同样在这一处被换成宿主分配的 id（`id` 不参与 core 的任何
 * 判断，换掉只会让它对客户端更一致）。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import {
  addUsage,
  AgentNS as AgentNSValue,
  generateMessageId,
  inboxEntryContent,
  reconcileAbortedMessages,
  reconcileAbortedToolRounds,
  sumUsage,
} from "@ai-zen/agents-core";
import type { SubAgentContext, ToolCallEndContext } from "@ai-zen/agents-core";
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
  AssemblingToolCall,
  AttachmentOutcome,
  CompactionMode,
  GenerationPhaseName,
  GenerationState,
  InboxItem,
  MessageInput,
  ProblemFact,
  RunOutcome,
  RunningTool,
  RunState,
  SubAgentSnapshot,
  UsageSnapshot,
} from "../wire/states.js";
import type { AgentRegistry } from "./AgentRegistry.js";
import type { RunHandle, RunRegistry } from "./RunRegistry.js";
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
  /** 这一轮开始前的历史（core 原样消息），工厂可以把它当作给 agent 的初始消息 */
  history: AgentNS.Message[];
}

/** 造 agent。测试注入假 agent，生产用 `createSdkAgentFactory()` */
export type AgentFactory = (context: AgentBuildContext) => Promise<ChatAgent>;

/**
 * 交接服务（SDK 口径）按这一轮的装配事实现场取一个。
 *
 * 给 `undefined` 就是「这一轮不装交接线插件」（R50：装配处会推一条警告，不静默）。
 */
export type HandoffProvider = (context: AgentBuildContext) => HandoffService | undefined;

/**
 * 一段的边界（core 的 `status` 事件载荷 + 它是哪段对话）。
 *
 * core 的载荷是 `{ agent, from, to }`：`agent` 有了，但「哪段对话」只有宿主知道 —— 所以由
 * `AgentRegistry`（它按 conversationId 登记）在转达时补上这一格，消费方（`ChatRunner`）
 * 不必反过来拿 agent 去查表。
 */
export interface AgentStatusEvent {
  conversationId: string;
  agent: ChatAgent;
  /** 变化前的段状态 */
  from: AgentNS.RunStatus;
  /** 变化后的段状态（`idle` / `running` / `stopping` / `terminated`） */
  to: AgentNS.RunStatus;
}

/**
 * 一条内容进了这段对话的 inbox（core 的 `inbox` 事件载荷 + 它是哪段对话）。
 *
 * 「这一段是被谁叫起来的」只有入队那一刻答得出来（`entry.source`）：投递走的是 agent 自己的
 * inbox，不经过宿主，等 `status → running` 时再回头看已经分不清「谁叫的」与「队列里还剩谁」。
 * 所以 `AgentRegistry` 把这条事件原样转出来，宿主记下最近一条（见 `ChatRunner.noteInbox`）。
 */
export interface AgentInboxEvent {
  conversationId: string;
  agent: ChatAgent;
  entry: AgentNS.InboxEntry;
}

/**
 * 本文件驱动的那部分 agent 表面。
 *
 * core 的 `Agent` 与 SDK 的 `SdkAgent` 都满足它；测试里的假 agent 也满足它，
 * 于是「一轮怎么跑」的用例不必真的连模型。
 */
export interface ChatAgent {
  /**
   * 这段对话的消息数组（内存真相；agent 常驻，于是它跨轮累积）。
   *
   * 本文件只读它（算用量、取历史），首次装配时把从库里读来的历史 push 进去 —— 已有 agent
   * 时不 push（那段历史就在它自己这里）。
   */
  messages: AgentNS.Message[];
  append(message: AgentNS.Message): AgentNS.Message;
  /** core 的 `send()`：跑完整组内循环（含多轮工具调用）后返回消息数组 */
  send(content: AgentNS.MessageContent): Promise<AgentNS.Message[]>;
  abort(): void;
  /**
   * 排队待发的内容（core 的 `Agent.inbox`，PRD D14）。
   *
   * 宿主**只读**它：`RunState.inbox` 就是这份数组（装配期的 `pending` 接在后面）。不自己另记
   * 一份 —— 数组本身是唯一真相，另记的一份随时可能与它分叉。
   */
  inbox: AgentNS.InboxEntry[];
  /**
   * 投一条待发内容（core 的 `deliver`，单条形态）；core 在轮末（工具轮收尾之后 / 整段停下之后）
   * 把它落成一条 User 消息，静止态时会顺手把段叫起来。
   *
   * `messageId` 允许由投的人定死：宿主已经把 id 告诉客户端了（D5），落地那条必须用同一个，
   * 否则同一条内容会在屏幕上画两遍。
   *
   * 回执里的 `woke` 宿主不看：跑中入队必然 `woke === false`（这一轮本来就在跑）。
   */
  deliver(input: AgentNS.InboxInput): AgentNS.DeliveryReceipt;
  /**
   * 整批投（core 的 `deliver`，一批形态）：**全部入队之后只唤醒一次**。
   *
   * 与单条的区别只在「N 条同时到达」时的落地形状：一条一条投会变成「第 1 条落地起段、其余
   * N-1 条在段内下一次取件点才落地」，而一批让 N 条在**同一拍**落成 N 条 User 消息（静止态）
   * 或落在**同一个**内循环边界（跑着）—— 一次模型请求就看见全部 N 条。
   *
   * 本文件的会话级投递（`ChatRunner.deliver`）攒够一批之后就走它：会话间投递天然是「几条
   * 一起到」的。空数组 core 那边直接返回 `[]`（不入队、不叫醒）。
   */
  deliver(inputs: AgentNS.InboxInput[]): AgentNS.DeliveryReceipt[];
  /** 事件广播口（core 的 `EventBus`）；本文件只用 `on`，返回值当「取消订阅」的句柄用 */
  events: { on(name: string, handler: (...args: never[]) => void): unknown };
}

/** 把已上传的素材变成真正发出去的内容段（PRD F-H7）；不给就原样用 `input.content` */
export interface AttachmentPreparation {
  /** 真正发给模型的内容（已按实发模型换成文件引用 / 内联 / 文字） */
  content: AgentNS.MessageContent;
  attachments: AttachmentOutcome[];
  /**
   * 落库用的内容（消息里只存我们自己的引用：段上的 `__asset_id`）。
   *
   * 不给时落库的就是 `content`：不是每个注入方都有“厂商产物不能进库”这回事。
   */
  storedContent?: AgentNS.MessageContent;
}

export type AttachmentPreparer = (context: {
  conversationId: string;
  agentId: string;
  modelId: string | null;
  input: MessageInput;
}) => Promise<AttachmentPreparation>;

/**
 * 历史里的素材引用还原成当前模型能吃的内容段（PRD F-H7）：每轮发送之前跑一次。
 *
 * 每轮都要跑一次：能不能吃跟着实发模型 / 端点变，而历史里存的是与端点无关的 `__asset_id`。
 * 不给就原样把历史交给 agent。
 */export type AttachmentHistoryResolver = (context: {
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

/** 一轮的入参（`conversation.send` 的 params 去掉 wire 外壳） */
export interface ChatRunParams {
  conversationId: string;
  input: MessageInput;
  /** 这一轮是哪条连接发起的语言（D8；缺省用注入的默认语言） */
  language?: Language;
  /**
   * 这一轮是谁叫起来的（core 的 `InboxEntry.source` 同义）：
   * `"user"`（缺省）= 用户自己发的；其他值 = 某个外部来源自动推送，正文最前面会带一行
   * `// 这条消息来自 <source> 自动推送（<时间>）`。
   */
  source?: string;
}

/**
 * 一轮结算之后的事实（R59：交接线问题由宿主自己在这个时机问）。
 *
 * 「到交接线了没有」只在宿主算得出来：`promptTokens` 是这一轮实际用量，`handoffTokens`
 * 是生效模型上配的那条线（0 表示这个模型没配）。带着 `language` 一起给，是因为问用户的话
 * 要按发起这条连接的语言渲染（D8）。
 */
export interface TurnSettledFacts {
  conversationId: string;
  outcome: RunOutcome;
  /**
   * 这一轮的失败事实（与 `TurnSettlement.problem` 同一份；`completed` / `aborted` 时是 `null`）。
   *
   * 结算时**顺带**带上它，是因为「这一段为什么没跑完」只有这一段自己知道：把结果转述给别人
   * 的那条链路（平级会话把派生会话这一段的结果投回父对话）要写清原因，就得有这一格 —— 让它
   * 再去翻消息表猜一遍，猜出来的只会是「原因不明」。
   */
  problem: ProblemFact | null;
  /** 这一轮是谁叫起来的（与 `ChatRunParams.source` 同义；`"user"` = 用户本人发的） */
  source: string;
  /** 这一轮的 `prompt_tokens`（结算快照里的本轮用量） */
  promptTokens: number;
  /** 生效模型的交接线；`0` 表示没配 */
  handoffTokens: number;
  language: Language;
}

/**
 * 一段对话正在跑的那一段（`conversation.send` 的受理回执，也是 `turns` 里存着的那个现场）。
 *
 * 两条消息 id 是**可选**的：普通轮次在受理时就把它们分配好了，而自起段（agent 被 `deliver()`
 * 叫醒跑起来的那一段）一条也没有 —— 它的 id 归属见两个字段各自的注释。
 */
export interface ChatTurn {
  conversationId: string;
  /**
   * 这一段那条用户消息的 id，还没定下来时是 `null`。
   *
   * 普通轮次：受理时就分配（L6 / D5）。
   * 自起段：core 把 inbox 落地的那一刻认领 —— **id 是投递方入队时定死的那个，宿主不改写**
   * （改写了，同一条内容就会在客户端画两遍），落地之前是 `null`。
   */
  userMessageId: string | null;
  /**
   * 这一段那条助手消息的 id，还没定下来时是 `null`。
   *
   * 普通轮次：受理时连同占位行一起分配。
   * 自起段：没有占位行（也就没有预分配），宿主第一次见到那条占位 assistant 时用 `newId()`
   * 分配并登记；一段里没有 assistant 消息（开局就失败）时它一直是 `null`，`run.state` 照实报。
   */
  assistantMessageId: string | null;
  /** 每个附件这一轮最后是怎么走的 */
  attachments: AttachmentOutcome[];
  /** 受理时刻（ISO 8601） */
  acceptedAt: string;
  /**
   * 结算之后 resolve（写库、`RunRegistry.finish`、推结算态都已完成）。
   *
   * agent **不在这里释放**：它常驻，留给下一段（只有配置改过的那种「陈旧」agent 会在结算时
   * 被换掉，那也不是这一轮的事，见 `AgentRegistry.invalidate` / `complete`）。
   */
  readonly done: Promise<TurnSettlement>;
  /** 中止这一轮（与 `conversation.abort` 走同一条路：用户显式动作，PRD D14） */
  abort(reason?: string): void;
  /**
   * 此刻的现场快照（六态、子 Agent、用量）。
   *
   * 重连的客户端拉 `conversation.state` 时用这一份（PRD L5）；它读的是这一轮自己的内存，
   * 不是第二份「谁在跑」：那个事实只在 `RunRegistry`。
   */
  runState(): RunState;
}

/**
 * `conversation.send` 的受理回执：两条 id 在请求发出**之前**就分配好了（PRD L6 / F-I12）。
 *
 * 与 {@link ChatTurn} 的差别只有这一点：自起段不是这条路的产物（它没有受理，也就没有预分配），
 * 所以「受理即有两个 id」这条契约收在 `run()` 的返回类型上，而不是让接线层去猜 `null`。
 */
export interface AcceptedTurn extends ChatTurn {
  userMessageId: string;
  assistantMessageId: string;
}

/**
 * 一句排进**正在跑的那一轮**的用户输入（`conversation.send` 的排队回执，PRD D14）。
 *
 * 没有 `assistantMessageId`：排队的话还没有「这一次要被回答的助手消息」—— 它落成一条 User
 * 消息之后由那一轮接着跑，流还是那一轮原来那条流。宿主在入队这一刻就把 `userMessageId`
 * 定死（D5），客户端先按它画一条，落地那条用的就是同一个 id。
 */
export interface QueuedTurn {
  conversationId: string;
  /** 入队时就定死的消息 id（落地那条消息用的就是它） */
  userMessageId: string;
  /** 每个附件这一句最后是怎么走的（与老路径同一份事实，F-H7） */
  attachments: AttachmentOutcome[];
  /** 入队时刻（ISO 8601） */
  acceptedAt: string;
}

/**
 * 一条「会话间投递」的内容：正文 + 来源（core 的 `InboxEntry.source` 同义）。
 *
 * 不带附件、不带 `messageId`：投递方（别的会话）不掌握这条消息在宿主侧怎么落，落库那一份、
 * 消息 id、来源注释全由宿主 + core 自己算。
 */
export interface DeliveryInput {
  content: AgentNS.MessageContent;
  /** 正文最前面那行注释里的来源名（`"user"` = 用户本人，不加注释） */
  source: string;
}

/**
 * 一次投递的**受理回执**：收下了，以及「收下的那一刻对方是什么状态」。
 *
 * 只有 `accepted` 一个取值（恒 `true`）：投递唯一会失败的情形是「那段对话不存在」，那种情况
 * 直接 reject（现状不变），所以这里没有 `accepted: false` 这一支 —— 编一个用不到的失败码只会
 * 让调用方去处理一件不可能发生的事。
 *
 * `state` 是**当场可判**的事实，不是结果：
 *   - `running`：交给了在跑的那一段，条目会在它这一轮里落地；
 *   - `idle`：这一条会把它叫醒（自起段）；
 *   - `settling`：先攒进会话级待投列表，等这一段结算完再投。
 *
 * **刻意不报 `woke`**：待投列表那条路上的唤醒发生在结算之后，同步回一个「叫醒了」就是撒谎
 * —— 投递那一刻它还没被叫醒。「叫醒没叫醒」由调用方按 `idle` 自己说（那是它能说清的话）。
 */
export interface DeliveryOutcome {
  /** 恒 `true`：唯一会失败的情形是「那段对话不存在」，那种情况直接 reject（见上） */
  accepted: true;
  /** 投递那一刻对方处于什么状态 —— 由调用方决定怎么跟用户 / 模型说 */
  state: "running" | "idle" | "settling";
}

/** 一轮的结局 */
export interface TurnSettlement {
  conversationId: string;
  /** 这一段那条助手消息的 id；自起段一段里没出过 assistant（开局就失败）时是 `null` */
  assistantMessageId: string | null;
  outcome: RunOutcome;
  problem: ProblemFact | null;
  /** 这一轮结束后内存里的全部消息（历史 + 本轮产出，core 原样） */
  messages: AgentNS.Message[];
  /** 这一轮产出的消息（写进库里的就是这些） */
  produced: AgentNS.Message[];
  usage: UsageSnapshot;
  run: RunState;
}

/** 装载/重启后的修复结果 */
export interface ReconcileResult {
  /** 修好之后的消息（顺序即对话顺序，core 原样） */
  messages: AgentNS.Message[];
  /** 被改写的消息 id（状态或 `omit` 变了） */
  repairedIds: string[];
}

export interface ChatRunnerOptions {
  messages: MessageStore;
  conversations: ConversationStore;
  /**
   * Scope 的持有者（能力容器）。
   *
   * 本文件只用它的 `create`（受理时确保这段对话的 Scope 存在，并拿它读配置里的阈值）。
   * 销毁 Scope 不是一轮的事：它活到显式 `dispose` 或进程退出。
   */
  scopes: ScopeRegistry;
  runs: RunRegistry;
  /**
   * agent 存活管理的唯一拥有者（它是「agent 唯一的来源」）。
   *
   * 拿（`acquire`：在且合用就复用，不在 / 不合用就装配）、结算（`complete`：陈旧才退役）、
   * 对话被删（`discard`：只丢引用）、配置生效（`invalidate`）、收尾（`disposeAll`）都走它。
   * 本文件不再自己调 agent 工厂，也不再自己判「复不复用」—— 于是「agent 从哪来、活多久」
   * 只写在一个地方。
   */
  agents: AgentRegistry;
  emit: ChatEventEmitter;
  clock?: Clock;
  /** 宿主分配消息 id；缺省用 `crypto.randomUUID` */
  newId?: () => string;
  /** 边流边写的节流时长（毫秒）；0 表示每到一片就写一次 */
  streamWriteIntervalMs?: number;
  prepareAttachments?: AttachmentPreparer;
  /**
   * 历史里的素材引用 → 当前模型能吃的段（F-H7）。不给时历史原样交给 agent。
   *
   * 与 `prepareAttachments` 分开两个注入点，是因为它们错在不同时机：一个在受理时算一次，
   * 一个是每次装配 agent 之前按当时的模型 / 端点算。
   */
  prepareHistory?: AttachmentHistoryResolver;
  /**
   * 用户消息落库那一刻登记素材关系行（`conversation_assets`）。不注入就不记。
   */
  linkMessageAssets?: MessageAssetLinker;
  /** 这一轮没带语言时用哪种语言渲染宿主注入的那段话（D8） */
  defaultLanguage?: Language;
  /** 一轮结算之后的回调（R59：交接线问题由它触发） */
  onTurnSettled?: (facts: TurnSettledFacts) => void;
  /** 内部错误的去处（写库失败、回收失败等）；缺省忽略 */
  onError?: (error: unknown, context: string) => void;
}

/** 边流边写的缺省节流：200ms 一次，兼顾「客户端断了丢得少」与「写盘次数」 */
export const DEFAULT_STREAM_WRITE_INTERVAL_MS = 200;

// ---------------------------------------------------------------------------
// 六态里那些「每片都要摸一遍」的小工具
// ---------------------------------------------------------------------------

/** core 广播的原始 chunk 里本文件用到的部分（`choices[0].delta` 就是 `AgentNS.Delta`） */
interface RawChunk {
  usage?: AgentNS.Usage;
  choices?: Array<{ delta?: AgentNS.Delta; finish_reason?: string | null }>;
}

/** 正文 / 思考的字符数（分段内容只数文本段） */
function contentChars(content: AgentNS.MessageContent | undefined): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const section of content) {
      if ("text" in section && typeof section.text === "string") total += section.text.length;
    }
    return total;
  }
  return 0;
}

/** 工具调用的定位键：优先用 `id`，没有就退回「名字 + 序号」（`function_call` 形态） */
function toolKey(toolCall: AgentNS.ToolCall): string {
  if (toolCall.id) return `id:${toolCall.id}`;
  return `fn:${toolCall.function?.name ?? ""}#${toolCall.index ?? 0}`;
}

/** 两位小数（速率是给人看的一个数，不是账目） */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 唯一一个不需要加来源注释的 source：用户本人说的话（与 core 的 `InboxEntry.source` 同义） */
const SOURCE_USER = "user";

/**
 * 自起段报给 `TurnSettledFacts.source` 的**兜底**值。
 *
 * 正常情况下那一段的来源是叫醒它的那条 inbox 条目的 `source`（见 `ChatRunner.noteInbox`）：
 * 「这一段是被谁叫起来的」这个事实只有投递方知道，报出来才不会把一次会话间投递说成某个
 * 笼统的东西。真不知道时（不是 inbox 叫起来的，例如交接回合自己 `send()` 起的那一段）
 * 才落到这个值：它依旧不是 `"user"` —— 结算那一跳（R59：要不要问交接线的问题）只对
 * 用户本人叫起来的轮次开口。
 */
const SOURCE_INBOX = "inbox";

/**
 * 正文按来源包一层：`"user"`（或缺省）原样返回，其他来源在正文最前面加一行
 * `// 这条消息来自 <source> 自动推送（<时间>）`。
 *
 * 拼装不在这里写第二遍：注释的形状（`注释\n\n正文` / 分段内容在最前面插一段 text）归 core 的
 * `inboxEntryContent`，宿主只是把同一个纯函数用在「宿主自己造 user 消息」这条路上 —— 于是
 * 自动推送的消息不论从 inbox 落地还是从这一轮直接发出，读者看到的是同一行话。
 */
function withSourceNote(
  content: AgentNS.MessageContent,
  source: string,
  messageId: string,
  createdAt: string,
): AgentNS.MessageContent {
  if (source === SOURCE_USER) return content;
  return inboxEntryContent({ messageId, source, priority: "high", content, createdAt });
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
 * 两种都接住：agent 常驻之后“订上去就不能不管”是硬要求（见 `TurnSession.detachListeners`），
 * 所以这里不假设只有一种形状，但也不把三种形状写进公开接口。
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
 * 这条消息在对话落库时写一次，之后不再重写、也不随每轮拼接（说了两遍模型会以为目录变了）。
 * 目录取的是这个对话所属项目的 cwd（不是进程工作目录）；句子用的是「这是宿主加的，不是
 * 用户输入的」那条文案（R21：不新造消息类型）。
 */
export function injectedContextOf(cwd: string, language: Language): string {
  const summary = render(language, "message.injectedContext.cwd", { cwd });
  return render(language, "message.injectedContext", { summary });
}

/**
 * 消息 → 边流边写的入参。
 *
 * `content` 走 JSON 列：存储层的 `content` 列就是 core 内容段的 JSON，两边的形状一致，
 * 只差存储层为了「不 import core」而声明的索引签名，故此处做一次显式转换。
 * `parentToolCallId` 非空即「这条消息是某个子 Agent 说的」（R37 / F-I7）。
 */
function toRow(
  message: AgentNS.Message,
  conversationId: string,
  createdAt: number,
  statusOverride?: AgentNS.MessageStatus,
  parentToolCallId?: string,
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

  return {
    id: message.id,
    conversationId,
    role: message.role,
    status: (statusOverride ?? message.status ?? AgentNSValue.MessageStatus.Unknown) as string,
    omit: message.omit === true,
    content: (message.content ?? null) as unknown as MessageUpsertInput["content"],
    data: Object.keys(data).length > 0 ? data : null,
    parentToolCallId: parentToolCallId ?? null,
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
 * 真正面向某个连接的语言由接线层按 `code` / `messageKey` / `params` 重新渲染（architecture §6）。
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

/** SDK 的 `ContextOverflowError` 形状（只认字段，避免为一次判断引入 SDK 的运行时依赖面） */
function asContextOverflow(
  error: unknown,
): { promptTokens: number; guardTokens: number } | undefined {
  if (!isRecord(error)) return undefined;
  if (error.name !== "ContextOverflowError") return undefined;
  const { promptTokens, guardTokens } = error;
  if (typeof promptTokens !== "number" || typeof guardTokens !== "number") return undefined;
  return { promptTokens, guardTokens };
}

/** 任意抛出物 → 失败事实：到了硬线就说硬线，其余都归为内部错误 + 原始原因 */
function toProblem(error: unknown): ProblemFact {
  const overflow = asContextOverflow(error);
  if (overflow) {
    return problem(
      "context_guard",
      "error.contextGuard",
      { limit: overflow.guardTokens, used: overflow.promptTokens },
      overflow,
    );
  }
  const reason = error instanceof Error ? error.message : String(error);
  return problem("internal", "error.internal", {}, { reason });
}

// ---------------------------------------------------------------------------
// 一轮
// ---------------------------------------------------------------------------

/** 一段现场的共同部分：三个入口（受理 / 自起）都要的东西 */
interface TurnSessionInitBase {
  conversationId: string;
  /** 中止入口（`RunRegistry` 的句柄）。中止只有一个入口，现场只负责订上去 */
  handle: RunHandle;
  /** 这一段开始时刻（ISO 8601） */
  acceptedAt: string;
  startedAtMs: number;
  /** 这一段开始前的历史（受理前的库内历史 / 建现场那一刻 `agent.messages` 的快照） */
  history: AgentNS.Message[];
  /** 结算收尾之后通知一声（`ChatRunner` 用它把这一轮从「现场」表里摘掉） */
  onSettled?: () => void;
}

/**
 * `conversation.send` 受理出来的那一轮：两条消息 id、要发出去的内容、历史都在受理时就定下。
 */
interface AcceptedTurnInit extends TurnSessionInitBase {
  kind: "accepted";
  /** 会话行（`workspaceId` / 模型 / 思考档位都从它来） */
  conversation: Conversation;
  /** 受理时要到的那个 Scope（读配置用；agent 由 `AgentRegistry` 挂在同一个 Scope 上） */
  scope: Scope;
  /** 还原之后的历史（`__asset_id` 已按当时的模型 / 端点换过） */
  history: AgentNS.Message[];
  /**
   * 真装配那一刻要的历史（按**现在**的事实读库 + 还原素材）。
   *
   * 只在一条路上用得到：手里那个 agent 不合用、被 `acquire` 重建了。那时本轮的占位行已经
   * 落库，所以它是「这一轮之前那些行」（界限由 `run()` 拍，`TurnSession` 自己不知道）。
   */
  rebuildHistory: () => Promise<AgentNS.Message[]>;
  content: AgentNS.MessageContent;
  /** 落库用的内容；不给时就是 `content` */
  storedContent?: AgentNS.MessageContent;
  attachments: AttachmentOutcome[];
  language: Language;
  /** 这一轮是谁叫起来的（`ChatRunParams.source` 定下来的那一份） */
  source: string;
  userMessageId: string;
  assistantMessageId: string;
}

/**
 * 自起段：agent 被 `deliver()` 叫醒跑起来的那一段（没有 `conversation.send` 的受理）。
 *
 * 它没有受理，也就没有预分配的两条 id、没有要发出去的内容、没有附件，有的只是「哪个 agent
 * 正在跑这一段」。会话行与 Scope 也**不在这里**：这一段是在 `status` 事件里**同步**建的
 * （迟一拍就错过 core 紧接着 `flushInbox()` 广播的那条 user 消息，见 `ChatRunner.onAgentStatus`），
 * 那是同步上下文，读不了库。它们随后由 `ChatRunner.hydrate` 补上。
 */
interface SelfStartedTurnInit extends TurnSessionInitBase {
  kind: "self-started";
  /** 正在跑这一段的那一个 agent：现场当场就订上它的事件总线（不能等一个 await） */
  agent: ChatAgent;
  /**
   * 这一段是被**谁**叫起来的：投进 inbox 那条条目的 `source`（`ChatRunner.noteInbox` 记的
   * 最近一条）。不知道时是 {@link SOURCE_INBOX}。
   */
  source: string;
}

type TurnSessionInit = AcceptedTurnInit | SelfStartedTurnInit;

/**
 * 一段的现场：消息真相、六态、用量、写库节流。
 *
 * 它同时是 `ChatTurn`（`conversation.send` 的受理回执）：受理与执行是同一件事的两半，
 * 分成两个对象只会让「谁持有内存真相」含糊。
 *
 * ## 两种段，同一个现场
 *
 * - `kind: "accepted"`：`conversation.send` 受理的那一段。两条 id 与占位行都在受理时定了。
 * - `kind: "self-started"`：agent 被 `deliver()` 叫醒自己跑起来的那一段。它没有受理人、
 *   没有占位行、不写任何占位行，两条 id 都是**跑着才定**的（见 `claimId`）。
 *
 * 后面的结算、落库、`runs.finish`、推 `run.state` 两边完全同一套 —— 差别只在 id 从哪来。
 */
class TurnSession implements ChatTurn {
  readonly conversationId: string;
  /**
   * 这一段那条用户消息的 id（`null` = 还不知道）。
   *
   * 普通轮次在受理时就写好了（预分配）；自起段在 core 把 inbox 落地那一刻**认领**：
   * id 就是投递方入队时定的那个，宿主不改写它们（见 `claimId`）。
   */
  userMessageId: string | null;
  /** 这一段那条助手消息的 id（`null` = 还没出占位；自起段首次见到时分配，见 `claimId`） */
  assistantMessageId: string | null;
  readonly attachments: AttachmentOutcome[];
  readonly acceptedAt: string;
  readonly done: Promise<TurnSettlement>;
  /** 这一段是自起段吗（`status` 事件里建的现场）—— 结算时几处分支只看这一个标记 */
  readonly selfStarted: boolean;

  /**
   * 会话行。自起段建现场时（`status` 事件里）还拿不到它：那是同步上下文，读不了库，
   * 由 `hydrate` 随后补上（结算前一定到位，见 `factsReady`）。
   */
  private conversation?: Conversation;
  /** 能力容器（读配置里的模型阈值）；到位时机与 `conversation` 相同 */
  private scope?: Scope;
  /**
   * 「装配事实（会话行 + Scope）到位了」的信号。
   *
   * 普通轮次在受理时就有这两件，这个 Promise 已经是完成态（直接 resolve）；自起段要等
   * `ChatRunner.hydrate` —— 结算要用它们（`conversation.changed` 的 `workspaceId`、交接线的
   * 模型阈值），所以 `settle()` 开头等它。
   */
  private readonly factsReady: Promise<void>;
  private resolveFacts!: () => void;
  /** 还原后的历史（这一轮实际交给 agent 的那份） */
  private history: AgentNS.Message[];
  /**
   * 这一段先前的思考：`history` 是**受理那一刻**拍的（按当时的模型还原过）。
   *
   * 万一段中才发现手里那个 agent 不合用（会话行上的模型 / 档位改过）—— `acquire` 会重建它，
   * 重建要的那份历史得按**现在**的事实重新读库 + 还原素材（换模型本来就该重走那一步）。
   * 这件事只能由 `run()` 接上（它知道这段对话与那两条预分配的 id），于是这里只留一个口子。
   *
   * 自起段没有：它不装配 agent（agent 已经在、正被它拿着跑）。
   */
  private readonly rebuildHistory?: () => Promise<AgentNS.Message[]>;
  /** 这一轮发给模型的内容（`prepareAttachments` 的产物）；自起段没有（它不是受理来的） */
  private content: AgentNS.MessageContent;
  /**
   * 落库的内容（`__asset_id` 形态）：它就是用户挂的那几张图。
   *
   * 自起段没有这一份（那条 user 消息的内容是 core 落地时算好的，带不带来源注释由 core 定），
   * 于是为 `undefined` —— `persistFinal` 就不会拿它去盖掉任何行。
   */
  private readonly storedContent?: AgentNS.MessageContent;
  private readonly language: Language;
  /**
   * 这一轮是谁叫起来的（与 `ChatRunParams.source` 同义）。
   *
   * 两个用处：跑中入队的条目带上它（core 落地时据此加来源注释）、结算时报给
   * `TurnSettledFacts`（自动推送叫起来的轮次不问交接）。
   */
  private readonly source: string;
  private readonly handle: RunHandle;
  private readonly options: ChatRunnerOptions;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly startedAtMs: number;
  private readonly onSettled?: () => void;

  private resolveDone!: (settlement: TurnSettlement) => void;
  private agent?: ChatAgent;
  private aborted = false;
  private problem: ProblemFact | null = null;
  private settledAtMs: number | null = null;

  /** 已经确认过 id 的消息（历史 + 本轮）；不在里面的会被认领成宿主 id */
  private readonly knownIds = new Set<string>();
  /** 每条消息第一次出现的时间（库里的 `createdAt`） */
  private readonly createdAtOf = new Map<string, number>();
  /** 本轮 core 追加过的消息 id，按先后顺序 */
  private readonly producedIds: string[] = [];
  /** 中止时在途的消息 id（D15：这些行以 `Aborted` 落库） */
  private readonly abortedInFlight = new Set<string>();
  private readonly deltaSeq = new Map<string, number>();
  private readonly runningTools = new Map<string, RunningTool>();
  private readonly subagents = new Map<string, SubAgentSnapshot>();
  /** 已经落过库的子 Agent 委派（工具调用 id） */
  private readonly persistedSubAgents = new Set<string>();
  /**
   * 子 Agent 的消息 → 宿主分配的 id。
   *
   * 子 Agent 跑的时候它的消息只在**它自己的内存**里，而客户端要按 id 才拼得起来；id 必须
   * 在第一次见到这条消息时定死，否则「流式时推出去的 id」与「结束后落库的 id」会是两个，
   * 客户端就会以为那是两条消息。
   */
  private readonly subAgentIds = new WeakMap<AgentNS.Message, string>();
  /** 子 Agent 消息的节流写：每条约 streamWriteIntervalMs 写一次（与主线同一个口径） */
  private readonly subWriteAt = new Map<string, number>();
  /** 每个子 Agent 到目前为止追加过几条消息（快照里的 `messageCount` 用它） */
  private readonly subAgentCount = new Map<string, number>();

  private userIdUsed = false;
  private assistantIdUsed = false;
  private streaming?: AgentNS.Message;
  /**
   * 本轮产出的消息：`settle` 开头拍下来的那一份。
   *
   * 旧写法靠「结算时 agent 已经丢了」来保证「本轮产出」只有一个来源（`detached`）；agent
   * 常驻之后它不会被丢，于是改成**定格**：结算开头把这批消息拍下来，之后不管 agent 里又长了
   * 什么（下一段还会往同一个数组里追加），这一轮的结算、用量与快照都只读这一份。
   */
  private roundProduced?: AgentNS.Message[];
  /**
   * 订在 agent（及其子 Agent）事件总线上的监听：agent 常驻，它的寿命不再与本轮一致。
   *
   * 不摘的后果不是泄漏，而是错乱：下一段每次 `message` / `chunk-parsed` 广播都会叫到**已经
   * 结算过的**这一轮上（认领 id、推 `run.state`、再写一遍库）。所以 `settle` 里逐条取消。
   */
  private readonly listeners: Array<() => void> = [];
  /**
   * 这一轮的中止订阅（挂在 `RunHandle` 上）。结算末尾摘掉：agent 常驻，一个过期句柄再按一下
   * 不该按到它头上（`RunRegistry` 已经不认这一轮了，但句柄还在调用方手里）。
   */
  private offAbort?: () => void;
  private generation: GenerationState;
  private writeTimer?: () => void;
  private lastWriteAt = 0;
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * 这一轮不再接新话（`send()` 返回了 / 用户按了停 / 已经结算）。
   *
   * 三处置位：`attemptOnce` 的 finally（这一轮再没有轮末插入点）、`takeAbortSnapshot`、
   * `settle` 兜底。
   */
  private closed = false;
  /**
   * 装配期间收到的投递：agent 还没装上，先存着，装好就冲进它的 inbox。
   *
   * 取舍：`pending` 里那几条随这一轮失败一起丢（与「已经进了 inbox 但这一轮没取走」同一个命）。
   */
  private pending: AgentNS.InboxEntry[] = [];
  /**
   * 已经排队、还没落地的消息 id（落地时据此把它们记进 `producedIds`，按**落地顺序**落库）。
   *
   * 这些 id 同时也在 `knownIds` 里：落地时 core 那条消息带着我们入队时定的 id 回来，
   * `claimId` 不该再给它换一个（D5）。
   */
  private readonly queuedIds = new Set<string>();
  /**
   * 排队条目的**落库那一份**内容（`__asset_id` 形态）。
   *
   * 与老路径的用户消息同一个道理：发给模型的是厂商的 `file_id` / base64，库里要留与端点
   * 无关的引用（F-H7）。core 落地那一刻只认 id 与内容，落库的内容在我们手里。
   */
  private readonly queuedStored = new Map<string, AgentNS.MessageContent>();

  constructor(options: ChatRunnerOptions, init: TurnSessionInit) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? defaultNewId;
    this.conversationId = init.conversationId;
    this.handle = init.handle;
    this.acceptedAt = init.acceptedAt;
    this.startedAtMs = init.startedAtMs;
    this.onSettled = init.onSettled;
    this.generation = { phase: "connected", since: init.acceptedAt };
    // 受理时刚写过一次占位行：节流从那一次算起
    this.lastWriteAt = init.startedAtMs;
    this.done = new Promise<TurnSettlement>((resolve) => {
      this.resolveDone = resolve;
    });
    // 装配事实到位的信号：自起段建现场时还没有它们（见 `factsReady`）
    this.factsReady = new Promise<void>((resolve) => {
      this.resolveFacts = resolve;
    });

    if (init.kind === "accepted") {
      this.selfStarted = false;
      this.conversation = init.conversation;
      this.scope = init.scope;
      this.content = init.content;
      this.storedContent = init.storedContent ?? init.content;
      this.language = init.language;
      this.source = init.source;
      this.attachments = init.attachments;
      this.userMessageId = init.userMessageId;
      this.assistantMessageId = init.assistantMessageId;
      this.rebuildHistory = init.rebuildHistory;
      // 受理时两件都已到手，没有要等的
      this.resolveFacts();
    } else {
      this.selfStarted = true;
      // 自起段：没有发出去的内容、没有要落库的素材那一份、没有任何预分配的 id
      this.content = "";
      this.storedContent = undefined;
      this.language = options.defaultLanguage ?? DEFAULT_LANGUAGE;
      // 这一段是某条 inbox 条目叫起来的：结算时报的就是它的来源（没人看着的那种来源不会问交接）
      this.source = init.source;
      this.attachments = [];
      this.userMessageId = null;
      this.assistantMessageId = null;
      // 就地订上这个 agent：core 紧接着就 `flushInbox()`，那条 user 消息的广播就在下一拍
      this.attach(init.agent, false);
    }

    this.history = init.history;

    for (const message of init.history) {
      this.knownIds.add(message.id);
      this.createdAtOf.set(message.id, this.startedAtMs);
    }
    // 两条由宿主预先分配的消息：id 已经是我们的，不再认领（自起段一条都没有，两处都跳过）
    if (this.userMessageId !== null) {
      this.createdAtOf.set(this.userMessageId, this.startedAtMs);
    }
    if (this.assistantMessageId !== null) {
      this.createdAtOf.set(this.assistantMessageId, this.startedAtMs);
    }
  }

  // ---- 对外的三个动作 ----

  abort(reason?: string): void {
    this.handle.abort(reason);
  }

  runState(): RunState {
    return this.buildRunState();
  }

  /**
   * 自起段「这一段跑起来了」的那一次推送（`ChatRunner` 在订好事件之后立刻叫它）。
   *
   * 普通轮次不需要：`execute()` 一上来就推一次（受理即回，客户端那一刻就该看到 running）。
   */
  announce(): void {
    this.pushRunState();
  }

  /**
   * 把一句用户输入排进这一轮（PRD D14）。
   *
   * 返回 `null` = 这一轮接不了（已经收工 / 被叫停）：调用方回老路径（`run()`），由它决定
   * 「开新一轮」还是「回 `busy` 兜底」。agent 还没装上不算接不了 —— 先收进 `pending`，
   * `attach()` 那一刻冲进它的 inbox。
   *
   * ## 为什么「判能不能排」与「推」之间不允许有 await
   *
   * 中间一旦让出执行权，就可能出现「判完还开着、推的时候已经关上」：条目推进一个再也不会
   * 被取走的 inbox，而我们已经回了客户端 `queued: true` —— 那就是一句假话。所以这里全程同步。
   */
  enqueue(input: {
    content: AgentNS.MessageContent;
    storedContent?: AgentNS.MessageContent;
    attachments: AttachmentOutcome[];
    /** 这一条是谁推来的（缺省 `"user"`）；落地时由 core 据此决定要不要加来源注释 */
    source?: string;
  }): QueuedTurn | null {
    if (this.closed || this.aborted || this.handle.aborted) return null;

    // 消息 id 现在就定死（D5）：客户端马上要按它画一条，落地那条必须用同一个
    const userMessageId = generateMessageId();
    const entry: AgentNS.InboxEntry = {
      messageId: userMessageId,
      // 来源照抄投递方：`"user"`（缺省）不带「这条消息来自…自动推送」那行注释，其他来源由
      // core 在落地那一刻（`inboxEntryContent`）加上 —— 这里不自己拼那句话
      source: input.source ?? SOURCE_USER,
      // 高优先：落点是「工具轮跑完的边界」—— 不打断模型正在吐的那一段，又能尽快接住
      priority: "high",
      content: input.content,
      // 入队时刻在这里定下（装配期的那几条也一样）：`run.state.inbox` 要按它显示「排了多久」
      createdAt: this.nowIso(),
    };
    // 装配期间先存着（谁也不用等），装好了就冲进它的 inbox
    if (this.agent) this.agent.deliver(entry);
    else this.pending.push(entry);
    // 先认下这个 id：落地时 core 那条消息带着它回来，`claimId` 不该再改一遍
    this.knownIds.add(userMessageId);
    this.queuedIds.add(userMessageId);
    this.createdAtOf.set(userMessageId, this.clock.now());
    if (input.storedContent !== undefined) {
      // 落库那一份也要过**同一个**注释函数（与 `run()` 里处理 `storedContent` 的写法一致）：
      // 落地时 `persistLandedQueued` 是拿它整份覆盖行内容的，不过这一道，「非 user 来源 + 带
      // 附件」的条目就会分叉 —— 模型看到的那份带注释，库里那份是原始内容。`source === "user"`
      // 时它原样返回，用户自己发的消息一个字不变；注释只加这一次，`__asset_id` 段原封不动。
      this.queuedStored.set(
        userMessageId,
        withSourceNote(input.storedContent, entry.source, userMessageId, entry.createdAt),
      );
    }

    // 客户端要看得见**这一条**排上了：`inbox` 这会儿刚多了一项（内容摘要、来源、入队时刻都在里面）
    this.pushRunState();

    return {
      conversationId: this.conversationId,
      userMessageId,
      attachments: input.attachments,
      acceptedAt: this.nowIso(),
    };
  }

  /** 真正跑一轮。`ChatRunner` 在受理之后立刻叫它，不等结果 */
  async execute(): Promise<void> {
    try {
      this.pushRunState();
      await this.attemptOnce();
    } catch (error) {
      // 一轮就是一次尝试：失败原样记成这一轮的结局。厂商那侧的降级（Files API 失败改内联、
      // 模型看不了图转为文字）在 SDK 的选路里，这里不重发。
      this.recordFailure(error);
    } finally {
      await this.settle();
    }
  }

  /**
   * 自起段的收尾入口：core 报「这一段跑完了」（`status → idle | terminated`）时叫它（见
   * `ChatRunner.onAgentStatus`）。
   *
   * 与 {@link execute} 的差别只在于**没有 `attemptOnce`**：这一段不是宿主发起的 —— 内容已经由
   * core 从 inbox 落地并跑完，宿主这边只剩结算（写终版、`runs.finish`、推 `run.state`）。
   * 失败也不在这里记：那一路由订在 agent 上的 `error` 事件走 `recordFailure`。
   *
   * 一段里一条 assistant 也没出（开局就失败 / 一开头就被按停）同样走到这里：`settle()` 不依赖
   * `assistantMessageId` 非空，没占位行就不写占位行，但库、`run.state`、`runs.finish` 一件不少。
   */
  finish(): void {
    void this.settle();
  }

  /**
   * 补上装配事实（会话行 + Scope）。只有自起段会调：它在 `status` 事件里同步建现场，
   * 那一刻读不了库（见 `ChatRunner.onAgentStatus` 的「为什么建现场必须同步」）。
   */
  hydrate(conversation: Conversation, scope: Scope): void {
    this.conversation = conversation;
    this.scope = scope;
    this.resolveFacts();
  }

  /**
   * 补不到装配事实（会话行已经没了 / Scope 建不起来）：记成这一段的失败事实，然后放行结算。
   *
   * 放行是不能省的一步：结算在等 `factsReady`，不放行就是永久卡住 —— 而这一段真的跑过，
   * 它的消息就在 agent 里，落库与 `runs.finish` 都必须照常走完。
   */
  failFacts(error: unknown): void {
    this.problem = toProblem(error);
    this.resolveFacts();
  }

  /**
   * 一次尝试：拿 agent → 把历史与用户输入发出去；失败原样上抛，由 `execute` 记成这一轮的结局。
   *
   * agent 从 `AgentRegistry.acquire` 来（在且合用就复用，不在就装配，事实变了就重建 ——
   * 判据全在那边）。本文件不再自己拼装配顺序，也不再决定「它跑完就没」：那是结算时
   * `agents.complete` 与配置生效时 `agents.invalidate` 的事。
   */
  private async attemptOnce(): Promise<void> {
    // 只有受理路径走到这里（自起段没有要发出去的内容，不走本方法），而受理时一定读到了会话行
    const conversation = this.conversation!;
    // 先看一眼它是不是已经在：在 = 历史就是它内存里那份（`run()` 没读库、`attach` 不必 push）
    const live = this.options.agents.get(this.conversationId);
    const agent = await this.options.agents.acquire(
      {
        conversationId: this.conversationId,
        workspaceId: conversation.workspaceId,
        agentId: conversation.agentId,
        modelId: conversation.modelId,
        thinkingLevel: conversation.thinkingLevel,
        // 只在真装配时用得到：已有且合用时这个字段被忽略（`acquire` 直接交还那个实例）
        history: [...this.history],
      },
      conversation,
    );
    // 交回来的不是原来那个 = 真的装了一个新的（首次装配 / 装配事实变了）：历史要 push 进去。
    //
    // 事实变了那一路 `run()` 手里那份是按**旧**事实还原的（那时还不知道会不会复用），所以
    // 这里按现在的事实重读一次库 —— 换模型本来就该把历史里的素材重走一遍（F-H7）。
    if (agent !== live) {
      if (live !== undefined) {
        const rebuilt = await this.rebuildHistory?.();
        if (rebuilt) this.history = rebuilt;
      }
      this.attach(agent, true);
    } else {
      this.attach(agent, false);
    }

    // 装配 agent 期间用户就按了停：不再发请求，直接按中止结算
    if (this.handle.aborted) {
      this.takeAbortSnapshot();
      agent.abort();
      return;
    }
    try {
      await agent.send(this.content);
    } finally {
      // `send()` 返回 = 这一轮再没有轮末插入点：此刻起排进来的条目一句也不会被发出去。
      // 门必须在这里关上 —— `settle()` 还要写库，那一段时间在 `RunRegistry` 眼里仍然「在跑」。
      this.closed = true;
    }
  }

  // ---- 装配：把 core 的事件接到本文件 ----

  /**
   * 装配：把 core 的事件接到本文件。
   *
   * `seedHistory` 只在**首次装配**时为真（agent 是这一轮才造出来的）：那时它的 `messages` 是空的，
   * 历史（从库里读、按当前模型还原过的那份）要 push 进去。复用时**不能** push —— 它内存里的
   * 消息已经是这段对话的全部历史（连同上一段的产出），再 push 一遍就是双份。
   */
  private attach(agent: ChatAgent, seedHistory: boolean): void {
    this.agent = agent;
    // 首次装配：历史就是这个 agent 的全部消息（内存里只有这一份）
    if (seedHistory) agent.messages.push(...this.history);
    this.listen(agent);
  }

  /**
   * 把 core 的事件接到本文件（`attach` 与自起段的构造函数共用）。
   *
   * 拆出来是因为自起段要「到场就订上」：`attach` 除了订阅还要接历史（push），而自起段那一步
   * 是空动作。拆完之后两边订的是**同一套**事件 —— 少订一个，自起段就会出现「落了库但没推
   * 流式」之类的半边现场。
   */
  private listen(agent: ChatAgent): void {
    this.subscribe(agent.events, "message", (message: AgentNS.Message) => this.onMessage(message));
    this.subscribe(agent.events, "open", () => this.enterAwaitingFirstToken());
    this.subscribe(agent.events, "chunk-parsed", (receiver: AgentNS.Message, chunk: RawChunk) =>
      this.onChunk(receiver, chunk),
    );
    this.subscribe(agent.events, "error", (error: unknown) => this.recordFailure(error));
    this.subscribe(agent.events, "tool-call-end", (ctx: ToolCallEndContext) =>
      this.onToolCallEnd(ctx),
    );
    this.subscribe(agent.events, "sub-agent-start", (ctx: SubAgentContext) =>
      this.onSubAgentStart(ctx),
    );
    this.subscribe(agent.events, "sub-agent-end", (ctx: SubAgentContext) =>
      this.onSubAgentEnd(ctx),
    );

    // 中止只有一个入口：RunRegistry 的句柄（服务层的 abort 也走这里）。
    // 它挂在**这一轮的** `RunHandle` 上（不是 agent 上），所以结算末尾单独摘（`offAbort`）。
    this.offAbort = this.handle.onAbort(() => {
      this.takeAbortSnapshot();
      this.agent?.abort();
    });

    // 装好了：装配期间收下的那几句现在冲进它的 inbox（随这一轮失败一起丢，不单独追）
    for (const entry of this.pending.splice(0)) agent.deliver(entry);
  }

  /**
   * 订一个事件，并把「取消订阅」收在 {@link listeners} 里。
   *
   * 三种事件口都接得住：core 的 `EventBus.on` 返回 `Disposable`（`{ dispose() }`）、测试里的
   * 记账总线返回函数、最小假件返回 `undefined`（那样就不会被摘，但没有真实总线也就没有后患）。
   */
  private subscribe(
    events: { on(name: string, handler: (...args: never[]) => void): unknown },
    name: string,
    handler: (...args: never[]) => void,
  ): void {
    const off = toUnsubscribe(events.on(name, handler));
    if (off) this.listeners.push(off);
  }

  /**
   * 把订在 agent（与子 Agent）上的监听全部摘掉 —— 这一轮的子就在这一刻结束。
   *
   * agent 常驻，事件总线也就不再随它一起死：没摘的监听会在下一段被叫醒，拿一个已经结算过的
   * 现场去认领 id / 推状态 / 写库。
   */
  private detachListeners(): void {
    for (const off of this.listeners.splice(0)) {
      try {
        off();
      } catch (error) {
        this.options.onError?.(error, "detach-agent-listeners");
      }
    }
  }

  /** core 追加了一条消息：认领 id、记时间、更新六态里那些跟消息有关的部分 */
  private onMessage(message: AgentNS.Message): void {
    if (this.queuedIds.delete(message.id)) {
      // 排队的那条落地了：core 在轮末把它 append 进来，id 是入队时定的那个（D5），
      // 所以这里既不重新认领、也不换 id。现在才把它记进 `producedIds`。
      this.createdAtOf.set(message.id, this.clock.now());
      if (!this.producedIds.includes(message.id)) this.producedIds.push(message.id);
      // **落地这一刻就写库**（不能拖到 `persistFinal`）：`seq` 是 `MAX(seq)+1` 按插入顺序
      // 给的，而助手消息是边流边写的 —— 排队这一句若等到收尾才第一次写，它就会排到
      // 它引出的那条回答**之后**（真机上量出来的颠倒）。见 `persistLandedQueued`。
      this.persistLandedQueued(message);
      // 排队的少了一条（core 落地时已经从 inbox 里摘走），客户端据此收起一个「已排队」
      this.pushRunState();
      return;
    }
    if (!this.knownIds.has(message.id)) {
      message.id = this.claimId(message);
      this.knownIds.add(message.id);
      this.createdAtOf.set(message.id, this.clock.now());
      if (!this.producedIds.includes(message.id)) this.producedIds.push(message.id);
      if (this.selfStarted && message.role === AgentNSValue.Role.User) {
        // 自起段里由 core 落地的那条 user 消息（投递进来的条目，不是跑中排队那一半）：
        // **这一刻就写库**。不能等到收尾那一次：`seq` 按插入顺序给，而这一段的助手消息是边流
        // 边写的 —— 等到收尾才首次写它，库里它就会排到它引出的那条回答**之后**（与
        // `persistLandedQueued` 同一个道理，普通轮次的这条消息在受理时就写过了）。
        this.enqueueWrite(message);
        // 队列被取走了一条，客户端据此收起「已排队」
        this.pushRunState();
      }
    }

    if (message.role === AgentNSValue.Role.Assistant) {
      if (message.status === AgentNSValue.MessageStatus.Pending) {
        // 新一轮内循环的占位：接下来要拼的就是它
        this.streaming = message;
        this.setGeneration({ phase: "connected", since: this.sinceFor("connected") });
      }
      return;
    }

    if (
      message.role === AgentNSValue.Role.Tool ||
      message.role === AgentNSValue.Role.Function
    ) {
      this.trackRunningTool(message);
      // 工具结果一出现就落一行（状态还是 pending）：进程中间没了，装载时能看出
      // 「这个工具参与了、但没定型」，而不是压根不知道它存在
      this.enqueueWrite(message);
    }
  }

  /**
   * 认领 id：这一段里的消息各自用哪个 id。
   *
   * ## 普通轮次
   *
   * 头两条（用户消息、助手占位）用受理时预分配、已经告诉客户端的 id，之后 core 追加的每一条
   * 各自要一个新 id（id 由宿主分配，PRD L6）。
   *
   * ## 自起段（一路 `??=`，不覆盖）
   *
   * - 第一条 user 消息：**就是 core 从 inbox 落地的那条**，id 是投递方入队时定死的那个，
   *   宿主认领它（记下来，用于后面的 `storedContent` / 结算）但**不改写**：改写会让同一条
   *   内容在客户端画两遍（D5）。
   * - 第一条 pending assistant：没有占位行，也就没有预分配 —— 在这一刻用 `newId()` 分配并登记，
   *   此后这条消息的流、落库、结算都用它。
   */
  private claimId(message: AgentNS.Message): string {
    if (message.role === AgentNSValue.Role.User && !this.userIdUsed) {
      this.userIdUsed = true;
      if (this.userMessageId === null) {
        // 自起段：认领 core 落地时用的那个 id，原样返回（不改写）
        this.userMessageId = message.id;
      }
      return this.userMessageId;
    }
    if (
      message.role === AgentNSValue.Role.Assistant &&
      !this.assistantIdUsed &&
      message.status === AgentNSValue.MessageStatus.Pending
    ) {
      this.assistantIdUsed = true;
      // 自起段：首次见到占位那一刻分配并登记（普通轮次这里是受理时那个 id，不变）
      this.assistantMessageId ??= this.newId();
      return this.assistantMessageId;
    }
    return this.newId();
  }

  /** 一片增量：推事件（core 的 `AgentNS.Delta` 原样）+ 推进六态 + 节流写库 */
  private onChunk(receiver: AgentNS.Message, chunk: RawChunk): void {
    const delta = chunk.choices?.[0]?.delta;
    // 只有外层字段的收尾片（带 usage / finish_reason）不产生增量事件
    if (!delta) return;
    const seq = this.deltaSeq.get(receiver.id) ?? 0;
    this.deltaSeq.set(receiver.id, seq + 1);
    this.options.emit("message.delta", {
      conversationId: this.conversationId,
      messageId: receiver.id,
      seq,
      delta,
      at: this.nowIso(),
    });

    this.advanceGeneration(receiver, delta);
    this.scheduleStreamWrite(receiver);
  }

  /**
   * 一个工具定型了（L8 的「在等哪几个工具」）。
   *
   * 剩下还有工具没定型就继续报「在等工具」，并把列表缩到还在跑的那些（并行时逐个减少）。
   * 都定型了就不该停在「在等工具」：那一态描述的是一件已经不成立的事，此时回到「连上」
   * （接下来要么是下一轮的首字，要么这一轮结束）。
   */
  private onToolCallEnd(ctx: ToolCallEndContext): void {
    this.runningTools.delete(toolKey(ctx.toolCall));
    if (this.runningTools.size === 0) {
      this.setGeneration({ phase: "connected", since: this.sinceFor("connected") });
      return;
    }
    this.setGeneration({
      phase: "awaiting_tools",
      since: this.sinceFor("awaiting_tools"),
      runningTools: [...this.runningTools.values()],
    });
  }

  private onSubAgentStart(ctx: SubAgentContext): void {
    const toolCallId = ctx.toolCallContext.tool_call.id ?? "";
    const snapshot: SubAgentSnapshot = {
      toolCallId,
      name: subAgentName(ctx.subAgent),
      status: "running",
      startedAt: this.nowIso(),
      finishedAt: null,
      messageCount: ctx.subAgent.messages.length,
      usage: null,
      problem: null,
    };
    this.subagents.set(toolCallId, snapshot);

    // 子 Agent 说的话也要过线（F-I7）：它跑在自己的 Agent 实例里，宿主不转发的话，
    // 客户端只能等它跑完去读库 —— 中间整段时间屏幕上是一个字都没有的。
    // 订的是子 Agent 自己的总线（随它一起没），但同样记进 `listeners`：子 Agent 活过这一段时
    // 也不该再叫到一个已结算的现场上。
    this.subscribe(ctx.subAgent.events, "message", (message: AgentNS.Message) => {
      this.onSubAgentMessage(toolCallId, message);
    });
    this.subscribe(
      ctx.subAgent.events,
      "chunk-parsed",
      (receiver: AgentNS.Message, chunk: RawChunk) => {
        this.onSubAgentChunk(toolCallId, receiver, chunk);
      },
    );

    const running = this.runningTools.get(toolKey(ctx.toolCallContext.tool_call));
    if (running) running.subagent = snapshot;
    this.pushRunState();
  }

  /** 子 Agent 追加了一条消息：先定 id（与落库那份一致），再刷新条数 */
  private onSubAgentMessage(toolCallId: string, message: AgentNS.Message): void {
    if (this.subAgentIds.has(message)) return;
    this.subAgentIdOf(message);
    const count = (this.subAgentCount.get(toolCallId) ?? 0) + 1;
    this.subAgentCount.set(toolCallId, count);
    const snapshot = this.subagents.get(toolCallId);
    if (snapshot) snapshot.messageCount = count;
    this.pushRunState();
  }

  /** 子 Agent 的一片增量：推成 `message.delta`（带 `toolCallId`）+ 节流写库 */
  private onSubAgentChunk(toolCallId: string, receiver: AgentNS.Message, chunk: RawChunk): void {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
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
    this.scheduleSubAgentWrite(toolCallId, receiver);
  }

  /** 子 Agent 那条消息的 id（第一次见就定下来，之后一直用这一个） */
  private subAgentIdOf(message: AgentNS.Message): string {
    const existing = this.subAgentIds.get(message);
    if (existing !== undefined) return existing;
    const id = this.newId();
    this.subAgentIds.set(message, id);
    this.createdAtOf.set(id, this.clock.now());
    return id;
  }

  private onSubAgentEnd(ctx: SubAgentContext): void {
    const toolCallId = ctx.toolCallContext.tool_call.id ?? "";
    const existing = this.subagents.get(toolCallId);
    if (!existing) return;

    const usage = sumUsage(ctx.subAgent.messages);
    const failed = ctx.subAgent.messages.some(
      (message) => message.status === AgentNSValue.MessageStatus.Error,
    );
    existing.status = this.aborted ? "aborted" : failed ? "error" : "done";
    existing.finishedAt = this.nowIso();
    existing.usage = usage;
    if (failed) {
      const reason = lastErrorText(ctx.subAgent.messages);
      existing.problem = problem("subagent.failed", "message.subagentFailed", {
        name: existing.name,
        reason,
      });
    }

    // F-I7：子 Agent 说过的话也落库（挂在那次委派的工具调用上），条数就是真落下去的条数
    const rows = this.persistSubAgent(toolCallId, ctx.subAgent.messages);
    existing.messageCount = rows;
    this.pushRunState();
  }

  /**
   * 把子 Agent 的消息落库（F-I7），返回落了多条。
   *
   * 同一次委派只落一遍（`sub-agent-end` 重复到达时不重复写）；每条都拿**宿主已经发给客户端的**
   * 那个 id（`subAgentIds`）—— 另给一个新 id 会让客户端把同一条消息当成两条。
   * 挂上 `parentToolCallId`，`seq` 由仓储在对话内递增。
   */
  private persistSubAgent(toolCallId: string, messages: readonly AgentNS.Message[]): number {
    if (this.persistedSubAgents.has(toolCallId)) return messages.length;
    this.persistedSubAgents.add(toolCallId);
    const now = this.clock.now();
    const rows = messages.map((message) => {
      const id = this.subAgentIdOf(message);
      return toRow(
        { ...message, id },
        this.conversationId,
        this.createdAtOf.get(id) ?? now,
        undefined,
        toolCallId,
      );
    });
    this.enqueueWrites(rows);
    return rows.length;
  }

  /** 工具结果消息一出现就算「开始等它」；并行时列表里有几个就是几个（PRD L8） */
  private trackRunningTool(message: AgentNS.Message): void {
    const call: AgentNS.ToolCall = {
      id: message.tool_call_id,
      type: "function",
      function: { name: message.name ?? "" },
    };
    const key = message.tool_call_id ? `id:${message.tool_call_id}` : toolKey(call);
    if (this.runningTools.has(key)) return;
    this.runningTools.set(key, { toolCall: call, startedAt: this.nowIso() });
    this.setGeneration({
      phase: "awaiting_tools",
      since: this.sinceFor("awaiting_tools"),
      runningTools: [...this.runningTools.values()],
    });
  }

  // ---- 六态 ----

  /** 同一态内沿用原来的 `since`，换态才用此刻（客户端据此算「这一态多久了」） */
  private sinceFor(phase: GenerationPhaseName): string {
    return this.generation.phase === phase ? this.generation.since : this.nowIso();
  }

  private enterAwaitingFirstToken(): void {
    this.setGeneration({
      phase: "awaiting_first_token",
      since: this.sinceFor("awaiting_first_token"),
    });
  }

  /**
   * 按这一片带来的东西推进六态。
   *
   * 只往前推、不回退：思考之后来正文是「在想 → 在输出」；正文之后再来的思考片
   * 不把状态拽回「在想」（同一条消息内部顺序恒定，F-I2）。
   */
  private advanceGeneration(receiver: AgentNS.Message, delta: AgentNS.Delta): void {
    if (delta.tool_calls?.length) {
      this.setGeneration({
        phase: "assembling_tool_calls",
        since: this.sinceFor("assembling_tool_calls"),
        toolCalls: assemblingToolCalls(receiver),
      });
      return;
    }
    if (delta.content !== undefined) {
      this.setGeneration({
        phase: "generating",
        since: this.sinceFor("generating"),
        chars: contentChars(receiver.content),
      });
      return;
    }
    if (delta.reasoning_content !== undefined && this.generation.phase !== "generating") {
      this.setGeneration({
        phase: "thinking",
        since: this.sinceFor("thinking"),
        chars: receiver.reasoning_content?.length ?? 0,
      });
    }
  }

  /**
   * 换态/换列表时推一次 `run.state`。
   *
   * 字符数增长不单独推：增量本来就在 `message.delta` 里，`run.state` 只在「换了一态」或
   * 「还在跑的工具变了」这两种事实变化时发，免得一条流式消息把状态事件刷成两倍流量。
   */
  private setGeneration(next: GenerationState): void {
    const changed = !sameGeneration(this.generation, next);
    this.generation = next;
    if (changed) this.pushRunState();
  }

  // ---- 写库 ----

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

  private enqueueWrite(message: AgentNS.Message): void {
    this.lastWriteAt = this.clock.now();
    const row = toRow(
      message,
      this.conversationId,
      this.createdAtOf.get(message.id) ?? this.clock.now(),
      this.abortedInFlight.has(message.id) ? AgentNSValue.MessageStatus.Aborted : undefined,
    );
    this.writeChain = this.writeChain
      .then(() => this.options.messages.upsert(row))
      .catch((error: unknown) => this.options.onError?.(error, "stream-write"));
  }

  /**
   * 子 Agent 消息的节流写（与主线同一份节奏）。
   *
   * 不写的话，子 Agent 在跑的那几十分钟里库里什么都没有：客户端切过去是一页空白，
   * 中途断线也一个字不剩。写完不丢终版：`sub-agent-end` 时 `persistSubAgent` 用同一批 id 再写一次。
   */
  private scheduleSubAgentWrite(toolCallId: string, message: AgentNS.Message): void {
    const interval = this.options.streamWriteIntervalMs ?? DEFAULT_STREAM_WRITE_INTERVAL_MS;
    if (interval <= 0) {
      this.enqueueSubAgentWrite(toolCallId, message);
      return;
    }
    const id = this.subAgentIdOf(message);
    const now = this.clock.now();
    if (now - (this.subWriteAt.get(id) ?? 0) < interval) return;
    this.subWriteAt.set(id, now);
    this.enqueueSubAgentWrite(toolCallId, message);
  }

  private enqueueSubAgentWrite(toolCallId: string, message: AgentNS.Message): void {
    const id = this.subAgentIdOf(message);
    const row = toRow(
      { ...message, id },
      this.conversationId,
      this.createdAtOf.get(id) ?? this.clock.now(),
      undefined,
      toolCallId,
    );
    this.writeChain = this.writeChain
      .then(() => this.options.messages.upsert(row))
      .catch((error: unknown) => this.options.onError?.(error, "sub-agent-stream-write"));
  }

  /**
   * 排队落地的那条用户消息：**落地这一刻**写下它的行（而不是等到收尾）。
   *
   * ## 为什么必须是这一刻
   *
   * `seq` 由存储层按插入顺序给（`MAX(seq)+1`，见 `MessageRepository` 的 UPSERT），而助手消息是
   * 边流边写的（`scheduleStreamWrite`）。排队那句要是等到 `persistFinal` 才第一次写，它的
   * `seq` 就排在**它引出的那一轮回答之后** —— 客户端重开这段对话时读到的转录成了
   * 「助手说完 → 助手又说 → 用户冒一句」，而且最后那句永远没有回答它的助手消息。
   * 普通（非排队）用户消息没有这个毛病：它在 `run()` 受理时就写行了。
   *
   * ## 为什么写行与记素材关系绑在一起
   *
   * `conversation_assets.messageId` 的外键指着 `messages.id`，所以只能「先写行、再记关系」;
   * 老路径也是这个顺序（受理时写行 → 紧接着 `linkMessageAssets`）。排队这条晚落地，但口径
   * 一样，只是搬到了它真正成为一条消息的那一刻。
   *
   * 写进串行链（`writeChain`）而不是当场 await：`onMessage` 是同步的事件处理器，接不住
   * Promise；而链上已经有边流边写与子 Agent 的写，跟着排队才能保证落盘顺序与事件顺序一致，
   * 也让 `settle()` 的 `flushWrites()` 自然等到它写完。
   *
   * 落库正文用 `queuedStored` 那一份（`__asset_id` 形态），与主消息同一个口径：发给模型的
   * 是厂商产物，库里不能绑死在这次发送的端点上。
   */
  private persistLandedQueued(message: AgentNS.Message): void {
    // 落地时刻（onMessage 刚记下的那一份）：库里的时间线要与它在对话里的位置一致，
    // 用受理时刻会把它拉到这一轮开头，用收尾时刻会把它推到回答后面，两个都不对
    const createdAt = this.createdAtOf.get(message.id) ?? this.clock.now();
    const row = toRow(message, this.conversationId, createdAt);
    const stored = this.queuedStored.get(message.id);
    if (stored !== undefined) {
      row.content = stored as unknown as MessageUpsertInput["content"];
    }
    this.writeChain = this.writeChain
      .then(async () => {
        // 同一 id 再写是覆盖（仓储 `ON CONFLICT (id) DO UPDATE`：`seq` 与 `createdAt` 保留
        // 第一次写入时的值），所以收尾那一遍不会把这条换成两行、也不会改掉它的 `seq`
        await this.options.messages.upsert(row);
        await this.linkQueuedAssets([message]);
      })
      .catch((error: unknown) => this.options.onError?.(error, "queued-landing-write"));
  }

  /** 一批行按同一份额度写下去（子 Agent 的消息一次写一拍）；与边流边写共用一条串行链 */
  private enqueueWrites(rows: MessageUpsertInput[]): void {
    if (rows.length === 0) return;
    this.lastWriteAt = this.clock.now();
    this.writeChain = this.writeChain
      .then(() => this.options.messages.upsertMany(rows))
      .catch((error: unknown) => this.options.onError?.(error, "sub-agent-write"));
  }

  /** 把挂着的节流写收干净（结算前必须做：不能让「最终版」被一次迟到的增量写覆盖） */
  private async flushWrites(): Promise<void> {
    this.writeTimer?.();
    this.writeTimer = undefined;
    await this.writeChain;
  }

  // ---- 结算 ----

  private recordFailure(error: unknown): void {
    // 用户按下中止时 core 也可能抛一次（请求被 abort）：那不是失败，不记 problem
    if (this.aborted || this.handle.aborted) return;
    this.problem = toProblem(error);
  }

  /** 中止那一刻在途的消息：core 会把它们标成 Aborted，这里的 id 用来保证库里也记 Aborted（D15） */
  private takeAbortSnapshot(): void {
    this.aborted = true;
    // 用户按停 = 这一轮不再接新话，所以这里就把门关上
    this.closed = true;
    for (const message of this.agent?.messages ?? []) {
      if (
        message.status === AgentNSValue.MessageStatus.Pending ||
        message.status === AgentNSValue.MessageStatus.Writing
      ) {
        this.abortedInFlight.add(message.id);
      }
    }
    if (!this.assistantIdUsed && this.assistantMessageId !== null) {
      this.abortedInFlight.add(this.assistantMessageId);
    }
  }

  private outcome(): RunOutcome {
    if (this.aborted || this.handle.aborted) return "aborted";
    return this.problem ? "error" : "completed";
  }

  private async settle(): Promise<void> {
    if (this.settledAtMs !== null) return;
    this.settledAtMs = this.clock.now();
    // 兜底：装配就失败 / 没走完 `send()` 的那几条路径也把门关上
    this.closed = true;

    // 先把装配事实等到手：自起段建现场时读不了库（见 `onAgentStatus`），会话行与 Scope 是
    // 随后补的，而下面几处（`conversation.changed` 的 `workspaceId`、交接线的模型阈值）要用它们。
    // 普通轮次在受理时就有，这个 await 是空转。
    await this.factsReady;

    const outcome = this.outcome();
    // 本轮产出的消息在结算**开头**就定格（而不是等到“agent 已经不在了”那一刻）：agent 常驻，
    // 之后它还会被下一段接着改写 —— 谁在哪一刻问「本轮产出了什么」，答案必须是这一份。
    const produced = this.producedMessages();
    this.roundProduced = produced;
    // agent 不再随这一轮消失，所以订在它总线上的监听要显式摘：不摘的话下一段的广播会叫到
    // 这个已经结算的现场上。
    this.detachListeners();

    try {
      await this.flushWrites();
      await this.persistFinal(outcome, produced);
    } catch (error) {
      this.options.onError?.(error, "final-write");
    }

    // 收工那一刻 inbox 里还有东西 = 这一轮欠着一句没落地。正常路径上这里应当是空的：取件点
    // 在 core 的 `run()` 里（一段跑完一组就取一次），而收尾钩子之后投进来的条目 core 已经不再
    // 顺手带走 —— 这一轮不会再发它们，所以得吭声。（agent 常驻之后它们**不会被丢**：留在
    // inbox 里等下一次外部驱动的那一段带走，但「这一轮没接住」仍是一个不该无声发生的事实。）
    //
    // 只有一种「还剩下」是**预期**的，不报：用户按了停 —— core 的 `abort()` 不再清空 inbox
    // （有意的语义变更：一条来自别的会话的投递不该被「用户按停」这个无关动作抹掉）。
    const leftover = this.agent?.inbox ?? [];
    if (leftover.length > 0 && !this.aborted && !this.handle.aborted) {
      const ids = leftover.map((entry) => entry.messageId).join(", ");
      this.options.onError?.(
        new Error(`这一轮已经收工，inbox 里还剩 ${leftover.length} 条没被取走：${ids}`),
        "inbox-leftover",
      );
    }

    // agent 不再跑完即弃：它留在 `AgentRegistry` 里，下一段 `acquire` 拿到的就是它（连同它的
    // messages、inbox 与装好的模型客户端）。所以这里**没有** `this.agent = undefined`，也没有
    // 无条件的退役 —— 留不留由 `complete` 按「配置改过没有」判。
    this.options.runs.finish(this.conversationId);

    // 陈旧标记的兑现处：配置改过、而它当时正在跑（`AgentRegistry.invalidate` 只打标记不强行
    // 停），现在这一段真的结束了 —— 陈旧就退役，下一段 `acquire` 按新配置重新装配（= 复活）。
    //
    // 顺序：先 `runs.finish` 再结算。两步之间没有 await，`invalidate` 插不进来；而反过来
    // （先判后 finish）插进来的 `invalidate` 会看见「还在跑」而只打标记 —— 那个标记就没人再
    // 来兑现了（这一段已经过了检查点）。先 finish 则它看见「空闲」，当场就能退役。
    this.options.agents.complete(this.conversationId);

    // 这一轮的句柄到此就不该再能按到那个（现在常驻的）agent 上：摘掉中止订阅。
    // 结算之后用户再按一次「停」，`RunRegistry` 已经不认这一轮；如果订阅还在，那一下会传到
    // 下一段要用的那个 agent 上（core 里 `abort()` 打在静止态上 = 把它拉到 `terminated`）。
    this.offAbort?.();
    this.offAbort = undefined;

    const usage = this.usageSnapshot();
    const run = this.buildRunState();
    this.options.emit("run.state", {
      conversationId: this.conversationId,
      run,
      at: this.nowIso(),
    });
    this.options.emit("usage", { conversationId: this.conversationId, usage, at: this.nowIso() });
    // 装配事实没到位（自起段补不到会话行）：没有 `workspaceId` 可报，这一跳跳过 ——
    // 库里那几行已经写了，客户端下一次 `conversation.state` 照样能拿到。
    const workspaceId = this.conversation?.workspaceId;
    if (workspaceId !== undefined) {
      this.options.emit("conversation.changed", {
        conversationId: this.conversationId,
        workspaceId,
        change: "messages_persisted",
        messageCount: this.history.length + produced.length,
        at: this.nowIso(),
      });
    }

    this.resolveDone({
      conversationId: this.conversationId,
      assistantMessageId: this.assistantMessageId,
      outcome,
      problem: this.problem,
      messages: [...this.history, ...produced],
      produced,
      usage,
      run,
    });

    this.notifySettled(outcome, usage);
    this.onSettled?.();
  }

  /**
   * 一轮结算之后通知组装层（R59：交接线问题由它触发）。
   *
   * 这一跳只报事实：本轮 `prompt_tokens`、生效模型上那条交接线、这一轮连接的语言。
   * 「到线了没、要不要问用户」不在本文件判断（PRD D22：问，且不在流式中途）。
   */
  private notifySettled(outcome: RunOutcome, usage: UsageSnapshot): void {
    const onSettled = this.options.onTurnSettled;
    if (!onSettled) return;
    // 装配事实没到位（自起段补不到会话行）时：没有模型阈值可报，用 `0`（= 没配，不问交接）
    const model = this.scope?.config.models.find(
      (candidate) => candidate.id === this.conversation?.modelId,
    );
    try {
      onSettled({
        conversationId: this.conversationId,
        outcome,
        // 结算之后要把这一段的结果转述出去的那条链路要用它（见 `TurnSettledFacts.problem`）
        problem: this.problem,
        source: this.source,
        promptTokens: usage.turn.prompt_tokens,
        handoffTokens: model?.tokenThresholds.handoff ?? 0,
        language: this.language,
      });
    } catch (error) {
      this.options.onError?.(error, "on-turn-settled");
    }
  }

  /**
   * 内循环结束写一次最终版（PRD F-C2）。
   *
   * 除了本轮产出的消息，还要兜住一种情况：助手占位在 agent 建起来之前就结束了（装配失败、
   * 或被立刻中止），库里那条占位必须有个终态，否则客户端会看到一条永远在写的消息。
   *
   * **这一写不是所有消息的首次写入**：助手消息边流边写、普通用户消息在受理时就写、排队落地
   * 的用户消息在落地那一刻写（`persistLandedQueued`）、自起段那条 user 消息也在落地那一刻写
   * （`onMessage`）。这里是「把终态盖回去」的那一遍 —— 尤其用户消息，第一次写入时它还只是一条
   * 刚落地的行。所以它必须留在，但不能再被当成「排队那条第一次出现的时刻」。
   */
  private async persistFinal(outcome: RunOutcome, produced: AgentNS.Message[]): Promise<void> {
    const rows = produced.map((message) => {
      const row = toRow(
        message,
        this.conversationId,
        this.createdAtOf.get(message.id) ?? this.settledAtMs ?? this.clock.now(),
        this.abortedInFlight.has(message.id) ? AgentNSValue.MessageStatus.Aborted : undefined,
      );
      // 用户那条消息在 core 那边带着「这一次发出去的内容」（厂商的 file_id / base64）。
      // 落库要的是 `__asset_id` 那一份：否则库里这条消息就绑死在这次发送所用的端点上了。
      // 排队进来的那几句同样有这个岔路（D14：排队的也走一遍素材准备），只是它们各自那一份
      // 存在 `queuedStored` 里 —— 每句话的附件可以不同，不能拿主消息那份套上去。
      // 自起段一条也不匹配：它的 `storedContent` 是 `undefined`，那条 user 消息就用 core
      // 落地时算好的内容（带不带来源注释由 core 定，宿主不改）。
      const stored =
        message.id === this.userMessageId ? this.storedContent : this.queuedStored.get(message.id);
      if (stored !== undefined) {
        row.content = stored as unknown as MessageUpsertInput["content"];
      }
      return row;
    });

    // 占位行只有受理时写过（普通轮次）：自起段没有预分配的助手 id、也从未向客户端发过
    // 一条占位，所以一段里没出 assistant 消息时这里什么都不补（否则库里会凭空多一条
    // 谁也不认识、也没人回答的空助手消息）。
    if (!this.assistantIdUsed && this.assistantMessageId !== null) {
      const status =
        outcome === "aborted"
          ? AgentNSValue.MessageStatus.Aborted
          : outcome === "error"
            ? AgentNSValue.MessageStatus.Error
            : AgentNSValue.MessageStatus.Completed;
      rows.push({
        id: this.assistantMessageId,
        conversationId: this.conversationId,
        role: AgentNSValue.Role.Assistant,
        status: status as string,
        omit: false,
        content: null,
        data: null,
        createdAt: this.startedAtMs,
      });
    }

    // 收尾这一写是**终态回写**：所有消息都要，包括本轮落地时已经写过行的那几句排队消息
    // （`persistLandedQueued`）。同一 id 的重复写只是覆盖（仓储 `ON CONFLICT (id) DO UPDATE`，
    // `seq` / `createdAt` 保留第一次的值），所以它不会把那条变成两行、也不会把它的 `seq`
    // 改到回答后面 —— 但前提是落地那一刻已经写过一次，不能靠它当首次写入。
    if (rows.length > 0) await this.options.messages.upsertMany(rows);
  }

  /**
   * 排队落地的那些用户消息 → 素材关系行（F-H7）。
   *
   * 调用点是 {@link persistLandedQueued} 里紧跟着行写入的那一步：外键方向决定了只能「先写行、
   * 再记关系」（`conversation_assets.messageId` 指着 `messages.id`）。放到收尾就算晚了 ——
   * 那时这条消息已经该在库里了。
   *
   * 失败不当成这一轮的失败（消息已经发出去了）：记不下来只是引用计数少一行，删字节会晚一步。
   */
  private async linkQueuedAssets(landed: readonly AgentNS.Message[]): Promise<void> {
    const link = this.options.linkMessageAssets;
    if (!link) return;
    for (const message of landed) {
      const content = this.queuedStored.get(message.id);
      // 只有排队进来的那些在 `queuedStored` 里（主消息走受理那一处，不在这里重记一遍）
      if (content === undefined) continue;
      try {
        await link({ conversationId: this.conversationId, messageId: message.id, content });
      } catch (error) {
        this.options.onError?.(error, "link-queued-assets");
      }
    }
  }

  /**
   * 本轮 core 追加过的消息（按先后顺序；被 core 整段替换掉的就不在里面了）。
   *
   * 结算之后一律读 `roundProduced`（开头定格的那一份）：agent 常驻，它里面的东西已经不是
   * 「这一轮的」了。
   */
  private producedMessages(): AgentNS.Message[] {
    if (this.roundProduced) return this.roundProduced;
    const messages = this.agent?.messages ?? [];
    const byId = new Map(messages.map((message) => [message.id, message]));
    const produced: AgentNS.Message[] = [];
    for (const id of this.producedIds) {
      const message = byId.get(id);
      if (message) produced.push(message);
    }
    return produced;
  }

  // ---- 用量（PRD F-I5：本轮 / 累计（含子 Agent）/ 速率） ----

  private usageSnapshot(): UsageSnapshot {
    const produced = this.producedMessages();
    const turn = sumUsage(produced);
    // 累计 = 这一轮之前 + 这一轮；子 Agent 的开销在 `subAgentUsage` 里，`sumUsage` 已并入
    const total = addUsage(sumUsage(this.history), turn);
    const subAgent = sumSubAgentUsage([...this.history, ...produced]);

    const elapsedMs = Math.max(0, (this.settledAtMs ?? this.clock.now()) - this.startedAtMs);
    const rate =
      elapsedMs > 0 ? round2(turn.completion_tokens / (elapsedMs / 1000)) : 0;

    return {
      turn,
      total,
      subAgent,
      rate: { value: rate, unit: "tokens_per_second", basis: "completion" },
      updatedAt: this.nowIso(),
    };
  }

  // ---- 快照与推送 ----

  buildRunState(): RunState {
    const settledAt = this.settledAtMs;
    // 排队条目直接问这一轮的 agent（core 的 `inbox`），不自己另记一份：数组就是真相，
    // 另记的一份会与它分叉。顺序即取件顺序：在跑的 agent 的队列在前（core 先取它），
    // 装配期缓冲在 `pending` 里的那几条在后（attach 才进 inbox）。
    //
    // 结算之后一律报空：`inbox` 说的是「**这一轮**还排着什么」，而结算完的这一轮已经没有
    // 排队这回事 —— core 不再取件（下一个取件点是下一段）。agent 常驻之后它的队列里可能
    // 真的还留着条目（下一段会带走，见 `settle` 里的 leftover），但那不是这一轮的事，
    // 报出去只会让客户端的排队区在一条已结算的轮次上挂着一个挂件。
    const inbox = settledAt !== null ? [] : [...(this.agent?.inbox ?? []), ...this.pending];
    return {
      conversationId: this.conversationId,
      status: settledAt !== null ? "settled" : "running",
      assistantMessageId: this.assistantMessageId,
      inbox: inbox.map((entry) => toInboxItem(entry)),
      startedAt: new Date(this.startedAtMs).toISOString(),
      settledAt: settledAt !== null ? new Date(settledAt).toISOString() : null,
      generation: settledAt !== null ? null : this.generation,
      outcome: settledAt !== null ? this.outcome() : null,
      problem: this.problem,
      subagents: this.finalizedSubagents(),
      usage: this.usageSnapshot(),
    };
  }

  private pushRunState(): void {
    this.options.emit("run.state", {
      conversationId: this.conversationId,
      run: this.buildRunState(),
      at: this.nowIso(),
    });
  }

  /** 结算时还没跑完的子 Agent：这一轮中止了就记 aborted，否则记 error（没有「悄悄消失」这一档） */
  private finalizedSubagents(): SubAgentSnapshot[] {
    const settled = this.settledAtMs !== null;
    const items = [...this.subagents.values()];
    if (!settled) return items;
    for (const item of items) {
      if (item.status !== "running") continue;
      item.status = this.aborted || this.handle.aborted ? "aborted" : "error";
      item.finishedAt = item.finishedAt ?? this.nowIso();
    }
    return items;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

/** 排队条目摘要的长度上限（`preview` 是一行，客户端不滚动） */
const INBOX_PREVIEW_LIMIT = 120;

/**
 * core 的 `InboxEntry` → 契约里的 `InboxItem`（只换掉内容：原文换成一行摘要）。
 *
 * `run.state` 每次六态变化都推一次，所以这里不能带 `content` 原文：段里可能装着图片/文件的
 * 原始数据，搬原文等于每推一次状态就重发一遍附件。
 */
function toInboxItem(entry: AgentNS.InboxEntry): InboxItem {
  return {
    messageId: entry.messageId,
    source: entry.source,
    createdAt: entry.createdAt,
    preview: inboxPreview(entry.content),
  };
}

/** 排队条目的一行摘要：文本按顺序拼接，非文本段记成 `[图片]` / `[文件]`，最后折叠空白 + 截断 */
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

/** 六态里「正在拼的工具调用」：从 core 正在拼的消息上取，参数长度给出一个可见的进度 */
function assemblingToolCalls(receiver: AgentNS.Message): AssemblingToolCall[] {
  return (receiver.tool_calls ?? []).map((toolCall) => ({
    toolCall,
    argumentsChars: toolCall.function?.arguments?.length ?? 0,
  }));
}

/** 两个六态快照是不是「同一件事」（只比对外有意义的那些事实） */
function sameGeneration(a: GenerationState, b: GenerationState): boolean {
  if (a.phase !== b.phase) return false;
  // 在想 / 在输出：字符数逐片在长，但那件事本身没变（增量已经逐片推过了）
  if (a.phase === "assembling_tool_calls" && b.phase === "assembling_tool_calls") {
    return toolListKey(a.toolCalls.map((item) => item.toolCall)) ===
      toolListKey(b.toolCalls.map((item) => item.toolCall));
  }
  if (a.phase === "awaiting_tools" && b.phase === "awaiting_tools") {
    return toolListKey(a.runningTools.map((item) => item.toolCall)) ===
      toolListKey(b.runningTools.map((item) => item.toolCall));
  }
  return true;
}

function toolListKey(toolCalls: readonly AgentNS.ToolCall[]): string {
  return toolCalls.map((toolCall) => toolKey(toolCall)).join("|");
}

/** 子 Agent 的名字：SDK 的 `SdkAgent` 带定义，core 的 `Agent` 没有，认不出来就退回通用名 */
function subAgentName(agent: { messages: AgentNS.Message[] }): string {
  const definition = (agent as { definition?: { name?: string } }).definition;
  return definition?.name ?? "sub-agent";
}

/** 子 Agent 失败时给人看的原因：最后一条 error 消息的正文 */
function lastErrorText(messages: readonly AgentNS.Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.status !== AgentNSValue.MessageStatus.Error) continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((section) => ("text" in section ? section.text : ""))
        .join(" ")
        .trim();
      if (text) return text;
    }
    return "error";
  }
  return "error";
}

/** 子 Agent 贡献的用量：`subAgentUsage` 一栏（含孙级，core 的委派路径会累加） */
function sumSubAgentUsage(messages: readonly AgentNS.Message[]): AgentNS.Usage {
  let total: AgentNS.Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const message of messages) {
    if (message.subAgentUsage) total = addUsage(total, message.subAgentUsage);
  }
  return total;
}

/** 宿主分配 id 的缺省实现（Node 19+ 有 `crypto.randomUUID`） */
function defaultNewId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// ChatRunner
// ---------------------------------------------------------------------------

export class ChatRunner {
  private readonly options: ChatRunnerOptions;
  private readonly clock: Clock;
  /**
   * 正在跑的轮次（对话 id → 那一轮的现场）。
   *
   * 存的是**这一轮自己的内存对象**（`TurnSession` 就是 `ChatTurn` 的另一半：受理与执行是
   * 同一件事），供 `conversation.state` 拿到流中的六态与用量，也供跑中发送找那一轮的 inbox；
   * 「有没有在跑」仍然只问 `RunRegistry.isRunning`，两张表不由这里合并。
   */
  private readonly turns = new Map<string, TurnSession>();
  /**
   * 会话级待投列表：**这一批投不进去时先攒着的地方**（按 conversationId 开，条目保持到达顺序）。
   *
   * 只有两段窗口会用到它，两段都是「投进去会起一段没有上下文的段」的时刻：
   *
   *   1. **落后窗口**：core 的 `runStatus` 已经是 `idle`，而宿主这边的现场还在（这一段正在结算：
   *      `closed` 已置位、`RunRegistry` 还没 `finish`）。此刻投进去，core 会把 agent 叫醒跑一段，
   *      而 `onAgentStatus` 看到 `turns` 里还有现场就什么都不建 —— 那一段的消息于是没人落库。
   *   2. **受理窗口**：`conversation.send` 已经 `runs.start`，现场却还没建（受理那半段在读库）。
   *      此刻投进去同样是「core 起段、宿主没有接住它的现场」。
   *
   * 两段的出口相同：那一段（或那次受理）**结算之后**，把攒下的整批 `deliver([...])` 出去。于是
   * 「攒够了一起投」既是正确性要求（一条也不能丢），也顺带成了最省的一次请求。
   */
  private readonly waitlists = new Map<string, DeliveryInput[]>();
  /**
   * 每段对话「最近一条投进 inbox 的条目是谁推的」—— 自起段结算时报给宿主的来源。
   *
   * 为何不另存一份「谁在跑」：这里只是**一条观察值**（`TurnSettledFacts.source`），不参与任何
   * 判断，「在跑」的真相仍然只在 `turns` / `RunRegistry`。投递方与唤醒是两件事，而这个映射
   * 只记后者要报的那个值。
   */
  private readonly inboxSources = new Map<string, string>();
  /**
   * 每段对话的投递串行链：**同一段对话的投递不并行**。
   *
   * 「结算 → 投递 → 再起段」这条链中间有 await（要装配 agent、要读会话行），两条投递同时走到
   * `deliver([...])`（一批形态）就会各自叫醒一次。core 的单飞能保证不成两段，但「投递」这件事
   * 本身也不该并行：
   * 串起来之后，同一段对话的投递顺序 = 到达顺序，攒批也只攒一次。
   */
  private readonly deliveries = new Map<string, Promise<void>>();

  constructor(options: ChatRunnerOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
  }

  /** 宿主分配消息 id（PRD L6）：缺省 `crypto.randomUUID`，测试可注入递增 id */
  private newId(): string {
    return (this.options.newId ?? defaultNewId)();
  }

  /**
   * core 的 `inbox` 事件转进来：记下这条条目是谁推的。
   *
   * 「这一段是被谁叫起来的」只有投递方知道（条目的 `source`），而自起段建现场那一刻（`status`）
   * 拿不到它 —— 投递走的是 agent 自己的 inbox，不经过宿主。于是投递方一入队就把来源记在这里，
   * 建现场时取一次（取完就清，不留给下一段）。
   */
  noteInbox(conversationId: string, source: string): void {
    this.inboxSources.set(conversationId, source);
  }

  /**
   * 登记一段对话的运行时（会话实例）—— 会话实例的「生」只有这一个入口。
   *
   * 会话实例仍是一轮一个：登记在受理之后，摘除在结算时（{@link disposeRuntime}）。
   * 常驻的是 **agent**，不是它：这一段的六态、写库节流、本轮产出都只属于这一轮。
   */
  private createRuntime(session: TurnSession): void {
    this.turns.set(session.conversationId, session);
  }

  /**
   * 摘掉一段对话的运行时 —— 会话实例的「灭」只有这一个入口。
   *
   * 只丢引用：叫停（`abort`）与落库结算都是 `TurnSession` 自己的事，这里不替它做。
   *
   * `session` 给的时候只摘「自己那一份」：一段结算完才摘，而这期间同一段对话可能已经起了
   * 新的一段（两段之间的交接）—— 按对话 id 无脑删会把新现场的引用删掉，那一段于是无人结算。
   */
  private disposeRuntime(conversationId: string, session?: TurnSession): void {
    if (session && this.turns.get(conversationId) !== session) return;
    this.turns.delete(conversationId);
  }

  /**
   * 一段真的结算完了：摘现场 → 再看一眼待投列表。
   *
   * 两步的顺序是这段代码的全部意义：**先**把现场摘掉（`turns` 空、`runs` 已经 `finish`），
   * **再**投。反过来的话，投进去的那一批会把 agent 叫醒跑一段，而 `onAgentStatus` 看到 `turns`
   * 里还有现场就什么都不建 —— 那一段的消息于是没人落库（这就是要关掉的落后窗口）。
   */
  private finishRuntime(conversationId: string, session?: TurnSession): void {
    this.disposeRuntime(conversationId, session);
    this.flushWaited(conversationId);
  }

  // ---- 自起的段：agent 被 `deliver()` 叫醒跑起来的那一段 ----

  /**
   * 接住 agent 报上来的一段边界（`status` 事件）—— 「自起的段」的全部入口。
   *
   * ## 为什么入口是 `status`
   *
   * 自起段从头到尾不经过宿主：`agent.deliver(entry)` 在静止态把 agent 叫醒，core 自己把队列
   * 落地、自己跑完、自己收尾。宿主唯一能知道「一段开始了 / 一段结束了」的时刻就是 core 广播的
   * `status`。所以 agent 常驻期都在听它（`AgentRegistry` 装配时订上，见
   * `AgentRegistryOptions.onStatus`），由接线层转进这里。
   *
   * ## 为什么建现场这一跳必须同步（这里没有 await）
   *
   * core 定的次序是「`status → running` → 队列落地（`message`）→ 跑」。本方法返回之后紧接着
   * 就是那几条 user 消息的广播，所以现场要在这里就地建好、就地订上 `message` —— 让出一次执行权
   * （哪怕只是 `await` 一次读库）就会错过它们，那几条消息于是既不落库、也不进这一段的产出。
   * 会话行与 Scope 因此只能随后补（`hydrate`）。
   *
   * ## 普通轮次完全照旧
   *
   * `conversation.send` 那一轮在 `run()` 里就建好了现场，所以 `→ running` 到这里是空动作 ——
   * 绝不能建第二个（两套现场会把同一条消息记两遍、结算两次，断言见用例
   * “普通轮次不会多出一个 TurnSession”）。
   */
  onAgentStatus(event: AgentStatusEvent): void {
    const { conversationId, agent, to } = event;
    const turn = this.turns.get(conversationId);

    if (to === "running") {
      if (turn) return;
      this.startSelfRun(conversationId, agent);
      return;
    }

    // 段结束（`idle` 正常收尾 / `terminated` 被叫停收完尾）：自起段走它自己的结算路径。
    // 普通轮次在这里是空动作 —— 它的结算由 `execute()` 自己走（`send()` 返回之后）。
    if (turn?.selfStarted) turn.finish();
  }

  /**
   * 给一段自起的段建现场：先占位（`RunRegistry`）、再建 `TurnSession`（就地订上 agent）、
   * 推一次 `run.state`，最后去补装配事实。
   *
   * 占位排在建现场之前有两个原因：`RunHandle` 是现场的构造参数（中止订阅就挂在它上面），
   * 而它同时是「这一段对话现在忙」的唯一来源 —— 客户端那一刻按 `conversation.abort` 必须能找到
   * 这一段。
   *
   * 此刻不该有别的轮次在跑（有的话 `turns` 里就有现场，`onAgentStatus` 已经返回了），所以
   * `runs.start` 撞上 `busy` 只剩一种情形：上一段的 `RunRegistry` 还没 `finish`（它正在写库
   * 结算，而 core 已经收完尾、又能被叫醒了）。那种情形下这一段本来就没有现场可建 —— 报出来，
   * 不静默吞。
   */
  private startSelfRun(conversationId: string, agent: ChatAgent): void {
    let handle: RunHandle;
    try {
      handle = this.options.runs.start(conversationId);
    } catch (error) {
      this.options.onError?.(error, "self-run-start");
      return;
    }

    const nowMs = this.clock.now();
    // 叫醒它的那条条目的来源（`noteInbox` 记的最近一条）：取完就清，不留给下一段。
    // 没有（不是 inbox 叫起来的）就落到兜底值 —— 它仍然不是 `"user"`。
    const source = this.inboxSources.get(conversationId) ?? SOURCE_INBOX;
    this.inboxSources.delete(conversationId);
    // 回调里要拿现场去「只摘自己那一份」，而现场这时才在造
    let session: TurnSession;
    session = new TurnSession(this.options, {
      kind: "self-started",
      conversationId,
      agent,
      source,
      // 这一段开始前的历史：此刻 core 还没把 inbox 落地（`status` 先于 `message`），
      // 所以这份快照正好是「上一段结束时的样子」（usage 的累计与结算报的 `messages` 都靠它）
      history: [...agent.messages],
      handle,
      acceptedAt: new Date(nowMs).toISOString(),
      startedAtMs: nowMs,
      onSettled: () => this.finishRuntime(conversationId, session),
    });
    this.createRuntime(session);
    // 现场已经就位（并且已经订上 `message`）：推一次「这一段跑起来了」
    session.announce();
    void this.hydrate(conversationId, session);
  }

  /**
   * 补上自起段的装配事实（会话行 + Scope）。
   *
   * 建现场那一刻读不了库（见 `onAgentStatus`），所以这两件在这里补。补不到（对话刚被删 /
   * Scope 建不起来）不算「什么都没发生」：记成这一段的失败事实，让结算照常走完 —— 那一段真的
   * 跑过，它的消息就在 agent 里，落库与 `runs.finish` 都不能卡住。
   */
  private async hydrate(conversationId: string, session: TurnSession): Promise<void> {
    try {
      const conversation = await this.options.conversations.get(conversationId);
      if (!conversation) {
        throw new HostError("not_found", { params: { entity: "conversation" } });
      }
      const scope = await this.options.scopes.create(conversation.workspaceId);
      session.hydrate(conversation, scope);
    } catch (error) {
      session.failFacts(error);
      this.options.onError?.(error, "self-run-hydrate");
    }
  }

  /**
   * 受理一轮：占位、落两条消息、把执行放到后台，然后把两个 id 还给调用方（PRD L6 / F-I12）。
   *
   * 已经在跑就抛 `busy`（D14 里它只剩兜底）；对话不存在则 `not_found`。任何一种失败都不会
   * 留下一个占着不动的轮次，也不会凭空留着半个会话实例。
   */
  async run(params: ChatRunParams): Promise<AcceptedTurn> {
    const { conversationId } = params;
    const handle = this.options.runs.start(conversationId);
    const language = params.language ?? this.options.defaultLanguage ?? DEFAULT_LANGUAGE;

    let session: TurnSession | undefined;
    try {
      const conversation = await this.options.conversations.get(conversationId);
      if (!conversation) {
        throw new HostError("not_found", { params: { entity: "conversation" } });
      }
      // 先把能力容器要到手（幂等）：这一轮要拿它读配置（硬线 / 交接线），而 agent 由
      // `AgentRegistry.acquire` 挂在同一个 Scope 上。workspace 不在了就在这里失败，
      // 而不是等到后台那一轮里才发现。
      const scope = await this.options.scopes.create(conversation.workspaceId);

      // 历史从哪来：**agent 已经在就从它内存里来**（常驻之后它的 messages 就是这段对话的真相，
      // 库里那些行只是快照 —— 再读一遍库既多一次 IO，又得再 push 一遍，于是同一个历史会在
      // agent 里存两份）。它合不合用是 `acquire` 的事（模型 / 思考档位改了它会重建）；这里只
      // 按「在不在」决定读不读库 —— **首次装配才读库**。
      //
      // 万一它其实不合用（会话行上的模型 / 档位在这期间改了），重建那一路要的那份历史在
      // `attemptOnce` 里补读一次 —— 那里才知道真的重建了（那时才知道该按新事实重走一遍素材）。
      const live = this.options.agents.get(conversationId);
      let history: AgentNS.Message[];
      if (live) {
        // 只拍一份快照：数组本身还会被这一轮接着追加，`usage` / `done` 要的是“本轮开始前”那份
        history = [...live.messages];
      } else {
        // 首次装配：装载即修复（上一次进程如果是在写的时候没的，这里把在途消息修成可继续的
        // 状态）+ 按当前模型还原素材（F-H7）。必须在下面两次落库之前做完 —— `reconcile` 会把
        // 「在途」的行当成被中断的，本轮刚落的那两行也在它眼里。
        history = await this.storedHistory(conversationId, conversation, { repair: true });
      }
      const prepared = await this.prepare(params, conversation);

      const nowMs = this.clock.now();
      const acceptedAt = new Date(nowMs).toISOString();
      const userId = this.newId();
      const assistantId = this.newId();

      // 这一轮是谁叫起来的：缺省就是用户本人发的话（那时一个字都不动）。其他来源（将来由别的
      // 会话的结果唤醒）把来源写进正文最前面那行注释 —— 否则模型会把那条结果当成用户说的话。
      const source = params.source ?? SOURCE_USER;
      // 两份内容各包各的（且都只包一次）：落库那份决定用户下次回看时看到什么，发给模型那份
      // 决定模型看到什么。core 的 inbox 落地路径也是这两份一致（`inboxEntryMessage` 用包过的
      // 内容当消息内容）；`storedContent` 没给时两份本来就是同一份，包出来的也各自独立。
      const content = withSourceNote(prepared.content, source, userId, acceptedAt);
      const storedContent = withSourceNote(
        prepared.storedContent ?? prepared.content,
        source,
        userId,
        acceptedAt,
      );

      // 用户消息与助手占位都在请求返回之前落库（L6：客户端拿着这两个 id 接流）。
      // 用户消息存的是 `__asset_id` 形态（`storedContent`），不是这一次发送的产物
      await this.options.messages.upsertMany([
        {
          id: userId,
          conversationId,
          role: AgentNSValue.Role.User as string,
          status: AgentNSValue.MessageStatus.Completed as string,
          omit: false,
          content: storedContent as unknown as MessageUpsertInput["content"],
          data: null,
          createdAt: nowMs,
        },
        {
          id: assistantId,
          conversationId,
          role: AgentNSValue.Role.Assistant as string,
          status: AgentNSValue.MessageStatus.Pending as string,
          omit: false,
          content: null,
          data: null,
          createdAt: nowMs,
        },
      ]);

      // 用户消息刚落库：把 content 里的 `__asset_id` 记成关系行（同一 message+asset 只一行）。
      // 扫的是落库那一份（来源注释只是前面多一段文本，`__asset_id` 段原封不动地还在后面）
      await this.linkMessageAssets(conversationId, userId, storedContent);

      session = new TurnSession(this.options, {
        kind: "accepted",
        conversationId,
        conversation,
        scope,
        history,
        // 段中才发现手里那个不合用时（模型 / 档位改过 → `acquire` 重建）要的那份历史：
        // 按**现在**的事实重新读库 + 还原素材。此刻本轮的占位行已落库，于是不 `reconcile`
        // （它会把刚落的 pending 行当成「被中断」），并把这轮自己写的那两行排除掉。
        rebuildHistory: () =>
          this.storedHistory(conversationId, conversation, {
            repair: false,
            exclude: [userId, assistantId],
          }),
        content,
        // 没给 `storedContent` 时不给这一项：`TurnSession` 自己退回去用 `content`（两份同源）
        ...(prepared.storedContent === undefined ? {} : { storedContent }),
        source,
        attachments: prepared.attachments,
        userMessageId: userId,
        assistantMessageId: assistantId,
        handle,
        language,
        acceptedAt,
        startedAtMs: nowMs,
        onSettled: () => {
          this.finishRuntime(conversationId, session);
        },
      });
    } catch (error) {
      this.options.runs.finish(conversationId);
      // 受理失败 = 这一段没有现场了：攒着的待投内容不能跟着这次失败一起烂在列表里
      this.flushWaited(conversationId);
      throw error;
    }

    // 受理完成：执行交给后台，事件从这一刻起会陆续推给在线客户端
    this.createRuntime(session);
    void session.execute();
    // 这条路上两条 id 都在上面分配好了（自起段不走这里，它没有预分配），类型上收窄一次：
    // 「受理即有两个 id」是 `conversation.send` 这条路的契约（L6 / F-I12）。
    return session as AcceptedTurn;
  }

  /**
   * 库里这段对话的历史 + 按当前模型还原过的素材（F-H7）。
   *
   * `repair`：读之前先跑一次 `reconcile`（装载即修复，PRD D15）。**只有「这一轮的两条占位行
   * 还没落库」时才能为真** —— `reconcile` 会把在途行当成「上一段进程死在写它的路上」，刚落的
   * 占位行也会被它修成 `aborted`。受理之后要读库就传 `false`，并把这一轮自己写进去的那几条用
   * `exclude` 排掉：历史是「这一轮之前」那些。
   */
  private async storedHistory(
    conversationId: string,
    conversation: Conversation,
    options: { repair: boolean; exclude?: Array<string | null> },
  ): Promise<AgentNS.Message[]> {
    let messages: AgentNS.Message[];
    if (options.repair) {
      messages = (await this.reconcile(conversationId)).messages;
    } else {
      // 历史要连 `hidden` 的一起取：那些消息只是不给人看，模型下一轮照样得看到它们
      const rows = await this.options.messages.listByConversation(conversationId, undefined, {
        includeHidden: true,
      });
      messages = rows.map(fromRow);
    }
    const excluded = new Set(options.exclude ?? []);
    const wanted = excluded.size === 0 ? messages : messages.filter((one) => !excluded.has(one.id));
    return await this.resolveHistory(conversationId, wanted, conversation.modelId);
  }

  /**
   * 历史装载完之后的第一件事情：把里面的 `__asset_id` 还原成当前模型能吃的段（F-H7）。
   *
   * 还原失败不让整轮发不出去：打一条日志、带着原样的历史继续。
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
      this.options.onError?.(error, "还原历史里的素材引用失败");
      return messages;
    }
  }

  /**
   * 用户消息落库之后登记素材关系行（`conversation_assets`）。
   *
   * 记不下来不让这一轮失败（消息已经发出去了）：打一条日志继续 —— 后果只是这份素材的
   * 引用计数少一行，删字节会晚一步。
   */
  private async linkMessageAssets(
    conversationId: string,
    messageId: string,
    content: AgentNS.MessageContent | undefined,
  ): Promise<void> {
    const link = this.options.linkMessageAssets;
    if (!link) return;
    try {
      await link({ conversationId, messageId, content });
    } catch (error) {
      this.options.onError?.(error, "登记消息的素材引用失败");
    }
  }

  /** 这一段对话正在跑的那一轮（没有就 `undefined`）：拉现场用 */
  turn(conversationId: string): ChatTurn | undefined {
    return this.turns.get(conversationId);
  }

  /**
   * 把一句用户输入排进**正在跑的那一轮**（PRD D14：跑中发送不打断、也不拒）。
   *
   * 返回 `null` 表示「这一段对话现在没有能排进去的一轮」：没在跑（`turns` 里没有这一段的
   * 现场）、或者这一轮已经跑完 / 被叫停。调用方拿到 `null` 就回老路径（`run()`）—— 于是
   * 「空闲时发送」与「刚好跑完时发送」都走老路，只有真正在跑的时候才排队。
   * agent 还在装配不算：那几句先收着，装好就冲进它的 inbox。
   *
   * ## 为什么入队这件事长在 `ChatRunner` 上，而不是让接线层直接摸 agent
   *
   * 附件准备（F-H7 的选路，可能要上传厂商文件）、消息 id 的口径、落库那一份内容、
   * `run.state` 推送 —— 全都在这一层。接线层只该拿到一份回执，再由它翻译成契约形状。
   */
  async enqueue(params: ChatRunParams): Promise<QueuedTurn | null> {
    const { conversationId } = params;
    const turn = this.turns.get(conversationId);
    if (!turn) return null;

    const conversation = await this.options.conversations.get(conversationId);
    if (!conversation) return null;

    const prepared = await this.prepare(params, conversation);
    return turn.enqueue({
      content: prepared.content,
      attachments: prepared.attachments,
      ...(prepared.storedContent === undefined ? {} : { storedContent: prepared.storedContent }),
      ...(params.source === undefined ? {} : { source: params.source }),
    });
  }

  // ---- 会话间投递：`deliver` 这一个入口 ----

  /**
   * 投一条内容给某段对话 —— **会话间投递的唯一入口**，调用方不必判断任何东西。
   *
   * 与 core 的 `deliver` 撞名但不同层：那个是 **agent 级**的（投给一个 agent 的 inbox，收
   * `InboxInput`），这个是**会话级**的（按 `conversationId` 找 agent / 攒批 / 复活，收
   * `DeliveryInput`）；两名字各自稳定，不在这一层改名。
   *
   * 它自己解决三件事（从前这三件散在 `PeerSessionService` 里，靠「先 enqueue、`null` 就 run、
   * `run` 抛错就记 dropped」猜出来的）：
   *
   * 1. **agent 不在就复活**：`agents.get` 为空 → 按库里的历史重新装配（`reconcile` +
   *    `resolveHistory`，与 `run()` 首次装配同一条路），历史一条不少地 push 进新 agent；
   * 2. **跑着 / 正在结算就攒着**：这一段还接话就交给它（那一段的取件点会带走，不新起一段）；
   *    接不了（正在结算）或现场还没建（受理中）就挂在会话级待投列表里，等那一段结算完一起投
   *    —— 这就是把「core 已 idle、宿主 `RunRegistry` 还没 finish」那一段落后窗口关掉的地方；
   * 3. **攒够了一起投**：结算之后把待投列表里攒下的条目**一次性** `deliver([...])` 出去
   *    （= 一次 `flushInbox` 落成多条 user message、一次模型请求）。空闲时直接投。
   *
   * ## 回执里有什么、没有什么
   *
   * 「投递被受理」= 它迟早会落地；调用方（平级会话）除了「收下了没有」还要知道**投递那一刻
   * 对方是什么状态** —— 那决定它怎么跟模型 / 用户说（「排在它这一轮末尾」/「把它叫起来了」/
   * 「它正在收尾，这一条排在后面」）。于是返回 {@link DeliveryOutcome}：`accepted` 恒 `true`，
   * 加上当场可判的 `state`。
   *
   * 会话不存在是**唯一**的拒绝（抛 `not_found`）；那一批内容是真的没有去处，调用方据此记
   * `dropped`。**不报 `woke`**：待投列表那条路上的唤醒发生在结算之后（见上），同步回一个
   * 「叫醒了」就是撒谎。
   *
   * ## 重入怎么防
   *
   * 「结算 → 投递 → 再起段」这条链上有 await（装配 agent、读会话行），所以：
   *   - 同一段对话的投递走**一条串行链**（{@link serialized}）：来两条就排两次，不会各自叫醒；
   *   - 每次真正投出去之前（`flushWaitlist`）都**再判一次**现场（`turns` / `RunRegistry`）——
   *     装配期间起了新段的话，这一批就交给那一段，而不是再起一段；
   *   - core 自己的单飞是最后一道：真投到一段正在跑的 agent 上，它只会入队、不会起第二段。
   */
  async deliver(conversationId: string, input: DeliveryInput): Promise<DeliveryOutcome> {
    // ① 这一段还接话：推进它（不新起一段，也不打断它；落地由它自己的取件点负责）
    const turn = this.turns.get(conversationId);
    if (turn?.enqueue({ content: input.content, source: input.source, attachments: [] })) {
      return { accepted: true, state: "running" };
    }

    // ② 收下的这一刻对方是什么状态：判据与下面那条串行链用的是同一份（{@link isDeliveryBlocked}）。
    // 现场还在（结算窗口）或运行表还说在跑（受理中）都走「攒着」那一路；其余就是空闲。
    // **当场判、判完就定**：这里不能等 `await` 之后再判 —— 那一刻世界已经变了，报出去的
    // 就是一件没发生过的事。
    const state = this.isDeliveryBlocked(conversationId) ? "settling" : "idle";

    // ③ 其余情形先攒着（正在结算 / 受理中 / 空闲三种都先走这一格）
    this.wait(conversationId, input);
    // ④ 空闲才真的投；结算窗口里的那一批由那一段的结算末尾自己 flush（`finishRuntime`）
    await this.serialized(conversationId, () => this.flushWaitlist(conversationId));
    return { accepted: true, state };
  }

  /**
   * 把待投列表里攒下的条目投出去 —— 投得成就清空，投不成（正在结算 / 受理中）就原样留着。
   *
   * 全程只在**这一条串行链**上被调用（`deliver` 与 `finishRuntime` 都走 {@link serialized}），
   * 所以它里面的 await 不会与同一段对话的另一次投递交错。
   */
  private async flushWaitlist(conversationId: string): Promise<void> {
    const waiting = this.waitlists.get(conversationId);
    if (!waiting || waiting.length === 0) return;
    // 先摘下来：这一批就是「这一次投递要投的全部内容」，按到达顺序
    const batch = waiting.splice(0, waiting.length);
    if (waiting.length === 0) this.waitlists.delete(conversationId);

    // 这一段还接话：交给它（一次取件点把整批取走，段还是原来那一段）
    const turn = this.turns.get(conversationId);
    if (turn && this.handToTurn(conversationId, turn, batch)) return;

    // 正在结算 / 现场还没建：放回去，等那一段结算完（`finishRuntime`）再来
    if (this.isDeliveryBlocked(conversationId)) {
      this.park(conversationId, batch);
      return;
    }

    const conversation = await this.options.conversations.get(conversationId);
    if (!conversation) {
      // 这段对话已经不在了：这一批没有去处（**唯一**会拒绝投递的情形）
      throw new HostError("not_found", { params: { entity: "conversation" } });
    }

    // agent 不在就复活（走出这段窗口的只有「有历史、没有 agent」那一种）
    const agent = await this.ensureAgent(conversationId, conversation);

    // 装配期间世界又变了：起了新段就交给它，进了结算就再放回去（这一批一条都没投出去）
    const born = this.turns.get(conversationId);
    if (born && this.handToTurn(conversationId, born, batch)) return;
    if (this.isDeliveryBlocked(conversationId)) {
      this.park(conversationId, batch);
      return;
    }

    // 空闲：整批一起投（一次 `deliver([...])` = 一次 `flushInbox` 落成多条 user message、一次请求）
    agent.deliver(
      batch.map((entry) => ({
        content: entry.content,
        source: entry.source,
        // 与跑中排队同一个档位：赶工具轮的边界，不打断正在吐的那一段
        priority: "high" as const,
      })),
    );
  }

  /**
   * 把一批内容交给**正在跑的那一段**。
   *
   * 返回 `false` 表示那一段不接话（已经收工 / 被叫停，正在结算）—— 调用方据此挂回待投列表。
   *
   * 「能不能接」的判定是同步的（`TurnSession.enqueue` 只看这一轮自己的几个标记），所以第一条
   * 接下了、后面的一定也接得下；真接不下就把那一条留在待投列表里等下一次（宁可晚，不能丢）。
   */
  private handToTurn(
    conversationId: string,
    turn: TurnSession,
    batch: DeliveryInput[],
  ): boolean {
    const first = batch[0];
    if (!first) return true;
    if (!turn.enqueue({ content: first.content, source: first.source, attachments: [] })) {
      return false;
    }
    for (let index = 1; index < batch.length; index += 1) {
      const entry = batch[index]!;
      if (!turn.enqueue({ content: entry.content, source: entry.source, attachments: [] })) {
        this.wait(conversationId, entry);
      }
    }
    return true;
  }

  /**
   * 这一段对话现在**投不进**吗 —— 判据只来自 `turns`（现场）与 `RunRegistry`（运行表）。
   *
   * 现场还在 = 那一段在跑或在结算（`turns` 里摘掉才是「结算真的完了」）；运行表还说在跑 =
   * 受理了、现场还没建。本文件不另记一份「在跑」（两份随时会分叉）。
   */
  private isDeliveryBlocked(conversationId: string): boolean {
    return this.turns.has(conversationId) || this.options.runs.isRunning(conversationId);
  }

  /** 把一条内容排进这段对话的待投列表（队尾：保持到达顺序） */
  private wait(conversationId: string, input: DeliveryInput): void {
    const waiting = this.waitlists.get(conversationId);
    if (waiting) {
      waiting.push(input);
      return;
    }
    this.waitlists.set(conversationId, [input]);
  }

  /** 把一整批放回待投列表的**队首**（它们比后来者先到） */
  private park(conversationId: string, batch: DeliveryInput[]): void {
    if (batch.length === 0) return;
    const waiting = this.waitlists.get(conversationId);
    if (!waiting) {
      this.waitlists.set(conversationId, [...batch]);
      return;
    }
    waiting.unshift(...batch);
  }

  /**
   * 同一段对话的投递串行化：前一条（哪怕是失败的那条）跑完才跑下一条。
   *
   * 链尾自我清理：没有在途投递时把登记删掉，免得一张 Map 跟着对话数一直长。
   */
  private serialized(conversationId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.deliveries.get(conversationId) ?? Promise.resolve();
    // 前一条失败不挡后一条：每一批各自结算自己的成败
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.deliveries.set(conversationId, tail);
    void tail.then(() => {
      if (this.deliveries.get(conversationId) === tail) this.deliveries.delete(conversationId);
    });
    return run;
  }

  /**
   * 结算末尾（现场刚摘掉）再看一眼待投列表：有攒着的就投 —— 这一刻 `turns` 空了、`runs` 也
   * `finish` 了，投进去起的段才有现场可建。
   */
  private flushWaited(conversationId: string): void {
    if (!this.waitlists.get(conversationId)?.length) return;
    void this.serialized(conversationId, () => this.flushWaitlist(conversationId)).catch(
      (error: unknown) => {
        // 这一跳没有调用方（是结算顺手做的），所以只能报出去：会话被删是最可能的原因
        this.options.onError?.(error, "会话间投递");
      },
    );
  }

  /**
   * 拿到这段会话现在该用的 agent —— 不在（或不合用）就按库里的事实**重新装配**。
   *
   * 只有这一个入口需要「先读库再装配」：投递进来时 agent 可能早就不在了（进程重启过、配置换过、
   * 对话被别处丢过），而这一段得从库里的历史接着跑。与 `run()` 首次装配同一条路：`reconcile`
   * （装载即修复）+ `resolveHistory`（按当前模型还原素材）→ `acquire`（在且合用就复用，不在 /
   * 不合用就装配）。新装配的那个手里还是空的，历史要 push 进去 —— 复用的那个不 push（它的
   * `messages` 就是这段对话的真相）。
   *
   * 「要不要读库」按 `get` 判：有活着的就不读（常驻的那个还带着全部历史）；不在就一定要读。
   * 活着但不合用的那一种由 `acquire` 重建，它要的历史得按**现在**的事实还原 —— 上面没读库，
   * 所以在下面补一次。
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
    // 交回来的不是原来那个 = 真的装了一个新的：它手里是空的，历史得 push 进去（`run()` 那条路
    // 在 `attach` 里做同一件事）。活着但不合用那一路上面没读库 —— 那一份是按旧事实还原的，
    // 这里按现在的事实重读一次（这一刻这段对话没有在跑的段，`reconcile` 安全）。
    if (agent !== live && agent.messages.length === 0) {
      const assembled =
        live === undefined
          ? history
          : await this.storedHistory(conversationId, conversation, { repair: true });
      agent.messages.push(...assembled);
    }
    return agent;
  }

  /** 中止（转发给 `RunRegistry`：中止的唯一入口在那里） */
  abort(conversationId: string, reason?: string): boolean {
    return this.options.runs.abort(conversationId, reason);
  }

  /**
   * 对话（或它所在的项目）被删之后，把这一轮的内存现场丢掉。
   *
   * 正在跑的那一轮会先被要求停下，再等它自己结算写库（删对话的人已经先确认过代价）。
   */
  forget(conversationId: string): void {
    const turn = this.turns.get(conversationId);
    turn?.abort("conversation removed");
    this.disposeRuntime(conversationId);
    // 这段对话已经不在了：攒着的待投内容也就没有去处（留着只会在删掉之后凭空跑出一段）
    this.waitlists.delete(conversationId);
    // 同理，那条「最近一次投递是谁推的」也不再有意义（留着只会让下一段报错来源）
    this.inboxSources.delete(conversationId);
    // 这一段对话已经不在了，它的 agent 也就不该继续挂在 Scope 的账上 —— 否则紧接着的
    // `scopes.dispose`（删项目）会被一个正在收尾的对话挡下来。丢的只是登记（`discard` 不
    // abort、不结算），那个 agent 仍由它自己那一轮握在手里跑完收尾。
    this.options.agents.discard(conversationId);
  }

  /**
   * 装载/重启后修复（PRD D15）。
   *
   * 两步：
   *   1. 在途（`pending` / `writing`）消息当作被中断 —— 进程是在写它们的时候没的；
   *   2. 交 core 的两支归一：工具轮次 `fill`（整轮进出，补上未完成的原因）、
   *      被中断的 assistant `keep`（已输出的内容留在上下文里，模型下一轮能接着半截说）。
   *
   * 只写回状态/`omit` 真的变了的那些行，于是「启动时扫一遍」不会把整段历史重写一次。
   */
  async reconcile(conversationId: string): Promise<ReconcileResult> {
    // 历史要连 `hidden` 的一起取：那些消息只是不给人看，模型下一轮照样得看到它们
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

  private async prepare(
    params: ChatRunParams,
    conversation: Conversation,
  ): Promise<AttachmentPreparation> {
    const prepare = this.options.prepareAttachments;
    if (!prepare) {
      // 没有注入素材转换：`assetIds` 原样不处理，内容照客户端给的发（事实在 `attachments` 里给空）
      return { content: params.input.content, attachments: [] };
    }
    return prepare({
      conversationId: conversation.id,
      agentId: conversation.agentId,
      modelId: conversation.modelId,
      input: params.input,
    });
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
   * 这一段是不是**派生会话**（`PeerSessionService` 认得的那一段）——「要不要自己压」的唯一判据。
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
 * 这一段会话该带哪些模型参数（PRD F-B6）。
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
    // 会话行上的模型就是这一轮的模型（`conversation.setModel` 写的就是它），
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
            // 归一规则按**会话类型**分，不按轮次来源分：
            //   - 派生会话（平级会话开出来的那一段）没人盯着它，越线就自己压（`"self"`）；
            //   - 用户会话把「要不要压」交还给宿主：一轮结算之后问用户
            //     （`askHandoffAfterSettle`），这里回 `null` = 本次不迁移。
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

    // 插件在 send 之前 init（例如工具刷新插件的首次准备）
    await agent.init();
    return agent;
  };
}
