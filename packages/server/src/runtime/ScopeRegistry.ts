/**
 * `ScopeRegistry` —— workspaceId → `Scope` 的持有者、依赖计数与空闲回收（architecture §4 / PRD D28）。
 *
 * 一个 Workspace 一个 Scope（PRD D9）：同一 Workspace 下的多段对话复用同一个 Scope，
 * 所以这里记的是**依赖计数**而不是「谁在打开它」。计数归零之后不立刻拆，而是起一个
 * 10 分钟的空闲计时；计时到点才真正销毁 —— 销毁就是 `Scope.dispose()`，它会逆序调用各插件的
 * `dispose()`，MCP 插件在那里断开它自持的全部连接，于是「Scope 与 MCP 连接同生共死」
 * 不用第二套代码来表达。
 *
 * 计时器只有这一处（architecture §4 A10）：L4 说的「10 分钟无活动」与 D28 说的
 * 「Scope 空闲 10 分钟」是同一个计时器的两个说法，别处不再另起一份。
 *
 * Scope 会被销毁的三种场合（architecture §4）：空闲到点、Workspace 被删、配置变更要重连 MCP。
 * 三者都收敛到本文件的 `dispose`，区别只在「谁来叫」。
 *
 * 时间与 Scope 的创建方式都从构造参数进来：测试用假时钟推进十分钟，接线层提供真实的
 * SDK 装配（见本文件末尾的 `createWorkspaceScopeFactory`）。
 */

import type { AllInOneOptions, AppConfig, ToolEnvDeps } from "@ai-zen/agents-sdk";
import { allInOne, Scope } from "@ai-zen/agents-sdk";

/** 空闲回收的缺省时长：10 分钟（PRD D28） */
export const DEFAULT_SCOPE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 计时入口。
 *
 * `setTimeout` 返回「取消函数」而不是句柄：假时钟与真定时器都能实现它，调用方不必知道
 * 句柄长什么样，也就不需要 `clearTimeout` 的第二个入口。
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
    // 空闲回收计时不该单独把进程钉住：真要退出时由根对象按「什么都不欠了」判断
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * 造一个 Scope 的方式（按 workspaceId）。
 *
 * 之所以是外部注入而不是本文件自己 `new Scope(...)`：装配 Scope 需要配置快照、能力路径、
 * MCP 配置的 5 层链（PRD L9）—— 那些都是配置层的财产；本文件只管「什么时候有、什么时候拆」。
 * 接线层若不想自己写，用本文件末尾的 `createWorkspaceScopeFactory`。
 */
export type ScopeFactory = (workspaceId: string) => Promise<Scope>;

export interface ScopeRegistryOptions {
  /** 懒创建：只有 `acquire` 到不存在的 workspaceId 时才叫它 */
  createScope: ScopeFactory;
  /** 空闲回收时长，缺省 10 分钟 */
  idleTimeoutMs?: number;
  /** 计时入口，缺省真实时钟 */
  clock?: Clock;
  /** 销毁 Scope 时抛出的错误往哪里报（缺省吞掉：回收失败不该让调用方以为业务失败了） */
  onError?: (error: unknown, workspaceId: string) => void;
}

/** 一个 Workspace 对应的一条记录 */
class ScopeEntry {
  readonly workspaceId: string;
  /**
   * 创建中的 Promise；与 `resolved` 指向同一个 Scope。
   *
   * 在构造函数里就把它起来：`acquire` 登记完条目之后才能有人 await 到它，
   * 而构造函数是同步跑完的，所以不存在「拿到条目但 Promise 还没赋值」的窗口。
   */
  readonly created: Promise<Scope>;
  /** 创建完成后才有值 */
  resolved?: Scope;
  /** 依赖计数：当前有多少个调用方正拿着它 */
  refs = 1;
  /** 空闲计时器的取消函数 */
  cancelIdle?: () => void;
  /** 配置变更时它正被持有：等最后一次 release 再销毁（不在别人用着的时候拆能力） */
  recycleWhenFree = false;
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
  private readonly idleTimeoutMs: number;
  private readonly clock: Clock;
  private readonly onError?: (error: unknown, workspaceId: string) => void;
  private readonly allRecycledListeners = new Set<() => void>();

  constructor(options: ScopeRegistryOptions) {
    this.createScope = options.createScope;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SCOPE_IDLE_TIMEOUT_MS;
    this.clock = options.clock ?? systemClock;
    this.onError = options.onError;
  }

  /**
   * 借一个 Scope：没有就懒创建，依赖计数 +1，并取消空闲计时。
   *
   * 并发的两次 `acquire` 只会创建一次（两个调用方等同一个 Promise）。
   */
  acquire(workspaceId: string): Promise<Scope> {
    const existing = this.entries.get(workspaceId);
    if (existing) {
      existing.refs += 1;
      this.cancelIdle(existing);
      return existing.created;
    }

    // 先登记再创建：创建过程中再来的 acquire 会命中这条记录、等同一个 Promise
    const entry = new ScopeEntry(workspaceId, (created) => this.create(created));
    this.entries.set(workspaceId, entry);
    return entry.created;
  }

