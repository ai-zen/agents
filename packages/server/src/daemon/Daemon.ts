/**
 * 常驻服务进程 —— 只监听 loopback，只讲一种帧协议。
 *
 * ## 本版边界（v1，刻意最小）
 *
 * - **没有鉴权**：因为只绑 `127.0.0.1`。`start()` 里对 host 做了断言 —— 未鉴权的端口一旦
 *   能被非本机访问，等于把 `exec`（远程执行）送给整个局域网。要对外必须先做鉴权，没有"先
 *   开着再说"的中间态。
 * - **只有三个自带方法**：`ping` / `status` / `shutdown`（它们在任何命名空间之外，
 *   因为它们是「活着吗 / 你是谁 / 可以关了吗」这三个问题）。其余方法全部由组装根注入：
 *   `session.*` / `workspace.*` / `events.watch`（`src/protocol/` 的 `sessions.ts`）、
 *   `config.*` / `agent.*`（同一个包的 `config.ts`）、`content.upload`（`content.ts`）。本类只管
 *   「字节 → 帧 → 方法调用」，不认识业务，也不认识字节从哪里来（那是 `./wire.ts` 的事）。
 * - **握手不省**：即使现在不鉴权，首帧也必须 `hello`。将来加 token/公钥时只改握手内容，
 *   不动所有客户端的建连逻辑。
 *
 * ## 为什么帧协议与传输解耦
 *
 * 同一套帧要能跑在 TCP / WebSocket / stdio 上（将来 `ssh` 隧道、浏览器直连）。本文件只
 * 负责"文本行 → 帧 → 方法调用"，与那条线「从哪来」无关：入参是 `Wire`（`./wire.js`），
 * 六个成员，每一个都是本文件真正用到的。目前只有一种传输 —— TCP：`start()` 里把每个
 * `net.Socket` 用 `socketWire()` 包一层再交给 `handleConnection()`；加第二种传输时只新写
 * 一个 `Wire` 实现和一个监听器，本文件不用改。
 */

import { createServer, type Server } from "node:net";
import { encodeFrame, FrameDecoder, ProtocolError } from "../wire/frames.js";
import type { DaemonStatusResult, PingResult, ShutdownResult } from "../protocol/index.js";
import type { EventFrame, HelloResponse } from "../protocol/index.js";
import type { AnyMethod, ParamsOf, ResultOf } from "../protocol/api.js";
import { isHelloRequest, isRequestFrame, PROTOCOL_VERSION } from "../wire/messages.js";
import type { ServerDescriptor } from "../wire/discovery.js";
import { descriptorPath, removeDescriptor, writeDescriptor } from "../wire/discovery.js";
import { isLoopbackHost } from "../wire/host.js";
import { socketWire, type Wire } from "./wire.js";

/**
 * 一张方法表：**键必须是 `MethodApi` 的方法名**，参数与结果由方法名决定。
 *
 * 四个 handler 工厂各返回其中一部分，组装根合并成一张。写错方法名、参数类型对不上、
 * 返回的结果不是那条方法的结果 —— 都在各自的工厂里当场编译错误。
 */
export type MethodHandlers = {
  [M in AnyMethod]?: (
    params: ParamsOf<M>,
    connection: Connection,
    /**
     * 跟在帧后面的原始字节 —— 只有带字节的方法（见 `BINARY_METHODS`）会收到，其余恒为
     * `undefined`（它们的请求帧后面一个多余字节都没有）。
     */
    payload?: Buffer,
  ) => ResultOf<M> | Promise<ResultOf<M>>;
};

/**
 * 内部存放用的擦除形态：一个 `Map` 的键是运行时才知道的字符串，类型参数到不了这里。
 *
 * 这是一处**有意**的擦除，位置在「收到一帧 JSON → 查到某个 handler」这个边界上；
 * 帧本身的合法性由 `isRawRequestFrame` 判定，而「这条方法的参数长什么样」由方法表声明。
 */
export type AnyHandler = (params: never, connection: Connection, payload?: Buffer) => unknown;

