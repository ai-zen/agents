/**
 * 走 **WebSocket + JSON-RPC 2.0** 的 {@link ServerClient} 实现 —— 客户端侧唯一的「线上」实现。
 *
 * ## 为什么叫 Socket 而不是 Remote，为什么是 Server 而不是 Session
 *
 * 后缀写**传输**，不写**距离**：v1 连的就是 `127.0.0.1`，叫 `Remote` 等于把一个还没发生的事实
 * 提前写进类型；将来真要跨机时它照样叫这个名字。换传输（stdio / 内存双工）时换的是前缀，
 * 不是主体。
 *
 * 而主体是 **Server**：它是一条到服务端的连接，`ping`、`workspace.*`、`session.*` 都走它。
 * `session` 在本项目里特指「与某个 Agent 的一段会话」（workspace 的下级对象），不是连接 ——
 * 一条连接可以陆续服务好几个会话。
 *
 * ## 传输用 Node 内建的 `WebSocket`，不是 `ws`
 *
 * 客户端**不许**把 `ws` 变成运行期依赖（cli / desktop 打包会把 `dependencies` 里的一切拖进产
 * 物），而 Node 26 的全局 `WebSocket` 就是浏览器那个 WebSocket：`open` / `message` / `close` /
 * `error` 四个事件 + `send()`。代价记在明处：全局 WebSocket 的 `error` 事件**不带底层原因**
 * （`ECONNREFUSED` 之类在 undici 内部被吞掉了），所以这里的错误消息自己带上端点 —— 探活失败
 * 时「连不上谁」是必须说出来的那一半。
 *
 * ## 握手是一条普通方法
 *
 * 上一版的握手是一种专用帧（`kind: "hello"`）。本版它就是 `MethodApi` 里的一条普通方法：
 * 连上就发 `{jsonrpc:"2.0", id:1, method:"hello", params:{protocol, client}}`，然后等 `id: 1`
 * 的回执。好处是**错误分级只有一套** —— 握手被拒就是一条失败响应（`error.data.code` 是
 * `version-mismatch` / `bad-params` / …），与别的调用走同一条路。
 *
 * `hello` 的 result 是**扁平**的 `{name, version, protocol, pid, startedAt}`（A23：没有 `server`
 * 那一层）。
 *
 * ## 失败响应靠「有没有 `error`」判，不靠 `ok`
 *
 * JSON-RPC 的响应只有两种形状：`result` 或 `error` 恰有其一。业务失败全在 `error` 里，两层码
 * 各管一件事：`error.code` 是数字码（`-32000` / `-32602` …，回答「该不该改请求」），
 * `error.data.code` 是原来的字符串码（`session-missing` / `turn-busy` …，业务语义）。调用方读
 * 的是**字符串码**，所以它被挂到 `Error.code` 上。
 *
 * ## 二进制：同一条连接上的第二条消息
 *
 * `call(method, params, { bytes })` 发的是**两条** WS 消息：先一条文本请求（`params` 里没有
 * 「字节数」这个字段），再一条二进制消息（前 4 字节是该请求 `id` 的大端无符号数，其余是载荷）。
 * 服务端靠这 4 字节把字节与在飞的请求对上 —— 可并发、可乱序，不靠「帧后紧跟」。
 *
 * ## 入站只有两条路
 *
 *   1. **通知**（有 `method`、没有 `id`）：只认 `session.event`，把 `params` 交给事件分发；
 *      其它 `method` 忽略（本版服务端不主动发请求）。
 *   2. **回执**（没有 `method`、有 `id`）：按 `id` 在自己的在飞表里认领。**认不到就静默丢弃**
 *      （A20）：迟到的回执（已经超时落定的）与根本不是我发的 `id`，都没有可做的事。
 *
 * 一条文本消息不是合法 JSON 时同样丢弃：WS 已经给了消息边界，这一条坏了不影响下一条，而这条
 * 连接上没有任何一条请求需要为此失败。
 *
 * ## 握手在 `connect()` 里做完
 *
 * `connect()` 返回时一定已经握过手，调用方拿到客户端就能 `call()`。把「先发 hello、等回执、
 * 再发请求」摊给每个调用点，等于将来加鉴权时每个调用点都要跟着改。
 */

