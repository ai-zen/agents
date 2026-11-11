/**
 * 常驻服务进程 —— 只监听 loopback，只讲 JSON-RPC 2.0 over WebSocket。
 *
 * ## 本版边界（v3，刻意最小）
 *
 * - **鉴权只有一串不透明 token**：`hello` 的 `params.token` 必须与服务端手上那串相等（注入
 *   的从构造时就生效，没注入则在 `start()` 时读或生成 `<aiZenDir>/run/token`，见
 *   `wire/token.ts`）。失败回 `unauthorized` —— 请求级失败，**不断连**（客户端可以改正
 *   重试；而断连反而暴露"这个端口存在"）。
 * - **仍然只绑 loopback**，而且**不是**因为没鉴权了：远程访问走隧道 / 反向代理（nginx 在
 *   同机反代到 `127.0.0.1`，正好落进 `start()` 里那条断言）。服务端**永不实现 TLS、永不绑
 *   非 loopback** —— `wss://` 是客户端的一个能力，不是服务端的一个模式。
 * - **浏览器来源另有一道 Origin 校验**（`start()` 的 `upgrade` 回调）：无 `Origin` 放行
 *   （非浏览器客户端由 token 兜）、`Origin` 的 hostname 是 loopback 放行、在
 *   `DaemonOptions.allowedOrigins` 里放行，其余一律 **`403` 拒绝升级**（此刻 WS 还没建立，
 *   回 WS close 码是错误的）。定位是纵深防御：真正挡住"任意网页连裸端口"的是 token（网页
 *   读不到本地那个 0600 文件）。
 * - **只有四个自带方法**：`hello` / `ping` / `status` / `shutdown`（它们在任何命名空间之外，
 *   因为它们是「能不能开始用 / 活着吗 / 你是谁 / 可以关了吗」这四个问题）。其余方法全部由
 *   组装根注入：`session.*` / `workspace.*` / `events.watch`（`src/protocol/` 的 `sessions.ts`）、
 *   `config.*` / `agent.*`、`content.upload`。本类只管「一条消息 → 方法调用」，不认识业务，
 *   也不认识消息从哪里来（那是 `./wire.ts` 的事）。
 * - **握手不省**：第一条请求必须是 `hello`，协议版本与凭证都在它的 `params` 里。所有客户端
 *   的建连逻辑因此只有一处（`HelloParams`），没有「先发一个专门的鉴权帧」那种第二套顺序。
 *
 * ## 一条消息怎么变成一次调用
 *
 * 文本消息直接 `JSON.parse`，然后只看两个键在不在（判别规则见 `protocol/messages.ts`）：
 * 有 `method` 是请求；无 `method` 有 `id` 是响应（服务端不会收到）。有 `method`、没有 `id` 的
 * 是**通知**，按 JSON-RPC 原文（服务端 MUST NOT reply to a Notification）**静默丢弃**；
 * 其余同不出来的（顶层数组 / 缺 `method` / 外壳不合法）回一条 `invalid-request`，**不断连**。
 *
 * 带字节的请求（`content.upload`）是**两条** WS 消息：先一条文本请求（`params` 里只有
 * 普通参数），再一条二进制消息（前 4 字节是这条请求的 `id`，其余是载荷）。所以文本先到、
 * 字节后到，两者靠 `id` 配对 —— 见 `awaitingBinary`。
 *
 * ## 断连情形收敛成六条（其余一律回错误、连接继续）
 *
 *   1. 一条消息超过 WS 层的 `maxPayload`（64 MiB）—— 那条消息根本没被收下，没有可回应之物；
 *   2. 文本消息超过实现层的 8 MiB（同上，没有恢复路径）；
 *   3. 握手阶段协议版本不匹配（断代：后面每条消息的形状都不可信）；
 *   4. 二进制消息的 `id` 找不到在飞请求 —— WS 单连接**保序**，所以这只可能是实现错误；
 *   5. 同一个 `id` 收到第二块二进制 —— 同上；
 *   6. 二进制消息不足 4 字节（连 `id` 都读不出来）。
 *
 * 共同性质：**这条连接再也无法继续**。其余全部「回一条错误、连接照旧」，**包括不是合法
 * JSON 的文本**：WS 已经给了消息边界，「这一条不是 JSON」不再等于「后面的字节全部错位」。
 * 上一版把非法 JSON 当成流错位而断连，那个判据来自 JSON-lines 时代，本版作废。
 *
 * 凭证不对（`unauthorized`）在这六条之外：它回一条错误、连接照旧 —— 客户端换一条 `hello`
 * 就能继续说（见 `protocol/errors.ts` 该码的注释）。
 *
 * ## 为什么传输与派发解耦
 *
 * 入参是 `Wire`（`./wire.js`）：七个成员，每一个都是本文件真正用到的。`start()` 里把每个
 * WebSocket 用 `webSocketWire()` 包一层再交给 `handleConnection()`；加第二种传输时只新写
 * 一个 `Wire` 实现和一个监听器，本文件不用改。
 */

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { encodeFrame, MAX_PAYLOAD_BYTES, MAX_TEXT_BYTES } from "../wire/frames.js";
import type {
  DaemonStatusResult,
  ErrorFrame,
  EventNotification,
  HelloParams,
  HelloResult,
  PingResult,
  ResultFrame,
  ServerEvent,
  ShutdownResult,
} from "../protocol/index.js";
import type { AnyMethod, ParamsOf, ResultOf } from "../protocol/api.js";
import type { ErrorCode } from "../protocol/errors.js";
import {
  isRequestFrame,
  PROTOCOL_VERSION,
  readRequestId,
  REQUEST_ID_BYTES,
} from "../wire/messages.js";
import { rpcCodeOf } from "../wire/errors.js";
import type { ServerDescriptor } from "../wire/discovery.js";
import { descriptorPath, removeDescriptor, writeDescriptor } from "../wire/discovery.js";
import { isLoopbackHost } from "../wire/host.js";
import { ensureToken } from "../wire/token.js";
import { webSocketWire, type Wire } from "./wire.js";

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
     * 这条请求的**二进制载荷** —— 只有带字节的方法（见 `BINARY_METHODS`）会收到，其余恒为
     * `undefined`（它们的请求只有一条文本消息）。空载荷是长度 0 的 `Buffer`（不是
     * `undefined`）：那说明对端确实发了二进制消息，只是里面没有内容，该由 handler 判。
     */
    payload?: Buffer,
  ) => ResultOf<M> | Promise<ResultOf<M>>;
};

