/**
 * `ScopeRegistry` —— key（workspaceId / 临时对话的目录键）→ `Scope` 的持有者（PLAN §4）。
 *
 * 一个 Workspace 一个 Scope（PRD D9）：同一 Workspace 下的多段对话复用同一个 Scope。
 * 这个文件只回答两个问题：**现在有没有**（`create` 幂等 get-or-create）、
 * **什么时候拆**（`dispose` / `disposeAll`）。
 *
 * ## 没有空闲计时、没有引用计数、没有自动回收
 *
 * 实例活着就是因为有人显式持有它：
 *
 *   - 建出来之后一直活着，直到有人调 `dispose(workspaceId)`（Workspace 被删）或
 *     `disposeAll()`（进程收尾）。中间不会因为「没人用」而消失 —— 也没有「没人用」这个
 *     可判定的状态：Scope 是能力容器，它不属于某一段对话；
 *   - 因此本文件不再记引用计数（那是自动回收的输入），也不再持有计时器
 *     （PLAN §4 曾经唯一的那个空闲计时已撤掉）。
 *
 * 「这个 Scope 上还活着几个 agent」是 `AgentRegistry` 的账，不是这里的账：本文件只在
 * `dispose` 时**问一句**（{@link ScopeRegistryOptions.liveConversations}），有活的就拒绝。
 *
 * ## 回收自下而上：撞上活着的 agent 就拒绝，不级联
 *
 * `dispose` 遇到还活着的 agent 时抛 {@link ScopeBusyError}（带着 `conversationId` 列表），
 * 而不是顺手把那些对话掐掉：级联会静默掐死正在跑的对话，而显式 API 的价值就是「动作要有意识」。
 * 调用方的顺序是：先让会话停下（`ChatRunner.abort` / `forget`）+ 丢掉 agent
 * （`AgentRegistry.kill` / `killAll`），再回来销毁 Scope。
 *
 * `disposeAll` 是**收尾**用的，不拒绝：进程要退出了，那时已经没有「稍后再拆」这回事。
 *
 * ## 销毁就是 `Scope.dispose()`
 *
 * 它会逆序调用各插件的 `dispose()`，MCP 插件在那里断开它自持的全部连接，于是
 * 「Scope 与 MCP 连接同生共死」不用第二套代码来表达 —— 只是时机从「空闲到点」变成
 * 「显式 dispose / 进程退出」。
 *
 * **配置改动不是销毁场合**：配置改动的本质是「磁盘上几个 json 变了」，`refresh()`
 * （重读配置 + 各插件重新发现）就能让它生效，Scope 实例还是同一个 —— 见
 * `refreshWorkspace`。
 *
 * Scope 的创建方式从构造参数进来：接线层提供真实的 SDK 装配（见本文件末尾的
 * `createWorkspaceScopeFactory`）。
 */

import type { AllInOneOptions, AppConfig, ToolEnvDeps } from "@ai-zen/agents-sdk";
import { allInOne, PeerSessionsScopePlugin, Scope } from "@ai-zen/agents-sdk";
import type { PeerSessionPort } from "@ai-zen/agents-sdk";

/**
 * 计时入口。
 *
 * `setTimeout` 返回「取消函数」而不是句柄：假时钟与真定时器都能实现它，调用方不必知道
 * 句柄长什么样，也就不需要 `clearTimeout` 的第二个入口。
 *
 * 本文件自己**完全不用**它：空闲计时已撤，构造参数里也不再有 `clock`。导出留着是因为
 * 真正的消费者在别处，用的还是同一个口径：`ChatRunner.ts` 里两个类都拿它（`ChatRunner` 用
 * `now()` 记时间戳，`ConversationBridge` 用它做写库节流的计时与消息落库时间）与接线层
 * `app.ts`（`options.clock` 注入点，再往下分给各服务），`runtime/index.ts` 只是转手再导出；
 * 测试助手 `TestSupport.ManualClock` 实现的就是它。`services/CompletionService` **不在**此列
 * —— 它自带形状相同的 `CompletionClock` / `systemCompletionClock`，不引用这一份。
 *
 * 归属上这里只是「历史上的家」：它本来为 Scope 的空闲回收而生，回收撤掉之后没有任何
 * ScopeRegistry 的代码碰它。真要收拢，它该搬到一个不依赖任何东西的叶子模块
 * （如 `runtime/clock.ts`），这样 `ChatRunner` 不必为了一个时钟去 import ScopeRegistry。
 * 本轮不动导出（那会牵动一圈 import）。
 */
