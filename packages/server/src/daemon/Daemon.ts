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
 *   `session.*` / `workspace.*` / `events.watch`（`protocol/sessions.ts`）、`config.*` /
 *   `agent.*`（`protocol/config.ts`）。本类只管「文本行 → 帧 → 方法调用」，不认识业务，
 *   也不认识字节从哪里来（那是 `./wire.ts` 的事）。
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
import { encodeFrame, FrameDecoder, ProtocolError } from "../protocol/frames.js";
import {
  DAEMON_METHODS,
  type DaemonStatusResult,
  type PingResult,
  type ShutdownResult,
} from "../protocol/daemon.js";
import {
  isHelloRequest,
  isRequestFrame,
  PROTOCOL_VERSION,
  type EventFrame,
  type HelloResponse,
} from "../protocol/messages.js";
import {
  descriptorPath,
  removeDescriptor,
  writeDescriptor,
  type ServerDescriptor,
} from "../protocol/discovery.js";
import { isLoopbackHost } from "../protocol/host.js";
import { socketWire, type Wire } from "./wire.js";

/** 方法处理函数：拿参数、返回结果；抛错则回 `ok:false` */
export type MethodHandler = (params: unknown, connection: Connection) => Promise<unknown> | unknown;

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
  /** 业务方法表（`ping` / `status` / `shutdown` 由本类自带，同名的以注入的为准） */
  handlers?: Record<string, MethodHandler>;
  /** 空闲多久自动退出（毫秒）；`0`/不传 = 不自动退出 */
  idleTimeoutMs?: number;
  /** 日志出口（默认不输出；由 bin 接到文件） */
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** 退出前的收尾（如 flush 日志）。`stop()` 之后调用 */
  onStopped?: (reason: string) => void;
}

/** 拒绝启动时给用户看的那句话里的地址说明（判据本身的实现在 `host.ts`） */
const LOOPBACK_HOSTS_NOTE = "127.0.0.0/8 / ::1 / localhost";

export class Daemon {
  private readonly options: DaemonOptions;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly handlers = new Map<string, MethodHandler>();

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
    this.handlers.set(DAEMON_METHODS.ping, (): PingResult => ({ pong: true }));
    this.handlers.set(DAEMON_METHODS.status, () => this.status());
    this.handlers.set(DAEMON_METHODS.shutdown, (): ShutdownResult => {
      // 先让响应发出去，再收摊（一个 tick 之后再停，见 stop() 的注释）
      setTimeout(() => void this.stop("client requested"), 0);
      return { stopping: true };
    });
    for (const [name, handler] of Object.entries(options.handlers ?? {})) {
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
    // 以前这里直接 `return`，于是「客户端发 shutdown」与「进程收信号」撞车时，
    // 后来的那个调用方拿到的是「已经停了」的假象 —— 而发现文件这时可能还没删。
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

    wire.onData((chunk: string) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        const code = error instanceof ProtocolError ? error.code : "bad-frame";
        this.log("warn", `conn#${id} protocol error: ${code}`);
        if (!wire.destroyed) {
          wire.write(encodeFrame({ ok: false, error: { code, message: String(error) } }));
        }
        wire.destroy();
        return;
      }

      for (const frame of frames) {
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
        void this.dispatch(frame.id, frame.method, frame.params, connection, wire);
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
      const result = await handler(params, connection);
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