/**
 * 内部存放用的擦除形态：一个 `Map` 的键是运行时才知道的字符串，类型参数到不了这里。
 *
 * 这是一处**有意**的擦除，位置在「收到一条消息 → 查到某个 handler」这个边界上；
 * 外壳的合法性由 `isRequestFrame` 判定，而「这条方法的参数长什么样」由方法表声明。
 */
export type AnyHandler = (params: never, connection: Connection, payload?: Buffer) => unknown;

/** 一条已建连的连接（握手后可用） */
export interface Connection {
  /** 连接 id，只用于日志 */
  readonly id: number;
  /** 主动推一条事件给该客户端（包成 `session.event` 通知） */
  send(event: ServerEvent): void;
  /** 关闭连接（不再回任何东西） */
  close(): void;
  /**
   * 这条连接断开时的回调；返回取消注册的函数。
   *
   * 订阅类方法（如 `events.watch`）靠它在断开时退订：不退订就会给一条已经关掉的连接一直
   * 写消息，而写一条关掉的连接是不报错的 —— 泄漏是安静的。
   */
  onClose(listener: () => void): void;
}

export interface DaemonOptions {
  /** 配置根目录（`~/.ai-zen`）。**必须注入**：本包不读进程级全局 */
  aiZenDir: string;
  /**
   * 监听地址。默认 `127.0.0.1`；非 loopback 一律拒绝启动（远程走隧道 / 反向代理，
   * 服务端永不实现 TLS、永不绑非 loopback）
   */
  host?: string;
  /** 端口；`0` = 让系统分配（测试用）。默认 8790 */
  port?: number;
  /**
   * 注入的凭证（`hello` 的 `params.token` 要与之相等）。
   *
   * 不传 = `start()` 时用 `ensureToken(aiZenDir)` 读或生成 `<aiZenDir>/run/token`。
   * 注入的用处有两个：用例不必为了拿一串凭证去读文件，以及凭证由别处管理（容器编排把
   * 密钥挂进来）时不必假装它住在 `aiZenDir` 里。
   *
   * **空字符串或全空白按「没有注入」处理**：那不是一个长度为 0 的凭证，而是「宿主读到了一个
   * 空值」（密钥存储里那一项是空的、配置项写成 `AI_ZEN_TOKEN=`）。于是 `start()` 回落到
   * `ensureToken()` 读或生成文件，而不会变成「空凭证 = 人人可进」（判据见
   * `normalizeInjectedToken`）。
   */
  token?: string;
  /**
   * 额外允许的浏览器 `Origin`（完整串，如 `https://your.domain`；默认空 = 只允许 loopback）。
   *
   * 判据在 `start()` 的 `upgrade` 回调里：无 `Origin` 放行、loopback hostname 放行、
   * 在这个名单里放行，其余 `403` 拒绝升级。名字里的 `allowed` 是「除了默认那一条之外还
   * 允许谁」，不是「允许谁」的全集 —— loopback 永远放行（与端口无关）。
   */
  allowedOrigins?: string[];
  /** 服务端包版本，写进发现文件与握手回执 */
  version: string;
  /**
   * 业务方法表（`hello` / `ping` / `status` / `shutdown` 由本类自带，同名的以注入的为准）。
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
  /**
   * 收摊中间的一步：**连接已全部关掉、发现文件还没删** 的那一刻（`stop()` 里调）。
   *
   * 为什么需要这个缝：收摊的五步有先后（拒新连接 → 关连接 → 停会话 → flush 日志 → 删
   * 发现文件 → 退出），而「停会话」不属于传输层。本类只管前两步与删发现文件；中间那一步
   * 交给持有者（`ServerApp`）—— 它才手上有会话。顺序不能倒：先删发现文件再停会话的话，
   * 下一个客户端有可能在会话还没收完时就接上一个已经没有会话的进程。
   */
  onDrained?: (reason: string) => void | Promise<void>;
}