export interface Clock {
  /** 当前时刻（毫秒，`Date.now()` 口径） */
  now(): number;
  /** 到点后执行 `handler`，返回取消函数 */
  setTimeout(handler: () => void, ms: number): () => void;
}

/**
 * 真实时钟。无状态，可以放心共享；需要可控时间的地方（测试、或将来把时钟挂到根对象上）
 * 通过构造参数换成别的实现。
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => {
    const timer = setTimeout(handler, ms);
    // 计时不该单独把进程钉住：真要退出时由根对象按「什么都不欠了」判断
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * 造一个 Scope 的方式（按 key）。
 *
 * 之所以是外部注入而不是本文件自己 `new Scope(...)`：装配 Scope 需要取配置的端口、能力路径、
 * MCP 配置的 5 层链（PRD L9）—— 那些都是配置层的财产；本文件只管「什么时候有、什么时候拆」。
 * 接线层若不想自己写，用本文件末尾的 `createWorkspaceScopeFactory`。
 */
export type ScopeFactory = (workspaceId: string) => Promise<Scope>;

/**
 * 「这个 Scope 上还活着哪几段对话」—— 由 `AgentRegistry` 提供（结构上它满足）。
 *
 * 只有 `dispose` 用它：撞上活的就拒绝。不注入时当作「没有活着的 agent」
 * （单独用本文件的小工具、用例里的假注册表都属于这种情形）。
 */
export type LiveConversationsQuery = (workspaceId: string) => string[];

/**
 * 还活着的 agent 挡着，Scope 不能销毁。
 *
 * 形状是有意的扁的：`conversationIds` 直接可以报给调用方/日志，不必再去别处查一遍。
 */
export class ScopeBusyError extends Error {
  readonly workspaceId: string;
  /** 还活着的对话（`AgentRegistry` 里的那些），按登记顺序 */
  readonly conversationIds: string[];

  constructor(workspaceId: string, conversationIds: string[]) {
    super(
      `Scope "${workspaceId}" is still running ${conversationIds.length} conversation(s): ` +
        `${conversationIds.join(", ")}`,
    );
    this.name = "ScopeBusyError";
    this.workspaceId = workspaceId;
    this.conversationIds = [...conversationIds];
  }
}

export interface ScopeRegistryOptions {
  /** 懒创建：只有 `create` 到不存在的 key 时才叫它 */
  createScope: ScopeFactory;
  /** 查「这个 Scope 上还活着哪几段对话」（`AgentRegistry.conversationIds` 结构上满足） */
  liveConversations?: LiveConversationsQuery;
  /** 销毁 / 刷新 Scope 时抛出的错误往哪里报（缺省吞掉：这事失败不该让调用方以为业务失败了） */
  onError?: (error: unknown, workspaceId: string) => void;
}

/** 一个 key 对应的一条记录 */
class ScopeEntry {
  readonly workspaceId: string;
  /**
   * 创建中的 Promise；与 `resolved` 指向同一个 Scope。
   *
   * 在构造函数里就把它起来：`create` 登记完条目之后才能有人 await 到它，
   * 而构造函数是同步跑完的，所以不存在「拿到条目但 Promise 还没赋值」的窗口。
   */
  readonly created: Promise<Scope>;
  /** 创建完成后才有值 */
  resolved?: Scope;
  /** 正在销毁（幂等） */
  disposing?: Promise<void>;

  constructor(workspaceId: string, start: (entry: ScopeEntry) => Promise<Scope>) {
    this.workspaceId = workspaceId;
    this.created = start(this);
  }
}

export class ScopeRegistry {
  private readonly entries = new Map<string, ScopeEntry>();
  private readonly createScope: ScopeFactory;
  private readonly liveConversations?: LiveConversationsQuery;
  private readonly onError?: (error: unknown, workspaceId: string) => void;

  constructor(options: ScopeRegistryOptions) {
    this.createScope = options.createScope;
    this.liveConversations = options.liveConversations;
    this.onError = options.onError;
  }

