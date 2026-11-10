/**
 * 会话管理器 —— 服务端「活着的会话」与**事件流**的源头。
 *
 * ## 它管什么、不管什么
 *
 * 管：会话的创建/关闭、一轮对话的编号（`turnId`）、把 SDK 的事件翻译成协议事件
 * （阶段、正文增量、轮次收尾）、按阶段算出「谁还在跑」。
 *
 * 不管：Agent 怎么装配（配置、Scope、工具发现）——那由**组装根**通过 `createAgent`
 * 注入。存档只经 `SessionStore` 端口读写（`save` / `saveAs` / `last` / `rollback` / `list`
 * 与每轮收尾的 `writeSession`）：格式、位置、目录布局都由那个端口决定，本类不碰文件。
 * 这条边界是为了让本文件可测：给一个假 Agent 就能跑完整个事件流程，不需要网络。
 *
 * 同理，**本层不读配置**：凡要「配置 + Agent 定义」才能算出来的东西（自动标题、清单里
 * 存档条目的生效模型）都由组装根注入成窄函数（`SessionManagerOptions` 里的 `autoTitle` /
 * `resolveSessionModel`）。活会话的生效模型不在此列 —— 它是 `createAgent` 那一次解析的
 * 现成产物，本类只读。
 *
 * ## 为什么事件出口是 `subscribe()` 而不是构造参数
 *
 * 一个会话可能被多个客户端看（终端 + 桌面端同时连）。广播是管理器的职责，
 * 「推给哪条连接」是守护进程的职责（它知道谁连着）。
 *
 * ## 「活着」的判据：`keepAlive ∧ 有持有者`
 *
 * 两个**不同来源**的事实，缺一不可：
 *
 *   · `keepAlive`  —— 客户端**声明**的意图（切走 / 退出时收回）。它靠一帧 `keepAlive.set`
 *     传过来，而**崩溃的进程发不出这一帧**；
 *   · `holders`    —— 此刻**真有一条连接在看着它**。连接断开是内核保证的（进程被
 *     `kill -9`、崩溃、断电都会让那条 socket 消失），不需要客户端配合。
 *
 * 只认前者，就会出现「声明了保活、然后进程被硬杀」→ 标记永远停在 `true` → 会话连同
 * 它占的 Agent 与消息历史永久留在内存里（本包在 loopback 上跑，唯一的回收时机是重启
 * 守护进程）。只认后者，则「同一条连接换了会话」（`/new`、`/load`）无从表达，还会把
 * 客户端明确说要放手的那一段一直留着。
 *
 * 所以判据是合取：**声明了要 ∧ 确实有人看着** ⇒ 才留着。其余一律走同一条回收路径
 * （见 `scheduleReclaim`）：先等一段宽限期（`DEFAULT_SESSION_IDLE_TIMEOUT_MS`），到点
 * 再判一次 —— 宽限期是给断线重连留的窗口，不是给「没人要」的会话续命。
 */

import { PhaseTracker, pendingToolCalls, type PhaseInfo } from "../progress/PhaseTracker.js";
import { compareSessionEntries } from "../store/SessionStore.js";
import type { SessionRecord, SessionRef, SessionStore } from "../store/SessionStore.js";
import { EventHub } from "../events/EventHub.js";
import {
  SessionHandoff,
  isHandoffAborted,
  type HandoffAgentLike,
} from "../handoff/SessionHandoff.js";
import type { AutoTitleFn } from "./AutoTitle.js";
// `resolveModelParams` 是**运行期**依赖：参数该取哪一层只有 SDK 那一处实现
// （`packages/sdk/src/runtime/resolveModel.ts`）。快照要报「当前生效的参数」，就得问
// 它 —— 本层再写一遍「哪一档取哪一份」，就是让同一个 `switch` 存在两份的第二天。
// 其余两个只借**类型**：自动迁移触发上下文的形状真相源在 SDK 的插件里，本层再抄一份就是
// 第二份会漂移的规则（`import type` 编译后会被擦掉，不构成运行期依赖）。
import { resolveModelParams } from "@ai-zen/agents-sdk";
import type { AutoMigrateTriggerInfo, ModelParams } from "@ai-zen/agents-sdk";
import type {
  MessageContent,
  ModelLevel,
  SubAgentSnapshotResult,
} from "../../protocol/sessions.js";
import {
  SESSION_EVENTS,
  SESSION_NOTICE_CODES,
  DEFAULT_MIGRATION_STRATEGY,
  type HandoffMode,
  type MigrationStrategy,
  type NoticeLevel,
  type NoticePayload,
  type ServerEvent,
  type SessionAnswerResult,
  type SessionAttachResult,
  type SessionCancelResult,
  type SessionCloseResult,
  type SessionCreateResult,
  type SessionHandoffResult,
  type SessionKeepAliveSetResult,
  type SessionLastResult,
  type SessionMigrateResult,
  type SessionNoticeCode,
  type SessionQuestionKind,
  type SessionRollbackResult,
  type SessionSaveAsResult,
  type SessionSaveResult,
  type SessionSnapshotResult,
  type SessionListEntry,
  type SessionRenameResult,
  type SessionRemoveResult,
} from "../../protocol/sessions.js";

/**
 * 能跑一轮对话的 Agent 的最小面。
 *
 * 结构性类型（不是 SDK 的 `Agent`）：SDK 的 Agent 天然满足它，本包也不必把
 * core 的类型体系拖进来 —— 与本包 `PhaseMessageLike` 同一个理由、同一个 `*Like` 后缀。
 *
 * 不叫 `SessionAgent`：那读起来像「一种 Agent」，而它只是 Agent 的一个**面**（能跑会话）。
 */
export interface AgentLike {
  /** 当前消息列表。**可写**：续接存档时由会话管理器整体换成存档里的那份 */
  messages: unknown[];
  /** 最近一轮用量（SDK 的 Agent 有；假件可以不给） */
  readonly lastUsage?: unknown;
  /** 实发模型名（快照会把它带给客户端拼图片内容块；假件可以不给） */
  readonly model?: string;
  /**
   * 生效模型来自哪一级（SDK 解析出来的档位，快照原样透传给客户端）。
   *
   * **必填**：这一位没有「缺省档」可言 —— 猜一个就能让选择器把「当前生效」标错，
   * 而那种错没人会怀疑。假件照抄真件给一个值（它们本来就该与真件同形）。
   */
  readonly modelLevel: ModelLevel;
  /** 返回本轮产出（SDK 返回 `Message[]`）；会话管理器不看它，进展走事件 */
  send(input: MessageContent): Promise<unknown>;
  abort(): void;
  /**
   * SDK 的事件流（`@ai-zen/event-bus`）。
   *
   * 载荷是**多参**的，而且每个事件不一样：`chunk-parsed` 是 `(receiver, chunk)`，
   * `sub-agent-start` 是 `({ subAgent })`，`open` / `finally` 没有载荷。这里写 `(...args)`
   * 而不是 `(payload)` 是故意的：曾经它就是 `(payload: any) => void`，于是监听器只收一个
   * 参数也能过编译 —— 而那个参数是**消息**，不是 chunk，正文增量于是一条也发不出去
   * （详见 `attachEvents` 里 `onChunk` 的注释）。类型说诚实话，比它“好用”重要。
   */
  events: {
    on(event: string, handler: (...args: any[]) => void): void;
    off(event: string, handler: (...args: any[]) => void): void;
  };
}

/**
 * 被委派出去的子 Agent 在本层需要的那两面：**它自己的**对话与**它自己的**事件流。
 *
 * 与 `AgentLike` 同一个理由（结构性类型、`*Like` 后缀）：SDK 的子 Agent 天然满足它，
 * 本包不必为此把 core 的类型体系拖进来，测试也能用一个最小的假件驱动整个流程。
 */
export interface SubAgentLike {
  messages: unknown[];
  events: {
    // 同 `AgentLike.events`：载荷是多参的（`chunk-parsed` = `(receiver, chunk)`）
    on(event: string, handler: (...args: any[]) => void): void;
  };
}

/**
 * 一个子 Agent 在会话层的条目。
 *
 * `agent` 字段**只在本层用**（取 `messages`、挂事件监听），不进协议：客户端拿到的
 * 是数据（`SubAgentSnapshotResult.messages`），不是对象 —— 远程时这个实例根本不在
 * 客户端那边。
 */
interface SubAgentEntry {
  id: string;
  index: number;
  agent: SubAgentLike;
  /**
   * 三态，可变：`running` → `done` / `failed`。
   *
   * **`failed` 是终态**：出错之后 SDK 还会发 `sub-agent-end`，那条路径必须先看这个
   * 字段再决定是否发 `ended{done}`，否则真实的失败会在界面上变成「跑完了」。
   */
  status: "running" | "done" | "failed";
}

/**
 * 一次提问的规格（服务端 → 客户端）。
 *
 * 字段与协议里的 `SessionQuestionEvent` 一一对应，只多了 `fallback` 的语义收口：
 * 它是「没人答/答不了时服务端自己用什么收场」，由提问方给（哪条路安全只有它知道）。
 */
export interface AskQuestionSpec {
  kind: SessionQuestionKind;
  input: "select" | "text";
  options?: readonly string[];
  params?: Record<string, unknown>;
  allowSkip?: boolean;
  fallback: string | null;
}

/** 一个挂着等回答的提问（`resolve` 收场，`fallback` 是没人答时的取值） */
interface PendingQuestion {
  resolve: (choice: string | null) => void;
  fallback: string | null;
}

export interface CreateAgentInput {
  workspaceId: string;
  /** 工作区路径（Agent 的 cwd：工具、相对路径都以它为基准） */
  path: string;
  agentId: string;
  /**
   * **会话级**模型覆盖（`LiveSession.modelId`）。
   *
   * 本层只负责「把这一段会话的覆盖递进去」，**不在这里做任何解析**：三级顺序
   * （`会话级 > Agent 定义 > 全局兜底`）的唯一实现在 SDK 的 `resolveModel`（由
   * `createAgent` 调用）。两边各写一份，就会出现「服务端算出来的模型 ≠ Agent 实际在用的
   * 模型」—— 那正是「界面写着 A、请求发给 B」的根源。
   */
  modelId?: string;
  /**
   * **会话级**模型参数覆盖（`LiveSession.modelParams`）—— 与上面那个 `modelId` 同一级。
   *
   * 不透明载荷（与 `messages` / 存档里的 `modelParams` 同一口径）：本包不解释它的键名，
   * 只负责把它递到装配方，再由 SDK 按档位决定用不用（`resolveModelParams`）。
   *
   * 它**只在模型来自会话级时生效**：会话级模型 + 定义级参数那种组合会把旧模型的思考
   * 参数发给新模型（端点 400），所以决定权在 SDK 那一处，不在这里。
   */
  modelParams?: unknown;
  /**
   * 交接/迁移进行中？装配方据此接上 `ContextGuardPlugin.isSuspended`。
   *
   * 不接的话，交接回合本身就是「上下文最满」的时刻，会被硬线直接掐死。
   */
  isHandoffBusy?: () => boolean;
  /**
   * 自动迁移的落地动作（**会话层提供**：存档、换 id、事件都在它手里）。
   *
   * 不给就不装自动迁移：没有交接能力时该让硬线拦，而不是让 SDK 去调一个不存在的服务。
   *
   * `mode` 是用户在 `session.question` 里选的执行者：`resolveMode` 只回答「用哪种方式」，
   * 真正动手的是这里 —— 中间那一跳把它丢掉，用户的选择就只是弹了个框。
   */
  autoMigrate?: (mode?: HandoffMode) => Promise<void>;
  /**
   * 自动迁移的执行者解析（**会话层提供**：它会向客户端提问并等回答）。
   *
   * 不提供就用交接服务自己的默认执行者（`self`）：那是兜底，不是产品决策 ——
   * 有客户端在看时，谁来写交接文档必须由用户决定。
   */
  resolveMode?: (info: AutoMigrateTriggerInfo) => Promise<HandoffMode | null>;
}

/** attach 的入参：`sessionId` 必填（语义就是「别给我开新的」） */
export type SessionAttachInput = SessionCreateInput & { sessionId: string };

/** `create()` 的入参：`agentId` / `sessionId` 都可省，前者补 `default`，后者由服务端分配 */
export interface SessionCreateInput {
  workspaceId: string;
  path: string;
  agentId?: string;
  sessionId?: string;
  /** 每轮收尾是否自动落盘（缺省 `true`）；`false` 见协议里 `SessionCreateParams.persist` */
  persist?: boolean;
}