/** 拒绝启动时给用户看的那句话里的地址说明（判据本身的实现在 `host.ts`） */
const LOOPBACK_HOSTS_NOTE = "127.0.0.0/8 / ::1 / localhost";

/** 握手回执里自称的名字（与 `version.ts` 的 `SERVER_NAME` 同值；本类不为此多一个依赖） */
const SERVER_NAME = "@ai-zen/agents-server";

/**
 * 要收二进制载荷的方法（线上会多一条二进制消息的那些）。
 *
 * 判据放在这里、而不在 handler 里：收到文本请求时**先不派发**，等它的二进制帧到了再一起
 * 派发。这个「等」必须由认识方法名的那一层决定 —— handler 只拿到参数与载荷，它无法表达
 * 「我还没收到字节」。
 *
 * 表里的名字受 `AnyMethod` 约束 —— 拼错方法名当场编译错误（而不是变成一条永远等不到载荷、
 * 也就永远不会被派发的方法）。
 */
const BINARY_METHODS: ReadonlySet<string> = new Set(["content.upload"] satisfies AnyMethod[]);

export class Daemon {
  private readonly options: DaemonOptions;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly handlers = new Map<string, AnyHandler>();

  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private actualPort = 0;
  /**
   * 本进程的凭证（注入的从构造时就生效；没注入则在 `start()` 时读 / 生成
   * `<aiZenDir>/run/token`）。
   *
   * `null` = 还没定（`start()` 之前，或用例直接 `handleConnection()` 喂连接的那种），**或**
   * 注入的是空串 / 全空白（赋值处已经归一，见 `normalizeInjectedToken`）。此时任何 `hello`
   * 都对不上 —— 没有凭证就没有「对的凭证」，这是 fail-closed 的那一侧。
   *
   * 它**绝不进日志**：日志里最多出现 token 文件的路径。
   */
  private token: string | null = null;
  /** 当前连接的**传输那一侧**（`Wire`，不是 WebSocket）：收摊时要逐个断掉 */
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
    // 注入的凭证从构造时就生效：它不依赖「读文件」，也就不依赖 `start()` —— 用例直接
    // `handleConnection()` 喂连接时（没有监听的场景）也是同一把锁。
    // 空串 / 全空白在这里就归一成「没有凭证」：空凭证等于人人可进，理由见
    // `normalizeInjectedToken`。与 `start()` 那处走同一个函数，两处口径不会分叉。
    this.token = normalizeInjectedToken(options.token);

    // 自带方法：足够让客户端判断"能不能开始用"、"活着"、"是不是我这个版本"、"能不能让我关掉"
    this.handlers.set("hello", (): HelloResult => this.identity());
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