import type {
  ErrorObject,
  HelloParams,
  HelloResult,
  ServerEvent,
} from "@ai-zen/agents-server/protocol";
import { encodeFrame } from "./wire/frames.js";
import {
  isNotification,
  MAX_REQUEST_ID,
  PROTOCOL_VERSION,
  REQUEST_ID_BYTES,
} from "./wire/messages.js";
import type { CallOptions, ClientInfo, ServerAddress, ServerClient } from "./types.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SocketServerClientOptions {
  address: ServerAddress;
  client: ClientInfo;
  /** 建连 + 握手的总时限。握手是两趟往返，但都在本机，1s 都算宽裕 */
  connectTimeoutMs?: number;
  /** 单次 `call` 的默认时限（会话类方法会跑很久，调用点应显式传 `timeoutMs`） */
  callTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * 握手用的 `id`：`1`。
 *
 * 保留一个固定值而不是「从分配器里取一个」：`connect()` 返回之前只有这一条请求，而它必须与
 * 之后的调用**不撞号** —— 于是分配器从 `2` 起（见 {@link nextRequestId}）。
 */
const HELLO_ID = 1;

export class SocketServerClient implements ServerClient {
  readonly address: ServerAddress;

  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<(payload: ServerEvent) => void>>();
  private readonly callTimeoutMs: number;

  /** 握手期间的非空槽位：`hello` 的回执到时由它落定 `connect()` 的 promise */
  private pendingHandshake: { resolve: () => void; reject: (error: Error) => void } | null = null;
  /** 握手回执里服务端自报的身份（版本 / pid / 协议号）；`connect()` 成功之前一直是 `undefined` */
  private serverInfo: HelloResult | undefined;
  private nextId = HELLO_ID + 1;
  private closedFlag = false;
  /** 「连接断了」的订阅者（与事件通道分开：这是传输层说的，不是服务端说的） */
  private readonly closeListeners = new Set<() => void>();

  private constructor(socket: WebSocket, address: ServerAddress, callTimeoutMs: number) {
    this.socket = socket;
    this.address = address;
    this.callTimeoutMs = callTimeoutMs;
  }