/** 一条已建连的连接（握手后可用） */
export interface Connection {
  /** 连接 id，只用于日志 */
  readonly id: number;
  /** 主动推一条事件给该客户端 */
  send(event: EventFrame): void;
  /** 关闭连接（不给客户端任何"再见"帧） */
  close(): void;
  /**
   * 这条连接断开时的回调；返回取消注册的函数。
   *
   * 订阅类方法（如 `events.watch`）靠它在断开时退订：不退订就会给一条已经 destroy 的
   * 连接一直写帧，而 `write` 在 Node 里是不报错的 —— 泄漏是安静的。
   */
  onClose(listener: () => void): () => void;
}

export interface DaemonOptions {
  /** 配置根目录（`~/.ai-zen`）。**必须注入**：本包不读进程级全局 */
  aiZenDir: string;
  /** 监听地址。默认 `127.0.0.1`；非 loopback 一律拒绝启动（本版无鉴权） */
  host?: string;
  /** 端口；`0` = 让系统分配（测试用）。默认 8790 */
  port?: number;
  /** 服务端包版本，写进发现文件与握手回执 */
  version: string;
  /**
   * 业务方法表（`ping` / `status` / `shutdown` 由本类自带，同名的以注入的为准）。
   *
   * 这里是**擦除形态**：daemon 是一个按名字分发的调度器，不认识具体有哪些方法。
   * 「方法名 ↔ 参数/结果」的严格性在四个 handler 工厂的返回类型上（`MethodHandlers`）——
   * 组装根把工厂的结果合并进来，写错就是工厂那边编译错误；而测试要注入 `boom` / `echo`
   * 这类假方法，不该被真实的方法表挡住。
   */
  handlers?: Record<string, AnyHandler>;
  /** 空闲多久自动退出（毫秒）；`0`/不传 = 不自动退出 */
  idleTimeoutMs?: number;
  /** 日志出口（默认不输出；由 bin 接到文件） */
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** 退出前的收尾（如 flush 日志）。`stop()` 之后调用 */
  onStopped?: (reason: string) => void;
}

/** 拒绝启动时给用户看的那句话里的地址说明（判据本身的实现在 `host.ts`） */
const LOOPBACK_HOSTS_NOTE = "127.0.0.0/8 / ::1 / localhost";

/**
 * 请求帧后面紧跟原始字节的方法（帧形状见 `src/wire/frames.ts`）。
 *
 * 判据放在这里、而不在 handler 里：「进入二进制阶段」必须在**同步**遍历刚切出的项时决定
 * （依据方法名 + 帧里的 `bytes`），否则「下一批字节属于谁」会跟着 `dispatch` 的异步时序漂。
 *
 * 表里的名字受 `AnyMethod` 约束 —— 拼错方法名当场编译错误（而不是变成一条永远带不上
 * payload 的方法）。
 */
const BINARY_METHODS: ReadonlySet<string> = new Set(["content.upload"] satisfies AnyMethod[]);

/**
 * 这一帧后面跟多少字节（`null` = 不跟字节）。
 *
 * 两条错法都在这里判：带字节的方法没声明长度、不带字节的方法冒出一个 `bytes`。
 * 长度本身合不合法（正整数 / 上限）由 `FrameDecoder.expectBytes` 判 —— 「payload 多长
 * 算长」只有那一处判据。
 *
 * @throws ProtocolError（`bad-frame`）—— 帧形状错，整条流已经对不齐了
 */
function payloadLengthOf(method: string, params: unknown): number | null {
  const declared = (params as Record<string, unknown> | null | undefined)?.["bytes"];
  if (!BINARY_METHODS.has(method)) {
    if (declared !== undefined) {
      throw new ProtocolError("bad-frame", `${method} does not take a binary payload`);
    }
    return null;
  }
  if (typeof declared !== "number") {
    throw new ProtocolError("bad-frame", `${method} requires "bytes" (the payload length)`);
  }
  return declared;
}

export class Daemon {
  private readonly options: DaemonOptions;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly handlers = new Map<string, AnyHandler>();

