/**
 * 会话管理器 —— 服务端「活着的会话」的**注册表与生命周期**。
 *
 * ## 它管什么
 *
 * 按「谁拥有 `LiveSession` 的哪些字段」分成四块：
 *
 *   · `EventBridge`     —— SDK 事件 → 协议事件（含流式影子：工具调用 / 已推消息 / 子 Agent 栏目）
 *   · `Persistence`     —— 存档的形状与写盘（`recordOf` 是那一处的唯一定义）
 *   · `QuestionBroker`  —— 服务端向客户端提问与等回答
 *   · **本类**          —— 注册表（`sessions`）、持有者与回收、一轮的生命周期
 *                          （`beginTurn` / `settleTurn` / `failTurn`）、目录
 *                          （`list` / `last` / `archivedModelOf` / `rename` / `remove` /
 *                          `rollback`）、交接（`handoff` / `migrate` / `autoMigrate`）、
 *                          以及 `create` / `attach` / `close` / `dispose`
 *
 * 留下这五组东西，是因为它们说的是同一件事：**我正在管的那批会话**。而前三块各自都能
 * 在一段会话对象上独立工作（不需要注册表），所以它们是注入进来的协作者，不是继承。
 *
 * ## 不管什么
 *
 * 不管 Agent 怎么装配（配置、Scope、工具发现）——那由**组装根**通过 `createAgent`
 * 注入。也不碰文件：存档只经 `SessionStore` 端口（由 `Persistence` 持有），格式、位置、
 * 目录布局都由那个端口决定。这条边界是为了让本文件可测：给一个假 Agent 就能跑完整个
 * 事件流程，不需要网络。
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
 * ## 「活着」的判据：只有一条 —— **有持有者**
 *
 * 会话寿命规则就三句：
 *
 *   1. 连接上有持有者（`holders` 非空）→ 活着；
 *   2. 持有者全没了 → 等一段宽限期（`DEFAULT_SESSION_IDLE_TIMEOUT_MS`）后回收；
 *   3. `session.close` → 立刻回收（存档在每轮收尾已经写好，`attach` 装得回来）。
 *
 * `holders` 是**此刻真有一条连接在看着它**：由传输层登记（`registerHolder`），连接断开时
 * 摘掉（`dropHolder`，挂在 `connection.onClose` 上）。它不需要客户端配合 —— 连接消失是
 * 内核保证的（进程被 `kill -9`、崩溃、断电都会让那条 socket 消失）。
 *
 * ## 为什么不要客户端上报意图
 *
 * 一个由客户端**上报**的「保活声明」会把判据变成它**与**持有者的合取，而两个事实里只有
 * 一个在「最难的情况」下还成立：
 *
 *   · 崩溃的进程发不出那一帧 —— 声明会永远停在「要」，会话连同它占的 Agent 与消息历史
 *     永久留在内存里（本包在 loopback 上跑，唯一的回收时机是重启守护进程）；
 *   · 而持有者是**内核保证**的事实，同样的崩溃恰好把它清干净。
 *
 * 判据取合取就是把不可靠的那个当成了必要条件。所以只有持有者一条：「我不看这段了」
 * 只剩一个显式表达（`session.close`），「我崩了」由内核兜 —— 两条路都不依赖客户端记得发帧。
 *
 * 代价（记账，不说成「行为不变」）：一次性调用（`ai "…"`）与 TUI 的 `/new` 要么显式
 * `session.close`，要么留到宽限期到点。宽限期是给断线重连留的窗口，不是给「没人要」的
 * 会话续命。
 */