  /** 创建失败时不留下坏条目：下一次 acquire 重新尝试 */
  private async create(entry: ScopeEntry): Promise<Scope> {
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
   * 归还：依赖计数 −1。归零后按两种场合分叉 ——
   * 平时起 10 分钟空闲计时；若期间发生过配置变更（`recycleAll`）要求它重建，就立刻销毁。
   */
  release(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;

    if (entry.recycleWhenFree) {
      void this.dispose(entry);
      return;
    }
    this.scheduleIdle(entry);
  }

  /** 看而不借：已经建好就返回它，没有或还在建就返回 `undefined` */
  peek(workspaceId: string): Scope | undefined {
    return this.entries.get(workspaceId)?.resolved;
  }

  /** 当前持有几个 Scope（含正在创建的） */
  size(): number {
    return this.entries.size;
  }

  /** 当前持有哪几个（配置改动后要报告「回收了哪些项目的 Scope」） */
  workspaceIds(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 全部回收 —— 配置改完要重连 MCP 时用（PRD F-E2：改完即生效，靠重连而不是重启）。
   *
   * 没人用的立刻销毁；正被持有的打上标记，等最后一次 `release` 再销毁。这样正在跑的那一轮
   * 不会在写到一半时被抽掉能力，而它结束后下一段对话拿到的已经是按新配置建的 Scope。
   */
  async recycleAll(): Promise<void> {
    const entries = [...this.entries.values()];
    await Promise.all(
      entries.map((entry) => {
        if (entry.refs > 0) {
          entry.recycleWhenFree = true;
          return Promise.resolve();
        }
        return this.dispose(entry);
      }),
    );
  }

  /**
   * 销毁某一个 Workspace 的 Scope —— Workspace 被删时用。
   *
   * 与 `recycleAll` 的区别：这里不等引用归零，因为 Workspace 已经不在了，
   * 再留着这个 Scope 也没有下一个调用方。
   */
  disposeWorkspace(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (!entry) return Promise.resolve();
    return this.dispose(entry);
  }

  /**
   * 全部回收之后通知根对象（architecture §4：根对象据此判断进程能不能退出）。
   *
   * 返回取消订阅的函数。
   */
  onAllRecycled(listener: () => void): () => void {
    this.allRecycledListeners.add(listener);
    return () => {
      this.allRecycledListeners.delete(listener);
    };
  }

  private scheduleIdle(entry: ScopeEntry): void {
    this.cancelIdle(entry);
    entry.cancelIdle = this.clock.setTimeout(() => {
      entry.cancelIdle = undefined;
      void this.dispose(entry);
    }, this.idleTimeoutMs);
  }

  private cancelIdle(entry: ScopeEntry): void {
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
  }

  /**
   * 销毁：先把条目从表里摘掉（之后 acquire 会重建），再等创建完成并 `dispose()`。
   *
   * 创建还没完成就得销毁时也要等它 —— 否则刚建出来的 Scope 没人拆，MCP 连接会漏。
   */
  private dispose(entry: ScopeEntry): Promise<void> {
    entry.disposing ??= this.doDispose(entry);
    return entry.disposing;
  }

  private async doDispose(entry: ScopeEntry): Promise<void> {
    this.cancelIdle(entry);
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

    if (scope) {
      try {
        // Scope.dispose() 逆序调用各插件的 dispose()：MCP 连接在这里断开（D28 同生共死）
        await scope.dispose();
      } catch (error) {
        this.onError?.(error, entry.workspaceId);
      }
    }

    this.notifyAllRecycled();
  }

  private notifyAllRecycled(): void {
    if (this.entries.size > 0) return;
    for (const listener of [...this.allRecycledListeners]) {
      try {
        listener();
      } catch {
        // 通知是「可以判退出了」这种事的广播，一个监听器出问题不该影响别的
      }
    }
  }
}

/**
 * 按 SDK 口径装配 Scope 的现成工厂。
 *
 * 装配内容：`new Scope({ config, cwd, agentsDir })` + `allInOne(...)`（内置工具、用户工具、
 * Skill、MCP、子 Agent 五类插件），然后 `init()` 做首次能力发现。MCP 插件自带连接管理器，
 * 于是「Scope 建好 = MCP 配置已发现」，`dispose()` 时连接一起断。
 *
 * 工作目录、配置、各能力路径都由接线层给：本文件不去问进程当前目录，也不猜数据根。
 */
export interface WorkspaceScopeFactoryOptions {
  /** 按 workspaceId 取工作目录（Workspace 的 cwd 不可变，PRD D9） */
  resolveWorkspace(workspaceId: string): Promise<{ cwd: string } | undefined>;
  /** 取当前配置：配置改过之后再 acquire 会拿到新的那一份 */
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
    const config = await options.getConfig();
    const abilityPaths: AllInOneOptions = {
      skillsPaths: pathsFor(options.skillsPaths, workspace.cwd),
      toolsPaths: pathsFor(options.toolsPaths, workspace.cwd),
      subAgentsPaths: pathsFor(options.subAgentsPaths, workspace.cwd),
      mcpPaths: options.mcpPaths?.(workspace.cwd),
    };
    const scope = new Scope({
      config,
      cwd: workspace.cwd,
      agentsDir: options.agentsDir,
      deps: options.deps,
    });
    scope.use(...allInOne(abilityPaths));
    await scope.init();
    return scope;
  };
}