export interface SessionManagerOptions {
  /** 造一个能跑一轮对话的 Agent。装配细节全在注入方，本包不碰配置与 Scope */
  createAgent: (input: CreateAgentInput) => Promise<AgentLike>;
  /**
   * 新会话的 id 生成器（客户端没指定时用）。
   *
   * 默认按与存档文件名同一套格式：`chat_YYYY_MM_DD_HH_mm_ss` —— 活会话与存档共用
   * 一个 id，续接时不会出现「内存叫 sess_3、盘上叫 chat_2026…」这种两套编号。
   */
  nextSessionId?: () => string;
  /**
   * 某个工作区的会话存档（续接与 `session.save` 用）。不注入则两者都不可用。
   *
   * 注入成**函数**而不是实例：一个进程服务多个工作区，每个工作区一份存档。
   */
  storeFor?: (workspaceId: string) => SessionStore | Promise<SessionStore>;
  /**
   * 让装配方丢掉某个工作区缓存的 Scope（配置可能已变）。
   * 不注入则 `reload()` 仍会重建 Agent，但沿用旧 Scope —— 端点凭据这类改动不会生效。
   */
  invalidateScope?: (workspacePath: string) => Promise<void>;
  /**
   * 事件出口。不注入则自建一个（单测方便）；组装根会传自己的，
   * 这样**全局通知**也能走同一条推送线。
   */
  hub?: EventHub;
  /**
   * 交接需要的路径根（`aiZenDir` / `homeDir`）。不注入则 `handoff` / `migrate` 明确报
   * `no-handoff` —— 交接要读磁盘上的 `handoff` Skill，本层不自己猜路径。
   */
  handoff?: { aiZenDir: string; homeDir: string };
  /**
   * 等客户端回答「自动迁移用哪种方式」的上限（毫秒），缺省 `ASK_TIMEOUT_MS`（5 分钟）。
   *
   * 之所以可注入：等 5 分钟才能验证的用例只能靠 `sleep(300000)`，那是把「超时」这件事
   * 测成「时钟」。理由见 `askHandoffMode`（为什么必须有时限）。
   */
  askTimeoutMs?: number;
  /**
   * 「没人看着之后还留多久」（毫秒），缺省 {@link DEFAULT_SESSION_IDLE_TIMEOUT_MS}（60 秒）。
   *
   * 只对 `keepAlive` 仍为 `true` 的会话生效：`keepAlive:false` 是客户端明确放手，宽限期
   * 取 0（等价于「空闲就当场收」）。`0` 表示不等待，与那一路径同一个含义。
   */
  sessionIdleTimeoutMs?: number;
  /**
   * 倒计时实现（注入只为测试）。
   *
   * 回收判定是**时间**驱动的，而等 60 秒才能断言的用例只能靠 `sleep` —— 那是把「宽限期」
   * 测成「时钟」。注入一个假计时器，用例就能手动「让它到点」，断言的是判定本身。
   */
  schedule?: (ms: number, run: () => void) => () => void;
  /**
   * 自动给还没有名字的会话起一个标题（不注入 = 不做这件事）。
   *
   * 为什么是注入而不是本层自己去调模型：**选模型要读配置**（`autoTitle` 开关、
   * `defaultMigrationModel`），而本层不读配置、也不认识端点与 Key。注入方是组装根手里
   * 那个 `createAutoTitle`（它只拿一个 `config.json` 路径就能干活）。
   *
   * 接口刻意窄成「模型 id + 消息 + 取消信号 → 名字」：会话对象、落盘、事件、超时、
   * 不覆盖手改名全在本层 —— 那边（`AutoTitle.ts`）只负责发那一次请求。
   */
  autoTitle?: AutoTitleFn;
  /**
   * 等标题的上限（毫秒），缺省 {@link AUTO_TITLE_TIMEOUT_MS}（10 秒）。
   *
   * 可注入的理与 `askTimeoutMs` 完全一样：等 10 秒才能验证「超时之后什么都没发生」的
   * 用例只能靠 `sleep(10000)`，那是把「超时」测成「时钟」。
   */
  autoTitleTimeoutMs?: number;
  /**
   * 解一条**存档条目**的生效模型（`agentId` 的定义 + 全局兜底 → 模型与档位）。
   *
   * ## 为什么需要这个注入点
   *
   * 清单里每条都要带生效模型（`SessionListEntry.effectiveModelId`，侧栏下拉框的当前值），
   * 而活会话那一半**已经有了**：Agent 实例是 `createAgent` 按三级解析造出来的，`modelIdOf`
   * / `modelLevelOf` 直接读它的解析产物。存档条目没有实例 —— 只剩一条 `SessionRecord`，
   * 解析它要「这个 `agentId` 的定义 + 当前 `AppConfig`」，而**本层刻意不读配置**
   * （见本接口里每个 `xxx` 的注释：本包只认注入进来的值）。
   *
   * 于是注入点窄成「`agentId` + 会话级覆盖 → 模型 + 档位」：怎么读定义、怎么读配置、
   * 解析顺序怎么排全在注入方（组装根），而且**唯一实现仍然只有 SDK 的 `resolveModel`**
   * —— 注入方必须调它，不许在这里或那里重写一遍 `a ?? b ?? c`。
   *
   * ## 语义
   *
   * 不注入 = 存档条目上不给这两个字段（活会话照旧给）：没有解析能力时，少给一个字段比
   * 让整个清单失败有用。
   *
   * 抛错（定义已删、三级都空）→ `list` 把**那一条**的字段省掉，其余条目照常返回：
   * 一段存档活过了它的 Agent 定义是常态（用户删了定义、留着历史），那不是「清单坏了」。
   *
   * 一个工作区里多数会话共用一两个 Agent，所以 `list` 在**本次调用内**按
   * `agentId` + 会话级覆盖去重，同一个输入只问它一次（不做进程级缓存：配置随时可能变，
   * 跨请求复用等于让清单在改完配置之后还说旧模型）。
   */
  resolveSessionModel?: (input: { agentId: string; sessionModelId?: string }) => Promise<{
    modelId: string;
    level: ModelLevel;
  }>;
}

interface LiveSession {
  id: string;
  workspaceId: string;
  /** 工作区路径：重建 Agent（reload）时要再交给装配方 */
  path: string;
  agentId: string;
  agent: AgentLike;
  turnId: number;
  phase: PhaseTracker;
  /** 本轮是否已经出过错（`error` 与 `finally` 都会到，收尾只报一次） */
  turnFailed: { code: string; message: string } | null;
  turnSettled: boolean;
  /**
   * 这一轮的收尾由交接/迁移方法自己负责（见 `settleTurn`）。
   *
   * 交接回合本身也是一次 `agent.send()`，SDK 会照常发 `finally`；不拦一下，
   * `self` 模式会在文档还没校验、历史还没剔除时就宣布本轮结束。
   */
  settleDeferred: boolean;
  /**
   * 这一轮收尾时要不要把会话写进存档（见 `settleTurn` 的第 1 步）。
   *
   * 只由「会产生对话内容」的回合置位：`send` / `handoff`。
   * `migrate` **不能**置位——它在交接前已经把**完整历史**存进旧 id，之后才把消息剔除；
   * 如果收尾时再无条件写一次，写下去的会是被 prune 过的版本，把刚存好的完整存档盖掉。
   * `autoMigrate` 反过来是安全的：它跑在 `send` 的那一轮里，收尾时 id 已经换成新的，
   * 写下去的就是新会话的开场（与旧版 `onMigrated` 里那次落盘同一个效果）。
   *
   * 同一条标记也是「这一轮真正的终点」的判据，所以回收判定也挂在它上：`migrate` 中场
   * 那次收尾不能触发回收（那时会话正要换 id）。
   */
  persistOnSettle: boolean;
  /**
   * 会话级的「自动落盘」策略：每轮收尾要不要写存档。
   *
   * 与上面那个**每轮**的 `persistOnSettle` 是两件事，别混：
   *   · `persistOnSettle` —— 这一轮该不该写（`migrate` 的中场收尾不写）；
   *   · `autoPersist` —— 这段会话值不值得写（一次性调用根本不进存档）。
   * 两个都为真才落盘。`false` 时想留档只有显式 `save`（CLI 的 `ai --save`）。
   */
  autoPersist: boolean;
  /**
   * 保活区标记：`true` = 客户端说「我还要这一段」。
   *
   * **新会话缺省在保活区里**，这是故意的：两种漏法的代价不对称 ——
   *   · 客户端忘了 `on:false`（切走 / 退出时没发）→ 会话多占几兆内存，泄漏；
   *   · 客户端忘了 `on:true`（刚开会话还没来得及声明）→ 用户正看着的那段被回收掉。
   * 后者是数据/体验事故，前者只是不够省。所以「默认留着，客户端不看了才放手」。
   *
   * 但它**不是**活着与否的全部依据：必须同时有持有者（`holders`），否则这条声明没有
   * 人兑现（进程崩了、连接断了）—— 那时走宽限期回收，见文件头「「活着」的判据」。
   * 断言这一点的实测（改这条判据**之前**）：把连接 `destroy()` 掉（不发任何帧），
   * `session.list` 里那段仍在，只有 `keepAlive.set{on:false}` 才会当场收 —— 也就是说，
   * 那时只有客户端发帧才能回收。
   */
  keepAlive: boolean;
  /**
   * 展示名（与 `id` 是两个事实：id 是身份，它是名字，改了不动 id）。
   *
   * `undefined` = 还没起过名：客户端拿首条用户消息兑底，服务端的自动标题也只在这种
   * 情况下写（不覆盖手改，见 `autoTitle`）。
   */
  title?: string;
  /**
   * 会话级模型覆盖（三级解析的最内层）：本字段 > `AgentDefinition.modelId` > `AppConfig.defaultModel`。
   *
   * 之所以不直接改写 `agent.modelConfig`：它是**这段会话**的意思，不该抹到 Agent 定义上
   * （那会改动所有用同一个 Agent 的会话）。换 Agent 时会被清掉（见 `setAgent`）。
   */
  modelId?: string;
  /**
   * 会话级模型**参数**覆盖（与上面那个 `modelId` 同一级）。
   *
   * 不透明载荷：本包不解释键名，只当数据搬（存档 ↔ 内存 ↔ 装配方），与 `messages` 同一
   * 口径。什么时候它真正生效由 SDK 按档位决定（`resolveModelParams`）—— 参数跟着「模型
   * 来自哪一级」走，模型来自 Agent 定义 / 全局兜底时这一份**不参与**合并（会话级模型配上
   * 定义级参数，等于把旧模型的 `thinking` 发给新模型，端点回 400）。
   *
   * 换模型（`setModel`）与换 Agent（`setAgent`）都会清掉它：目标模型不一定接受旧参数，
   * 与 `agent.model.set` 清思考参数同一个理由。
   */
  modelParams?: unknown;
  /** 最后一次活动的时刻（ISO）：列表排序与「运行中」的判断都不靠文件系统 */
  updatedAt: string;
  /**
   * 此刻看着这段会话的连接（不透明的连接 id）。
   *
   * 用 `Set` 而不是一个 id：一段会话被终端与桌面端**同时**看着是常态，谁先走都不该
   * 影响另一个。id 的类型留在 `number` 而不是 daemon 的 `Connection` —— `service/`
   * 不认识传输层，会话层只需要「若干个互不相干的身份」。
   *
   * 与 `keepAlive` 合起来才是「活着」，见文件头的判据一节。
   */
  holders: Set<number>;
  /** 正在跑的回收倒计时（取消函数）；`null` = 没在计时 */
  reclaimCancel: (() => void) | null;
  /**
   * 倒计时到点时这一轮还在跑：等它收尾再收（见 `reclaimNow`）。
   *
   * 必须记下来而不是「到点直接什么都不做」：一轮中途被收的代价是那一轮的产出与存档
   * 一起丢（`detach()` 之后 `settleTurn` 不再跑），所以只能延后，不能取消。
   */
  reclaimOnSettle: boolean;
  /** 交接服务（首次交接时创建；持有取消句柄，见 `handoffOf`） */
  handoff: SessionHandoff | null;
  /**
   * 本轮的子 Agent（subAgentId → 条目）。
   *
   * 生命周期**只到本轮结束**：一轮结束后主 Agent 已给出最终答案，子 Agent 只剩历史
   * 价值，留着会让栏目标签永远停在上一轮；`reload` / `adopt` / `close` 换了 Agent 或
   * 换了会话 id，也一并清（它们换的是同一段会话的「底座」，旧条目上的实例已不再被
   * 任何东西引用）。清空地集中在 `clearSubAgents`。
   */
  subAgents: Map<string, SubAgentEntry>;
  /** 展示序号（本轮内从 1 起，每轮归零：标签回到「子AGENT1」） */
  subAgentSeq: number;
  /** id 序号（与展示序号分开：id 要稳定且不带含义，见 `onSubStart` 的注释） */
  subAgentIdSeq: number;
  /**
   * 等客户端回答的问题（`questionId` → resolve）。
   *
   * 一个会话同一时刻只会有 0 或 1 个（自动迁移是串行的：`settleDeferred` 占着坑），
   * 仍用 Map 是因为「过期的回答一律拒」这条判定靠它：认领时按 id 查表，查不到就是来晚了
   * （超时 / 已答过 / 会话已收），而那三种情况对客户端是同一件事 —— 不必重试。
   */
  questions: Map<string, PendingQuestion>;
  /** 提问序号（只在会话内递增）：认领靠它的而不是轮次，一轮里可以问不止一次 */
  questionSeq: number;
  detach: () => void;
}

/**
 * 默认的会话 id：`chat_YYYY_MM_DD_HH_mm_ss`。
 *
 * 与存档文件名的格式一致（同一个 id 既标识内存里的会话，也是落盘的文件名）。
 * 同一秒内连开两个会话会撞 id —— 撞了就由 `create()` 回 `session-exists`，
 * 不靠“再猜一个后缀”掩盖（客户端本来就会带上自己的 id）。
 */
function defaultNextSessionId(): string {
  return `chat_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "_")}`;
}

/** 带机器可判别 code 的错误（守护进程原样回给客户端） */
function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error as Error & { code: string };
}

/**
 * 这一段会话有没有名字。
 *
 * 空串算没名字：`session.rename` 已经拒绝空标题，剩下的空串只可能来自手改坏的存档 ——
 * 把它当成「用户起过名」会让一句空话永久挡在自动标题前面。
 */
function isTitled(session: LiveSession): boolean {
  return Boolean(session.title?.trim());
}

/**
 * 等客户端回答「自动迁移用哪种方式交接」的上限：5 分钟。
 *
 * 进程内（TUI）是「人不在就一直等」：那一等只挂在自己终端上，用户回来接着选就行。
 * 远程模式完全不同 —— 提问之后这一段会话就在等答案，等多久就等于把它晾多久：用户
 * 看到的是「发不出下一条消息」（`turn-busy`），而且永远等不到这一轮的收尾。所以必须
 * 有个上限：5 分钟足够人从别的窗口回来点一下，又不至于把会话晾到没法用。
 */
const ASK_TIMEOUT_MS = 300_000;

/**
 * 「最后一个看着它的人也走了」之后还留多久：60 秒。
 *
 * 下界是**重连最坏耗时**：客户端三次尝试，每次含 `ensureServer` 的 10s 超时，再加
 * 100ms / 300ms 退避，约 30s。低于它就会出现最难解释的一种现象 —— 客户端正在重连，
 * 而服务端已经把会话按「没人要」收掉了。
 *
 * 上界是**崩溃后多占的内存**：每段会话只占一个 Agent 与它的消息数组（MCP 连接按工作区
 * 共享，`Scope` 缓存住，不随会话数增加）。60s 在两头都很松。
 */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60_000;

/**
 * 自动标题那次模型调用的硬超时：10 秒。
 *
 * 它不是「等到就好了」的宽容值，而是一个上限：起名是一次几十 token 的小请求，10 秒还没
 * 回来就只可能是端点卡了 / 网不通。而它挂在**会话**上 —— 不设上限的话，一个挂住的请求
 * 会连着 `AbortController` 与消息拷贝一起挂到进程结束（用户看不出来，只是内存与连接慢慢
 * 涨）。到点就取消，标题留空，什么也不说。
 */
const AUTO_TITLE_TIMEOUT_MS = 10_000;

/**
 * 默认的倒计时实现。
 *
 * `unref()` 是必须的：一个「等 60 秒再回收」的计时器不该成为进程不退出的理由（守护进程
 * 的空闲退出、测试进程的结束都靠事件循环空了才成立）。
 */
const defaultSchedule = (ms: number, run: () => void): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * 会话管理器只持有 Agent「能跑一轮」那一面（`AgentLike`，为了能用假件测完整个事件流）；
 * 交接需要更宽的那面（定义模板、工具表、`use()`）—— 同一个对象，只是视图不同。
 *
 * 收在这里而不是散在调用点：这一句在说「真件必须满足交接的要求」，散开就成了隐式约定。
 */
function asHandoffAgent(agent: AgentLike): HandoffAgentLike {
  return agent as unknown as HandoffAgentLike;
}

/**
 * 当前 Agent **实际在用**的模型 id。
 *
 * SDK 把三级解析的结果写进它交给 Agent 的那份定义（`definition.modelId`），所以
 * 这里读到的就是真正在跑的模型 —— 不是某一级的原始值。与会话相关但不在 `AgentLike` 里，
 * 所以还是「同一个对象、更宽的视图」。
 */
