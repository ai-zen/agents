import type { Scope } from "../scope/Scope.js";
import type { PeerSessionPort } from "../scope/plugins/peers/peerSessionTools.js";
import type { AgentDefinition } from "../types/index.js";
import { SILENT_LOG, type LogSink } from "../shared/logger.js";

/** 一个容器此刻能拿出什么（按插件候选聚合：还没过任何一段会话的权限） */
export interface ScopeCapabilities {
  tools: string[];
  subagents: string[];
  skills: string[];
  mcps: string[];
}

/** Scope 的三格事实（运行时把它转成对外的事实流，见 `RuntimeFact`） */
export type ScopeEvent =
  | { type: "appeared"; cwd: string; capabilities: ScopeCapabilities }
  | { type: "refreshed"; cwd: string; capabilities: ScopeCapabilities }
  | { type: "gone"; cwd: string };

/**
 * 一份没刷成的容器：哪个目录、为什么。
 *
 * `reason` 是渲染好的一句话（错误对象就取 `message`）：调用方要能把它原样说给人听，而不是拿到
 * 一个 `unknown` 之后自己再分一遍「这次是 Error 还是一个字符串」。
 */
export interface ScopeRefreshFailure {
  readonly cwd: string;
  readonly reason: string;
}

/**
 * 一遍刷新的回执：刷了几份、哪几份没刷成。
 *
 * 只有数字，没有能力快照 —— 「现在能拿出什么」那一份走 {@link ScopeEvent}，两者用途不同：这条
 * 回执答的是「这一手有没有生效」，能力那一份答的是「生效之后是什么」。
 */
export interface ScopeRefreshReport {
  /** 过这一遍时已经造好的容器有几份（没人用过的目录不在其中） */
  readonly total: number;
  readonly refreshed: number;
  /** 没刷成的那几份：它们留在原地用旧配置 */
  readonly failed: readonly ScopeRefreshFailure[];
}

/**
 * 算候选时喂给插件的那一份「会话定义」：空的那一份。
 *
 * 候选那一侧要一格会话定义（内置工具的可用性靠它判，如 `view_image` 看的是那一段会话绑的模型
 * 是不是视觉模型）。容器不属于任何一段会话，所以这边给的是空的那一份：凡是「只在某一段会话上
 * 才成立」的候选，在这个视角下都算这个目录拿不出来。
 */
const NO_SESSION_DEFINITION: AgentDefinition = {
  id: "",
  name: "",
  messages: [],
  createdAt: "",
  updatedAt: "",
};

export interface ScopesDeps {
  /**
   * 造一个容器。怎么装配能力不归这里管 —— 这里只负责「什么时候造、造几个、什么时候拆」。
   *
   * PeerSession 那三个工具是运行时的端口，随这次请求一起下去：容器在同一次装配里把它们装成工具。
   * 不另开一个「事后再装一个插件」的口 —— 那种口只对还没 `init()` 的容器有效，而 `init()`
   * 什么时候发生就成了两边各记一份的事。
   */
  readonly openScope: (cwd: string, peers: PeerSessionPort) => Promise<Scope>;
  /** 这个目录上还活着哪几段会话：问的是 Agent 那一侧，本模块不自己记账 */
  readonly aliveSessions: (cwd: string) => readonly string[];
  /** PeerSession 的端口（见 {@link ScopesDeps.openScope}） */
  readonly peers: PeerSessionPort;
  /** 刷新失败的出口：一个容器刷不动不该让其余容器也不动，所以逐个收口 */
  readonly log?: LogSink;
  /**
   * 容器这一侧的变化往外说的出口：出现了、刷新完了、拆掉了（{@link ScopeEvent}）。
   *
   * 旁路：容器不靠它做任何判断 —— 它只在事情发生之后说一句，没有它容器照旧造、照旧刷、照旧拆
   * （要不要造、刷成功了没有、拆得掉拆不掉，一个判据都不从这个回调读）。
   */
  readonly onChange: (event: ScopeEvent) => void;
}