  /** 启动：拿凭证 → 监听 → 写发现文件 → 挂空闲计时器 */
  async start(): Promise<ServerDescriptor> {
    // 凭证：注入的优先（构造函数里已经生效，这里再写一遍是为了让两处口径写在一起），
    // 否则读或生成那个 0600 文件 —— 文件读写是异步的，只可能在这里做。`start()` 失败
    // （比如下面那条 loopback 断言）时留下的文件无害：下次启动直接复用它。
    // 归一也走构造时那个函数：注入空串 / 全空白等价于「没注入」，于是回落到「读或生成文件」
    // —— 既不退化成「没有凭证谁都进不来」，也不变成「空凭证人人可进」。
    this.token =
      normalizeInjectedToken(this.options.token) ?? (await ensureToken(this.options.aiZenDir));

    // 只绑 loopback。**不是因为没鉴权**（现在有了），而是这条边界横在「同一台机器」上：
    // 远程访问走隧道 / 反向代理（nginx 在同机反代到 `127.0.0.1`，正好落进这条断言）；服务端
    // 永不实现 TLS、永不绑非 loopback —— `wss://` 是客户端的一个能力，不是服务端的一个模式。
    if (!isLoopbackHost(this.host)) {
      throw new Error(
        `refusing to listen on ${this.host}: this server only listens on loopback ` +
          `(${LOOPBACK_HOSTS_NOTE}) — remote access goes through a tunnel or a reverse proxy ` +
          `in front of 127.0.0.1`,
      );
    }

    // HTTP 服务器只是 WebSocket 的承载（握手要先有一次 HTTP upgrade）。普通 HTTP 请求
    // 回一句 426：这条端口只讲 WebSocket，说清楚比静默挂住有用。
    const server = createServer((_request, response) => {
      response.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
      response.end("this endpoint speaks WebSocket only\n");
    });
    // `noServer`：升级由我们自己从 HTTP 服务器的 `upgrade` 事件里接，ws 不再另开监听。
    // `maxPayload` 是**单条消息**的上限（64 MiB）：超了由 ws 直接断连（见文件头「六条断连」）。
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    server.on("upgrade", (request, socket, head) => {
      // 来源校验（纵深防御，判据见 `isOriginAllowed`）。拒绝必须发生在**升级之前**：
      // 此刻连 `101` 都还没发出去，对端收到的是一个 HTTP 响应而不是一条 WS 连接 ——
      // 所以这里回 WS close 码是错误的（没有连接可关）。
      const origin = request.headers.origin;
      if (!isOriginAllowed(origin, this.options.allowedOrigins ?? [])) {
        this.log("warn", `refused upgrade from origin ${String(origin)}`);
        const body = "origin not allowed\n";
        // 一个**完整的** HTTP 响应（状态行 + 头 + 空行 + body）：对端此刻读的是 HTTP，
        // 不是 WS 帧。`end` 的 callback 在数据都交出去之后才调 —— 紧接着就 destroy 的话，
        // 缓冲里那几行可能一个字节都到不了对端。
        socket.end(
          "HTTP/1.1 403 Forbidden\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            "\r\n" +
            body,
          () => socket.destroy(),
        );
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.handleConnection(webSocketWire(ws)));
    });
    this.server = server;
    this.wss = wss;

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

  /** 停止：拒新连接 → 关连接 →（停会话 / flush 日志）→ 删发现文件 → 退出 */
  async stop(reason: string): Promise<void> {
    // 已经有人在收摊：把同一个 Promise 交出去。
    // 不这样的话，「客户端发 shutdown」与「进程收信号」撞车时，后来那个调用方拿到的是
    // 「已经停了」的假象 —— 而发现文件这时可能还没删。
    this.stopping ??= this.doStop(reason);
    return await this.stopping;
  }

  private async doStop(reason: string): Promise<void> {
    this.clearIdleTimer();

    // ① 拒新连接：先把升级通道关掉（noServer 模式下 close() 只是把它标成不再接受升级，
    //    没有监听句柄要释放），这样接下来的销毁不会有过路的新连接插进来
    if (this.wss) {
      const wss = this.wss;
      this.wss = null;
      wss.close();
    }

    // ② 关连接：现有的全部断掉
    for (const wire of this.connections) wire.destroy();
    this.connections.clear();

    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 关闭帧是异步的：收摊不该等对端回应。这里直接掐掉所有底层连接，
        // 否则一个不回应的客户端会把 `close()` 的 callback 永远吊住
        server.closeAllConnections();
      });
    }
    this.actualPort = 0;

    // ③④ 停会话 / flush 日志：连接已经全没了，而发现文件还在（交给持有者）
    await this.options.onDrained?.(reason);

    // ⑤ 发现文件必须删：留着它，下一个客户端会连到一个已经没人监听的端口
    await removeDescriptor(this.options.aiZenDir);
    this.log("info", `stopped: ${reason}`);
    // ⑥ 退出（也交给持有者：日志 flush 完才走）
    this.options.onStopped?.(reason);
  }

  // ==================================================================
  // 连接处理
  // ==================================================================

  /**
   * 接一条**已经建好的双工线**：握手门 → 消息分类 → 派发 → 断开清理。
   *
   * 为什么是 public：这就是传输的插口，也是本类唯一对外开放的连接入口。`start()` 里把每个
   * WebSocket 包成 `Wire` 后调它；用例也从这扇门进来喂一个内存双工 —— 所以没有「只为测试
   * 存在」的构造参数或分支。
   */
  handleConnection(wire: Wire): void {
    const id = this.nextConnectionId++;
    let handshaken = false;
    /**
     * 已经收到文本请求、正在等它那条二进制消息的请求（`id → 那条请求`）。
     *
     * 这是「文本先到、字节后到」的配对表：WS 单连接保序，所以二进制消息必然晚于它的请求；
     * 反过来（先到字节）就是实现错误，见 `onBinary`。
     */
    const awaitingBinary = new Map<number, { method: string; params: unknown }>();
    const closeListeners = new Set<() => void>();

    this.connections.add(wire);
    this.clearIdleTimer();

    const connection: Connection = {
      id,
      send: (event) => writeIfOpen(wire, eventNotification(event)),
      close: () => wire.destroy(),
      onClose: (listener) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    };

    /** 回一条错误响应，连接照旧（请求级失败都走它，见文件头「六条断连」里的「其余一律」） */
    const replyError = (requestId: number | null, code: ErrorCode, message: string): void => {
      this.log("warn", `conn#${id} rejected: ${code} ${message}`);
      writeIfOpen(wire, errorFrame(requestId, code, message));
    };

    /**
     * 回一条错误响应**然后**断连。
     *
     * 本版只有一处用得上：版本真的不匹配（文件头六条里的第 ③ 条，见 `protocol/errors.ts`
     * 的 `version-mismatch`）。顺序不能反 —— 先把错误发出去，再关连接（`Wire.destroy()` 是
     * 优雅关闭，会把排队中的那条响应发完）。
     */
    const failAndClose = (requestId: number | null, code: ErrorCode, message: string): void => {
      replyError(requestId, code, message);
      this.log("warn", `conn#${id} closing: ${code}`);
      wire.destroy();
    };

    /** 收到一条文本消息：解析 → 分类 → 握手门 → （带字节的方法先挂起）→ 派发 */
    const onText = (text: string): void => {
      // 实现层的文本上限（二进制可以用满 WS 的 64 MiB，见 `wire/frames.ts`）。
      // 超限**断连且不回错误响应**（与 `maxPayload` 那一档同一个道理）：没有可回应之物 ——
      // 这条消息在体积上就没被收下，而且「同一段内容再发一遍还是这么大」，没有恢复路径。
      // 它与「不是合法 JSON」是两件事：后者回 `bad-frame`、不断连。
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        this.log("warn", `conn#${id} closing: text message exceeds ${MAX_TEXT_BYTES} bytes`);
        wire.destroy();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // 不是合法 JSON。上一版在这里断连（"流已经对不齐了"），本版不断：WS 给了消息边界
        replyError(null, "bad-frame", "message is not valid JSON");
        return;
      }

      if (isNotification(parsed)) {
        // JSON-RPC 原文：服务端 **MUST NOT** reply to a Notification。回一条错误是违反标准
        // （也把「客户端只管发、不管答」的那类用法变成噪声）。静默丢弃，连接照旧。
        // 排在外壳判定之前：通知没有 `id`，`isRequestFrame` 必然不认它。
        this.log(
          "info",
          `conn#${id} dropped notification: ${String((parsed as { method: string }).method)}`,
        );
        return;
      }

      if (!isRequestFrame(parsed)) {
        // 顶层数组（批量）/ 缺 method / 缺 `jsonrpc` / `id` 不合规 / 来了响应：
        // 都归不到任何一条请求，`id` 只能是 null
        replyError(null, "invalid-request", "message is not a valid request object");
        return;
      }

      const request = parsed;

      if (handshaken) {
        // 握手只有一次：重放不是「再来一遍」
        if (request.method === "hello") {
          replyError(request.id, "invalid-request", "hello has already been accepted");
          return;
        }
      } else {
        if (request.method !== "hello") {
          // 请求级失败：回错误就好，客户端补上 `hello` 就能继续用（不断连）
          replyError(
            request.id,
            "handshake-required",
            `first request must be hello, got ${request.method}`,
          );
          return;
        }
        // 版本从 `hello` 的普通参数里读（握手就是一条普通方法，见 `protocol/messages.ts`）。
        // 这里分两步，**形状错误与版本不匹配不是同一件事**（A27 / A31）：
        //   · 参数不是对象 / 没有 `protocol` / `protocol` 不是数字 → `bad-params`，**不断连**：
        //     客户端该改的是请求体，而报成 `version-mismatch` 会让人跑去改版本号；
        //   · 是数字但不等于本版的版本 → `version-mismatch` + 断连（断代：后面每条消息的形状
        //     都不可信，这是唯一需要断连的请求级失败）。
        const helloParams = request.params;
        if (typeof helloParams !== "object" || helloParams === null || Array.isArray(helloParams)) {
          replyError(
            request.id,
            "bad-params",
            `hello expects object params, got ${helloParams === null ? "null" : typeof helloParams}`,
          );
          return;
        }
        const protocol = (helloParams as Partial<HelloParams>).protocol;
        if (typeof protocol !== "number") {
          // 缺失或不是数字：仍是形状错（`{protocol:"2"}` 与 `{}` 同一种毛病），不是版本不同
          replyError(
            request.id,
            "bad-params",
            `hello expects a numeric "protocol", got ${protocol === undefined ? "nothing" : typeof protocol}`,
          );
          return;
        }
        if (protocol !== PROTOCOL_VERSION) {
          // 断代：版本不同意味着后面每条消息的形状都不可信
          failAndClose(
            request.id,
            "version-mismatch",
            `client speaks protocol ${String(protocol)}, this server speaks ${PROTOCOL_VERSION}`,
          );
          return;
        }
        // 凭证。**先形状后值**（与上面 `protocol` 同一把尺子，见 `protocol/errors.ts`）：
        //   · `token` 不是字符串 / 缺失 → `bad-params` —— 要改的是请求体；
        //   · 是字符串但不等 → `unauthorized` —— 要改的是凭证。
        // 两者都**不断连**（用 `replyError`，不是 `failAndClose`）：客户端换一条 `hello` 就能
        // 继续说；而挂断反而让扫描方知道"这个端口上确实有服务在听"。日志里只有错误码，
        // **token 本身一个字都不许进日志**。
        const token = (helloParams as Partial<HelloParams>).token;
        if (typeof token !== "string") {
          replyError(
            request.id,
            "bad-params",
            `hello expects a string "token", got ${token === undefined ? "nothing" : typeof token}`,
          );
          return;
        }
        if (!this.tokenMatches(token)) {
          replyError(request.id, "unauthorized", "token does not match this server");
          return;
        }
        // 握手成功。置位在派发之前：`hello` 的 handler 只是返回身份，没有失败路径
        handshaken = true;
      }

      if (BINARY_METHODS.has(request.method)) {
        // 带字节的请求：先不派发，等它的二进制消息到了再一起走（见 `onBinary`）
        awaitingBinary.set(request.id, { method: request.method, params: request.params });
        return;
      }

      void this.dispatch(request.id, request.method, request.params, connection, wire);
    };

    /** 收到一条二进制消息：前 4 字节是请求 `id`，其余是载荷 */
    const onBinary = (bytes: Buffer): void => {
      const requestId = readRequestId(bytes);
      if (requestId === null) {
        // 连 `id` 都读不出来：归不到任何请求，回不了错误，只可能是实现错误
        this.log("warn", `conn#${id} closing: binary message shorter than ${REQUEST_ID_BYTES}B`);
        wire.destroy();
        return;
      }
      const pending = awaitingBinary.get(requestId);
      if (!pending) {
        // WS 单连接保序 → 二进制必然晚于它的请求。早到（或同一个 id 的第二块）只可能是
        // 实现错误，而且无从回复（错误归不到任何在飞请求）—— 断连
        this.log("warn", `conn#${id} closing: no request waiting for binary payload ${requestId}`);
        wire.destroy();
        return;
      }
      awaitingBinary.delete(requestId);
      // 空载荷（正好 4 字节）照样派发：长度 0 交给 handler 判（它回 `bad-params`）
      void this.dispatch(
        requestId,
        pending.method,
        pending.params,
        connection,
        wire,
        bytes.subarray(REQUEST_ID_BYTES),
      );
    };

    wire.onText(onText);
    wire.onBinary(onBinary);

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
      writeIfOpen(wire, errorFrame(id, "unknown-method", `unknown method: ${method}`));
      return;
    }
    try {
      // 唯一的断言：`params` 是解出来的 JSON（外壳合法性已由 `isRequestFrame` 判过），
      // 具体形状由方法表声明。
      const result = await handler(params as never, connection, payload);
      writeIfOpen(wire, { jsonrpc: "2.0", id, result } satisfies ResultFrame);
    } catch (error) {
      // 码是 handler 抛出来的那个（业务层 `CodedError.code`），没有就是 `internal`：
      // 「服务端自己出的事」与「你参数错了」是两件不同的事，客户端处置也不同
      writeIfOpen(wire, errorFrame(id, codeOfThrown(error), messageOfThrown(error)));
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

  /**
   * 这条 `hello` 带来的 token 是不是本进程那把钥匙。
   *
   * 用 `crypto.timingSafeEqual` 而不是 `===`：它保证「比到第几个字符才发现不同」不反映在
   * 耗时上。但它的入参必须是**长度相等**的两串（不等长会直接抛错），所以先比长度 ——
   * 长度不等就是不等，没有必要进那个常数时间的比较。
   */
  private tokenMatches(candidate: string): boolean {
    const expected = this.token;
    // 没有凭证 = 没有任何东西能对上：fail-closed。这里的 `null` 不只是「`start()` 没跑过」——
    // 注入的值是空串 / 全空白时，赋值处（构造函数与 `start()`）已经把它归一成 `null`，所以
    // 那条路也走这里。空串若被当成一把（长度为 0 的）钥匙，就是「人人可进」：客户端没有凭证
    // 时发的恰恰是 `token: ""`（`wire/call-once.ts`）。见 `normalizeInjectedToken`。
    if (expected === null) return false;
    const given = Buffer.from(candidate, "utf8");
    const wanted = Buffer.from(expected, "utf8");
    if (given.length !== wanted.length) return false;
    return timingSafeEqual(given, wanted);
  }

  /** 握手的回执：这个进程是谁、说的是哪个版本 */
  private identity(): HelloResult {
    return {
      name: SERVER_NAME,
      version: this.options.version,
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
      startedAt: this.startedAt.toISOString(),
    };
  }

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

// ==================================================================
// 线上对象的两条出站形状
// ==================================================================

/**
 * 一条错误响应：`error.code` 是 JSON-RPC 的数字码（由字符串码映射来），`error.data.code`
 * 是原来的字符串码 —— 客户端看后者决定怎么办（见 `protocol/messages.ts` 的 `ErrorObject`）。
 */
function errorFrame(requestId: number | null, code: ErrorCode, message: string): ErrorFrame {
  return {
    jsonrpc: "2.0",
    id: requestId,
    error: { code: rpcCodeOf(code), message, data: { code } },
  };
}

/** 一条事件通知：15 个事件共用 method `session.event`，具体哪件事由 `params.event` 说 */
function eventNotification(event: ServerEvent): EventNotification {
  return { jsonrpc: "2.0", method: "session.event", params: event };
}

function writeIfOpen(wire: Wire, frame: ResultFrame | ErrorFrame | EventNotification): void {
  if (!wire.destroyed) wire.write(encodeFrame(frame));
}

/**
 * 这条升级请求的 `Origin` 能不能进（纵深防御；真正挡住「任意网页连裸端口」的是 token）。
 *
 * 三条放行，一条拒绝：
 *
 *   · **没有 `Origin`** —— 终端 / 桌面端 / 脚本都不发这个头（浏览器的 WS 握手才强制带它），
 *     它们由 token 兜；
 *   · `Origin` 的 **hostname 是 loopback** —— 本机的 webui / 调试页面在哪个端口上都算自己人
 *     （**与端口无关**，所以端口漂移不会把自己拒掉）；
 *   · 在 `allowedOrigins` 里 —— nginx + 域名部署时那个 `https://your.domain`；
 *   · 其余一律拒绝。
 *
 * 解析失败的（`Origin: null`、畸形串）按「不在名单里」处理：解不出 hostname 的东西没有
 * 资格被当成自己人。名单条目比较前两边都过一道 `new URL(...).origin`：多写一个结尾斜杠
 * 是迟早的事，而它不该表现为「自己配的域名被自己拒掉」。
 */
function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  const parsed = parseOrigin(origin);
  if (parsed === null) return false;
  for (const entry of allowed) {
    if (entry === origin) return true;
    if (parseOrigin(entry)?.origin === parsed.origin) return true;
  }
  return isLoopbackHost(parsed.hostname);
}

