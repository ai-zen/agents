import type { Scope } from "../scope/Scope.js";
import type { PeerSessionPort } from "../scope/plugins/peers/peerSessionTools.js";
import { SILENT_LOG, type LogSink } from "../shared/logger.js";

export interface ScopesDeps {
  /**
   * 造一个容器。怎么装配能力不归这里管 —— 这里只负责「什么时候造、造几个、什么时候拆」。
   *
   * 平级会话那三个工具是运行时的端口，随这次请求一起下去：容器在同一次装配里把它们装成工具。
   * 不另开一个「事后再装一个插件」的口 —— 那种口只对还没 `init()` 的容器有效，而 `init()`
   * 什么时候发生就成了两边各记一份的事。
   */
  readonly openScope: (cwd: string, peers: PeerSessionPort) => Promise<Scope>;
  /** 这个目录上还活着哪几段会话：问的是执行体那一侧，本模块不自己记账 */
  readonly aliveSessions: (cwd: string) => readonly string[];
  /** 平级会话的端口（见 {@link ScopesDeps.openScope}） */
  readonly peers: PeerSessionPort;
  /** 刷新失败的出口：一个容器刷不动不该让其余容器也不动，所以逐个收口 */
  readonly log?: LogSink;
}

/**
 * 能力容器按目录存活：同一个目录上的多段会话共用一个容器。
 *
 * 没有空闲计时、没有引用计数、没有自动回收：容器活着是因为有人显式持有它，直到有人显式拆掉。
 * 「没人用」不是一个可判定的状态，容器也不属于某一段会话。
 *
 * 拆的时候遇到还有活执行体的目录就拒绝，不级联 —— 级联会静默杀死正在进行的会话，让调用方
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

    this.containers.set(cwd, created);
    return created;
  }

  /** 拆一个目录的容器：上面还有活执行体就拒绝（要拆先杀） */
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
   * 只刷**已经造出来的**：没人用过的目录没有容器，下一次 `for` 会按新配置造一个，现在去造
   * 一个只是为了让它可以被刷一次。
   *
   * 逐个收口：一个容器刷不动不该让其余容器也不动。刷不动的那个留在原地用旧配置，下一次它被
   * 真正用到之前还有机会再刷。
   */
  async refreshAll(): Promise<void> {
    const resolved = await Promise.allSettled([...this.containers.values()]);
    const scopes = resolved
      .filter((entry): entry is PromiseFulfilledResult<Scope> => entry.status === "fulfilled")
      .map((entry) => entry.value);

    for (const scope of scopes) {
      try {
        await scope.refresh({ silent: true });
      } catch (error) {
        this.log.warn("Cannot refresh a scope after a config change", { error });
      }
    }
  }

  /** 进程收尾用，不拒绝：那时已经没有「稍后再拆」这回事 */
  async disposeAll(): Promise<void> {
    // 拆到一半的容器已经不在 `containers` 里，但还没有拆完：两个键集合并起来才是全部
    const cwds = new Set([...this.containers.keys(), ...this.tearing.keys()]);
    await Promise.all([...cwds].map((cwd) => this.tearDown(cwd)));
  }

  private tearDown(cwd: string): Promise<void> {
    const inflight = this.tearing.get(cwd);
    if (inflight !== undefined) return inflight;

    const tearing = (async () => {
      const pending = this.containers.get(cwd);
      if (pending === undefined) return;

      // 造的那一步可能还没落地。不等它，容器会在这次拆返回之后才建出来，没有人再拆得掉。
      // 造失败的那条路径上，要这个容器的调用方已经拿到同一个错误，这里没有容器要拆。
      const scope = await pending.catch(() => undefined);
      if (scope === undefined) return;

      this.containers.delete(cwd);
      await scope.dispose();
    })().finally(() => this.tearing.delete(cwd));

    this.tearing.set(cwd, tearing);
    return tearing;
  }
}