/**
 * Scope 按目录存活：同一个目录上的多段会话共用一个容器。
 *
 * 没有空闲计时、没有引用计数、没有自动回收：容器活着是因为有人显式持有它，直到有人显式拆掉。
 * 「没人用」不是一个可判定的状态，容器也不属于某一段会话。
 *
 * 拆的时候遇到还有活 Agent 的目录就拒绝，不级联 —— 级联会静默杀死正在进行的会话，让调用方
 * 看不见自己拆掉了什么。
 */
export class Scopes {
  /**
   * 值是在造它的那次调用，造完就是容器本身。分成「已造好」与「正在造」两张表就会出现两边都
   * 有的中间态，而它们要回答的是同一个问题：这个目录现在有没有容器。
   */
  private readonly containers = new Map<string, Promise<Scope>>();
  /** 正在拆的那一次：并发的第二次拆等的是同一次拆完，而不是立刻返回一个「拆好了」 */
  private readonly tearing = new Map<string, Promise<void>>();
  private readonly log: LogSink;

  constructor(private readonly deps: ScopesDeps) {
    this.log = deps.log ?? SILENT_LOG;
  }

  /**
   * 记的是这次调用的 Promise，不是「正在创建」的布尔标志：标志只在 `await` 之后才改写，
   * 两次调用会一起看到「没在创建」，于是造出两个容器。
   */
  for(cwd: string): Promise<Scope> {
    const existing = this.containers.get(cwd);
    if (existing !== undefined) return existing;

    const created = this.deps.openScope(cwd, this.deps.peers).catch((error: unknown) => {
      // 造失败的那一次不留记录：留着的话，这个目录此后每次 `for` 都拿到同一个失败
      this.containers.delete(cwd);
      throw error;
    });

    // 「出现了」只在真的造了一个的那次发：走到这里就是这次调用造的那一个（上面那一格已经
    // 返回了），记录也已经落好 —— 收到事实的人回头 `for` 一次，拿到的是同一个容器。
    //
    // 它排在上面那条 catch 之外：`onChange` 是旁路，它抛错不该被当成「造失败」把记录抹掉。
    // 也不要 `await`：这个回调挂在同一个 promise 上、先于调用方那一次 `await` 跑，不必再等它一圈。
    void created.then(
      (scope) =>
        this.deps.onChange({
          type: "appeared",
          cwd,
          capabilities: this.capabilitiesOf(scope),
        }),
      // 造失败的那一路上面已经收过尾：不发事实（它没造出来）
      () => undefined,
    );

    this.containers.set(cwd, created);
    return created;
  }

  /** 拆一个目录的容器：上面还有活 Agent 就拒绝（要拆先杀） */
  async dispose(cwd: string): Promise<void> {
    const sessionIds = this.deps.aliveSessions(cwd);
    if (sessionIds.length > 0) {
      throw new Error(
        `Cannot dispose the scope for "${cwd}": ${sessionIds.length} session(s) are still alive on it`,
      );
    }

    await this.tearDown(cwd);
  }