/** `Origin` 字符串 → 规格化后的 origin 与 hostname；解析失败返回 null */
function parseOrigin(value: string): { origin: string; hostname: string } | null {
  try {
    const url = new URL(value);
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    return null;
  }
}

/**
 * 这一条是不是一条 **JSON-RPC 通知**（有 `method`、没有 `id`）。
 *
 * 判据只取这两个键：方法名是不是认识的不重要 —— 通知本来就没有回执，也就不存在
 * 「方法不存在」的告诉方式。数组不是通知（本版不支持批量，那是 `invalid-request`）。
 */
function isNotification(frame: unknown): boolean {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return false;
  const value = frame as { method?: unknown; id?: unknown };
  return typeof value.method === "string" && value.method.length > 0 && value.id === undefined;
}

/**
 * handler 抛出来的东西 → 线上字符串码。
 *
 * 表外的码（服务端新加了一类失败、或者 SDK 抛的）照样递出去：**未知的码比丢掉的码有用**，
 * 客户端至少能显示「失败原因是这一条」。它们映射到 `-32000`（见 `wire/errors.ts`）。
 */
function codeOfThrown(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  // 唯一的断言：`code` 从 JSON 之外的边界（别处 `throw` 的对象）来，表由 `protocol/errors.ts`
  // 声明；合不合表在这里判不出来，也不该在这里改成 `internal`（那会吞掉真实原因）
  return typeof code === "string" && code.length > 0 ? (code as ErrorCode) : "internal";
}