function modelIdOf(agent: AgentLike): string {
  const definition = (agent as { definition?: { modelId?: unknown } }).definition;
  return typeof definition?.modelId === "string" ? definition.modelId : "";
}

/**
 * Agent **定义上**那份参数覆盖（`AgentDefinition.modelParams`）—— 三级里 `agent` 那一档。
 *
 * 为什么从 `definition` 上取：SDK 交给 Agent 的是**解析之后**的那份定义（`modelId`
 * 已经换成生效模型），而 `modelParams` 仍是这一档的原始覆盖 —— `createAgent` 只按档位
 * **选**一份去装配，不会把选中的结果写回定义。所以它和 `session.modelParams` 合起来
 * 就是 `resolveModelParams` 要的两个候选。
 *
 * 与 `modelIdOf` 同一个取法：这两个字段都不在 `AgentLike` 里（那是「能跑一轮」的最小面），
 * 仍是「同一个对象、更宽的视图」。
 */
function agentModelParamsOf(agent: AgentLike): ModelParams | undefined {
  const definition = (agent as { definition?: { modelParams?: ModelParams } }).definition;
  return definition?.modelParams;
}

/**
 * 生效模型来自哪一级（会话 / Agent 定义 / 全局兜底）。
 *
 * 同样来自 SDK 的解析副产品：本层不知道 `config.defaultModel`（它不读配置），也不应该
 * 再推一遍顺序。档位与 `modelIdOf` 同源（都来自 `createAgent` 那一次解析），
 * 所以状态栏的「哪个模型」和选择器的「哪一档」永远说得是同一件事。
 */
function modelLevelOf(agent: AgentLike): ModelLevel {
  return agent.modelLevel;
}

/**
 * Agent 实际发给端点的模型名（`modelName ?? id` 解析之后的值）。
 *
 * 客户端拼图片内容块时要按它反查端点与视觉能力：`file_id` 是端点维度资源，
 * 用配置里的 `modelId` 反查在“配了别名”时会落空。
 */
function apiModelOf(agent: AgentLike): string {
  const model = (agent as { model?: unknown }).model;
  return typeof model === "string" ? model : "";
}