  /**
   * 配置改了之后让每个已造好的容器重读一次磁盘。
   *
   * 只刷已经造出来的：没人用过的目录没有容器，下一次 `for` 会按新配置造一个，现在去造
   * 一个只是为了让它可以被刷一次。
   *
   * 逐个收口：一个容器刷不动不该让其余容器也不动。刷不动的那个留在原地用旧配置，下一次它被
   * 真正用到之前还有机会再刷。
   *
   * 回执报的是这一遍真的发生了什么：没刷成的那些也数进去（{@link ScopeRefreshReport.failed}），
   * 于是「一份都没刷动」与「全都刷好了」在调用方那里分得开 —— 只回一个 `void` 的话，两种处境
   * 长得一模一样，而前者正是要让人知道的那一种。
   */
  async refreshAll(): Promise<ScopeRefreshReport> {
    const resolved = await Promise.allSettled([...this.containers.values()]);
    // 造失败的那一条不算容器：它没造出来，调用方在 `for` 那一次已经拿到同一个错误，这里不再
    // 报一次（这一遍要回答的是「已造好的那几份刷没刷动」）
    const scopes = resolved
      .filter((entry): entry is PromiseFulfilledResult<Scope> => entry.status === "fulfilled")
      .map((entry) => entry.value);

    let refreshed = 0;
    const failed: ScopeRefreshFailure[] = [];

    for (const scope of scopes) {
      try {
        await scope.refresh({ silent: true });
      } catch (error) {
        this.log.warn("Cannot refresh a scope after a config change", { error });
        // 刷不动的那个没刷成功：不发「刷新完了」，它留在原地用旧配置
        failed.push({
          cwd: scope.cwd,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      refreshed += 1;
      // 刷成功了才发：这一格说的是「现在按新配置能拿出什么」，不是「有人试过刷」
      this.deps.onChange({
        type: "refreshed",
        cwd: scope.cwd,
        capabilities: this.capabilitiesOf(scope),
      });
    }

    return { total: scopes.length, refreshed, failed };
  }

  /** 进程收尾用，不拒绝：那时已经没有「稍后再拆」这回事 */
  async disposeAll(): Promise<void> {
    // 拆到一半的容器已经不在 `containers` 里，但还没有拆完：两个键集合并起来才是全部
    const cwds = new Set([...this.containers.keys(), ...this.tearing.keys()]);
    await Promise.all([...cwds].map((cwd) => this.tearDown(cwd)));
  }

  /**
   * 一个容器此刻能拿出什么：按插件候选聚合，四个维度各自去重、保序（先注册的插件在前）。
   *
   * 为什么用候选而不是 `filter(definition)` 的结果：候选是「这个容器能拿出什么」，权限是「这一段
   * AgentDefinition 准不准用」，两件事。混在一起，第三方说「现在能用什么能力」时说的会是一段会话的权限，
   * 而不是这个目录的能力。候选那一格会话定义用的是空的那一份（见 {@link NO_SESSION_DEFINITION}）。
   */
  private capabilitiesOf(scope: Scope): ScopeCapabilities {
    const tools = new Set<string>();
    const subagents = new Set<string>();
    const skills = new Set<string>();
    const mcps = new Set<string>();

    for (const plugin of scope.plugins) {
      const candidates = plugin.candidates(scope, NO_SESSION_DEFINITION);
      candidates.tools?.forEach((name) => tools.add(name));
      candidates.subagents?.forEach((name) => subagents.add(name));
      candidates.skills?.forEach((name) => skills.add(name));
      candidates.mcps?.forEach((name) => mcps.add(name));
    }

    return { tools: [...tools], subagents: [...subagents], skills: [...skills], mcps: [...mcps] };
  }

  private tearDown(cwd: string): Promise<void> {
    const inflight = this.tearing.get(cwd);
    if (inflight !== undefined) return inflight;

    const tearing = (async () => {
      const pending = this.containers.get(cwd);
      if (pending === undefined) return;

      // 造的那一步可能还没写进 messages。不等它，容器会在这次拆返回之后才建出来，没有人再拆得掉。
      // 造失败的那条路径上，要这个容器的调用方已经拿到同一个错误，这里没有容器要拆。
      const scope = await pending.catch(() => undefined);
      if (scope === undefined) return;

      this.containers.delete(cwd);
      await scope.dispose();
      // 拆完了才发：造失败（上面 `scope === undefined`）与本来就没人要过容器（`pending ===
      // undefined`）这两条路径都提前返回了，这里发的每一次都对应一个真的拆掉的容器
      this.deps.onChange({ type: "gone", cwd });
    })().finally(() => this.tearing.delete(cwd));

    this.tearing.set(cwd, tearing);
    return tearing;
  }
}
