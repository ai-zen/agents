/**
 * `ServerConnection` —— **一个进程一条连接**，以及「它断了之后怎么长回来」。
 *
 * ## 为什么要有这个类
 *
 * 「这条连接归谁、它死了谁负责」这个问题的两种土办法都会出事：
 *
 *   · 让每个组装点自己建一条再往下传 —— 「别建第二条」这条纪律就得由每个组装点记住，
 *     忘一处就是两套连接视图；
 *   · 用 `pending ??=` 缓存一条，但**建成之后永不复查 `closed`** —— daemon 重启一次，
 *     那个进程就永久失能（每次调用都撞在一条已经 destroy 的 socket 上，而界面看起来只是
 *     「没反应」）。
 *
 * 两者都在回答同一个问题。答案只能有一个，所以它进包。
 *
 * ## 三条不变量
 *
 * 1. **每次取用都判活**（`client()`）：缓存的连接 `closed` 就重建，绝不把一条死连接交出去。
 *    这是桌面端那个 bug 的正面写法 —— 「缓存」与「它还能用」是两件事。
 * 2. **`events.watch` 跟着连接走**（`watch()`）：它是**连接级**的订阅（服务端按连接登记
 *    推送），连接换了就得重新订阅，否则客户端的 `on()` 全都收不到东西（而且症状很安静：
 *    不报错，只是什么都不来）。
 *    订阅**每条连接只做一次**：服务端每收到一帧 `events.watch` 就多注册一个订阅者，重复
 *    调用会让每个事件到达 N 次 —— 屏幕上是「答案被切成两遍」。
 * 3. **断开与就绪都往上说**（`onClose` / `onOpen`）：连接是共享的，会话不是。所以「连接换了
 *    一条」这件事必须能被每个会话各自听见 —— 听见之后它要 `session.attach` 把自己接回去
 *    （状态在服务端，连接只是入口）。这就是「daemon 重启后上层怎么恢复」的全部机制。
 *
 * ## 为什么不重试
 *
 * 这里只负责「建一条」（失败就把错误抛给调用方），**不负责重试几次、退避多久**。
 * 那是会话层的规则（`SessionChannel` 的三次递增退避）：
 * 重试策略属于「谁在用这条连接」，不属于「连接」自己 —— 参数化到这里的唯一后果是
 * 配置面（只想读一个配置）与对话（有一轮在飞）被同一套重试策略绑住。
 *
 * ## `close()` 之后**不能**再用（二选一里的那一条，写在这里免得后人再猜）
 *
 * `close()` 是进程退出时的动作，语义就是「这条连接到此为止」。所以 `client()` 在
 * `disposed` 之后**直接抛错**，而不是再建一条。
 *
 * 为什么不能选另一条（「`close()` 之后仍可用，且会重新上报断线」）：那条路要求
 * `close()` 之后的 `handleClose()` 继续工作，而 `disposed` 恰恰是用来挡「自己关的却被
 * 当成断线去重连」的 —— 两者要同时成立，就得再引入一个「关过又醒了」的状态位。
 * 更具体地，不守门会得到一个很坏的形状：`close()` 把 `current` 置空，下一次 `client()`
 * 于是重建一条，而 `handleClose()` 因 `disposed` 直接 return —— 交出去的是一条**新但聋**
 * 的连接：它能发调用，却永远收不到「断了」的通知，调用方永久卡在「界面没反应」。
 * 明确的失败（抛错）比一个安静地不听事件的连接好。
 */

import { ensureServer } from "../ensure-server.js";
import type { ClientInfo, ServerClient } from "../types.js";