  private server: Server | null = null;
  private actualPort = 0;
  /** 当前连接的**传输那一侧**（`Wire`，不是 socket）：收摊时要逐个断掉 */
  private readonly connections = new Set<Wire>();
  private readonly startedAt = new Date();
  private nextConnectionId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 收摊中的 Promise：并发调用要**等它收完**，而不是拿到一个立刻完成的空响应 */
  private stopping: Promise<void> | null = null;

  constructor(options: DaemonOptions) {
    this.options = options;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 8790;

    // 自带方法：足够让客户端判断"活着"、"是不是我这个版本"、"能不能让我关掉"
    this.handlers.set("ping", (): PingResult => ({ pong: true }));
    this.handlers.set("status", () => this.status());
    this.handlers.set("shutdown", (): ShutdownResult => {
      // 先让响应发出去，再收摊（一个 tick 之后再停，见 stop() 的注释）
      setTimeout(() => void this.stop("client requested"), 0);
      return { stopping: true };
    });
    for (const [name, handler] of Object.entries(options.handlers ?? {})) {
      // 参数类型是 `never`：把 `(params: SessionSendParams) => …` 这类强类型 handler 赋进来
      // 是安全的（参数逆变），取值时的断言只有 `dispatch` 那一处。
      this.handlers.set(name, handler);
    }
  }

  /** 实际监听端口（`start()` 之后才有值；端口传 0 时是系统分配的那个） */
  get port(): number {
    return this.actualPort;
  }

  get listening(): boolean {
    return this.server !== null && this.actualPort > 0;
  }