/** 同上的 message 半边：`Error` 取 `message`，别的东西原样 `String()` */
function messageOfThrown(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.length > 0 ? message : String(error);
}

/**
 * 注入的凭证 → 本进程手上那把钥匙（`null` = 没有注入）。
 *
 * **空串与纯空白都归一成 `null`**，不能当成一串「长度为 0 的凭证」：
 *
 *   · 它不可能是「用户挑了这串」的结果 —— 说得出的那串凭证是 `randomBytes(32)` 的 base64url
 *     （43 字符，见 `wire/token.ts`），空 / 空白只可能来自「宿主读到了一个空值」：密钥存储里
 *     那一项是空的、配置项写成 `AI_ZEN_TOKEN=`、编排清单里的变量没填上；
 *   · 而客户端**没有凭证时发的恰恰是 `token: ""`**（`wire/call-once.ts` 里的
 *     `token: options?.token ?? ""`）。若把空串当成一把有效的钥匙，`tokenMatches()` 会比两个
 *     长度 0 的 `Buffer` 并返回 `true` —— 空凭证就成了「人人可进」，与 fail-closed 正好相反。
 *
 * 归一放在**赋值处**（构造函数与 `start()` 两处，同一个函数），而不是在 `tokenMatches()` 里
 * 打补丁：两处口径一致，将来多一个赋值点也不会漏。归一之后 `start()` 自然回落到
 * `ensureToken()`（注入空串 = 没注入 = 从文件读 / 生成）。
 *
 * 判空白用 `trim()`，但**值本身不改**：凭证是逐字节比较的东西，悄悄改写它会让「注入什么才
 * 对得上」变得不可推理。
 */
function normalizeInjectedToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.trim().length > 0 ? value : null;
}