  /**
   * 取一个 Scope：没有就建，有就原样返回（幂等 get-or-create）。
   *
   * 并发的两次 `create` 只会创建一次（两个调用方等同一个 Promise）。
   * 调用方不必背顺序：`AgentRegistry.create` 内部就是这么确保「Scope 先于 agent 存在」的。
   */
  create(workspaceId: string): Promise<Scope> {
    const existing = this.entries.get(workspaceId);
    if (existing) return existing.created;

    // 先登记再创建：创建过程中再来的 create 会命中这条记录、等同一个 Promise
    const entry = new ScopeEntry(workspaceId, (created) => this.build(created));
    this.entries.set(workspaceId, entry);
    return entry.created;
  }

  /** 当前持有哪几个（报告「刷了哪些项目的 Scope」、判退出用） */
  workspaceIds(): string[] {
    return [...this.entries.keys()];
  }

  /** 创建失败时不留下坏条目：下一次 create 重新尝试 */
  private async build(entry: ScopeEntry): Promise<Scope> {
    try {
      const scope = await this.createScope(entry.workspaceId);
      entry.resolved = scope;
      return scope;
    } catch (error) {
      if (this.entries.get(entry.workspaceId) === entry) {
        this.entries.delete(entry.workspaceId);
      }
      throw error;
    }
  }

  /**
   * 就地刷新某一个 Scope —— 配置改完之后用（PRD F-E2：改完即生效）。
   *
   * 刷的是 `Scope.refresh()`：重读配置 + 各插件重新发现（MCP 连接跟着对账），**实例还是同一个**。
   * 所以正在跑的那一轮不会被抽掉能力，而它读到的配置已经是磁盘上新那一份。
   *
   * 只对已经存在的条目动手：不存在就什么也不做（不为刷新去创建一个 Scope —— 下一段对话
   * `create` 时会按新配置建）。正在创建中的条目等它建完再刷。
   *
   * 刷新失败不往外抛：一个项目的 MCP 文件写坏了不该让整次「配置生效」变成失败（走 `onError`）。
   */
  async refreshWorkspace(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;

    let scope: Scope | undefined;
    try {
      scope = entry.resolved ?? (await entry.created);
    } catch {
      // 创建本来就没成：没有东西可刷（创建失败时条目已被摘掉）
      return;
    }

    try {
      await scope.refresh();
    } catch (error) {
      this.onError?.(error, workspaceId);
    }
  }

  /**
   * 销毁某一个 Scope —— Workspace 被删（或别的「这个能力容器不要了」的显式场合）时用。
   *
   * **撞上还活着的 agent 就拒绝**（{@link ScopeBusyError}，带着 `conversationId` 列表）：
   * 不级联、不静默掐掉正在跑的对话。调用方要先停会话、丢掉 agent，再回来调它。
   *
   * 不存在就什么也不做（幂等）；销毁之后再 `create` 得到新实例。
   */
  async dispose(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;

    const live = this.liveConversations?.(workspaceId) ?? [];
    if (live.length > 0) throw new ScopeBusyError(workspaceId, live);

    await this.disposeEntry(entry);
  }

  /**
   * 全部销毁 —— 宿主收尾（`doStop`）时用：进程要退出了，MCP 连接是 Scope 持有的，
   * 没有别人会替它关（D28 同生共死）。
   *
   * 与 `dispose` 的差别只有一条：**不拒绝**。收尾时「还有 agent 活着」不是要挡住销毁的理由
   * （进程马上就要没），而且这里没有「稍后再拆」这回事。
   *
   * 配置改动**不走这里**：那是 `refreshWorkspace` 的事。
   */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.disposeEntry(entry)));
  }

  /**
   * 销毁：先把条目从表里摘掉（之后 create 会重建），再等创建完成并 `dispose()`。
   *
   * 创建还没完成就得销毁时也要等它 —— 否则刚建出来的 Scope 没人拆，MCP 连接会漏。
   */
  private disposeEntry(entry: ScopeEntry): Promise<void> {
    entry.disposing ??= this.doDispose(entry);
    return entry.disposing;
  }

  private async doDispose(entry: ScopeEntry): Promise<void> {
    if (this.entries.get(entry.workspaceId) === entry) {
      this.entries.delete(entry.workspaceId);
    }

    let scope: Scope | undefined;
    try {
      scope = await entry.created;
    } catch {
      // 创建本来就失败了：没有东西要拆
      scope = undefined;
    }

    if (!scope) return;
    try {
      // Scope.dispose() 逆序调用各插件的 dispose()：MCP 连接在这里断开（D28 同生共死）
      await scope.dispose();
    } catch (error) {
      this.onError?.(error, entry.workspaceId);
    }
  }
}