/** 流末 chunk 的真实产物 token 数（`stream_options.include_usage`）；没有就是 undefined */
function completionOf(chunk: any): number | undefined {
  const value = chunk?.usage?.completion_tokens;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 从一片 OpenAI 风格的流式 chunk 里取出正文与推理增量。
 *
 * 主 Agent 与子 Agent 共用这一份取法：两边刷的是同一条 SDK 事件（`chunk-parsed`），
 * 形状一模一样，写两份只会在某天 SDK 改字段时漂成一半对一半错。
 */
function deltaOf(chunk: any): { text: string; reasoning: string } {
  const delta = chunk?.choices?.[0]?.delta;
  const text = typeof delta?.content === "string" ? delta.content : "";
  const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
  return { text, reasoning };
}

/**
 * 按**实例**找回它的条目。
 *
 * `sub-agent-end` / `error` 的载荷是实例而不是 id（SDK 侧就这么给），而协议里的 id 是
 * 本层分配的 —— 两边得在这里对上。
 */
function subAgentEntryOf(session: LiveSession, subAgent: SubAgentLike): SubAgentEntry | undefined {
  for (const entry of session.subAgents.values()) {
    if (entry.agent === subAgent) return entry;
  }
  return undefined;
}

export class SessionManager {
  private readonly createAgent: (input: CreateAgentInput) => Promise<AgentLike>;
  private readonly nextSessionId: () => string;
  private readonly storeFactory: SessionManagerOptions["storeFor"];
  private readonly invalidateScope: SessionManagerOptions["invalidateScope"];
  private readonly handoffOptions: SessionManagerOptions["handoff"];
  /** 等客户端回答的时限（可注入，缺省见 `ASK_TIMEOUT_MS`） */
  private readonly askTimeoutMs: number;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly hub: EventHub;
  /** 「没人看着之后还留多久」（宽限期，见文件头的判据） */
  private readonly sessionIdleTimeoutMs: number;
  /** 倒计时实现（可注入：时间驱动的判定得能手动“到点”） */
  private readonly schedule: (ms: number, run: () => void) => () => void;
  /** 自动标题（不注入 = 不做；见 `SessionManagerOptions.autoTitle`） */
  private readonly autoTitleFn: AutoTitleFn | undefined;
  /** 等标题的上限（可注入，缺省见 `AUTO_TITLE_TIMEOUT_MS`） */
  private readonly autoTitleTimeoutMs: number;
  /** 存档条目的生效模型解析（不注入 = 存档条目上不给这一对字段） */
  private readonly resolveSessionModel: SessionManagerOptions["resolveSessionModel"];
  /** 自建的 hub 由自己清理；外面传进来的归外面管 */
  private readonly ownsHub: boolean;

  constructor(options: SessionManagerOptions) {
    this.createAgent = options.createAgent;
    this.nextSessionId = options.nextSessionId ?? defaultNextSessionId;
    this.storeFactory = options.storeFor;
    this.invalidateScope = options.invalidateScope;
    this.handoffOptions = options.handoff;
    this.askTimeoutMs = options.askTimeoutMs ?? ASK_TIMEOUT_MS;
    this.sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    this.schedule = options.schedule ?? defaultSchedule;
    this.autoTitleFn = options.autoTitle;
    this.autoTitleTimeoutMs = options.autoTitleTimeoutMs ?? AUTO_TITLE_TIMEOUT_MS;
    this.resolveSessionModel = options.resolveSessionModel;
    this.hub = options.hub ?? new EventHub();
    this.ownsHub = !options.hub;
  }

  /**
   * 整份快照：客户端（重）连上来时一次拿全，不用先从事件流里攒。
   *
   * 模型那三样（`modelId` / `modelLevel` / `modelParams`）必须**同源**：解析只发生在
   * `createAgent` 里（`resolveModel` 给模型与档位），这边只把档位拿去问
   * `resolveModelParams`「参数该取哪一份」。各解析一遍的话，「模型来自会话级、参数却按
   * 定义级算」这种错在快照里看不出来（两边各自都“说得通”），而它真的会发生：会话换过
   * 模型、参数却还留在定义上，客户端显示的思考强度和实际发出去的请求就是两件事。
   */
  async snapshot(sessionId: string): Promise<SessionSnapshotResult> {
    const session = this.require(sessionId);
    // 档位只取一次，模型、参数两处都用它 —— 这就是「同一次解析」在代码里的样子
    const level = modelLevelOf(session.agent);
    const modelParams = resolveModelParams({
      level,
      sessionModelParams: session.modelParams as ModelParams | undefined,
      agentModelParams: agentModelParamsOf(session.agent),
    });
    return {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      // 生效模型 + 它来自哪一级：两者都是 SDK 解析结果的透传（见 `modelIdOf` / `modelLevelOf`）
      modelId: modelIdOf(session.agent),
      modelLevel: level,
      // 没有覆盖时整对字段都不出现：`undefined` 本身是「这一档什么都不带」这个答案，
      // 客户端照实显示出厂参数，而不是自己去定义 / 默认里推一个值出来
      ...(modelParams !== undefined ? { modelParams, modelParamsLevel: level } : {}),
      apiModel: apiModelOf(session.agent),
      turnId: session.turnId,
      phase: this.visiblePhase(session),
      messages: [...session.agent.messages],
      ...(session.agent.lastUsage !== undefined ? { lastUsage: session.agent.lastUsage } : {}),
    };
  }

  /**
   * 取某个子 Agent 到目前为止的完整对话（客户端切到该栏目时对齐用）。
   *
   * 找不到会话是 `unknown-session`（与其它方法同一口径）；会话在、但那轮已经结束
   * （条目已被 `clearSubAgents` 清掉）是 `sub-agent-missing` —— 后者不是“服务端出错”，
   * 子 Agent 本来就只活在当前一轮（参见 `SubAgentEntry` 的生命周期注释），客户端该做的
   * 是把栏目收回去，不是重试。
   */
  async subAgentSnapshot(sessionId: string, subAgentId: string): Promise<SubAgentSnapshotResult> {
    const session = this.require(sessionId);
    const entry = session.subAgents.get(subAgentId);
    if (!entry) throw codedError("sub-agent-missing", `no such sub-agent: ${subAgentId}`);
    return {
      subAgentId: entry.id,
      index: entry.index,
      status: entry.status,
      // 复制一份：服务端是真相源，客户端别拿一个会跟着流式追加变动的数组
      messages: [...entry.agent.messages],
    };
  }

  /** 把当前会话写进工作区存档，并把它设为「上一轮会话」 */
  async save(sessionId: string, options: { setAsLast?: boolean } = {}): Promise<SessionSaveResult> {
    const session = this.require(sessionId);
    const store = await this.storeFor(session.workspaceId);
    if (!store)
      throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);

    await store.write(this.recordOf(session));
    // `setAsLast:false` 是一次性调用的归档（`ai --save`）：存下来是为了事后翻看，
    // 但「本工作区上一轮会话」仍该是用户真正聊过的那一段。
    if (options.setAsLast !== false) await store.setLastSession(session.id);
    return { saved: true, sessionId: session.id };
  }

  /**
   * 另存为指定 id（`/save <名字>`）：写新档、删旧档、活会话换键。
   *
   * 与 {`migrate`} 的区别：这是**同一段对话**换个名字，所以 `turnId` 不动；
   * 删旧档是必须的 —— 同一份对话在 `/load` 列表里出现两条，用户分不清哪条是新的。
   */
  async saveAs(sessionId: string, id: string): Promise<SessionSaveAsResult> {
    const session = this.require(sessionId);
    const store = await this.storeFor(session.workspaceId);
    if (!store)
      throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);
    // 目标 id 已被另一段活会话占着：不静默顶掉它
    if (id !== session.id && this.sessions.has(id)) {
      throw codedError("session-exists", `session already exists: ${id}`);
    }

    const previousId = session.id;
    await store.write(this.recordOf(session, session.agent.messages, id));
    await store.setLastSession(id);
    if (id !== previousId) await store.remove(previousId);

    this.sessions.delete(previousId);
    session.id = id;
    this.sessions.set(id, session);
    if (id !== previousId) {
      this.emit({ event: SESSION_EVENTS.idChanged, from: previousId, sessionId: id });
    }
    return { saved: true, sessionId: id };
  }

  /**
   * 自动迁移 —— 由 SDK 的 `AutoMigratePlugin` 在**一轮内部**（`onAfterSend`）触发。
   *
   * 与手动 `migrate()` 的三点不同：
   *   1. **不新开一轮**（外面那一轮还没结束，`turnId` 不动）；
   *   2. 收尾仍归外面那一轮 —— 这里只把 `settleDeferred` 拿住，避免嵌套交接回合的
   *      SDK `finally` 把整轮提前结束；
   *   3. 没有返回值可给：客户端靠 `session.idChanged` 事件得知换了 id。
   *
   * 必须能存档：prune 之后旧历史只存在于存档里，存不下去就别动手。
   *
   * `mode` 是客户端在 `session.question` 里选的执行者。它必须从这条路径传下去：
   * `resolveMode` 只回答「用哪种方式」，真正动手的是这里 —— 而插件手里的 `service`
   * 是个 stub（见 `SessionAgentFactory.installPlugins`），不在这一跳把 mode 捞回来，
   * 用户在弹框里的选择就只是个框。不传则用交接服务的默认执行者（`self`）。
   *
   * 这里**不**加「已有一轮在跑就拒绝」那条判断（`send` 的 `turn-busy` / `requireIdle`
   * 的 `turn-in-flight`）：它天生运行在**一轮内部**（插件在 `onAfterSend` 里调），
   * `turnSettled` 必然为 false —— 照搬那条判断会把自动迁移整个废掉。它挡并发靠的是
   * 下面的 `settleDeferred` 占坑。
   */
  private async autoMigrate(sessionId: string, mode?: HandoffMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    // 交接已在跑（插件自己的 `busy` 检查漏了一次）：不重复迁移，也不报错
    if (!session || session.settleDeferred) return;

    // 先占坑再 await：下面每一条 await 都是让出点，并发进来的第二次调用会看到
    // `settleDeferred` 已经为真 —— 不占坑就是「两个迁移同时跑」，SDK 那边会直接抛
    // “A handoff is already in progress”
    session.settleDeferred = true;
    const previousId = session.id;
    try {
      const store = await this.storeFor(session.workspaceId);
      if (!store) {
        throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);
      }

      await store.write(this.recordOf(session, [...session.agent.messages], previousId));
      await store.setLastSession(previousId);
      this.notice(previousId, {
        level: "info",
        code: SESSION_NOTICE_CODES.handoffArchived,
        params: { sessionId: previousId },
      });

      await this.handoffOf(session).migrate(
        asHandoffAgent(session.agent),
        mode,
        DEFAULT_MIGRATION_STRATEGY,
      );
      await this.adopt(session, store);
    } finally {
      session.settleDeferred = false;
    }
  }

  /**
   * 问客户端「这次自动迁移用哪种方式交接」；返回 `null` = 用户选择不交接。
   *
   * 这是把旧版 TUI 的三选一（自己写 / 独立摘要 / 不交接）搬到线上。谁来写交接文档是
   * **用户的决定**（保真 vs 便宜、要不要现在就走），服务端替他选 `self`，等于把他没有的
   * 能力当成他的选择 —— 这正是「基础交互被前后端分离改掉」的那类回归。
   *
   * 本方法只负责两件事：把触发时的两个数（`promptTokens` / `handoffTokens`）交给
   * {@link askQuestion}，并把答案翻译成 `HandoffMode | null`。提问本身的四条约束
   * （没人在看就不问 / 先登记再发 / 有时限 / 三个出口都清表）在 `askQuestion` 里，
   * 不在这里重写一遍——那是一处会与实现无关地漂的副本。
   *
   * 兜底是 `null`（本次不交接）而不是 `self`：迁移要不要现在做，是用户的决定；服务端替他
   * 选 `self`，等于把「用户没有的能力」当成「用户的选择」。上下文继续长由硬线护栏兜。
   */
  private async askHandoffMode(
    session: LiveSession,
    info: AutoMigrateTriggerInfo,
  ): Promise<HandoffMode | null> {
    const choice = await this.askQuestion(session, {
      kind: "handoff-mode",
      input: "select",
      // 选项 id 就是 `HandoffMode` 的字面量：文案由客户端按 `kind + id` 查词典
      options: ["self", "summary"],
      params: { promptTokens: info.promptTokens, handoffTokens: info.handoffTokens },
      allowSkip: true,
      // **兜底是「什么都不做」**：迁移要不要现在做、用哪种方式，是用户的决定。服务端替他
      // 选 `self`，等于把「用户没有的能力」当成「用户的选择」。（旧版在无人可问时默认
      // `self` 自动迁移，这条已经按产品决定改掉：不迁移，上下文继续长由硬线护栏兜。）
      fallback: null,
    });

    if (choice === "self" || choice === "summary") return choice;

    // 跳过（用户选的 / 兜底走到这儿）：说一句「本次没迁」，否则用户只会看到上下文继续涨
    this.noticeIfAlive(session, {
      level: "info",
      code: SESSION_NOTICE_CODES.migrationSkipped,
    });
    return null;
  }

  /**
   * 问客户端一个问题，等它的答案（`session.answer`）。
   *
   * 四条规矩都写在这一个方法里，因为它们是**提问**这件事本身的约束（不是交接的）：
   *
   * 1. **没人在看就不问**：返回 `fallback`。发出去没人看得见，等一个不会来的答案只是
   *    把这一轮挂死（客户端已退出，而会话仍在服务端活着）。
   * 2. **先登记再发事件**：事件同步推给订阅者，客户端可能在同一轮事件循环里就答了 ——
   *    先发后登记会让那条回答撞上「表里没有这个 id」。
   * 3. **等，但有时限**（`askTimeoutMs`）：到点用 `fallback` 收场，不留悬挂的一轮。
   * 4. **三条出口都清表**（答了 / 超时 / 被 `releaseQuestions` 放行）：清表是「来晚了」
   *    的唯一判据；不清就会让迟到的回答重复生效。
   */
  private async askQuestion(session: LiveSession, spec: AskQuestionSpec): Promise<string | null> {
    if (this.hub.watcherCount() === 0) return spec.fallback;

    const questionId = `q-${++session.questionSeq}`;
    const answer = new Promise<string | null>((resolve) => {
      session.questions.set(questionId, { resolve, fallback: spec.fallback });
    });

    this.emit({
      event: SESSION_EVENTS.question,
      sessionId: session.id,
      questionId,
      kind: spec.kind,
      input: spec.input,
      ...(spec.options ? { options: spec.options } : {}),
      params: spec.params ?? {},
      allowSkip: spec.allowSkip ?? false,
      fallback: spec.fallback,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<string | null>((resolve) => {
      timer = setTimeout(() => resolve(spec.fallback), this.askTimeoutMs);
    });
    try {
      return await Promise.race([answer, timedOut]);
    } finally {
      clearTimeout(timer);
      session.questions.delete(questionId);
    }
  }

  /**
   * 发一条会话内通知，但会话可能已经不在（提问方被放行后继续跑的那一刻常见）。
   *
   * 不是在吞错 `notice()` 的错误：「会话已经没了」对这条路径是**正常结局**，而不是异常。
   */
  private noticeIfAlive(session: LiveSession, notice: NoticePayload): void {
    if (!this.sessions.has(session.id)) return;
    this.notice(session.id, notice);
  }

  /**
   * 把挂着的提问全部按默认执行者放行。
   *
   * 什么时候需要它：会话被关了（`close` / `dispose`）、或这一轮已经收尾 —— 这两种情况下
   * 不会再有回答进来，而 `askHandoffMode` 那边还挂着一个 promise。不放行它，那一轮就要
   * 白等到 5 分钟超时，期间这段会话一直占着闸门（后面的 `send` 全报 `turn-busy`）。
   *
   * 用 `self` 而不是「跳过」：关闭/收尾是**流程**结束了，不是用户表达了「这次不交接」；
   * 按默认执行者继续，与「没有客户端在看」同一口径。真到了迁移那一步，如果会话已经不在，
   * `autoMigrate` 会自己打住。
   */
  private releaseQuestions(session: LiveSession): void {
    if (session.questions.size === 0) return;
    // 先清表再 resolve：resolve 会让提问方继续跑（可能立即发起新的提问）
    const pending = [...session.questions.values()];
    session.questions.clear();
    // 每个问题按**它自己的**兜底收场。用统一值会出事：交接类问题的兜底是「什么都不做」，
    // 而“流程结束了”并不意味着用户表达了「这次不交接」以外的东西 —— 由提问方决定。
    for (const question of pending) question.resolve(question.fallback);
  }

  /**
   * 只产出交接文档（`/handoff`）：写文档，**不动会话**（不换 id、不剔历史）。
   *
   * 和 `send()` 一样按「一轮」记账：先把 `turnId` 进一格，交接回合的阶段与增量就都
   * 归在这一轮上，客户端不用另开一套「非对话回合」的渲染。区别只在收尾由本方法负责
   * （`settleDeferred`）—— 否则文档还没校验完，SDK 的 `finally` 就已宣布本轮结束。
   */
  async handoff(sessionId: string, mode?: HandoffMode): Promise<SessionHandoffResult> {
    const session = this.requireIdle(sessionId);
    this.beginTurn(session);
    session.settleDeferred = true;
    // 交接回合也算对话内容（指令 + 工具调用 + 回执都会留在 messages 里）：收尾时落盘。
    // `migrate` 不置位：它自己已在交接前存过完整历史，再写一次会把 prune 后的版本盖上去。
    session.persistOnSettle = true;
    try {
      const outcome = await this.handoffOf(session).handoff(asHandoffAgent(session.agent), mode);
      return {
        sessionId: session.id,
        handoffPath: outcome.handoffPath,
        mode: outcome.mode,
        messages: [...session.agent.messages],
      };
    } catch (error) {
      throw this.failHandoff(session, error);
    } finally {
      session.settleDeferred = false;
      await this.settleTurn(session);
    }
  }

  /**
   * 交接 + 开新会话（`/migrate`）：写文档、按 `strategy` 处置历史；`prune` 还要换 sessionId。
   *
   * ## `prune`（缺省，分家之前的行为）的顺序是定死的
   *
   *   1. 先把旧会话存进存档（**交接回合之前**的完整历史）。存不下去就在这里打住，
   *      此时内存里什么都还没动；反过来「先 prune 再存」则是文档写了、历史没了；
   *   2. 交接（SDK 负责：写文档、校验、降级、剔除历史、注入断点）；
   *   3. 收尾（发在旧 id 上）→ 换 id 并落盘新会话。
   *
   * ## `omit` 是另一条路，而且「不存档、不换 id」
   *
   * `omit` 不剔历史（只打 `omit: true` 标记），所以：
   *   - **不预存旧档**：存档就是同一份文件，收尾时会把「完整历史（带标记）」写回去；
   *     先存一遍等于同一份东西写两次，还会多发一条不实的 `handoffArchived`
   *     （用户会以为旧会话被另存成了一段）；
   *   - **不换 id**：内容没变（只是旧消息不再发给模型），它还是同一段对话。换 id 会让
   *     刚聊过的那一段在侧栏里凭空消失，存档里多一条不知道从哪来的幽灵。于是也不发
   *     `session.idChanged`；
   *   - 落盘改由收尾负责（`persistOnSettle`）：`turn.end` 之前写完，存档里那份就是
   *     带 `omit` 标记的完整历史 —— 下次 `attach` 装回来，旧消息仍然不会发给模型。
   *
   * 两条路共用的部分：`turnId` 是**会话内**的轮次编号，不因迁移清零；收尾在 `prune` 下
   * 必须 `await` 且发生在换 id **之前** —— 客户端先看到旧会话这一轮结束，再收到响应里
   * 的新 id，两次 `session.phase` / `turn.end` 的 `sessionId` 才不指一个它还不知道的会话。
   */
  async migrate(
    sessionId: string,
    mode?: HandoffMode,
    strategy: MigrationStrategy = DEFAULT_MIGRATION_STRATEGY,
  ): Promise<SessionMigrateResult> {
    const session = this.requireIdle(sessionId);
    const store = await this.storeFor(session.workspaceId);
    // 迁移必须能存档：prune 之后旧历史只存在于存档里（内存里只剩模板 + 断点）；omit 的
    // 「旧消息不再发给模型」这条事实也只能靠存档记住（否则 attach 回来又是一份干净历史）
    if (!store)
      throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);

    this.beginTurn(session);
    session.settleDeferred = true;
    // 收尾该不该写档：prune 已经自己存过完整历史（再写会把 prune 后的版本盖上去），
    // omit 则**必须**写（存档里那份要带上 `omit` 标记）
    session.persistOnSettle = strategy === "omit";
    try {
      const previousId = session.id;
      if (strategy === "prune") {
        await store.write(this.recordOf(session, [...session.agent.messages], previousId));
        await store.setLastSession(previousId);
        this.notice(previousId, {
          level: "info",
          code: SESSION_NOTICE_CODES.handoffArchived,
          params: { sessionId: previousId },
        });
      }

      const outcome = await this.handoffOf(session).migrate(
        asHandoffAgent(session.agent),
        mode,
        strategy,
      );

      session.settleDeferred = false;
      // 收尾必须 **await**：它发的是收尾那一刻 id 的 `turn.end`，而下一行可能就把 id
      // 换掉了。不等它跑完，客户端可能先收到新 id 的响应，再收一条指向旧会话的收尾事件。
      await this.settleTurn(session);

      // 换 id 只属于 prune（理由见方法注释）：omit 下 `session.id` 原样返回
      const nextId = strategy === "prune" ? await this.adopt(session, store) : session.id;
      return {
        sessionId: nextId,
        handoffPath: outcome.handoffPath,
        mode: outcome.mode,
        messages: [...session.agent.messages],
      };
    } catch (error) {
      throw this.failHandoff(session, error);
    } finally {
      session.settleDeferred = false;
      await this.settleTurn(session);
    }
  }

  /**
   * 换 Agent（`session.setAgent`）：按新定义重建、**保留消息**、更新 `agentId`、落盘一次。
   *
   * Agent 身份在服务端手里（Agent 就在这边跑），所以这是唯一能让「同一段对话换个 Agent
   * 继续」的办法：客户端把消息搬到一个新会话去，等于要求服务端接受客户端递来的历史，
   * 与「服务端是唯一真相源」直接冲突。
   *
   * 与 `reload` 的差别只有两件事：`agentId` 变了、多落一次盘（存档里记着 `agentId`，
   * 不写就会在下次 `attach` 时按旧 Agent 装回来）。**不重建 Scope**：Scope 里是配置与
   * 能力发现的结果，与 Agent 定义无关，而 `invalidateScope` 会连带踢掉同工作区的其它会话。
   *
   * 一轮在跑时拒绝（`turn-in-flight`）：换 Agent 会 `detach` 旧事件、换掉 `agent`，
   * 而旧 Agent 正流着的增量会全部丢在一个没人听的实例上。
   */
  async setAgent(sessionId: string, agentId: string): Promise<SessionSnapshotResult> {
    const session = this.require(sessionId);
    if (this.isTurnInFlight(session)) {
      throw codedError("turn-in-flight", `session ${sessionId} has a turn in flight`);
    }
    // 已经是这个 Agent：不重建（重建会丢掉工具发现的热状态，没任何好处）
    if (session.agentId === agentId) return await this.snapshot(sessionId);

    // 换 Agent 是**比换模型更强**的动作：模型跟着新定义走，会话级覆盖必须清掉。
    // 不清的话，上一任 Agent 的临时模型会跟着新 Agent 继续用 —— 用户换的是「谁来干」，
    // 却连带把「用什么模型」也留在了上一任的临时选择上，而且看不出来。
    // 参数同理（同一级的那一份）：新模型的参数不一定合法，而它已经和旧模型的覆盖绑在一起。
    // 这里先把两样覆盖从**这次装配**里摘掉（都不传），切换成功后才真清字段：
    // 装配失败（新定义不存在 / 端点缺 Key）时会话原样还在，覆盖也还在。
    const agent = await this.buildAgent(session, { agentId });
    session.agentId = agentId;
    delete session.modelId;
    delete session.modelParams;
    this.adoptAgent(session, agent);

    // 存档里记着 `agentId`：不写就会在下次 `attach` 时按旧 Agent 装回来
    await this.writeSession(session);

    return await this.snapshot(sessionId);
  }

  /**
   * 换**这一段会话**的模型（`session.model.set`）：写会话级覆盖、按它重建 Agent、落盘一次。
   *
   * 为什么落在会话上而不是 Agent 定义上：`/model <id>` 的意思是「这次用它」。写进定义会
   * 影响所有用这个 Agent 的会话（另一个终端里的对话会莫名其妙换了模型）。反过来，
   * 「以后默认用它」由 `agent.model.set` 负责 —— 两个动作两个方法，客户端不必猜。
   *
   * 装配顺序是「先按新模型造出 Agent，成功了才落覆盖」：端点缺 Key、模型被删掉这类失败
   * 发生在 `createAgent` 里，此时会话必须原样不动 —— 否则用户会留下一段指向坏模型的存档，
   * 下次 `attach` 直接起不来（而且他刚刚只是点了个选择器）。
   */
  async setModel(sessionId: string, modelId: string): Promise<SessionSnapshotResult> {
    const session = this.require(sessionId);
    if (this.isTurnInFlight(session)) {
      throw codedError("turn-in-flight", `session ${sessionId} has a turn in flight`);
    }

    // 换到**别的**模型就清掉会话级参数：旧参数是配给旧模型的（GLM 不接受
    // `thinking.disabled` 这类），带过去就是端点 400 —— 与 `agent.model.set` 清思考参数
    // 同一个理由。比较的是**生效模型**（当前参数属于它）而不是会话级覆盖：目标与生效值
    // 相同时模型根本没换，参数继续有效，不该被这一次“重设”抹掉。
    const sameModel = modelIdOf(session.agent) === modelId;
    const agent = await this.buildAgent(session, {
      agentId: session.agentId,
      modelId,
      // 只有模型没换时才把参数带进这次装配；带着旧参数换模型，就是让 SDK 把它们发给新模型
      ...(sameModel && session.modelParams !== undefined
        ? { modelParams: session.modelParams }
        : {}),
    });
    session.modelId = modelId;
    if (!sameModel) delete session.modelParams;
    this.adoptAgent(session, agent);

    // 覆盖属于存档的一份事实（`SessionRecord.modelId`）：不写，重启 / `attach` 就丢
    await this.writeSession(session);

    return await this.snapshot(sessionId);
  }

  /**
   * 写**这一段会话**的模型参数覆盖（`session.modelParams.set`）：重建 Agent、落盘一次。
   *
   * 为什么落在会话上而不是 Agent 定义上：`/think` 的目标层跟着**模型来自哪一级**走
   * （见 SDK 的 `resolveModelParams`）。模型是本段会话换的，参数就必须写在这一段 ——
   * 写进定义会影响所有用这个 Agent 的会话，而且下一段会话里那份参数碰不到一起。
   *
   * `null` = 清掉覆盖（回到模型出厂参数）：JSON 没有 `undefined`，所以「清除」只能由它
   * 表达。
   *
   * 装配顺序与 `setModel` 一致：先按新参数造出 Agent，成功了才落覆盖 —— 参数导致装配
   * 失败（模型不认识这些字段、端点缺 Key）时会话必须原样不动。
   */
  async setModelParams(sessionId: string, modelParams: unknown): Promise<SessionSnapshotResult> {
    const session = this.require(sessionId);
    if (this.isTurnInFlight(session)) {
      throw codedError("turn-in-flight", `session ${sessionId} has a turn in flight`);
    }

    // `null` = 清掉覆盖：这次装配干脆不带参数（与「从来没设过」同一条路），存档里也删掉
    const overrides = modelParams ?? undefined;
    const agent = await this.buildAgent(session, {
      agentId: session.agentId,
      ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
      ...(overrides !== undefined ? { modelParams: overrides } : {}),
    });
    if (overrides === undefined) delete session.modelParams;
    else session.modelParams = overrides;
    this.adoptAgent(session, agent);

    // 与 `setModel` 同一个理由：不落盘，重启 / `attach` 回来就退回定义那份参数
    await this.writeSession(session);

    return await this.snapshot(sessionId);
  }

  /**
   * 按磁盘上的（新）配置与 Agent 定义重建 Agent，**保留当前消息**。
   *
   * 用在「`/config` 改了端点凭据」「`agent.model.set` 换了模型」之后：Scope 持有配置
   * 快照，不连带重建就还是旧的那份（CLI 时代 `resetScope()` 的存在就是这个原因）。
   *
   * 会话级模型覆盖原样带进这次重建：它是这段会话的一部分，不该因为「重新读了一次配置」
   * 就被悄悄丢掉（真正该丢它的是 `setAgent`）。
   */
  async reload(sessionId: string): Promise<SessionSnapshotResult> {
    const session = this.require(sessionId);

    // 配置可能变了：先丢掉这个工作区缓存的 Scope（端点凭据、模型清单都在它手里）
    await this.invalidateScope?.(session.path);
    const agent = await this.buildAgent(session, {
      agentId: session.agentId,
      ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
      ...(session.modelParams !== undefined ? { modelParams: session.modelParams } : {}),
    });
    this.adoptAgent(session, agent);

    return await this.snapshot(sessionId);
  }

  /**
   * 造一个 Agent —— `setAgent` / `setModel` / `reload` 三条路共用这一份装配参数。
   *
   * 三处的差别只在**入参**（换 id / 换模型覆盖 / 什么都不换），而装配要接的那些钩子
   * （让行、自动迁移、提问）一个字都不该不一样：各写一份的那天，就会有一条路忘了接
   * 自动迁移，表现为「换完模型之后上下文旅满就不再迁移了」。
   *
   * 模型解析**不在这里做**：`modelId` 只是把会话级覆盖递进去，顺序由 SDK 的
   * `resolveModel` 决定（本层不知道 `config.defaultModel`、也不该再推一遍）。
   */
  private async buildAgent(
    session: LiveSession,
    input: { agentId: string; modelId?: string; modelParams?: unknown },
  ): Promise<AgentLike> {
    return await this.createAgent({
      workspaceId: session.workspaceId,
      path: session.path,
      agentId: input.agentId,
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      // 参数覆盖也一并递下去（不透明载荷）。只有模型来自会话级时它才真正生效：
      // 取哪一份由 SDK 的 `resolveModelParams` 按档位决定，本层不参与这个判断。
      ...(input.modelParams !== undefined ? { modelParams: input.modelParams } : {}),
      // 交接/迁移中让护栏让行：此刻这段会话还没注册（返回 false），正好
      isHandoffBusy: () => session.settleDeferred,
      // 自动迁移：SDK 的插件在**一轮内部**触发，落地动作必须回到会话层
      autoMigrate: (mode) => this.autoMigrate(session.id, mode),
      // 谁来写交接文档由用户在 `session.question` 里定（会话层向客户端提问并等回答）
      resolveMode: (info) => this.askHandoffMode(session, info),
    });
  }

  /**
   * 把新造的 Agent 接上：**保留消息**、摘旧事件监听、重挂监听、清空子 Agent 栏目。
   *
   * 与前一步成对使用（先 `buildAgent` 造好，成功了再 `adoptAgent` 切换）：造失败时旧
   * Agent 还在原位、监听也还挂着，会话不会变成一段「谁也不认识的」半死状态。
   */
  private adoptAgent(session: LiveSession, agent: AgentLike): void {
    const messages = [...session.agent.messages];
    session.detach();
    agent.messages = messages;

    session.agent = agent;
    session.turnFailed = null;
    session.turnSettled = true;
    session.phase.reset();
    // 换了 Agent：旧子 Agent 实例连同它们的对话一起退场（它们属于旧底座）
    this.clearSubAgents(session);
    session.detach = this.attachEvents(session);
  }

  /**
   * 某个工作区的会话清单：盘上的存档 ∪ 内存里的活会话。
   *
   * ## 为什么合并成一条（原来是 `list` + `listSaved`）
   *
   * 侧栏是**一个**列表：既要全部历史，又要「这段正在跑」。分两条时两边各缺一半（活会话
   * 有 phase、没标题；存档有历史、只有 id），客户端得自己拼，还会拼出「同一段会话出现
   * 两次」。合并后**一段会话在列表里只有一条**，`live` 说它此刻在不在内存里。
   *
   * `includeSaved: false` = 只看活会话（少读一次磁盘）。
   *
   * ## 生效模型（`effectiveModelId` / `effectiveModelLevel`）从哪来
   *
   * 两条路各自取「已经算好的那一份」，本层绝不自己推优先级（唯一实现是 SDK 的
   * `resolveModel`）：
   *
   *   · 活会话 —— Agent 实例就是 `createAgent` 按三级解析造出来的，`modelIdOf` /
   *     `modelLevelOf` 读的是那次解析的产物，与 `snapshot` 报的是同一件事实；
   *   · 存档条目 —— 只有 `SessionRecord`，没有实例，只能问注入的 `resolveSessionModel`
   *     （本层不读配置）。没注入 / 解析失败就省掉这两个字段，那一条照旧列出。
   */
  async list(
    workspaceId: string,
    options: { includeSaved?: boolean } = {},
  ): Promise<SessionListEntry[]> {
    const byId = new Map<string, SessionListEntry>();
    /**
     * 本次调用内的解析缓存（`agentId` + 会话级覆盖 → 结果或「解析不出来」）。
     *
     * 为什么键里要带会话级覆盖：解析的输入里就有它（`session > agent > global`，覆盖值一旦
     * 存在就直接赢），只按 `agentId` 缓存会把「没覆盖的那条」的答案发给「有覆盖的那条」。
     * 实际效果仍是「一个 Agent 一次」：同一个工作区里绝大多数存档都没有覆盖。
     *
     * 为什么缓存失败也是 `null` 而不只是省略：一个删掉的定义可能挂着一堆历史会话，
     * 每条都再问一次注入方，就是让同一个失败在一个请求里重演 N 次。
     *
     * 只在本次调用内有效（不做进程级缓存）：配置与定义随时会变，跨请求复用等于让清单
     * 在用户改完配置之后还报旧模型。
     */
    const resolvedModels = new Map<string, { modelId: string; level: ModelLevel } | null>();

    if (options.includeSaved !== false) {
      const store = await this.storeFor(workspaceId);
      // 没有存档不算错：活会话仍然列得出来（与 `listSaved` 的 `no-store` 不同口径——
      // 那条是「我要存档却不能给」，这条是「预览全部」，少一半总比报错有用）
      for (const entry of (await store?.list()) ?? []) {
        const resolved = await this.archivedModelOf(entry, resolvedModels);
        byId.set(entry.id, {
          sessionId: entry.id,
          agentId: entry.agentId,
          ...(entry.title !== undefined ? { title: entry.title } : {}),
          ...(entry.modelId !== undefined ? { modelId: entry.modelId } : {}),
          ...(resolved
            ? { effectiveModelId: resolved.modelId, effectiveModelLevel: resolved.level }
            : {}),
          messageCount: entry.messageCount,
          updatedAt: entry.updatedAt,
          live: false,
          phase: null,
        });
      }
    }

    // 活会话覆盖同名存档条目：内存里那份才是**此刻**的事实（可能多一整轮还没落盘）
    for (const session of this.sessions.values()) {
      if (session.workspaceId !== workspaceId) continue;
      // 生效模型 = 这个 Agent 装配时解析出来的那个（与 `snapshot` 同源，客户端不必自己算）。
      // 空串按「拿不到」算 —— 与 `resolveModel` 同一口径（`modelId: ""` 不是模型名）
      const effectiveModelId = modelIdOf(session.agent);
      byId.set(session.id, {
        sessionId: session.id,
        agentId: session.agentId,
        ...(session.title !== undefined ? { title: session.title } : {}),
        ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
        ...(effectiveModelId
          ? {
              effectiveModelId,
              effectiveModelLevel: modelLevelOf(session.agent),
            }
          : {}),
        messageCount: session.agent.messages.length,
        updatedAt: session.updatedAt,
        live: true,
        phase: this.visiblePhase(session),
      });
    }

    return [...byId.values()].sort((a, b) =>
      compareSessionEntries(
        { id: a.sessionId, updatedAt: a.updatedAt },
        { id: b.sessionId, updatedAt: b.updatedAt },
      ),
    );
  }

  /**
   * 一条**存档**条目的生效模型（见 `SessionManagerOptions.resolveSessionModel`）。
   *
   * 为什么失败返回 `null` 而不是抛出去：清单是侧栏的全部历史，一条解析不出来（定义被删、
   * 三级都空）不该让整张列表打不开 —— 那一段会话仍然在盘上、仍然要能被选中和删除。
   * 返回 `null` 的语义就是「这一刻说不准它的模型」，调用方据此省掉那两个字段（不猜值）。
   */
  private async archivedModelOf(
    entry: { agentId: string; modelId?: string },
    cache: Map<string, { modelId: string; level: ModelLevel } | null>,
  ): Promise<{ modelId: string; level: ModelLevel } | null> {
    // 没注入解析器 = 这一层没有解析能力（本层不读配置），那就一条都不给
    if (!this.resolveSessionModel) return null;

    const key = `${entry.agentId}\u0000${entry.modelId ?? ""}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let resolved: { modelId: string; level: ModelLevel } | null = null;
    try {
      resolved = await this.resolveSessionModel({
        agentId: entry.agentId,
        sessionModelId: entry.modelId,
      });
    } catch {
      // 具体原因（定义已删、配置里三级都空）是注入方的事，本层只需要「这条没有」这个结论
      resolved = null;
    }
    cache.set(key, resolved);
    return resolved;
  }

  /**
   * 改显示名 —— **不动 id**。
   *
   * 与 `saveAs` 是两件事：那个是「另存为」（换 id、旧档删掉），这个是改名字。
   * 目标可以只是盘上的存档（桌面的侧栏里改名不该要求先 attach 进内存）。
   *
   * 改名也算一次修改：`updatedAt` 跟着刷新（侧栏会把它排到最前）。
   */
  async rename(input: {
    workspaceId: string;
    sessionId: string;
    title: string;
  }): Promise<SessionRenameResult> {
    const title = input.title.trim();
    if (!title) throw codedError("bad-params", "title must not be empty");

    const session = this.sessions.get(input.sessionId);
    if (session) {
      session.title = title;
      const store = await this.storeFor(session.workspaceId);
      if (store) await store.write(this.recordOf(session));
      return { sessionId: session.id, title };
    }

    const store = await this.storeFor(input.workspaceId);
    if (!store) throw codedError("no-store", `no session store for ${input.workspaceId}`);
    const record = await store.read(input.sessionId);
    if (!record) throw codedError("session-missing", `no such session: ${input.sessionId}`);
    record.title = title;
    await store.write(record);
    return { sessionId: record.id, title };
  }

  /**
   * 删一段会话（**物理删存档**）。
   *
   * 幂等：本来就不存在回 `removed: false`（与 `agent.remove` 同一口径，不当错误）。
   *
   * 三条边界：
   *   1. 内存里有就先 `close()` —— 摘事件、摘子 Agent。那条正在跑的轮会继续跑完，但**不再
   *      写档**（`detach()` 之后 `settleTurn` 不会再跑）：用户说要删的东西不该跑完又写回来；
   *   2. 「上一轮会话」指针**不动** —— `last()` 发现目标存档不在了会回 `null`（客户端走
   *      新会话），不需要在这里做第二套清理；
   *   3. 只删本工作区的：`storeFor(workspaceId)` 就属于那一个工作区，不存在“删错地方”。
   */
  async remove(input: { workspaceId: string; sessionId: string }): Promise<SessionRemoveResult> {
    const store = await this.storeFor(input.workspaceId);
    const session = this.sessions.get(input.sessionId);
    const archived = store ? await store.exists(input.sessionId) : false;
    if (!session && !archived) return { removed: false };

    if (session) this.close(input.sessionId);
    if (archived && store) await store.remove(input.sessionId);
    return { removed: true };
  }

  /**
   * 某个工作区「上一轮会话」的指针 —— **只回 id**，且这个 id 必须是**盘上真有的存档**。
   *
   * 客户端拿它决定「新会话」还是「续接」：有 id 就原样塞进
   * `create({ workspaceId, sessionId })`。agentId 不在这里回：`create()` 已经实现了
   * 「调用方不给就从存档里取」（`input.agentId || record?.agentId`），再回一份就是
   * 第二份会漂移的真相。
   *
   * ## 为什么还读一次存档，而不是直接回指针
   *
   * 指针会过期：用户在别处 `/save <新名字>`（另存为会删旧档）、或手删了会话文件，指针
   * 仍然指着那个已经不存在的 id。而 `create()` 对「存档里没有这个 id」的定义是
   * **不报错、静默开一段空会话** —— 直接回指针的后果是：客户端以为在续接，用户看到
   * 的却是一段历史全空的新对话（「我明明接着上次，结果全没了」）。两害相权，
   * **宁可让客户端开一段新会话，也不能把它领进一段空会话**：新会话至少是诚实的。
   *
   * 代价是多一次落盘读。但它落在常见路径上本来就要发生的那次读上：客户端拿到 id 后
   * 立刻 `session.create`，`create()` 会读同一份存档 —— 这次读只是把那次提前了，
   * 算不上额外开销（指针为空 / 存档注定要删时更是省了一次白跑）。
   *
   * 没有指针、或指针指向的存档已不在时都回 `null`（客户端据此走新会话）；连存档都没
   * 注入时明确报 `no-store`，与 `listSaved` / `save` 同一口径 —— 不假装「这个工作区
   * 没有上一轮」。
   */
  async last(workspaceId: string): Promise<SessionLastResult> {
    const store = await this.storeFor(workspaceId);
    if (!store) throw codedError("no-store", `no session store for workspace ${workspaceId}`);
    const pointer = await store.lastSession();
    if (!pointer) return { sessionId: null };
    const record = await store.read(pointer.id);
    return { sessionId: record ? pointer.id : null };
  }

  /**
   * 撤回：删掉 `index` 起的消息，**并立即落盘**。
   *
   * 落盘不是可选项：只改内存的话，存档里仍留着被撤回的消息，下次 `/load` 或重启
   * 就“复活”（TUI 时代踩过这个坑）。所以先确认有存档可写，再动消息 —— 避免
   * “改了一半、存不下去”。
   */
  async rollback(sessionId: string, index: number): Promise<SessionRollbackResult> {
    const session = this.require(sessionId);
    const store = await this.storeFor(session.workspaceId);
    if (!store)
      throw codedError("no-store", `no session store for workspace ${session.workspaceId}`);

    const messages = session.agent.messages;
    if (!Number.isInteger(index) || index < 0 || index >= messages.length) {
      throw codedError("bad-index", `index ${index} is out of range (0..${messages.length - 1})`);
    }

    const removedMessages = messages.splice(index);
    session.agent.messages = messages;
    await store.write(this.recordOf(session, messages));
    await store.setLastSession(session.id);

    // 预填输入框用：被删掉的第一条用户消息（原文，不做任何“备注剥离”）
    const firstUser = removedMessages.find(
      (message) => (message as { role?: unknown } | null)?.role === "user",
    ) as { content?: unknown } | undefined;

    return {
      removed: removedMessages.length,
      prompt: typeof firstUser?.content === "string" ? firstUser.content : "",
      messages: [...messages],
    };
  }

  /** 订阅事件；返回取消订阅的函数（连接断开时调用） */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    return this.hub.subscribe(listener);
  }

  /**
   * 发一条**对话内**通知（绑会话）。
   *
   * 会话不存在就直接抛：发一条没有归属的通知，客户端既贴不到会话上、也没法清理。
   * 全局通知不归这里管 —— 那是服务本身的事，由组装根直接往 hub 里发。
   */
  notice(sessionId: string, notice: NoticePayload): void {
    const session = this.require(sessionId);
    this.hub.publish({
      event: SESSION_EVENTS.notice,
      sessionId: session.id,
      ...notice,
    });
  }

  async create(input: SessionCreateInput): Promise<SessionCreateResult> {
    const store = await this.storeFor(input.workspaceId);

    /**
     * id 从哪来，决定了撞车怎么办 —— 这是两件不同的事。
     *
     *   - **客户端指定**（`/load`、续接）：撞了就报 `session-exists`。那是不静默顶掉
     *     正在跑的会话的那条规矩，同时也防止覆盖同名存档。
     *   - **服务端分配**：`nextSessionId()` 只精确到秒，同一秒里开两段一定会撞 ——
     *     启动后立刻 `/new`、或两个前端同时开会话，都是常见路径。撞了就该换一个：
     *     分配器找空位是**本职**，不是错误。把它报成错误等于把实现细节漏给用户
     *     （现象是「打不开新会话」，而且是偶发的、看时辰的）。
     */
    let sessionId: string;
    let record: Awaited<ReturnType<SessionStore["read"]>> = null;
    /** 续接时存档自己的「最后一次活动」（没有存档 / 清单里没有 → `undefined`） */
    let archivedUpdatedAt: string | undefined;
    if (input.sessionId) {
      sessionId = input.sessionId;
      if (this.sessions.has(sessionId)) {
        throw codedError("session-exists", `session already exists: ${sessionId}`);
      }
      // 续接：这个 id 在工作区存档里有记录，就把它的消息装进 Agent。
      // 服务端是唯一真相源 —— 客户端只给 id，不搬消息。
      record = store ? await store.read(sessionId) : null;
      // 这个时间只住在 store 的清单里（`SessionEntry.updatedAt`，写入那一刻记下的），
      // 正文（`SessionRecord`）里没有它 —— 所以只能问 store，别在这里算一个「现在」，
      // 也别去拿文件系统时间凑：那都是给同一件事实造第二份真相。
      // `store.entry()` 是 `list()` 的单条版本：只读那一条清单（别再 `list().find()` ——
      // 那是为了一个字段扫一遍整个会话目录，存档越多「点开会话」越慢）。
      const entry = record && store ? await store.entry(sessionId) : null;
      archivedUpdatedAt = entry?.updatedAt || undefined;
    } else {
      sessionId = await this.freeSessionId(this.nextSessionId(), store);
    }
    // Agent 也跟着存档走：`/load` 只拿到一个 id（列表不解析存档内容），
    // 存档里记着这段会话是哪个 Agent 跑的 —— 不传就沿用它，而不是默默换成 `default`。
    const agentId = input.agentId || record?.agentId || "default";
    /**
     * 装配钩子里要用到**会话对象**（提问发在它的 id 上、回答认领它的问题表），而这一刻
     * 会话还没造完、更没进 `sessions` 表。用一个稍后赋值的局部变量把它带进闭包 —— 与上面
     * 那几个用局部 `sessionId` 的钩子是同一个理由：装配先于注册，而这些钩子只会在会话
     * 真正跑起来之后被调到（那时 `session` 早已就位）。
     */
    let session: LiveSession;
    const agent = await this.createAgent({
      workspaceId: input.workspaceId,
      path: input.path,
      agentId,
      // 续接时把存档里的**会话级模型覆盖**带回来（三级解析最内层的那一级）：
      // 覆盖是本层的财产，解析在 SDK（本层不重复一遍顺序）。参数与它同级，一起带回来
      // —— 只带模型不带参数，参数就会退回 Agent 定义那份（配给另一个模型的）。
      ...(record?.modelId !== undefined ? { modelId: record.modelId } : {}),
      ...(record?.modelParams !== undefined ? { modelParams: record.modelParams } : {}),
      // 交接/迁移中让护栏让行：此刻这段会话还没注册（返回 false），正好
      isHandoffBusy: () => this.sessions.get(sessionId)?.settleDeferred ?? false,
      // 自动迁移：SDK 的插件在**一轮内部**触发，落地动作必须回到会话层
      autoMigrate: (mode) => this.autoMigrate(sessionId, mode),
      // 谁来写交接文档由用户在 `session.question` 里定（会话层向客户端提问并等回答）
      resolveMode: (info) => this.askHandoffMode(session, info),
    });
    if (record && record.messages.length > 0) agent.messages = [...record.messages];

    session = {
      id: sessionId,
      workspaceId: input.workspaceId,
      path: input.path,
      agentId,
      agent,
      turnId: 0,
      phase: new PhaseTracker(),
      turnFailed: null,
      turnSettled: true,
      settleDeferred: false,
      persistOnSettle: false,
      autoPersist: input.persist !== false,
      keepAlive: true,
      // 续接已有存档时把它自己的名字与模型覆盖带回来；新会话三个都空
      ...(record?.title !== undefined ? { title: record.title } : {}),
      ...(record?.modelId !== undefined ? { modelId: record.modelId } : {}),
      ...(record?.modelParams !== undefined ? { modelParams: record.modelParams } : {}),
      /**
       * 「最后一次活动」= **谁改动了这段会话**（落盘那一刻，见 `recordOf`），
       * 不是 **谁看了一眼**。
       *
       * 为什么要说这句：`attach` / `/load` 是复用这条路来续接存档的，而「打开一段历史
       * 会话」不是一次活动 —— 存档里那个时间说的是「用户最后一次跟它说话是什么时候」。
       * 无条件写「现在」的后果是两头都中：侧栏里点开一段老会话，它就顶到列表最前、
       * 时间显示成「现在」；紧接着下一次落盘还会把这个错时间写进存档，「最后一次活动」
       * 这个事实就被一次「查看」永久污染了。
       *
       * 怎么做：与上面三个字段同一个写法 —— **有（续接了存档）就带回来**，只有真的新建
       * 的会话才用「现在」。真正的一次活动仍然由 `recordOf` 刷新，那条不用动。
       *
       * 为什么写错不会红：打开会话、看列表、看时间这三个界面读的是同一个值（刚被刷成
       * 「现在」的那个），三处**自洽地显示同一个错值**，谁也不跟谁矛盾，所以只能靠用例
       * 锁住（见 `SessionManager.test.ts` 的「续接不是一次活动」）。
       */
      ...(archivedUpdatedAt !== undefined
        ? { updatedAt: archivedUpdatedAt }
        : { updatedAt: new Date().toISOString() }),
      holders: new Set(),
      reclaimCancel: null,
      reclaimOnSettle: false,
      handoff: null,
      subAgents: new Map(),
      subAgentSeq: 0,
      subAgentIdSeq: 0,
      questions: new Map(),
      questionSeq: 0,
      detach: () => {},
    };
    session.detach = this.attachEvents(session);
    this.sessions.set(sessionId, session);
    return { sessionId, agentId };
  }

  /**
   * 从 `base` 开始找一个没被占用的会话 id（`base`、`base_2`、`base_3`…）。
   *
   * 「被占用」有两种：内存里活着，或盘上已有同名存档（覆盖存档比撞内存更坏 —— 那是
   * 悄悄毁掉别人一段对话）。所以两个都要看。
   */
  private async freeSessionId(
    base: string,
    store: SessionStore | null | undefined,
  ): Promise<string> {
    let candidate = base;
    for (let suffix = 2; ; suffix++) {
      const alive = this.sessions.has(candidate);
      const archived = store ? (await store.read(candidate)) !== null : false;
      if (!alive && !archived) return candidate;
      candidate = `${base}_${suffix}`;
    }
  }

  /**
   * 接上一段**已经存在**的会话 —— 活着就接上，盘上有就从存档装回来。
   *
   * ## 为什么不能拿 `create` 顶替
   *
   * 会话的存活期比客户端连接长：客户端退出（关终端、断网）只退订阅，会话连同 Agent 与
   * MCP 连接仍在服务端活着。`create` 对活着的 id 是**拒绝**（不静默顶掉正在跑的会话，
   * 那条语义仍然成立），于是「接着上次」这条最常用的启动路径会直接撞在 `session-exists`
   * 上 —— 用户看到的是「打不开自己上一轮会话」。把内部不一致泄露成使用障碍，是这类错误
   * 最不该有的形态。
   *
   * 所以两个动作分开：`create` = 我要一段**新的**；`attach` = 我要这段**已有的**。
   * 「已有的」判断必须由服务端做：客户端只持有 id，它无法知道那段会话此刻在不在内存里、
   * 还是只在盘上。
   *
   * 接上一个活着的会话是安全的：客户端拿到 id 之后本来就要拉一份快照，事件是按连接分发
   * 的，两边看到的是同一份真相。两个客户端可以**同时看**，但不能**同时发言**：一轮还在跑
   * 时 `send` 直接报 `turn-busy`（理由见 `send` 的注释）。
   *
   * 既不在内存、又不在盘上 → `session-missing`：什么都不接，绝不悄悄开一段空的。
   */
  async attach(input: SessionAttachInput): Promise<SessionAttachResult> {
    const live = this.sessions.get(input.sessionId);
    if (live) return { sessionId: live.id, agentId: live.agentId };

    const store = await this.storeFor(input.workspaceId);
    const record = store ? await store.read(input.sessionId) : null;
    if (!record) {
      throw codedError("session-missing", `no such session: ${input.sessionId}`);
    }
    // 走 create 的装配路径：它会按存档里的 agentId 装配 Agent 并把消息装进去
    return await this.create({ ...input, sessionId: input.sessionId });
  }

  /**
   * 开始一轮：立刻返回 `turnId`，结果与过程全部走事件。
   *
   * 不 `await agent.send()` 的原因见协议文件头：一轮可能跑几分钟，等它回来客户端
   * 就没东西可渲染。失败也走事件（`turn.end` 带 `ok:false`），不靠这一个 promise。
   */
  send(sessionId: string, content: MessageContent): { turnId: number } {
    const session = this.require(sessionId);

    // 交接/迁移进行中：再起一轮会同用一个 `turnId`，事件没任何办法归轮。
    //
    // 这条**必须排在下面那条之前**：交接期间 `turnSettled` 也是 false，顺序反了的话
    // 交接那一次会被报成 `turn-busy`，客户端就拿不到「正在交接」这个更准的原因
    // （两者对客户端是不同的事：前者等一会儿再发，后者可能要等一整份交接文档）。
    if (session.settleDeferred) {
      throw codedError("handoff-in-flight", `session ${sessionId} is handing off`);
    }

    // 已有一轮在跑就拒绝。
    //
    // 为什么必须挡：事件是靠 `session.turnId` 的**当前值**归轮的 —— 增量与收尾都在发出
    // 的那一刻才读它，而 `beginTurn` 直接 `turnId += 1`。真放第二轮进来，第一轮后半段的
    // 增量就会被贴上第二轮的编号，两条链路的 `turn.end` 也各自对不上，界面互相串轮。
    // 这不是理论风险：`attach` 之后「同一段会话被两个客户端看」是常态（客户端退出后会话
    // 仍活着，另一个客户端接上；或两个终端同看），谁多点一下就是两轮并行。
    //
    // 为什么拒绝而不是排队：`send` 的语义是「**现在**开始一轮」——它的返回值就是这一轮的
    // 编号，调用方拿到它就会用这个编号过滤事件。排队会让语义变成「稍后」，调用方手里的
    // 编号与它此刻看到的状态不再对应；该不该等、等多久，是客户端的决定，服务端不替它做。
    if (this.isTurnInFlight(session)) {
      throw codedError("turn-busy", `session ${sessionId} already has a turn in flight`);
    }

    this.beginTurn(session);
    // 这一轮会产生对话内容：收尾时写进存档（`turn.end` 之前）
    session.persistOnSettle = true;

    void session.agent.send(content).catch((error: any) => {
      // `send()` 自己抛错（不是事件通道里的 error）：当作本轮失败收尾
      this.failTurn(session, {
        code: error?.code ?? "internal",
        message: error?.message ?? String(error),
      });
    });
    return { turnId: session.turnId };
  }

  /**
   * 回答服务端提出的问题（`session.answer`）。
   *
   * 三种结果各有含义，不能混：
   *   - 会话不存在 → `unknown-session`：调用方拿错了 id；
   *   - 问题不在表里 → `{ answered: false }`：**不是参数错，是来晚了**（超时 / 已经答过 /
   *     会话已收）。客户端把选择器收掉就好，不重试、不报错 —— 把它报成错误，用户会在
   *     “操作失败”里卡一辈子，而实际上服务端早就自己继续跑了；
   *   - 认领成功 → `{ answered: true }`，`askHandoffMode` 那边随之继续。
   */
  answer(sessionId: string, questionId: string, choice: string | null): SessionAnswerResult {
    const session = this.require(sessionId);
    const pending = session.questions.get(questionId);
    if (!pending) return { answered: false };
    // 先摘表再 resolve：同一个 questionId 的第二次回答必须落进「来晚了」那条分支，
    // 而不是把同一个问题答两遍（第二遍的 promise 已经没人等了）
    session.questions.delete(questionId);
    pending.resolve(choice);
    return { answered: true };
  }

  cancel(sessionId: string): SessionCancelResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { cancelled: false };
    // 先掐交接：它挂在模型请求/工具上，服务自己持有的那个句柄是唯一入口；
    // `agent.abort()` 负责立即断正在流的那一轮（两者都要，顺序与 CLI 一致）
    session.handoff?.abort();
    session.agent.abort();
    return { cancelled: true };
  }

  close(sessionId: string): SessionCloseResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { closed: false };
    // 会话没了，倒计时也就没有意义：留着它就是一条会在若干秒后向已删会话伸手的回调
    this.cancelReclaim(session);
    session.handoff?.abort();
    // 会话已经收了：挂着的提问不会再有答案 —— 放行它，别让提问方白等到超时
    this.releaseQuestions(session);
    session.detach();
    // 会话已经不存在了：不留任何指向它的残留（子 Agent 里的实例也跟着退场）
    this.clearSubAgents(session);
    this.sessions.delete(sessionId);
    return { closed: true };
  }

  /**
   * 登记一个持有者（某条连接说「我要这一段」）。
   *
   * 为什么需要客户端说两次（`create`/`attach` 加这一句）：`attach` 的返回值只说「接上了」，
   * 而「我要一直看着它」是另一个事实 —— 传输层知道那条连接什么时候断，会话层不知道。
   * 由**处理层**（`sessionHandlers`）在 `attach`/`create` 成功后登记，并挂上
   * `connection.onClose(→ dropHolder)`：两个方向都不需要客户端额外发帧。
   */
  registerHolder(sessionId: string, holder: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return; // 会话已经不在了：没什么可保的
    session.holders.add(holder);
    // 有人接回来了：宽限期作废（不管是还没到点，还是已经到点但这一轮还在跑）
    this.cancelReclaim(session);
    session.reclaimOnSettle = false;
  }

  /** 摘掉一个持有者（那条连接断了）；最后一个走了就开始计时 */
  dropHolder(sessionId: string, holder: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return; // 已经被别的路径收掉了：目的已经达成
    session.holders.delete(holder);
    this.scheduleReclaim(session);
  }

  /**
   * 保活区开关（`session.keepAlive.set`）：客户端说「我还要」或「我不看了」。
   *
   * 它只改**声明**，不直接决定回收：两个方向都交给同一条判定
   * （`scheduleReclaim`）。`on:false` 且空闲时宽限期取 0 → 当场回收；一轮还在跑时
   * 不动它（用户可能刚切走又想回来，而正在跑的一轮中途被收掉比多占几兆内存严重），
   * 那一轮收尾时再按同一条判定收（见 `settleTurn`）。
   */
  keepAliveSet(sessionId: string, on: boolean): SessionKeepAliveSetResult {
    const session = this.require(sessionId);
    session.keepAlive = on;
    this.scheduleReclaim(session);
    return { sessionId, keepAlive: on };
  }

  /** 收摊：摘掉所有事件、清空会话（守护进程退出时调用） */
  dispose(): void {
    for (const session of this.sessions.values()) {
      this.cancelReclaim(session);
      session.handoff?.abort();
      this.releaseQuestions(session);
      session.detach();
    }
    this.sessions.clear();
    if (this.ownsHub) this.hub.clear();
  }

  // ==================================================================
  // SDK 事件 → 协议事件
  // ==================================================================

  private attachEvents(session: LiveSession): () => void {
    const { events } = session.agent;

    const onOpen = () => {
      session.phase.opened();
      this.emitPhase(session);
    };

    /**
     * 正文 / 推理增量：**第二个参数才是 chunk**。
     *
     * core 的 `Agent.parseStreamData` 发的是 `emit("chunk-parsed", receiver, chunk)`（两个
     * 参数）：第一个是那条正在拼的 assistant 消息，第二个才是这一片原始 chunk。这里曾经写成
     * `(receiver) => deltaOf(receiver?.chunk ?? receiver)` —— 拿到的永远是**消息本身**，
     * `choices[0].delta` 恒空，于是主 Agent 与子 Agent 的正文增量**一条都推不出去**（界面只能
     * 等 `turn.end` 之后靠快照一次性刷出来）；唯一漏过去的是流末那片（core 把 `usage` 挂在消息
     * 上，`completionOf(消息)` 恰好读得到），也正是它让这个 bug 看起来像“偶尔掉了”。
     *
     * 单测当时没抓住：假 Agent 是按**单参**形状 fire 的，恰好喂饱了 `receiver?.chunk ?? receiver`
     * 那条“两种形状都认”的兼容写法。假件的形状必须照拄真件的形状，否则它测的是想象。
     */
    const onChunk = (_receiver: unknown, chunk: any) => {
      session.phase.delta(chunk);
      this.emitPhase(session);

      const { text, reasoning } = deltaOf(chunk);
      const completionTokens = completionOf(chunk);
      // 只带 usage 的收尾 chunk 也要出去：客户端靠它校准速率（否则 tok/s 一直是估算值）
      if (!text && !reasoning && completionTokens === undefined) return;
      this.emit({
        event: SESSION_EVENTS.delta,
        sessionId: session.id,
        turnId: session.turnId,
        text,
        reasoning,
        ...(completionTokens === undefined ? {} : { usage: { completionTokens } }),
      });
    };

    const onParsed = (receiver: any) => {
      session.phase.streamEnded(receiver?.message ?? receiver);
      this.emitPhase(session);
    };

    // 工具跑完一个就报一次：并行时先完成的那个从「等待」里消失，
    // 否则界面会一直念着已经结束的工具名
    const onToolCallEnd = () => this.emitPhase(session);

    const onError = (error: any) => {
      this.failTurn(session, {
        code: error?.code ?? "internal",
        message: error?.message ?? String(error),
      });
    };

    const onFinally = () => {
      void this.settleTurn(session);
    };

    /**
     * 一个子 Agent 开始了（core 的 `AgentTool` / `AgentToolLazy` 在委派边界广播）。
     *
     * 两个计数器分开：`index` 是**展示序号**（本轮内从 1 起，栏目标签直接印它），
     * `subAgentId` 是**稳定标识**（客户端拿它当选中态与 React key）。分开的理由是它们
     * 回答不同的问题 —— 「用户看到的第几栏」与「是哪一次委派」，合并成一个数字就会变成
     * 「id 带上了展示含义」，改一次展示就得动一次 id。两者都只在**本轮**内唯一：一轮
     * 结束时列表与计数器一起归零（见 `clearSubAgents`），而客户端也在 `turn.end` 上
     * 清自己的列表，所以下一轮的 `sub-1` 不会被任何遗留的选中态认领。
     *
     * 子 Agent 自己的事件流只挂两条，且 **`chunk-parsed` 绝不碰 `session.phase`**：
     * 此刻主 Agent 正在等发起委派的那个工具（如 `call_skill_sub_agent`）返回，阶段
     * 应停在「等待 xxx 返回」；子 Agent 的思考 / 输出是工具内部的事，拿它的 delta 去改
     * 主阶段会让界面变成「输出中」，正好盖掉用户最需要知道的那句话。
     *
     * 这里挂的监听**不用**在 `sub-agent-end` 撤销：子 Agent 实例是「每次委派新建」的
     * （core 的 `AgentTool.exec()` 里 `new Agent(...)`、`AgentToolLazy.exec()` 里
     * `buildAgent(...)`），随本次 run 结束回收，监听器跟着走 —— 与 CLI 侧同一个理由。
     */
    const onSubStart = ({ subAgent }: { subAgent: SubAgentLike }) => {
      const entry: SubAgentEntry = {
        id: `sub-${++session.subAgentIdSeq}`,
        index: ++session.subAgentSeq,
        agent: subAgent,
        status: "running",
      };
      session.subAgents.set(entry.id, entry);
      this.emit({
        event: SESSION_EVENTS.subAgentStarted,
        sessionId: session.id,
        turnId: session.turnId,
        subAgentId: entry.id,
        index: entry.index,
      });

      /** 子 Agent 的正文增量：只带 `subAgentId` 推给客户端，不推进主阶段（理由见上） */
      const onSubChunk = (_receiver: unknown, chunk: any) => {
        // 同上：第二个参数才是 chunk（`chunk-parsed` 是两参，见 `onChunk`）
        const { text, reasoning } = deltaOf(chunk);
        if (!text && !reasoning) return;
        this.emit({
          event: SESSION_EVENTS.delta,
          sessionId: session.id,
          turnId: session.turnId,
          subAgentId: entry.id,
          text,
          reasoning,
        });
      };

      /**
       * 子 Agent 出错：标签标 `failed`，错误原文送进通知栏。
       *
       * 先填字段再发事件：之后 SDK 还会发 `sub-agent-end`，而那条路径只在状态仍是
       * `running` 时才置 `done` —— **`failed` 不被 `done` 覆盖**的安全网就挂在那里。
       */
      const onSubError = (error: any) => {
        entry.status = "failed";
        this.notice(session.id, {
          level: "error",
          code: SESSION_NOTICE_CODES.subAgentFailed,
          params: { index: entry.index, message: error?.message ?? String(error) },
        });
        this.emitSubAgentEnded(session, entry);
      };

      subAgent.events.on("chunk-parsed", onSubChunk);
      subAgent.events.on("error", onSubError);
    };

    const onSubEnd = ({ subAgent }: { subAgent: SubAgentLike }) => {
      const entry = subAgentEntryOf(session, subAgent);
      // 只把「还在跑」的置为完成：失败已由 `error` 监听标成 failed，不能被这里覆盖
      if (!entry || entry.status !== "running") return;
      entry.status = "done";
      this.emitSubAgentEnded(session, entry);
    };

    events.on("open", onOpen);
    events.on("chunk-parsed", onChunk);
    events.on("parsed", onParsed);
    events.on("tool-call-end", onToolCallEnd);
    events.on("sub-agent-start", onSubStart);
    events.on("sub-agent-end", onSubEnd);
    events.on("error", onError);
    events.on("finally", onFinally);

    return () => {
      events.off("open", onOpen);
      events.off("chunk-parsed", onChunk);
      events.off("parsed", onParsed);
      events.off("tool-call-end", onToolCallEnd);
      events.off("sub-agent-start", onSubStart);
      events.off("sub-agent-end", onSubEnd);
      events.off("error", onError);
      events.off("finally", onFinally);
    };
  }

  /**
   * 把一个子 Agent 的终态发给客户端。
   *
   * 状态取**条目上的那个**（调用方在发之前已经写好）：`running` 走不到这里 ——
   * 收尾只有两处（`error` 置 failed、`sub-agent-end` 仅在 running 时置 done）。
   * 只信一处状态，事件与快照才不会一个说 done、一个说 failed。
   */
  private emitSubAgentEnded(session: LiveSession, entry: SubAgentEntry): void {
    const status = entry.status === "failed" ? "failed" : "done";
    this.emit({
      event: SESSION_EVENTS.subAgentEnded,
      sessionId: session.id,
      turnId: session.turnId,
      subAgentId: entry.id,
      status,
    });
  }

  /**
   * 清空子 Agent 列表与展示序号。
   *
   * 为什么要清：子 Agent 是「内循环里工具调用的产物」，**只活在当前一轮**。一轮结束后
   * 主 Agent 已给出最终答案，子 Agent 只剩历史价值；留着会让栏目标签停在一段已经过去
   * 的对话上，而且下一轮的第一个子 Agent 会顶着上一轮的序号出现。`reload` / `setAgent`
   * （换了 Agent）、`adopt`（换了会话 id：迁移 / 另存为）、`close` 同理：旧条目上的实例
   * 已不再被任何东西引用。
   *
   * 两个计数器只有一个归零：
   *   - **展示序号归零**：下一轮又是「子AGENT1」（用户看到的是「这一轮的第三个」）；
   *   - **id 序号不归零**：`subAgentId` 是客户端选中态与 React key 的锚点，让它跨轮复用
   *     得到同一个值，就会出现「上一轮残留的选中 id 突然接到新一轮的 sub-1 上」。id 不带
   *     展示含义，多递增几次没有成本。
   */
  private clearSubAgents(session: LiveSession): void {
    session.subAgents.clear();
    session.subAgentSeq = 0;
  }

  /** 失败即收尾（`error` 之后 SDK 仍会发 `finally`，靠 `turnSettled` 去重） */
  private failTurn(session: LiveSession, failure: { code: string; message: string }): void {
    session.turnFailed = failure;
    void this.settleTurn(session);
  }

  /**
   * 把会话写进存档（并更新「本工作区上一轮会话」指针）。
   *
   * 两条规矩与旧版 `ConversationPersistPlugin` 逐字对齐：
   *   - **尚无用户消息就不写**：否则 `/load` 列表里会出现一串空会话；
   *   - 写失败不抛（那是收尾路径）：转成 `persistFailed` 通知给用户，因为「以为存了、
   *     其实没存」是最坏的失败形态——用户会在下次 `ai` 发现对话不翼而飞。
   */
  private async writeSession(session: LiveSession): Promise<void> {
    // 一次性会话（`persist:false`）：这一轮属于某次脚本调用，不在存档里留痕，也不挪
    // 「上一轮会话」指针 —— 否则下次 `ai` 会续接到一条管道结果上。
    if (!session.autoPersist) return;
    const messages = session.agent.messages as Array<{ role?: unknown }>;
    if (!messages.some((message) => message?.role === "user")) return;
    const store = await this.storeFor(session.workspaceId);
    // 没注入存档：这条路径本来就不支持落盘（与 `save` 的 `no-store` 同口径，
    // 但这里是收尾路径，不报错）
    if (!store) return;
    try {
      await store.write(this.recordOf(session, messages));
      await store.setLastSession(session.id);
    } catch (error: any) {
      this.notice(session.id, {
        level: "error",
        code: SESSION_NOTICE_CODES.persistFailed,
        params: { error: error?.message ?? String(error) },
      });
    }
  }

  /** 收尾时按标记落盘（为什么只有 `send` / `handoff` 置位，见 `persistOnSettle`） */
  private async writeOnSettle(session: LiveSession): Promise<void> {
    if (!session.persistOnSettle) return;
    session.persistOnSettle = false;
    await this.writeSession(session);
  }

  /**
   * 收尾一轮。
   *
   * 五步的顺序是定死的，每一步都有人依赖它：
   *
   *   1. **先落盘**（带用户消息的回合）：`turn.end` 一到，客户端就认为这一轮结束、内容
   *      已经定型；此时存档里还没有它，退出 TUI 再进来就「什么都没发生」。旧版的
   *      `ConversationPersistPlugin` 干的就是这一步（每轮 `onInnerLoopEnd`），搬到服务端
   *      之后一度漏了——于是「聊完退出、再 `ai` 是新会话」。
   *   2. 放行挂着的提问：不会再有答案了。
   *   3. 清子 Agent 栏目：它只活当前一轮。
   *   4. 阶段归零并广播：界面据此把 spinner 收起来。
   *   5. 发 `turn.end`。
   *
   * `turnSettled` 在入口就置位（重复调用直接返回）：落盘是异步的，不先置位就会写两遍。
   * 代价是「已置位、`turn.end` 未发」之间有个微窗口，此时再 `send`/`migrate` 不会被拦——
   * 但客户端要拿到 `turn.end` 才会发下一轮，这个窗口在协议上摸不到。
   */
  private async settleTurn(session: LiveSession): Promise<void> {
    if (session.turnSettled) return;
    // 交接/迁移进行中：这一轮的收尾归方法自己的 promise（见 `settleDeferred`）
    if (session.settleDeferred) return;
    session.turnSettled = true;
    // 本地记住「这一轮是不是客户端发起的正常回合」：`writeOnSettle` 会把标记消耗掉，
    // 而下面那个回收判定还要用它（`migrate` 的中场收尾不能触发回收）。
    const clientTurn = session.persistOnSettle;

    // 1) 落盘：`turn.end` 之前写完，存档与事件里的「这一轮」才是同一个东西
    await this.writeOnSettle(session);

    // 这一轮已经收尾：它提的问不会再有答案了（客户端在等的是 `turn.end`，不是这个选择器）。
    // 不在这里兜底放行，提问方就要挂到超时 —— 而它一直占着闸门，后面的 `send` 全报
    // `turn-busy`。放在发 `turn.end` 之前：两个事件的先后与「收尾已定」一致。
    this.releaseQuestions(session);

    // 一轮结束：子 Agent 列表跟着消失（只活当前一轮，理由见 `clearSubAgents`）。
    // 清在 `turn.end` 之前：客户端收到收尾事件时再去要子 Agent 快照，拿不到才是对的。
    this.clearSubAgents(session);

    session.phase.reset();
    this.emitPhase(session);
    this.emit({
      event: SESSION_EVENTS.turnEnd,
      sessionId: session.id,
      turnId: session.turnId,
      ok: session.turnFailed === null,
      ...(session.turnFailed ? { error: session.turnFailed } : {}),
    });

    // 6) 回收：这一轮收完，重判一次「还有没有人要它」（存档已在第 1 步写好，再点回来
    //    `attach` 从盘上装回来）。放在 `turn.end` **之后**：客户端拿到的最后一条事件仍然
    //    是「这一轮结束了」，而不是一个已经被摘掉的会话。
    //    只对客户端发起的正常回合判定 —— `migrate` 的中场收尾紧接着要换 id。
    if (clientTurn) {
      if (session.reclaimOnSettle) {
        // 宽限期在那一轮还在跑的时候就到了：已经延后过一次，现在收尾就收
        this.close(session.id);
      } else {
        // 同一条判定再算一次：`keepAlive:false` 的宽限期是 0，等同于「当场收」
        this.scheduleReclaim(session);
      }
    }

    // 7) 自动标题（只在第一轮、只在还没有名字时；**不 await**：`turn.end` 已经发出去了，
    //    标题是之后的事 —— 卡的是一行展示用的名字，一行都不能拖住下一轮对话）。
    //
    //    放在回收判定**之后**：回收可能当场关掉会话（`keepAlive:false`），那时就不必
    //    为了一个已经退场的会话再发一次模型请求（`autoTitle` 里也会再确认一次）。
    if (session.turnId === 1) void this.autoTitle(session);
  }

  /**
   * 自动给这一段会话起名（异步、可失败、失败静默）。
   *
   * ## 什么时候做
   *
   * 只在**第一轮**之后（`turnId === 1`）做，于是「同一段会话只生成一次」是这条判断的
   * 副产品，而不是另一个计数器：`turnId` 在同一段会话内只增不复位，一次会话里只会等于 1
   * 一次。续接的会话 `turnId` 从 0 重新开始，于是「从没起过名就接了回来」会再试一次
   * —— 那不算重试：它第一轮时服务端可能被回收了，而此刻用户手上确实需要个名字。
   * 失败也**不重试**：下一轮 `turnId` 已经不是 1。
   *
   * ## 为什么不阻塞、不报告
   *
   * 起名不是用户要求的事：失败（无 Key / 网络 / 端点报错 / 超时）就该像没发生过 ——
   * 推一条「起名失败」的通知只会让人以为出了故障，而且无人可据此做任何事。所以异常在
   * 这里吞掉，标题留空（客户端依旧用首条消息兑底）。
   *
   * ## 绝不覆盖用户的名字
   *
   * 进门前看一次、拿到结果再看一次（中间隔着一次模型请求，用户完全可能在这几秒里
   * `session.rename`）：名字一旦有了，就是用户的。
   */
  private async autoTitle(session: LiveSession): Promise<void> {
    const generate = this.autoTitleFn;
    if (!generate) return;
    if (isTitled(session)) return;
    // 已在收尾的回收里退场：存档已定稿，不再为一个不存在的会话发请求
    if (this.sessions.get(session.id) !== session) return;

    // 取消信号两边都接：超时（本层）与队列里的 `AbortController` 让那次 HTTP 请求真的断掉，
    // 而不是“跑完之后再假装没发生”
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.autoTitleTimeoutMs);
    let title: string | null;
    try {
      title = await generate({
        // 只有本层知道「这一段生效的模型是哪个」（三级解析的副产品，见 `modelIdOf`）
        modelId: modelIdOf(session.agent),
        messages: [...session.agent.messages],
        signal: controller.signal,
      });
    } catch {
      // 无 key / 网络 / 超时 / 端点报错：静默留空。不重试、不推通知（理由见方法注释）
      return;
    } finally {
      clearTimeout(timer);
    }
    if (!title) return;

    // await 之后世界可能已经变了（会话关了 / 被回收了 / 用户在这几秒里手改了名字）
    if (this.sessions.get(session.id) !== session) return;
    if (isTitled(session)) return;

    session.title = title;
    // 走现有的存档写入路径：标题是会话存档里的一份事实，另开一条写档路径就是第二处
    // 「存档里都有什么」（`recordOf` 漏一个字段就是一类数据丢失）
    await this.writeSession(session);
    this.emit({ event: SESSION_EVENTS.titleChanged, sessionId: session.id, title });
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 对外报的阶段要**再筛一遍**「谁还在跑」。
   *
   * 状态机只知道「这一轮都调了哪些工具」，而工具是并发跑的：结果消息一到终态，
   * 那个名字就该从等待里消失。不做这一步，界面会一直念着已经跑完的工具。
   */
  private visiblePhase(session: LiveSession): PhaseInfo | null {
    const phase = session.phase.phase;
    if (!phase || phase.kind !== "tool-waiting" || !phase.calls) return phase;
    const pending = pendingToolCalls(phase.calls, session.agent.messages as any[]);
    return { ...phase, tools: pending.map((call) => call.name) };
  }

  private emitPhase(session: LiveSession): void {
    this.emit({
      event: SESSION_EVENTS.phase,
      sessionId: session.id,
      turnId: session.turnId,
      phase: this.visiblePhase(session),
    });
  }

  private emit(event: ServerEvent): void {
    this.hub.publish(event);
  }

  private require(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw codedError("unknown-session", `unknown session: ${sessionId}`);
    return session;
  }

  /**
   * 开一轮：报新 `turnId`、清失败标记、进入 `connecting`。
   *
   * `send` 与 `handoff`/`migrate` 共用：交接回合也要算一轮，事件才能归轮。
   */
  private beginTurn(session: LiveSession): void {
    session.turnId += 1;
    session.turnFailed = null;
    session.turnSettled = false;
    session.phase.connecting();
    this.emitPhase(session);
  }

  /**
   * 是否已经有一轮在跑（`beginTurn` 置 false、`settleTurn` 置 true，新建的会话是 true）。
   *
   * 只此一处判断：`send`、`handoff`/`migrate`（经 `requireIdle`）挡的是**同一个状态**，
   * 各写一份 `!session.turnSettled` 迟早会漂成两套口径（比如哪天这一轮多了一种「未收尾」
   * 的形态，只改到其中一处）。文案与 code 仍按各自场景给：`turn-busy` / `turn-in-flight`。
   */
  private isTurnInFlight(session: LiveSession): boolean {
    return !session.turnSettled;
  }

  /**
   * 存档的形状**只有这一处定义**。
   *
   * 所有写档路径（`save` / `saveAs` / 每轮收尾 / 交接前归档 / 迁移换 id / 撤回）都从这里
   * 取，漏一个字段就是一类数据丢失：`title` 漏了 → 改过的名字下次写档被抹掉；`modelId`
   * 漏了 → 会话级模型覆盖在下一轮悄悄失效；`modelParams` 漏了 → 会话级参数在下一轮
   * 悄悄退回 Agent 定义那份（配给另一个模型的参数）。
   *
   * 顺手刷新 `updatedAt`：它是「最后一次活动」的唯一来源（列表排序与侧栏都读它）。
   * 写在这里而不是每个调用点，理由同上——一处定义。
   */
  private recordOf(
    session: LiveSession,
    messages: unknown[] = session.agent.messages,
    id: string = session.id,
  ): SessionRecord {
    session.updatedAt = new Date().toISOString();
    return {
      id,
      agentId: session.agentId,
      messages,
      ...(session.title !== undefined ? { title: session.title } : {}),
      ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
      ...(session.modelParams !== undefined ? { modelParams: session.modelParams } : {}),
    };
  }

  /**
   * 真的活着 = 「客户端说要」∧「有连接在看」。两个分开的真相源，判据只能取合取
   */
  private isHeld(session: LiveSession): boolean {
    return session.keepAlive && session.holders.size > 0;
  }

  /**
   * 进入回收倒计时（幂等）。
   *
   * 幂等是必须的：`turn.end` 每轮都会调一次，而重挂一次就等于把窗口一直往后推 ——
   * 一段没人要的会话会被它自己的历史拖住（聊了 100 轮就多留 100 个宽限期）。
   */
  private scheduleReclaim(session: LiveSession): void {
    if (this.isHeld(session)) {
      this.cancelReclaim(session);
      session.reclaimOnSettle = false;
      return;
    }
    // 客户端已经放手（`keepAlive:false`）→ 宽限期 0：空闲就当场收，跑着就跑完收
    if (!session.keepAlive) {
      this.reclaimNow(session);
      return;
    }
    if (session.reclaimCancel) return;
    session.reclaimCancel = this.schedule(this.sessionIdleTimeoutMs, () => {
      session.reclaimCancel = null;
      this.reclaimNow(session);
    });
  }

  /**
   * 到点（或宽限期为 0）时**再判一次**。
   *
   * 三条出口：期间有人接回来了（取消）/ 这一轮还在跑（等它收尾）/ 都不成立（收）。
   * 「到点再判一次」而不是「到点就收」不是防御性代码：一次断线重连里，`attach` 可能恰好
   * 紧接着计时器回调执行，只比它晚一个 tick —— 那时收掉会话，就是把“正在重连的客户端”
   * 关在门外。
   */
  private reclaimNow(session: LiveSession): void {
    this.cancelReclaim(session);
    if (this.isHeld(session)) return;
    if (this.isTurnInFlight(session) || session.settleDeferred) {
      // 一轮中途被收 = 那一轮的产出与存档一起丢（`detach()` 之后 `settleTurn` 不再跑）
      session.reclaimOnSettle = true;
      return;
    }
    this.close(session.id);
  }

  private cancelReclaim(session: LiveSession): void {
    const cancel = session.reclaimCancel;
    session.reclaimCancel = null;
    cancel?.();
  }

  /**
   * 交接的前提：这段会话得处于空闲、且真的有过对话。
   *
   * 两条都是「不满足就说不」而不是兜底：正在跑一轮时交接，两边的消息会同时往
   * `agent.messages` 里塞；空会话交接到的是模板消息，白烧一次模型调用。
   */
  private requireIdle(sessionId: string): LiveSession {
    const session = this.require(sessionId);
    if (this.isTurnInFlight(session)) {
      throw codedError("turn-in-flight", `session ${sessionId} has a turn in flight`);
    }
    const hasUserMessage = session.agent.messages.some(
      (message) => (message as { role?: unknown } | null)?.role === "user",
    );
    if (!hasUserMessage) {
      throw codedError("nothing-to-handoff", `session ${sessionId} has no user message yet`);
    }
    return session;
  }

  /**
   * 这段会话的交接服务（按需创建，一个会话一个实例）。
   *
   * 实例跨调用复用而不是每次新建：它持有 `busy` 与取消句柄（`session.cancel` 扳的就是
   * 它），SDK 侧按 Agent 注册的交接守卫也不该每次调用都重新挂一遍。
   */
  private handoffOf(session: LiveSession): SessionHandoff {
    if (!this.handoffOptions) {
      throw codedError("no-handoff", "handoff is not configured on this server");
    }
    session.handoff ??= new SessionHandoff({
      ...this.handoffOptions,
      workspacePath: session.path,
      notice: (notice) => this.notice(session.id, notice),
    });
    return session.handoff;
  }

  /**
   * 迁移后换 id：新会话立即落盘，再把活会话从旧键挪到新键。
   *
   * 顺序是「先写盘、再换键」：写失败时注册表还在旧 id 上，客户端收到的错误与它看到的
   * 状态才一致；反过来会出现「响应说迁移失败、会话其实已经改名」这种谁也修不了的状态。
   *
   * 换完发 `session.idChanged`：自动迁移发生在一轮内部，客户端没有响应可接，
   * 只能靠这条事件把后续请求与事件过滤切到新 id。
   */
  private async adopt(session: LiveSession, store: SessionStore): Promise<string> {
    const previousId = session.id;
    const nextId = this.nextSessionId();
    if (this.sessions.has(nextId)) {
      throw codedError("session-exists", `session already exists: ${nextId}`);
    }

    await store.write(this.recordOf(session, session.agent.messages, nextId));
    await store.setLastSession(nextId);

    this.sessions.delete(previousId);
    session.id = nextId;
    this.sessions.set(nextId, session);
    // 换 id = 这是新的一段会话：上一段里的子 Agent 不该跟着过来
    this.clearSubAgents(session);
    this.emit({ event: SESSION_EVENTS.idChanged, from: previousId, sessionId: nextId });
    return nextId;
  }

  /**
   * 交接/迁移失败（含用户取消）：记下本轮失败并让调用方决定怎么报。
   *
   * 取消不是失败：SDK 已经把会话回退到交接前（截掉交接回合、删掉半成品文档），
   * 这里只发一条 `turnAborted` 通知，把机器可判的 `handoff-aborted` 回给客户端。
   */
  private failHandoff(session: LiveSession, error: unknown): unknown {
    if (isHandoffAborted(error)) {
      this.notice(session.id, { level: "info", code: SESSION_NOTICE_CODES.turnAborted });
      session.turnFailed = { code: "aborted", message: "handoff cancelled" };
      return codedError("handoff-aborted", "handoff cancelled");
    }
    const failure = error as { code?: unknown; message?: unknown } | null;
    session.turnFailed = {
      code: typeof failure?.code === "string" ? failure.code : "internal",
      message: typeof failure?.message === "string" ? failure.message : String(error),
    };
    return error;
  }

  /** 存档工厂：没注入则续接与 save 都不可用 */
  private async storeFor(workspaceId: string): Promise<SessionStore | undefined> {
    return this.storeFactory ? await this.storeFactory(workspaceId) : undefined;
  }
}