  /** 当前连接数（`status` 会报出去，也用于空闲判定） */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** 启动：监听 → 写发现文件 → 挂空闲计时器 */
  async start(): Promise<ServerDescriptor> {
    if (!isLoopbackHost(this.host)) {
      throw new Error(
        `refusing to listen on ${this.host}: this build has no authentication yet, ` +
          `so it is restricted to loopback (${LOOPBACK_HOSTS_NOTE})`,
      );
    }

    // TCP 这一路：`net.Socket` → `Wire` 适配器 → `handleConnection()`。
    // 换传输时变的只有这一行之后的那个函数（新写一个监听器 + 一个新 `Wire` 实现）。
    const server = createServer((socket) => this.handleConnection(socketWire(socket)));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      /**
       * 请求的端口被占 → 退回系统分配（只退一次）。
       *
       * 8790 是给「人手敲 `agents-server serve`」的默认值，不是身份 —— 客户端的端口永远来自
       * 发现文件（`server.json`）。而**同一台机器上可能有好几个守护进程**：测试 / 脚本各自
       * 一个 `AI_ZEN_DIR`、多用户，以及一次 `ai "…"` 在另一个目录里刚拉起的那个。
       *
       * 抢不到就整个起不来的代价与「端口好记」完全不成比例：客户端那边看到的是
       * `server did not become reachable within 10000ms`（`ensureServer` 在等一个永远
       * 不会写的发现文件），而真正的原因被 `stdio: "ignore"` 吞掉了。
       */
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && this.requestedPort !== 0) {
          server.listen({ host: this.host, port: 0 }, () => {
            server.off("error", onError);
            resolve();
          });
          return;
        }
        reject(error);
      };
      // 用 `on` 而不是 `once`：退回系统分配之后还可能再错一次，那一次必须走到 reject
      server.on("error", onError);
      server.listen({ host: this.host, port: this.requestedPort }, () => {
        server.off("error", onError);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("failed to determine listening port");
    }
    this.actualPort = address.port;

    const descriptor: ServerDescriptor = {
      pid: process.pid,
      host: this.host,
      port: this.actualPort,
      protocol: PROTOCOL_VERSION,
      version: this.options.version,
      startedAt: this.startedAt.toISOString(),
      schema: 1,
    };
    await writeDescriptor(this.options.aiZenDir, descriptor);
    this.log("info", `listening on ${this.host}:${this.actualPort} (pid ${process.pid})`);
    this.armIdleTimer();
    return descriptor;
  }

  /** 停止：拒新连接 → 关掉现有连接 → 删发现文件 */
  async stop(reason: string): Promise<void> {
    // 已经有人在收摊：把同一个 Promise 交出去。
    // 不这样的话，「客户端发 shutdown」与「进程收信号」撞车时，后来那个调用方拿到的是
    // 「已经停了」的假象 —— 而发现文件这时可能还没删。
    this.stopping ??= this.doStop(reason);
    return await this.stopping;
  }

  private async doStop(reason: string): Promise<void> {
    this.clearIdleTimer();

    for (const wire of this.connections) wire.destroy();
    this.connections.clear();

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.actualPort = 0;

    // 发现文件必须删：留着它，下一个客户端会连到一个已经没人监听的端口
    await removeDescriptor(this.options.aiZenDir);
    this.log("info", `stopped: ${reason}`);
    this.options.onStopped?.(reason);
  }

  // ==================================================================
  // 连接处理
  // ==================================================================

  /**
   * 接一条**已经建好的双工线**：首帧 `hello` → 帧分发 → 断开清理。
   *
   * 为什么是 public：这就是传输的插口，也是本类唯一对外开放的连接入口。TCP 那一路在
   * `start()` 里把每个 `net.Socket` 包成 `Wire` 后调它；将来 WebSocket 的监听器做同一件事
   * （把 `ws` 的文本帧包成 `Wire`，然后调这一行），本类不用改。用例也从这扇门进来喂一个
   * 内存双工 —— 所以没有「只为测试存在」的构造参数或分支。
   */
  handleConnection(wire: Wire): void {
    const id = this.nextConnectionId++;
    const decoder = new FrameDecoder();
    let handshaken = false;
    /**
     * 等 payload 的那一帧（见 `wire.onData` 里的说明）。
     *
     * 它必须活到**整条连接**，而不是一个 chunk：payload 可以跨多个 chunk 才收满。
     */
    let awaitingPayload: { id: number; method: string; params: unknown } | null = null;
    const closeListeners = new Set<() => void>();

    this.connections.add(wire);
    this.clearIdleTimer();

    const connection: Connection = {
      id,
      send: (event) => {
        if (!wire.destroyed) wire.write(encodeFrame(event));
      },
      close: () => wire.destroy(),
      onClose: (listener) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    };

    const fail = (code: string, message: string) => {
      this.log("warn", `conn#${id} rejected: ${code} ${message}`);
      if (!wire.destroyed)
        wire.write(
          encodeFrame({
            kind: "hello",
            ok: false,
            error: { code, message },
          } satisfies HelloResponse),
        );
      wire.destroy();
    };

    /**
     * 帧层违规（非法帧 / 超限 / 带字节的帧声明了非法长度）。
     *
     * 一律断开：这条流已经对不齐了（下一帧从哪里开始不知道），继续读只会把后面的字节
     * 当成帧解析，错误会以更难查的形式出现在别处。
     */
    const rejectProtocol = (error: unknown) => {
      const code = error instanceof ProtocolError ? error.code : "bad-frame";
      this.log("warn", `conn#${id} protocol error: ${code}`);
      if (!wire.destroyed) {
        wire.write(encodeFrame({ ok: false, error: { code, message: String(error) } }));
      }
      wire.destroy();
    };

    wire.onData((chunk: Buffer) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        rejectProtocol(error);
        return;
      }

      /**
       * 一项一项取，而不是一次把 chunk 切完。
       *
       * 判据在**这一层**：帧之后跟的是不是二进制 payload，只有认识方法名的调用方知道。
       * 所以顺序是「取一帧 → 判它带不带字节 → （带就）`expectBytes` → 再取下一项」，
       * 全程同步 —— 这也是「先存帧、收到 payload 再派发」那个选择成立的前提：帧的派发可以
       * 异步，但「哪段字节属于哪一帧」在这串同步里就定死了。
       *
       * `awaitingPayload` 同一时刻最多一个：解码器是串行的（二进制阶段收满之前不会
       * 吐出下一帧）。
       */
      try {
        for (let item = decoder.next(); item; item = decoder.next()) {
          if (item.type === "bytes") {
            const pending = awaitingPayload;
            awaitingPayload = null;
            // 没有帧在等：帧形状自相矛盾（多出来一段没人认领的字节）
            if (!pending) throw new ProtocolError("bad-frame", "binary payload without a frame");
            void this.dispatch(
              pending.id,
              pending.method,
              pending.params,
              connection,
              wire,
              item.bytes,
            );
            continue;
          }

          const frame = item.frame;
          if (!handshaken) {
            if (!isHelloRequest(frame)) {
              fail("bad-handshake", "first frame must be hello");
              return;
            }
            if (frame.protocol !== PROTOCOL_VERSION) {
              fail(
                "version-mismatch",
                `client speaks protocol ${frame.protocol}, this server speaks ${PROTOCOL_VERSION}`,
              );
              return;
            }
            handshaken = true;
            wire.write(
              encodeFrame({
                kind: "hello",
                ok: true,
                server: {
                  name: "@ai-zen/agents-server",
                  version: this.options.version,
                  protocol: PROTOCOL_VERSION,
                  pid: process.pid,
                  startedAt: this.startedAt.toISOString(),
                },
              } satisfies HelloResponse),
            );
            continue;
          }

          if (!isRequestFrame(frame)) {
            wire.write(
              encodeFrame({
                ok: false,
                error: { code: "bad-frame", message: "expected a request frame" },
              }),
            );
            continue;
          }

          // 带字节的请求帧：进入二进制阶段（后面恰好 `bytes` 个字节），帧本身等收到字节再派发
          const length = payloadLengthOf(frame.method, frame.params);
          if (length !== null) {
            decoder.expectBytes(length);
            awaitingPayload = { id: frame.id, method: frame.method, params: frame.params };
            continue;
          }

          void this.dispatch(frame.id, frame.method, frame.params, connection, wire);
        }
      } catch (error) {
        rejectProtocol(error);
      }
    });

    wire.onClose(() => {
      this.connections.delete(wire);
      for (const listener of closeListeners) listener();
      closeListeners.clear();
      this.log("info", `conn#${id} closed (open: ${this.connections.size})`);
      this.armIdleTimer();
    });
    wire.onError((error) => {
      this.log("warn", `conn#${id} socket error: ${error.message}`);
    });
  }

  private async dispatch(
    id: number,
    method: string,
    params: unknown,
    connection: Connection,
    wire: Wire,
    payload?: Buffer,
  ): Promise<void> {
    const handler = this.handlers.get(method);
    if (!handler) {
      writeIfOpen(wire, {
        id,
        ok: false,
        error: { code: "unknown-method", message: `unknown method: ${method}` },
      });
      return;
    }
    try {
      // 唯一的断言：`params` 是解出来的 JSON（合法性已由 `isRawRequestFrame` 判过形状），
      // 具体形状由方法表声明。
      const result = await handler(params as never, connection, payload);
      writeIfOpen(wire, { id, ok: true, result });
    } catch (error: any) {
      writeIfOpen(wire, {
        id,
        ok: false,
        error: { code: error?.code ?? "internal", message: error?.message ?? String(error) },
      });
    }
  }

  // ==================================================================
  // 空闲退出
  // ==================================================================

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const timeout = this.options.idleTimeoutMs ?? 0;
    if (timeout <= 0 || this.stopping) return;
    this.idleTimer = setTimeout(() => {
      // 到期时再确认一次：这期间可能有连接进来（armIdleTimer 会重挂，但保险起见）
      if (this.connections.size === 0) {
        this.log("info", `idle for ${timeout}ms, exiting`);
        void this.stop("idle timeout");
      }
    }, timeout);
    // 不因这个计时器让进程拒绝退出
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ==================================================================
  // 内部
  // ==================================================================

  private status(): DaemonStatusResult {
    return {
      version: this.options.version,
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
      host: this.host,
      port: this.actualPort,
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Date.now() - this.startedAt.getTime(),
      connections: this.connections.size,
      descriptorPath: descriptorPath(this.options.aiZenDir),
    };
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, message);
  }
}

function writeIfOpen(wire: Wire, frame: unknown): void {
  if (!wire.destroyed) wire.write(encodeFrame(frame));
}