import { PhaseTracker } from "../../lib/phase.js";
import { compareSessionEntries } from "./store/SessionStore.js";
import type { SessionRecord, SessionStore } from "./store/SessionStore.js";
import { EventHub } from "../../lib/events.js";
import {
  SessionHandoff,
  isHandoffAborted,
  type HandoffAgentLike,
} from "../handoff/SessionHandoff.js";
import type { AutoTitleFn } from "./AutoTitle.js";
import { EventBridge, ToolCallReporter } from "./EventBridge.js";
import { Persistence } from "./Persistence.js";
import { QuestionBroker } from "./QuestionBroker.js";
import type { AgentLike, LiveSession, SubAgentLike } from "./LiveSession.js";
// `resolveModelParams` 是**运行期**依赖：参数该取哪一层只有 SDK 那一处实现
// （`packages/sdk/src/runtime/resolveModel.ts`）。快照要报「当前生效的参数」，就得问
// 它 —— 本层再写一遍「哪一档取哪一份」，就是让同一个 `switch` 存在两份的第二天。
// 其余两个只借**类型**：自动迁移触发上下文的形状真相源在 SDK 的插件里，本层再抄一份就是
// 第二份会漂移的规则（`import type` 编译后会被擦掉，不构成运行期依赖）。
import { resolveModelParams } from "@ai-zen/agents-sdk";
import type { AutoMigrateTriggerInfo, ModelParams } from "@ai-zen/agents-sdk";
import type {
  Message,
  MessageContent,
  ModelLevel,
  SessionListEntry,
  SubAgentSnapshotResult,
} from "@ai-zen/agents-protocol";
import {
  SESSION_EVENTS,
  SESSION_NOTICE_CODES,
  DEFAULT_MIGRATION_STRATEGY,
  type HandoffMode,
  type MigrationStrategy,
  type NoticePayload,
  type ServerEvent,
  type SessionAnswerResult,
  type SessionAttachResult,
  type SessionCancelResult,
  type SessionCloseResult,
  type SessionCreateResult,
  type SessionHandoffResult,
  type SessionLastResult,
  type SessionMigrateResult,
  type SessionRenameResult,
  type SessionRemoveResult,
  type SessionRollbackResult,
  type SessionSaveAsResult,
  type SessionSaveResult,
  type SessionSnapshotResult,
} from "@ai-zen/agents-protocol";
// 值导入（不是 `import type`）：`codedError` 与错误码表是**运行期**的东西，
// 它们的唯一定义在协议包里。
import { ERROR_CODES, codedError } from "@ai-zen/agents-protocol";