/**
 * 按 SDK 口径装配 Scope 的现成工厂。
 *
 * 装配内容：`new Scope({ getConfig, cwd, agentsDir })` + `allInOne(...)`（内置工具、用户工具、
 * Skill、MCP、子 Agent 五类插件），然后 `init()` 做首次能力发现。MCP 插件自带连接管理器，
 * 于是「Scope 建好 = MCP 配置已发现」，`dispose()` 时连接一起断；配置改了则是 `refresh()`
 * （重读配置 + MCP 连接对账），不用重建 Scope。
 *
 * 多给一个 `peerSessions` 端口时再装一个 `PeerSessionsScopePlugin`（平级会话的两个工具）：
 * 那是宿主注入的能力，不是磁盘上的目录，所以不在 `allInOne` 里。
 *
 * 工作目录、配置、各能力路径都由接线层给：本文件不去问进程当前目录，也不猜数据根。
 */
export interface WorkspaceScopeFactoryOptions {
  /** 按 workspaceId 取工作目录（Workspace 的 cwd 不可变，PRD D9） */
  resolveWorkspace(workspaceId: string): Promise<{ cwd: string } | undefined>;
  /** 取当前配置的端口：**原样交给 Scope**，于是 `refresh()` 每次都会现读磁盘 */
  getConfig(): AppConfig | Promise<AppConfig>;
  /** Agent 定义目录（SDK 的 `createAgent` 从这里读定义） */
  agentsDir: string;
  /** Skill 目录（可多层，越靠前优先级越高）；也能给一个「按 cwd 算」的函数 */
  skillsPaths?: AbilityPathOption;
  /** 用户工具目录 */
  toolsPaths?: AbilityPathOption;
  /** 子 Agent 目录 */
  subAgentsPaths?: AbilityPathOption;
  /** MCP 配置文件的 5 层链（PRD L9），按 cwd 算好 */
  mcpPaths?: (cwd: string) => string[];
  /**
   * 平级会话的端口（宿主实现）：给了才装 `PeerSessionsScopePlugin`。
   *
   * 不给就没有那两个工具 —— 「这个宿主能不能开平级会话」是一个装配事实，不是一个开关。
   */
  peerSessions?: PeerSessionPort;
  /** 出网/外部依赖的注入点（测试替身） */
  deps?: ToolEnvDeps;
}

/**
 * 一组能力目录：可以是固定的一份，也可以是「按 cwd 算」的函数。
 *
 * Skill / 工具 / 子 Agent 的目录跟项目走（L9：离项目越近越优先），而 Scope 是按 cwd 装配的，
 * 所以装配处需要把「按 cwd 算」这件事交进来，而不是在构造时先算一份死的。
 */
export type AbilityPathOption = string[] | ((cwd: string) => string[]);

/** 取一组目录（固定值与函数的两种写法收在一个地方） */
function pathsFor(option: AbilityPathOption | undefined, cwd: string): string[] | undefined {
  if (option === undefined) return undefined;
  return typeof option === "function" ? option(cwd) : option;
}

/** 造一个「按 SDK 装能力」的工厂；返回值直接喂给 `ScopeRegistry` 的 `createScope` */
export function createWorkspaceScopeFactory(
  options: WorkspaceScopeFactoryOptions,
): ScopeFactory {
  return async (workspaceId: string): Promise<Scope> => {
    const workspace = await options.resolveWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace "${workspaceId}" not found`);
    }
    const abilityPaths: AllInOneOptions = {
      skillsPaths: pathsFor(options.skillsPaths, workspace.cwd),
      toolsPaths: pathsFor(options.toolsPaths, workspace.cwd),
      subAgentsPaths: pathsFor(options.subAgentsPaths, workspace.cwd),
      mcpPaths: options.mcpPaths?.(workspace.cwd),
    };
    const scope = new Scope({
      // 端口原样转交：首份由 init() 读，之后每次 refresh() 都重读（配置改了不重建 Scope）
      getConfig: () => options.getConfig(),
      cwd: workspace.cwd,
      agentsDir: options.agentsDir,
      deps: options.deps,
    });
    scope.use(...allInOne(abilityPaths));
    // 平级会话：能力来自宿主端口（不给就不装，老行为一个字不变）
    if (options.peerSessions) scope.use(new PeerSessionsScopePlugin(options.peerSessions));
    await scope.init();
    return scope;
  };
}