export interface ServerConnectionDeps {
  /**
   * 注入一条**现成**的连接：给了就永远用它，本类不会重建。
   *
   * 为什么「不重建」：我们变不出第二条（它指向谁的服务器只有注入方知道）。所以注入的语义
   * 是「生命周期归你」—— 它关了，`client()` 就把这条关掉的连接原样交出去，让调用方如实
   * 看到「连接已关闭」，而不是在这里凭空换一条来路不明的连接。测试与「宿主自己管连接」的
   * 场景用这一支。
   */
  client?: ServerClient;
  /**
   * 自建连接的方式（可重建）。缺省 = {@link ensureServer}：没有服务端就拉起一个。
   *
   * 与 `client` 二者取一：这个的语义是「再建一条给我」，所以连接死了会再调一次。
   */
  connect?: () => Promise<ServerClient>;
  /**
   * 自动拉起服务端所需的事实：配置根、身份、以及拉哪个包。
   *
   * 只在既没有 `client` 也没有 `connect` 时才需要。本包不读 `AI_ZEN_DIR` 这类进程级全局
   * （它是库，读了就再也改不了目录），由组装根读一次再递进来。
   */
  aiZenDir?: string;
  /** 握手时自称的身份（同样只在自己建连时用到）：应用名 + 版本号 */
  clientInfo?: ClientInfo;
  /** `npx` 拉起的服务端包坐标（缺省 `@ai-zen/agents-server`）；预发布版本要带 `@x.y.z` */
  serverPackage?: string;
  /**
   * 接管「怎么拉起服务端」。不给就用 {@link ensureServer} 的默认（`npx`）。
   *
   * 宿主自带一份服务端时用它：桌面端就是拉起**随包分发**的那个，不必让用户机器上的
   * `npx` 去 registry 上找包（那台机器可能连 npm 都没有）。
   */
  startServerProcess?: (deps: { aiZenDir: string }) => Promise<void>;
}

export class ServerConnection {
  private readonly deps: ServerConnectionDeps;
  /** 当前连接（可变：断了会换一条）。`null` = 还没建过 */
  private current: ServerClient | null = null;
  /** 正在建的那一条：并发取用只建一条，不是每人一条 */
  private connecting: Promise<ServerClient> | null = null;
  /** 已经订阅过 `events.watch` 的那条连接（见不变量 2：每条连接只订一次） */
  private watched: ServerClient | null = null;
  /** 正在订阅中的那一次（并发 `watch()` 只发一帧） */
  private watching: Promise<void> | null = null;
  /** 有人订阅过事件：重建连接后在这条新连接上重新订阅（订阅是按连接登记的） */
  private watchWanted = false;
  /** 当前连接的「断了」订阅（换连接时整条换掉） */
  private offClose: (() => void) | null = null;
  private readonly closeListeners = new Set<() => void>();
  private readonly openListeners = new Set<() => void>();
  /** 自己 `close()` 过了：此后断线不再往上说（那是我们关的） */
  private disposed = false;

  constructor(deps: ServerConnectionDeps = {}) {
    this.deps = deps;
  }

  /** 当前这条连接还能不能用（`false` 时下一次 `client()` 会重建） */
  get closed(): boolean {
    if (this.deps.client) return this.deps.client.closed;
    return this.current === null || this.current.closed;
  }

  /**
   * 拿一条**活着**的连接。
   *
   * `close()` 之后直接抛错（选的是文件头那条「之后不能用」的语义）：否则这里会重建一条，
   * 而重建出来的那条永远收不到断线通知（`handleClose` 因 `disposed` 不工作）。
   *
   * 注入优先 → 缓存的（还活着就复用）→ 重建。重建是单飞的：两个会话同时发现连接断了，
   * 只该建出一条新连接（否则一条进程里躺着两条，第二条谁也不记得关）。
   */
  async client(): Promise<ServerClient> {
    if (this.disposed) {
      throw new Error("ServerConnection 已经 close()：这条连接到此为止，请重新组装一个实例");
    }
    if (this.deps.client) return this.deps.client;
    const current = this.current;
    if (current && !current.closed) return current;
    return await this.build();
  }