// 形状与最小面住在 `LiveSession.ts`（四个类共用）；这里转出去，是因为它们一直是本模块
// 公开面的一部分（`SessionAgentFactory` 与另一些包的测试按这个路径 import）。
export type { AgentLike, SubAgentLike, AskQuestionSpec } from "./LiveSession.js";

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
   * `mode` 是用户在 `session-question` 里选的执行者：`resolveMode` 只回答「用哪种方式」，
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
   * 细节见 `PersistenceOptions.storeFor`（本类只是把它转给存档那一块）。
   */
  storeFor?: (workspaceId: string) => SessionStore<Message> | Promise<SessionStore<Message>>;
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
   * 测成「时钟」。理由见 `QuestionBroker.askHandoffMode`（为什么必须有时限）。
   */
  askTimeoutMs?: number;
  /**
   * 「最后一个持有者走了之后还留多久」（毫秒），缺省 {@link DEFAULT_SESSION_IDLE_TIMEOUT_MS}
   * （60 秒）。
   *
   * `0` 表示不等待（持有者一走就收）：只在测试与「一次性调用、且不想用 `session.close`」
   * 的部署里说得通 —— 它把断线重连的窗口也一起取消了。
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

export class SessionManager {
  private readonly createAgent: (input: CreateAgentInput) => Promise<AgentLike>;
  private readonly nextSessionId: () => string;
  private readonly invalidateScope: SessionManagerOptions["invalidateScope"];
  private readonly handoffOptions: SessionManagerOptions["handoff"];
  private readonly sessions = new Map<string, LiveSession>();
  private readonly hub: EventHub;
  /** 「没人看着之后还留多久」（宽限期，见文件头的规则） */
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
  /** SDK 事件 → 协议事件的翻译（含流式影子与子 Agent 栏目） */
  private readonly events: EventBridge;
  /** 存档的形状与写盘 */
  private readonly store: Persistence;
  /** 向客户端提问与等回答 */
  private readonly questions: QuestionBroker;

  constructor(options: SessionManagerOptions) {
    this.createAgent = options.createAgent;
    this.nextSessionId = options.nextSessionId ?? defaultNextSessionId;
    this.invalidateScope = options.invalidateScope;
    this.handoffOptions = options.handoff;
    this.sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    this.schedule = options.schedule ?? defaultSchedule;
    this.autoTitleFn = options.autoTitle;
    this.autoTitleTimeoutMs = options.autoTitleTimeoutMs ?? AUTO_TITLE_TIMEOUT_MS;
    this.resolveSessionModel = options.resolveSessionModel;
    this.hub = options.hub ?? new EventHub();
    this.ownsHub = !options.hub;

    // 三块协作者只拿**函数**，不拿本类的实例：它们不该能调 `close()`、`list()` 这类动作
    // （那会把「谁负责什么」重新搅回一起，也把拆出来的意义抹掉）。
    this.events = new EventBridge({
      hub: this.hub,
      // 收尾与失败是**会话层**的规则（落盘、发 `session-turn-end`、判回收），事件桥只转达
      // 「SDK 说完了 / SDK 报错了」这两个事实
      settleTurn: (session) => void this.settleTurn(session),
      failTurn: (session, failure) => this.failTurn(session, failure),
      notice: (sessionId, notice) => this.notice(sessionId, notice),
    });
    this.store = new Persistence({
      ...(options.storeFor ? { storeFor: options.storeFor } : {}),
      nextSessionId: this.nextSessionId,
      isLive: (sessionId) => this.sessions.has(sessionId),
      notice: (sessionId, notice) => this.notice(sessionId, notice),
    });
    this.questions = new QuestionBroker({
      hub: this.hub,
      ...(options.askTimeoutMs !== undefined ? { askTimeoutMs: options.askTimeoutMs } : {}),
      // 按**实例**判活（不只是「表里有这个 id」）：换过 id 之后旧对象还在内存里跑完这一轮，
      // 但它已经不是「当前的这段会话」了
      isLive: (session) => this.sessions.get(session.id) === session,
      notice: (sessionId, notice) => this.notice(sessionId, notice),
    });
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
      phase: this.events.phaseOf(session),
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
    if (!entry) throw codedError(ERROR_CODES.subAgentMissing, `no such sub-agent: ${subAgentId}`);
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
    return await this.store.save(this.require(sessionId), options);
  }

  /**
   * 另存为指定 id（`/save <名字>`）：写新档、删旧档、活会话换键。
   *
   * 与 `migrate` 的区别：这是**同一段对话**换个名字，所以 `turnId` 不动；
   * 删旧档是必须的 —— 同一份对话在 `/load` 列表里出现两条，用户分不清哪条是新的。
   *
   * 两半分居两处：写新档 / 删旧档 / 挪指针在 `Persistence.saveAs`（存档侧），换键在
   * `rekey`（注册表侧）。撞上另一段活会话的 `session-exists` 在存档侧就抛了 —— 那时
   * 盘上什么都没动。
   */
  async saveAs(sessionId: string, id: string): Promise<SessionSaveAsResult> {
    const session = this.require(sessionId);
    const previousId = session.id;
    const result = await this.store.saveAs(session, id);
    this.rekey(session, previousId, id);
    return result;
  }

  /**
   * 活会话换了 id：**注册表与客户端可见的那一半**。
   *
   * 三件事必须一起做：注册表换键（旧 id 立刻 `unknown-session`）、清子 Agent 栏目（旧条目
   * 属于上一段）、发 `session-id-changed`（自动迁移发生在一轮内部，客户端没有响应可接，
   * 只能靠这条事件把后续请求与事件过滤切到新 id）。
   *
   * 换键的是**同一个对象**：会话不是「新建一段」，所以 `turnId`、消息、holders 都跟着走。
   */
  private rekey(session: LiveSession, previousId: string, nextId: string): void {
    this.sessions.delete(previousId);
    session.id = nextId;
    this.sessions.set(nextId, session);
    // 换 id = 这是新的一段会话：上一段里的子 Agent 不该跟着过来
    this.events.clearSubAgents(session);
    if (nextId !== previousId) {
      this.emit({ event: SESSION_EVENTS.idChanged, from: previousId, sessionId: nextId });
    }
  }

  /**
   * 自动迁移 —— 由 SDK 的 `AutoMigratePlugin` 在**一轮内部**（`onAfterSend`）触发。
   *
   * 与手动 `migrate()` 的三点不同：
   *   1. **不新开一轮**（外面那一轮还没结束，`turnId` 不动）；
   *   2. 收尾仍归外面那一轮 —— 这里只把 `settleDeferred` 拿住，避免嵌套交接回合的
   *      SDK `finally` 把整轮提前结束；
   *   3. 没有返回值可给：客户端靠 `session-id-changed` 事件得知换了 id。
   *
   * 必须能存档：prune 之后旧历史只存在于存档里，存不下去就别动手。
   *
   * `mode` 是客户端在 `session-question` 里选的执行者。它必须从这条路径传下去：
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
      const store = await this.store.requireStore(session.workspaceId);

      await this.store.archive(session, previousId, store);
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
      const nextId = await this.store.adopt(session, store);
      this.rekey(session, previousId, nextId);
    } finally {
      session.settleDeferred = false;
    }
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
   *     `session-id-changed`；
   *   - 落盘改由收尾负责（`persistOnSettle`）：`session-turn-end` 之前写完，存档里那份就是
   *     带 `omit` 标记的完整历史 —— 下次 `attach` 装回来，旧消息仍然不会发给模型。
   *
   * 两条路共用的部分：`turnId` 是**会话内**的轮次编号，不因迁移清零；收尾在 `prune` 下
   * 必须 `await` 且发生在换 id **之前** —— 客户端先看到旧会话这一轮结束，再收到响应里
   * 的新 id，两次 `session-phase` / `session-turn-end` 的 `sessionId` 才不指一个它还不知道的会话。
   */
  async migrate(
    sessionId: string,
    mode?: HandoffMode,
    strategy: MigrationStrategy = DEFAULT_MIGRATION_STRATEGY,
  ): Promise<SessionMigrateResult> {
    const session = this.requireIdle(sessionId);
    const store = await this.store.requireStore(session.workspaceId);

    this.beginTurn(session);
    session.settleDeferred = true;
    // 收尾该不该写档：prune 已经自己存过完整历史（再写会把 prune 后的版本盖上去），
    // omit 则**必须**写（存档里那份要带上 `omit` 标记）
    session.persistOnSettle = strategy === "omit";
    try {
      const previousId = session.id;
      if (strategy === "prune") {
        await this.store.archive(session, previousId, store);
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
      // 收尾必须 **await**：它发的是收尾那一刻 id 的 `session-turn-end`，而下一行可能就把 id
      // 换掉了。不等它跑完，客户端可能先收到新 id 的响应，再收一条指向旧会话的收尾事件。
      await this.settleTurn(session);

      // 换 id 只属于 prune（理由见方法注释）：omit 下 `session.id` 原样返回
      let nextId = session.id;
      if (strategy === "prune") {
        nextId = await this.store.adopt(session, store);
        this.rekey(session, previousId, nextId);
      }
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
      throw codedError(ERROR_CODES.turnInFlight, `session ${sessionId} has a turn in flight`);
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
    await this.store.write(session);

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
      throw codedError(ERROR_CODES.turnInFlight, `session ${sessionId} has a turn in flight`);
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
    await this.store.write(session);

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
      throw codedError(ERROR_CODES.turnInFlight, `session ${sessionId} has a turn in flight`);
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
    await this.store.write(session);

    return await this.snapshot(sessionId);
  }

  /**
   * 按磁盘上的（新）配置与 Agent 定义重建 Agent，**保留当前消息**。
   *
   * 用在「`/config` 改了端点凭据」「`agent.model.set` 换了模型」之后：Scope 持有配置
   * 快照，不连带重建就还是旧的那份。
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
      // 谁来写交接文档由用户在 `session-question` 里定（会话层向客户端提问并等回答）
      resolveMode: (info) => this.questions.askHandoffMode(session, info),
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
    this.events.resetStreamState(session);
    // 换了 Agent：旧子 Agent 实例连同它们的对话一起退场（它们属于旧底座）
    this.events.clearSubAgents(session);
    session.detach = this.events.attach(session);
  }

  /**
   * 某个工作区的会话清单：盘上的存档 ∪ 内存里的活会话。
   *
   * ## 为什么只有一条方法
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
   *
   * ## 性能（这条路径挂在「点开会话」上，别让它退化成每条一次 IO）
   *
   * 存档那一侧**只读一次清单**（`store.list()`），解析缓存按 `agentId + 会话级覆盖`
   * 在本次调用内去重；活会话那一侧直接读内存。所以成本是「一次 `list()` + 每种
   * agentId/覆盖组合一次解析」，与会话条数无关。
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
      const store = await this.store.store(workspaceId);
      // 没有存档不算错：活会话仍然列得出来（与 `last` 的 `no-store` 不同口径——
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
        phase: this.events.phaseOf(session),
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
    if (!title) throw codedError(ERROR_CODES.badParams, "title must not be empty");

    const session = this.sessions.get(input.sessionId);
    if (session) {
      session.title = title;
      const store = await this.store.store(session.workspaceId);
      if (store) await store.write(this.store.recordOf(session));
      return { sessionId: session.id, title };
    }

    const store = await this.store.store(input.workspaceId);
    if (!store) throw codedError(ERROR_CODES.noStore, `no session store for ${input.workspaceId}`);
    const record = await store.read(input.sessionId);
    if (!record)
      throw codedError(ERROR_CODES.sessionMissing, `no such session: ${input.sessionId}`);
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
    const store = await this.store.store(input.workspaceId);
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
   * 注入时明确报 `no-store`，与 `save` / `rollback` 同一口径 —— 不假装「这个工作区
   * 没有上一轮」。
   */
  async last(workspaceId: string): Promise<SessionLastResult> {
    const store = await this.store.requireStore(workspaceId);
    const pointer = await store.lastSession();
    if (!pointer) return { sessionId: null };
    const record = await store.read(pointer.id);
    return { sessionId: record ? pointer.id : null };
  }

  /**
   * 撤回：删掉 `index` 起的消息，**并立即落盘**。
   *
   * 落盘不是可选项：只改内存的话，存档里仍留着被撤回的消息，下次 `/load` 或重启
   * 就“复活”。所以先确认有存档可写，再动消息 —— 避免
   * “改了一半、存不下去”。
   */
  async rollback(sessionId: string, index: number): Promise<SessionRollbackResult> {
    const session = this.require(sessionId);
    const store = await this.store.requireStore(session.workspaceId);

    const messages = session.agent.messages;
    if (!Number.isInteger(index) || index < 0 || index >= messages.length) {
      throw codedError(
        ERROR_CODES.badIndex,
        `index ${index} is out of range (0..${messages.length - 1})`,
      );
    }

    const removedMessages = messages.splice(index);
    session.agent.messages = messages;
    await store.write(this.store.recordOf(session, messages));
    await store.setLastSession(session.id);

    // 预填输入框用：被删掉的第一条用户消息（原文，不做任何“备注剥离”）
    const firstUser = removedMessages.find((message) => message.role === "user");

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
    const store = await this.store.store(input.workspaceId);

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
    let record: SessionRecord<Message> | null = null;
    /** 续接时存档自己的「最后一次活动」（没有存档 / 清单里没有 → `undefined`） */
    let archivedUpdatedAt: string | undefined;
    if (input.sessionId) {
      sessionId = input.sessionId;
      if (this.sessions.has(sessionId)) {
        throw codedError(ERROR_CODES.sessionExists, `session already exists: ${sessionId}`);
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
      // 谁来写交接文档由用户在 `session-question` 里定（会话层向客户端提问并等回答）
      resolveMode: (info) => this.questions.askHandoffMode(session, info),
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
      toolCalls: new ToolCallReporter(),
      turnFailed: null,
      turnSettled: true,
      settleDeferred: false,
      persistOnSettle: false,
      autoPersist: input.persist !== false,
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
    session.detach = this.events.attach(session);
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
    store: SessionStore<Message> | null | undefined,
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

    const store = await this.store.store(input.workspaceId);
    const record = store ? await store.read(input.sessionId) : null;
    if (!record) {
      throw codedError(ERROR_CODES.sessionMissing, `no such session: ${input.sessionId}`);
    }
    // 走 create 的装配路径：它会按存档里的 agentId 装配 Agent 并把消息装进去
    return await this.create({ ...input, sessionId: input.sessionId });
  }

  /**
   * 开始一轮：立刻返回 `turnId`，结果与过程全部走事件。
   *
   * 不 `await agent.send()` 的原因见协议文件头：一轮可能跑几分钟，等它回来客户端
   * 就没东西可渲染。失败也走事件（`session-turn-end` 带 `ok:false`），不靠这一个 promise。
   */
  send(sessionId: string, content: MessageContent): { turnId: number } {
    const session = this.require(sessionId);

    // 交接/迁移进行中：再起一轮会同用一个 `turnId`，事件没任何办法归轮。
    //
    // 这条**必须排在下面那条之前**：交接期间 `turnSettled` 也是 false，顺序反了的话
    // 交接那一次会被报成 `turn-busy`，客户端就拿不到「正在交接」这个更准的原因
    // （两者对客户端是不同的事：前者等一会儿再发，后者可能要等一整份交接文档）。
    if (session.settleDeferred) {
      throw codedError(ERROR_CODES.handoffInFlight, `session ${sessionId} is handing off`);
    }

    // 已有一轮在跑就拒绝。
    //
    // 为什么必须挡：事件是靠 `session.turnId` 的**当前值**归轮的 —— 增量与收尾都在发出
    // 的那一刻才读它，而 `beginTurn` 直接 `turnId += 1`。真放第二轮进来，第一轮后半段的
    // 增量就会被贴上第二轮的编号，两条链路的 `session-turn-end` 也各自对不上，界面互相串轮。
    // 这不是理论风险：`attach` 之后「同一段会话被两个客户端看」是常态（客户端退出后会话
    // 仍活着，另一个客户端接上；或两个终端同看），谁多点一下就是两轮并行。
    //
    // 为什么拒绝而不是排队：`send` 的语义是「**现在**开始一轮」——它的返回值就是这一轮的
    // 编号，调用方拿到它就会用这个编号过滤事件。排队会让语义变成「稍后」，调用方手里的
    // 编号与它此刻看到的状态不再对应；该不该等、等多久，是客户端的决定，服务端不替它做。
    if (this.isTurnInFlight(session)) {
      throw codedError(ERROR_CODES.turnBusy, `session ${sessionId} already has a turn in flight`);
    }

    this.beginTurn(session);
    // 这一轮会产生对话内容：收尾时写进存档（`session-turn-end` 之前）
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
   *
   * 认领的判定在 `QuestionBroker`（清表是「来晚了」的唯一判据，那一处实现）；
   * 本方法只负责「先确认会话存在」—— 「拿错 id」与「来晚了」必须是两个不同的答案。
   */
  answer(sessionId: string, questionId: string, choice: string | null): SessionAnswerResult {
    return this.questions.answer(this.require(sessionId), questionId, choice);
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
    this.questions.release(session);
    session.detach();
    // 会话已经不存在了：不留任何指向它的残留（子 Agent 里的实例也跟着退场）
    this.events.clearSubAgents(session);
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
   *
   * 这是「活着」的**唯一**来源（见文件头的规则）：所以它也是回收倒计时的取消点。
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
   * 关掉一个工作区下**全部**活会话（删工作区时用）。
   *
   * 为什么这条归本类而不是归 handler：它需要知道「哪些会话是活的」，而那是本类的注册表。
   * 让 handler 自己拼（`list(workspaceId, {includeSaved:false})` 再逐个 `close()`）有两个后果：
   * 一是**业务规则跑到传输层**去了（handler 只该验参数与接线），
   * 二是那次 `list()` 白白拼了一整套 `SessionListEntry`（生效模型、消息条数、阶段）只为了
   * 拿一串 id —— 而这类会话恰恰是「正要被删掉的」，取那些字段一点用都没有。
   *
   * 为什么非要关：目录删了、会话还在跑的话，它下一轮收尾会把存档写回来
   * （`FileSessionStore.write` 自己会 `mkdir`），刚删掉的工作区就**部分复活**了。
   * `close()` 之后那条轮跑完也不再写档。
   *
   * 幂等：本来就没有活会话时什么都不做。
   */
  closeWorkspace(workspaceId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.workspaceId === workspaceId) this.close(session.id);
    }
  }

  /** 收摊：摘掉所有事件、清空会话（守护进程退出时调用） */
  dispose(): void {
    for (const session of this.sessions.values()) {
      this.cancelReclaim(session);
      session.handoff?.abort();
      this.questions.release(session);
      session.detach();
    }
    this.sessions.clear();
    if (this.ownsHub) this.hub.clear();
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 收尾一轮。
   *
   * 五步的顺序是定死的，每一步都有人依赖它：
   *
   *   1. **先落盘**（带用户消息的回合）：`session-turn-end` 一到，客户端就认为这一轮结束、内容
   *      已经定型；此时存档里还没有它，退出 TUI 再进来就「什么都没发生」。所以这一步落在
   *      发收尾事件之前：漏了它，症状就是「聊完退出、再 `ai` 是新会话」。
   *   2. 放行挂着的提问：不会再有答案了。
   *   3. 清子 Agent 栏目：它只活当前一轮。
   *   4. 阶段归零并广播：界面据此把 spinner 收起来。
   *   5. 发 `session-turn-end`。
   *
   * `turnSettled` 在入口就置位（重复调用直接返回）：落盘是异步的，不先置位就会写两遍。
   * 代价是「已置位、`session-turn-end` 未发」之间有个微窗口，此时再 `send`/`migrate` 不会被拦——
   * 但客户端要拿到 `session-turn-end` 才会发下一轮，这个窗口在协议上摸不到。
   *
   * **两个标记别混**：`persistOnSettle`（这一轮该不该写档）与 `reclaimOnSettle`（这段会话
   * 该不该在收尾时被收掉）是两件事，各有各的来源；混成一个就会出现「迁移的中场收尾把会话
   * 收了」或「该写的档没写」这类只有特定路径才发作的错。
   */
  private async settleTurn(session: LiveSession): Promise<void> {
    if (session.turnSettled) return;
    // 交接/迁移进行中：这一轮的收尾归方法自己的 promise（见 `settleDeferred`）
    if (session.settleDeferred) return;
    session.turnSettled = true;
    // 本地记住「这一轮是不是客户端发起的正常回合」：`writeOnSettle` 会把标记消耗掉，
    // 而下面那个回收判定还要用它（`migrate` 的中场收尾不能触发回收）。
    const clientTurn = session.persistOnSettle;

    // 1) 落盘：`session-turn-end` 之前写完，存档与事件里的「这一轮」才是同一个东西
    await this.store.writeOnSettle(session);

    // 这一轮已经收尾：它提的问不会再有答案了（客户端在等的是 `session-turn-end`，不是这个选择器）。
    // 不在这里兜底放行，提问方就要挂到超时 —— 而它一直占着闸门，后面的 `send` 全报
    // `turn-busy`。放在发 `session-turn-end` 之前：两个事件的先后与「收尾已定」一致。
    this.questions.release(session);

    // 一轮结束：子 Agent 列表跟着消失（只活当前一轮，理由见 `clearSubAgents`）。
    // 清在 `session-turn-end` 之前：客户端收到收尾事件时再去要子 Agent 快照，拿不到才是对的。
    this.events.clearSubAgents(session);

    this.events.resetStreamState(session);
    this.events.emitPhase(session);
    this.emit({
      event: SESSION_EVENTS.turnEnd,
      sessionId: session.id,
      turnId: session.turnId,
      ok: session.turnFailed === null,
      ...(session.turnFailed ? { error: session.turnFailed } : {}),
    });

    // 6) 回收：这一轮收完，重判一次「还有没有人要它」（存档已在第 1 步写好，再点回来
    //    `attach` 从盘上装回来）。放在 `session-turn-end` **之后**：客户端拿到的最后一条事件仍然
    //    是「这一轮结束了」，而不是一个已经被摘掉的会话。
    //    只对客户端发起的正常回合判定 —— `migrate` 的中场收尾紧接着要换 id。
    if (clientTurn) {
      if (session.reclaimOnSettle) {
        // 宽限期在那一轮还在跑的时候就到了：已经延后过一次，现在收尾就收
        this.close(session.id);
      } else {
        // 同一条判定再算一次（幂等：宽限期在收尾之前就已经起跑时不会重挂）
        this.scheduleReclaim(session);
      }
    }

    // 7) 自动标题（只在第一轮、只在还没有名字时；**不 await**：`session-turn-end` 已经发出去了，
    //    标题是之后的事 —— 卡的是一行展示用的名字，一行都不能拖住下一轮对话）。
    //
    //    放在回收判定**之后**：回收可能当场关掉会话（`reclaimOnSettle` 那一路），那时就不必
    //    为了一个已经退场的会话再发一次模型请求（`autoTitle` 里也会再确认一次）。
    if (session.turnId === 1) void this.autoTitle(session);
  }

  /** 失败即收尾（`error` 之后 SDK 仍会发 `finally`，靠 `turnSettled` 去重） */
  private failTurn(session: LiveSession, failure: { code: string; message: string }): void {
    session.turnFailed = failure;
    void this.settleTurn(session);
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
   * 这里吞掉，标题留空（客户端依旧用首条消息兜底）。
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
    await this.store.write(session);
    this.emit({ event: SESSION_EVENTS.titleChanged, sessionId: session.id, title });
  }

  private emit(event: ServerEvent): void {
    this.hub.publish(event);
  }

  private require(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw codedError(ERROR_CODES.unknownSession, `unknown session: ${sessionId}`);
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
    this.events.emitPhase(session);
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
   * 真的活着 = 此刻有一条连接在看着它。判据只有这一个来源，见文件头的规则一节
   */
  private isHeld(session: LiveSession): boolean {
    return session.holders.size > 0;
  }

  /**
   * 进入回收倒计时（幂等）。
   *
   * 幂等是必须的：`session-turn-end` 每轮都会调一次，而重挂一次就等于把窗口一直往后推 ——
   * 一段没人要的会话会被它自己的历史拖住（聊了 100 轮就多留 100 个宽限期）。
   */
  private scheduleReclaim(session: LiveSession): void {
    if (this.isHeld(session)) {
      this.cancelReclaim(session);
      session.reclaimOnSettle = false;
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
      throw codedError(ERROR_CODES.turnInFlight, `session ${sessionId} has a turn in flight`);
    }
    const hasUserMessage = session.agent.messages.some(
      (message) => (message as { role?: unknown } | null)?.role === "user",
    );
    if (!hasUserMessage) {
      throw codedError(
        ERROR_CODES.nothingToHandoff,
        `session ${sessionId} has no user message yet`,
      );
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
      throw codedError(ERROR_CODES.noHandoff, "handoff is not configured on this server");
    }
    session.handoff ??= new SessionHandoff({
      ...this.handoffOptions,
      workspacePath: session.path,
      notice: (notice) => this.notice(session.id, notice),
    });
    return session.handoff;
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
      return codedError(ERROR_CODES.handoffAborted, "handoff cancelled");
    }
    const failure = error as { code?: unknown; message?: unknown } | null;
    session.turnFailed = {
      code: typeof failure?.code === "string" ? failure.code : "internal",
      message: typeof failure?.message === "string" ? failure.message : String(error),
    };
    return error;
  }
}