  /** 建连 + 握手；握手被拒或超时一律抛错（调用方据此决定"重拉一个"还是"报给人看"） */
  static async connect(options: SocketServerClientOptions): Promise<SocketServerClient> {
    const { address, client } = options;
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    const socket = new WebSocket(webSocketUrl(address));
    const connection = new SocketServerClient(
      socket,
      address,
      options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );

    const ready = new Promise<void>((resolve, reject) => {
      connection.pendingHandshake = { resolve, reject };
    });
    connection.attach();

    const timer = setTimeout(() => {
      connection.settleHandshake(
        new Error(
          `handshake timeout after ${connectTimeoutMs}ms (${address.host}:${address.port})`,
        ),
      );
      connection.destroy();
    }, connectTimeoutMs);

    socket.addEventListener("open", () => connection.sendHello(client));

    try {
      await ready;
      return connection;
    } catch (error) {
      connection.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 握手回执里服务端自报的身份（只在 `connect()` 成功后可用） */
  get server(): HelloResult | undefined {
    return this.serverInfo;
  }

  call<T = unknown>(method: string, params?: unknown, options?: CallOptions): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`client is closed, cannot call ${method}`));
    }
    const id = this.nextId;
    this.nextId = nextRequestId(id);
    return this.sendCall<T>(
      id,
      method,
      params,
      options?.timeoutMs ?? this.callTimeoutMs,
      options?.bytes,
    );
  }

  on<E extends ServerEvent["event"]>(
    event: E,
    listener: (payload: Extract<ServerEvent, { event: E }>) => void,
  ): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    const set = this.listeners.get(event)!;
    const wrapped = listener as (payload: ServerEvent) => void;
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  /** 连接是否已断（断开后不可再用，要恢复只能新建一条） */
  get closed(): boolean {
    return this.closedFlag;
  }

  close(): void {
    this.failAll(new Error("client closed"));
    this.destroy();
  }

  /** 订阅「连接断了」；返回取消订阅的函数 */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  // ==================================================================
  // 内部
  // ==================================================================

  private attach(): void {
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    // 全局 WebSocket 的 `error` 事件没有底层原因（undici 把它吞了），所以消息里带端点。
    // 之后必定还会来一条 `close`：`failAll` 只通知一次
    this.socket.addEventListener("error", () =>
      this.failAll(new Error(`connection error (${this.endpoint})`)),
    );
    this.socket.addEventListener("close", () =>
      this.failAll(new Error(`connection closed (${this.endpoint})`)),
    );
  }

  /** `host:port`（错误消息用；与 `webSocketUrl` 的区别是这里不写成 URL） */
  private get endpoint(): string {
    return `${this.address.host}:${this.address.port}`;
  }

  /**
   * 发 `hello` —— 它就是一条普通请求：走同一张在飞表、同一个回执判别，只是结果另外存一份。
   *
   * 用 `.then(…)` 而不是 `await`：`connect()` 那边等的是 `pendingHandshake`，两条路各自落定，
   * 不必把 `open` 之后的发送也接进那个 promise 链。
   */
  private sendHello(client: ClientInfo): void {
    const params: HelloParams = { protocol: PROTOCOL_VERSION, client };
    void this.sendCall<HelloResult>(HELLO_ID, "hello", params, this.callTimeoutMs).then(
      (result) => {
        this.serverInfo = result;
        this.settleHandshake();
      },
      (error: Error) => this.settleHandshake(error),
    );
  }

  /**
   * 发一条请求并等它的回执：登记进在飞表 → 发文本请求 →（有字节时）再发一条二进制消息。
   *
   * 两条 `send()` 在同一连接上保序（WS 单连接有序），所以对端读到的必然是「先请求、后字节」。
   */
  private sendCall<T>(
    id: number,
    method: string,
    params: unknown,
    timeoutMs: number,
    bytes?: Uint8Array,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms calling ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });

      try {
        // `params` 为 undefined 时 `JSON.stringify` 会整键丢掉，消息里就只剩 `{jsonrpc,id,method}`
        this.socket.send(encodeFrame({ jsonrpc: "2.0", id, method, params }));
        // 字节是**另一条** WS 消息：前 4 字节是这条请求的 `id`，其余原样（不 base64、不转义）
        if (bytes) this.socket.send(payloadMessage(id, bytes));
      } catch (error) {
        // 连接已经开始关了：这条调用当场失败，别挂到超时
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 收到一条 WS 消息（服务端的回执与通知都是文本；二进制一侧本版不存在） */
  private handleMessage(data: unknown): void {
    // 服务端不发二进制（它的结果全部是 JSON）；收到了说明对端搞错了，没有可处理之物
    if (typeof data !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      // 不是合法 JSON：丢掉。WS 已经给了消息边界，这一条坏了不影响下一条
      return;
    }
    this.handleFrame(frame);
  }

  /** 一条文本消息 → 通知或回执（判别规则见文件头「入站只有两条路」） */
  private handleFrame(frame: unknown): void {
    if (isNotification(frame)) {
      const notification = frame as { method: string; params?: unknown };
      // 本版服务端只推一条 method：15 个事件共用 `session.event`，具体哪件事由 `params.event` 说
      if (notification.method === "session.event") this.dispatchEvent(notification.params);
      return;
    }

    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    const response = frame as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof response.id !== "number") return;

    const call = this.pending.get(response.id);
    // `id` 不在自己在飞表里的响应 → 静默丢弃（A20）：迟到的回执与别人的 `id` 都无从归属
    if (!call) return;
    this.pending.delete(response.id);
    clearTimeout(call.timer);

    if (response.error !== undefined) call.reject(failureOf(response.error));
    else call.resolve(response.result);
  }

  /** 事件通知的 `params` → 订阅者（按 `event` 字面量分派，与 `on()` 的类型一一对应） */
  private dispatchEvent(params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const event = (params as { event?: unknown }).event;
    if (typeof event !== "string") return;
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(params as ServerEvent);
      } catch {
        // 一个监听器抛错不该连累同事件的其它监听器（更不该弄坏连接）
      }
    }
  }

  private settleHandshake(error?: Error): void {
    const handshake = this.pendingHandshake;
    if (!handshake) return;
    this.pendingHandshake = null;
    if (error) handshake.reject(error);
    else handshake.resolve();
  }

  /** 断掉这条连接（`WebSocket.close()`：先发关闭帧，再等对端回应/超时） */
  private destroy(): void {
    try {
      this.socket.close();
    } catch {
      // 已经在关 / 从没连上：没有可做的事，连接到此为止
    }
  }

  /** 连接不可用：让所有在飞的调用一起失败，且之后不再接受新调用 */
  private failAll(error: Error): void {
    // 只通知一次：全局 WebSocket 的 `error` 之后还会来 `close`，`failAll` 会被调两次
    const alreadyClosed = this.closedFlag;
    this.closedFlag = true;
    this.settleHandshake(error);
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
    this.listeners.clear();
    if (alreadyClosed) return;
    // 断开通知放在最后：订阅方（重连逻辑）此刻应该看到「这条连接已经彻底没用了」
    for (const listener of [...this.closeListeners]) {
      try {
        listener();
      } catch {
        // 一个订阅方抛错不该影响别的订阅方（与 EventHub 同一口径）
      }
    }
    this.closeListeners.clear();
  }
}