  /**
   * 让这条连接开始收事件（服务端按连接登记推送）。
   *
   * 幂等：同一条连接上重复调用不会再发帧。服务端每收到一帧就给这条连接登记一个订阅者，
   * 同一条连接订两次 = 每个事件收到两份。
   *
   * 订阅是**连接级**的：换一条连接就等于没订过（新连接默认什么都不推），所以重建连接时会
   * 在新连接上重新订阅一次。调用方只表达**意图**（「我要收事件」），不必自己盯着连接换没换。
   */
  async watch(): Promise<void> {
    this.watchWanted = true;
    await this.ensureWatched(await this.client());
  }

  /** 订阅「连接断了」（主动 `close()` 不算：那一条已经先摘掉监听）。返回解绑函数 */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /**
   * 订阅「一条**新**连接就绪」（建好，并且已经在这条连接上重新订阅过事件）。
   *
   * 用途是「连接换了一条，你手里那些状态该重新对齐了」（会话要 `attach`、缓存要作废）。
   * 放在重新订阅之后：监听者拿到的连接一定已经在收事件，不必自己再订一遍。
   */
  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  /**
   * 退出时断开。
   *
   * 先标记「自己关的」再关，否则 `close()` 自己触发的那条断开通知会被当成断线去重连
   * （用户按了 Ctrl+C，后台却在拉起连接、还把会话重新 attach 上去）。
   */
  close(): void {
    this.disposed = true;
    this.offClose?.();
    this.offClose = null;
    const client = this.deps.client ?? this.current;
    this.current = null;
    this.watched = null;
    client?.close();
  }

  private async build(): Promise<ServerClient> {
    const inFlight = this.connecting;
    if (inFlight) return await inFlight;
    const attempt = (async () => {
      const client = await this.makeConnection();
      this.install(client);
      // 重新订阅：订阅按连接登记，新连接默认什么都不推
      if (this.watchWanted) {
        await client.call("events.watch");
        this.watched = client;
      }
      this.fire(this.openListeners);
      return client;
    })();
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      // 失败也要放开：否则一次瞬时故障会让这个进程永久失能（下次调用得能重试）
      this.connecting = null;
    }
  }

  private async ensureWatched(client: ServerClient): Promise<void> {
    if (this.watched === client) return;
    const inFlight = this.watching;
    if (inFlight) {
      await inFlight;
      if (this.watched === client) return;
    }
    const attempt = (async () => {
      await client.call("events.watch");
      this.watched = client;
    })();
    this.watching = attempt;
    try {
      await attempt;
    } finally {
      this.watching = null;
    }
  }

  /** 换成这条连接：先摘旧连接的断开订阅，再挂新的 */
  private install(client: ServerClient): void {
    this.offClose?.();
    this.current = client;
    // 换了连接 = 之前那次订阅随旧连接一起没了（服务端按连接登记，断线即退订）
    this.watched = null;
    this.watching = null;
    this.offClose = client.onClose(() => this.handleClose(client));
  }

  private handleClose(client: ServerClient): void {
    if (this.disposed) return;
    // 只对**当前**那条负责：旧连接迟到的通知不该把新连接报成「断了」
    if (client !== (this.deps.client ?? this.current)) return;
    this.fire(this.closeListeners);
  }

  private fire(listeners: Set<() => void>): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 一个订阅方抛错不该影响别的订阅方（与 EventHub / socket 客户端同一口径）
      }
    }
  }

  private async makeConnection(): Promise<ServerClient> {
    if (this.deps.connect) return await this.deps.connect();
    const { aiZenDir, clientInfo } = this.deps;
    if (!aiZenDir || !clientInfo) {
      throw new Error(
        "ServerConnection 需要 connect，或者 aiZenDir + clientInfo（不注入时就不知道怎么拉起服务端）",
      );
    }
    const { serverPackage, startServerProcess } = this.deps;
    return (await ensureServer({ aiZenDir, clientInfo, serverPackage, startServerProcess })).client;
  }
}