// ==================================================================
// 线上的两条出站形状
// ==================================================================

/**
 * 二进制消息：`[4 字节 id][载荷…]`。
 *
 * 大端无符号 —— 与 `wire/messages.ts` 的 `readRequestId()`（服务端那份读法）同一条约定。用
 * `DataView.setUint32(0, id, false)` 而不是 `Buffer`：载荷是任意字节，不该为了写 4 个字节把它
 * 变成 Node 专有的类型（这条实现要能原样搬到浏览器）。
 */
function payloadMessage(id: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const message = new Uint8Array(REQUEST_ID_BYTES + bytes.byteLength);
  new DataView(message.buffer).setUint32(0, id, false);
  message.set(bytes, REQUEST_ID_BYTES);
  return message;
}

/**
 * 一条失败响应 → `Error`，字符串码挂在 `.code` 上。
 *
 * 取的是 `error.data.code`（业务语义）而不是 `error.code`（数字码）：调用方靠它决定「换一段会话
 * 还是重试」，数字码只回答「是不是协议级失败」。`data.code` 按契约必填，但**表外的码照样递出
 * 去** —— 服务端新增了一类失败而老客户端还不认识时，未知的码比丢掉的码有用（`codeOf()` 对
 * 表外的码返回 `undefined`，不会把它硬塞进 `ErrorCode`）。
 */
function failureOf(error: unknown): Error & { code?: string } {
  const value = (error ?? {}) as Partial<ErrorObject>;
  const code = typeof value.data?.code === "string" ? value.data.code : undefined;
  const message = typeof value.message === "string" ? value.message : "request failed";
  const failure = new Error(code ? `${code}: ${message}` : message) as Error & { code?: string };
  if (code) failure.code = code;
  return failure;
}

/** 下一个请求 `id`：跳过握手那个，封顶回到 `2`（值域是 `0 … 2³²-1`，见 `wire/messages.ts`） */
function nextRequestId(id: number): number {
  return id >= MAX_REQUEST_ID ? HELLO_ID + 1 : id + 1;
}

/** `ws://host:port` —— IPv6 字面量要加方括号（`::1` 是允许的监听地址之一） */
function webSocketUrl(address: ServerAddress): string {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `ws://${host}:${address.port}`;
}
