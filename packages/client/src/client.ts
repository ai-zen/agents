/**
 * 一条到 `agents-host` 的连接（一条 WebSocket + JSON-RPC 2.0）。
 *
 * ## 四件事
 *
 * `connect` / `call` / `subscribe` / `close`，就这四件：
 *   · `connect` 里把**握手**一次做完（`host.hello`），拿到 `Client` 就能直接调方法；
 *   · `call` 的入参与出参由宿主的 `MethodMap` 推出来（`MethodParams` / `MethodResult`）；
 *   · `subscribe` 按 `EventMap` 收窄载荷（`run.state` / `message.delta` / … 六个事件）；
 *   · `close` 之后不再可用，要恢复就 `reconnect()`。
 *
 * 另有两条不在 JSON-RPC 里的通道：`resume`（补拉）与 {@link Client.sendBinary}（上传分片的二进制
 * 帧）。后者的帧格式收在 `chunkFrame.ts`，上传本身是一次三段式（见 `upload.ts`）。
 *
 * ## 握手：首帧 `host.hello`，凭证不进 URL
 *
 * `{ token, language?, clientInfo }` 放在**第一帧**里（`packages/host/src/wire/methods.ts` 的
 * `HostHelloParams`），而不是 URL 查询串 —— 查询串会进日志、进程表与反向代理的访问记录。
 * 握手成功之前 `call()` 一律在本地就被拒（`not_connected`），与宿主「未 `hello` 只放行
 * `hello`」那道门是同一件事的两侧。
 *
 * ## 不重放、不 ack
 *
 * 事件是 JSON-RPC 通知（无 `id`），断线即作废。重连之后由 {@link Client.resume} 拉回现场与消息
 * （`conversation.state` + `message.list({ after })`，见 `resume.ts`）。所以这里没有「补发」的逻辑，
 * 也没有「确认收到」的往返。
 *
 * ## 传输用 Node 内建的全局 `WebSocket`
 *
 * 不是 `ws`：本包要能被 cli / 桌面端**捆进自己的产物**，运行期依赖越少越好，而 Node 26 的全局
 * `WebSocket` 就是浏览器那个（`open` / `message` / `close` / `error` + `send`）。代价记在明处：
 * 它的 `error` 事件不带底层原因（`ECONNREFUSED` 之类在内部被吞掉了），所以本地错误文案里自己
 * 带上端点（`host:port`）—— 连不上谁，是必须说出来的那一半。
 */

import type {
  ClientInfo,
  EventName,
  EventPayload,
  JsonRpcId,
  MethodName,
  MethodParams,
  MethodResult,
  NoParams,
  HostHelloParams,
  HostHelloResult,
} from "@ai-zen/agents-host";

import { addressLabel, parseAddress, webSocketUrl, type HostTarget } from "./address.js";
import { ClientError, fromHostError, localError } from "./errors.js";
import { encodeFrame, parseIncoming, requestFrame } from "./frames.js";
import {
  lastMessageId,
  resumeConversation,
  type ContractCaller,
  type ResumedConversation,
} from "./resume.js";

/** 取消订阅（`subscribe` / `onClose` / `onResume` 的返回值） */
export type Unsubscribe = () => void;

/** 单次调用的选项 */
export interface CallOptions {
  /** 这次调用等多久算超时；缺省用客户端的 `callTimeoutMs` */
  timeoutMs?: number;
}

/** 建连参数 */
export interface ClientOptions {
  /** 连哪儿：结构化地址（发现文件给的）或用户填的那串（`ws://` / `host:port` 都认） */
  target: HostTarget | string;
  /** 握手凭证。没有就传空串 —— 宿主会回 `unauthorized`，那句话由它渲染 */
  token: string;
  /** 客户端身份（`hello` 的 `clientInfo`：名字、版本、平台） */
  clientInfo: ClientInfo;
  /** 连接语言（设置里的那一项）。留空 = 由宿主的默认语言决定（D8：缺省英文） */
  language?: string;
  /** 建连 + 握手的总时限 */
  connectTimeoutMs?: number;
  /** 单次 `call` 的缺省时限 */
  callTimeoutMs?: number;
}

/** 握手用的是 `1` 号请求；之后从 `2` 起，独占一段号段免得与握手撞号 */
const HELLO_ID = 1;
/** 请求 id 的上界（JSON-RPC 允许字符串，这里用数字：够用、好对日志） */
const MAX_REQUEST_ID = 0xffff_ffff;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/**
 * 二进制写出去的「高水位」：`bufferedAmount` 超过它就等一等再写下一帧。
 *
 * 上传一个 20MB 的文件是几百帧，`send()` 是同步入队、不背压：一路写下去会把整份文件攒在
 * socket 的发送缓冲里。4MB 足够把一条链路的往返延迟盖住，又不至于把内存交给对端的接收速度。
 */
const BINARY_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** 等发送缓冲降下去时的轮询间隔（WS 没有 drain 事件，只能轮着看） */
const BINARY_DRAIN_INTERVAL_MS = 2;

/**
 * `call` 的其余入参：方法本身没有入参（`NoParams`）时可以整段省掉。
 *
 * 由 `MethodParams` 推出来，所以 `call("host.version")` 与
 * `call("conversation.state", { conversationId })` 各自是各自的样子 —— 不必为了「有的方法没参数」
 * 在契约或调用点写宽松重载。
 */
export type MethodCallArgs<M extends MethodName> =
  MethodParams<M> extends NoParams
    ? [params?: MethodParams<M>, options?: CallOptions]
    : [params: MethodParams<M>, options?: CallOptions];

/** 一次补拉的结果：成了给快照，没成给原因（两条路都要让调用方看见） */
export type ResumeOutcome =
  | { ok: true; resumed: ResumedConversation }
  | { ok: false; conversationId: string; error: ClientError };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: ClientError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 一条连接。用 {@link Client.connect} 建，不要自己 `new` */
export class Client implements ContractCaller {
  private readonly target: HostTarget;
  private readonly token: string;
  private readonly clientInfo: ClientInfo;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  /** 设置里的语言；`host.setLanguage` 之后跟着变（重连时按它再握一次手） */
  private configuredLanguage: string | undefined;

  private socket: WebSocket | null = null;
  private helloResult: HostHelloResult | null = null;
  private nextId = HELLO_ID + 1;
  private closing = false;
  /** 正在进行的重连：两个调用方同时发现断线是常态（`onClose` 与「用户点了重试」），只该连一次 */
  private reconnecting: Promise<void> | null = null;

  private readonly pending = new Map<number, PendingCall>();
  /** 事件名 → 订阅者（键是字符串：客户端不维护第二份事件名清单，没人订阅的名字自然没人接） */
  private readonly eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly closeHandlers = new Set<(error: ClientError) => void>();
  private readonly resumeHandlers = new Set<(outcome: ResumeOutcome) => void>();
  /** 已经打过招呼、重连之后要补拉的对话 → 本地最后一条消息 id（补拉的 `after`） */
  private readonly anchors = new Map<string, string | null>();

  private constructor(options: ClientOptions) {
    this.target =
      typeof options.target === "string" ? parseAddress(options.target) : options.target;
    this.token = options.token;
    this.clientInfo = options.clientInfo;
    this.configuredLanguage = options.language;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /**
   * 建连 + 握手。返回时一定已经握过手 —— 把「先发 hello、等回执」摊给每个调用点，等于将来加鉴权
   * 时每个调用点都要跟着改。
   */
  static async connect(options: ClientOptions): Promise<Client> {
    const client = new Client(options);
    await client.dial();
    return client;
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  /** 握手结果（语言、版本、能力 id、附件上限）；没握手成功时为空 */
  get hello(): HostHelloResult | null {
    return this.helloResult;
  }

  /**
   * 这条连接说的是哪种语言：连上之后是**协商结果**（`Language`），没连上时是设置里那一项
   * （可能是宿主不认识的写法，握手时它自己回落）。要那个更窄的联合类型就读 `hello.language`。
   */
  get language(): string | undefined {
    return this.helloResult?.language ?? this.configuredLanguage;
  }

  /** 现在可用吗（socket 在、且握手成功过） */
  get connected(): boolean {
    return this.socket !== null && this.helloResult !== null;
  }

  /** 连的是哪儿（`host:port`，不含凭证） */
  get endpoint(): string {
    return addressLabel(this.target);
  }

  /** 结构化地址（`ensureHost` 与界面用） */
  get address(): HostTarget {
    return this.target;
  }

  // -------------------------------------------------------------------------
  // 调用
  // -------------------------------------------------------------------------

  /**
   * 调一个契约方法。
   *
   * 失败一律是 {@link ClientError}：宿主回的业务错误原样保留（`code` / `message` / `detail`），
   * 传输层的失败用本地码。握手没成就发方法会被本地拒（`not_connected`）。
   */
  call<M extends MethodName>(method: M, ...args: MethodCallArgs<M>): Promise<MethodResult<M>> {
    const params = args[0];
    const options = args[1] as CallOptions | undefined;
    return this.request(method, params, options?.timeoutMs) as Promise<MethodResult<M>>;
  }

  /**
   * 往这条连接写一个**二进制帧**。上传分片走这里（帧的形状见 `chunkFrame.ts`）。
   *
   * 为什么单独开一条通道而不是把字节塞进 JSON：`asset.begin` 之后的分片是任意二进制，
   * base64 进 JSON 会平白多出三分之一体积，而且宿主得先解一层编码才拿到字节。这条连接上
   * 二进制帧只有一种含义（上传分片），所以不需要再用 JSON-RPC 那套 `id` / `method` 包装。
   *
   * 分片没有回执（宿主按 `uploadId` 收，出错时用 `id: null` 的错误帧说话）：调用方发完所有
   * 分片再 `asset.end`，由那一步的长度与摘要校验给出最终答案。
   *
   * 没握手成功时本地就拒（`not_connected`），与宿主「未 `hello` 不收二进制」那道门是同一件事。
   *
   * 参数上那个 `<ArrayBuffer>` 不是废话：全局 `WebSocket.send` 只收底层是 `ArrayBuffer` 的视图，
   * 而 `Uint8Array` 缺省可以挂在 `SharedArrayBuffer` 上。写在这里比在调用点转一道强。
   */
  async sendBinary(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    const socket = this.socket;
    if (!socket || !this.helloResult) {
      throw localError("not_connected", {
        language: this.configuredLanguage,
        params: { method: "asset.chunk", endpoint: this.endpoint },
      });
    }
    await this.drain(socket);
    try {
      socket.send(frame);
    } catch {
      throw this.lostError();
    }
  }

  /**
   * 换这条连接的语言（`/lang` 那种连接级动作，D8）。
   *
   * 语言挂在连接上、断开即忘，所以这里记住协商结果，重连时照旧带上。
   */
  async setLanguage(language: string): Promise<HostHelloResult["language"]> {
    const { language: negotiated } = await this.call("host.setLanguage", { language });
    this.configuredLanguage = negotiated;
    if (this.helloResult) this.helloResult = { ...this.helloResult, language: negotiated };
    return negotiated;
  }

  // -------------------------------------------------------------------------
  // 订阅
  // -------------------------------------------------------------------------

  /** 订阅一个事件（按 `EventMap` 收窄载荷）；返回取消订阅的函数 */
  subscribe<E extends EventName>(
    event: E,
    handler: (payload: EventPayload<E>) => void,
  ): Unsubscribe {
    const set = this.eventHandlers.get(event) ?? new Set<(payload: unknown) => void>();
    // 载荷在分派时按事件名查表拿到，形状由契约保证；这里只是把它交给按事件名收窄过的回调
    set.add(handler as (payload: unknown) => void);
    this.eventHandlers.set(event, set);
    return () => {
      set.delete(handler as (payload: unknown) => void);
    };
  }

  /** 订阅「连接断了」（在一次成功握手之后真的断了时才有）；返回取消订阅的函数 */
  onClose(handler: (error: ClientError) => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** 订阅「补拉结果」（`reconnect()` 之后自动补、或手动 `resume()` 时）；返回取消订阅的函数 */
  onResume(handler: (outcome: ResumeOutcome) => void): Unsubscribe {
    this.resumeHandlers.add(handler);
    return () => this.resumeHandlers.delete(handler);
  }

  // -------------------------------------------------------------------------
  // 重连与补拉
  // -------------------------------------------------------------------------

  /**
   * 换一条 socket 重新握手（连上之后**自动补拉** {@link Client.track} 过的对话）。
   *
   * 旧连接上的在飞调用在这里一并失败（它们本来就随断线作废），事件不重放 —— 断线期间发生的事
   * 由补拉回答。要不要一直重试、试几次由调用方决定（见 `reconnect.ts`）。
   */
  reconnect(): Promise<void> {
    if (this.closing) {
      return Promise.reject(
        localError("closed", {
          language: this.configuredLanguage,
          params: { endpoint: this.endpoint },
        }),
      );
    }
    this.reconnecting ??= this.doReconnect().finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
  }

  /** 真正的那一次重连（同一时刻只有一条，见 {@link Client.reconnect}） */
  private async doReconnect(): Promise<void> {
    const previous = this.socket;
    this.socket = null;
    this.helloResult = null;
    this.failPending(this.lostError());
    if (previous) {
      try {
        previous.close();
      } catch {
        // 已经在关 / 从没连上：没有可做的事，连接到此为止
      }
    }

    await this.dial();
    await this.resumeTracked();
  }

  /**
   * 记住「这段对话我要跟着」：重连成功之后按它补拉。
   *
   * `anchor` 是本地已知的最后一条消息 id（补拉的 `after`，A12）；不传就按全量补一次，之后每次
   * `resume` 都会把新的锚点记住。
   */
  track(conversationId: string, anchor?: string): void {
    this.anchors.set(conversationId, anchor ?? this.anchors.get(conversationId) ?? null);
  }

  /** 不再跟着这段对话（关掉它 / 换对话时调） */
  untrack(conversationId: string): void {
    this.anchors.delete(conversationId);
  }

  /** 更新补拉的锚点（本地列表变了、画面上最后一条换了时调） */
  setAnchor(conversationId: string, messageId: string | null): void {
    if (this.anchors.has(conversationId)) this.anchors.set(conversationId, messageId);
  }

  /**
   * 补拉一段对话（`conversation.state` + `message.list({ after })`）。
   *
   * `after` 缺省用 {@link Client.track} 记住的那个锚点；结果会顺手记成新的锚点，并把
   * {@link ResumeOutcome} 交给 `onResume` 的订阅者。
   */
  async resume(conversationId: string, after?: string): Promise<ResumedConversation> {
    const from = after ?? this.anchors.get(conversationId) ?? undefined;
    const resumed = await resumeConversation(this, conversationId, from);
    if (this.anchors.has(conversationId)) {
      this.anchors.set(conversationId, lastMessageId(resumed.messages) ?? null);
    }
    this.notifyResume({ ok: true, resumed });
    return resumed;
  }

  // -------------------------------------------------------------------------
  // 关闭
  // -------------------------------------------------------------------------

  /** 关掉这条连接。在飞调用当场失败（`closed`），之后再用它会一直报这个码 */
  async close(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    this.socket = null;
    this.helloResult = null;
    this.failPending(
      localError("closed", {
        language: this.configuredLanguage,
        params: { endpoint: this.endpoint },
      }),
    );
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // 已经在关 / 从没连上
    }
  }

  // -------------------------------------------------------------------------
  // 内部：连接
  // -------------------------------------------------------------------------

  /** 建一条 socket 并握手；成功才留下它 */
  private async dial(): Promise<void> {
    const socket = new WebSocket(webSocketUrl(this.target));
    this.socket = socket;
    this.helloResult = null;
    this.attach(socket);
    try {
      const hello = await this.handshake(socket);
      // 握手期间连接被换掉（上一次 dial 的尾巴）时，这一条已经不作数了
      if (this.socket !== socket) throw this.lostError();
      // 握好手才发现本端已经关了：不要留下一条没人会用的连接
      if (this.closing) {
        this.dropSocket(socket);
        throw localError("closed", {
          language: this.configuredLanguage,
          params: { endpoint: this.endpoint },
        });
      }
      this.helloResult = hello;
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null;
        try {
          socket.close();
        } catch {
          // 同上：能关到就关，关不到也没有可做的事
        }
      }
      throw error instanceof ClientError ? error : this.lostError();
    }
  }

  /** 挂三条入站事件；`close` / `error` 都走同一个「断了」的出口（全局 WebSocket 的 `error` 之后必有 `close`） */
  private attach(socket: WebSocket): void {
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.onMessage(event.data);
    });
    socket.addEventListener("error", () => this.onDisconnected(socket));
    socket.addEventListener("close", () => this.onDisconnected(socket));
  }

  /**
   * 握手：`open` 之后发首帧 `host.hello`，等它的回执。
   *
   * 三条出口——回执、`close`、`error`——都可能先到，所以用一个 `settled` 闸门只落定一次，并让
   * 握手有独立时限：连上了但对面一句话都不回，是这条路上最容易发生的那种「卡住」。
   */
  private handshake(socket: WebSocket): Promise<HostHelloResult> {
    return new Promise<HostHelloResult>((resolve, reject) => {
      let settled = false;
      const finish = (error?: ClientError, result?: HostHelloResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result as HostHelloResult);
      };

      const timer = setTimeout(() => {
        finish(
          localError("handshake_timeout", {
            language: this.configuredLanguage,
            params: { endpoint: this.endpoint },
          }),
        );
        this.dropSocket(socket);
      }, this.connectTimeoutMs);

      socket.addEventListener(
        "open",
        () => {
          const params: HostHelloParams = {
            token: this.token,
            clientInfo: this.clientInfo,
            ...(this.configuredLanguage ? { language: this.configuredLanguage } : {}),
          };
          this.transmit(socket, HELLO_ID, "host.hello", params, this.connectTimeoutMs).then(
            (result) => finish(undefined, result as HostHelloResult),
            (error: unknown) => finish(error instanceof ClientError ? error : this.lostError()),
          );
        },
        { once: true },
      );

      socket.addEventListener("error", () => finish(this.unavailableError()), { once: true });
      socket.addEventListener("close", () => finish(this.lostError()), { once: true });
    });
  }

  /** 一条连接确认没用了：清掉在飞调用，并在「本来连着」的情况下通知订阅者 */
  private onDisconnected(socket: WebSocket): void {
    // 已经被换掉（重连）或者不是当前那条：这条连接的消息不该再影响现在的状态
    if (this.socket !== socket) return;
    const wasConnected = this.helloResult !== null;
    this.socket = null;
    this.helloResult = null;
    const error = this.lostError();
    this.failPending(error);
    if (!wasConnected || this.closing) return;
    for (const handler of [...this.closeHandlers]) {
      try {
        handler(error);
      } catch {
        // 一个订阅者抛错不该连累其它订阅者，更不该让一条已经断了的连接出别的岔子
      }
    }
  }

  /**
   * 等发送缓冲落回高水位以下（`bufferedAmount` 一路涨说明对端读得慢）。
   *
   * 轮询而不是等事件：全局 `WebSocket` 没有 drain 事件。连接在这一等里断了就当场失败 ——
   * 否则上传会卡在一个永远不会降下来的数字上。
   */
  private async drain(socket: WebSocket): Promise<void> {
    while (typeof socket.bufferedAmount === "number" && socket.bufferedAmount > BINARY_HIGH_WATER_BYTES) {
      await new Promise<void>((resolve) => setTimeout(resolve, BINARY_DRAIN_INTERVAL_MS));
      if (this.socket !== socket) throw this.lostError();
    }
  }

  private dropSocket(socket: WebSocket): void {
    try {
      socket.close();
    } catch {
      // 从没连上 / 已经在关
    }
    if (this.socket === socket) this.socket = null;
  }

  private lostError(): ClientError {
    return localError("connection_lost", {
      language: this.configuredLanguage,
      params: { endpoint: this.endpoint },
    });
  }

  private unavailableError(): ClientError {
    return localError("host_unavailable", {
      language: this.configuredLanguage,
      params: { endpoint: this.endpoint },
    });
  }

  // -------------------------------------------------------------------------
  // 内部：请求与分派
  // -------------------------------------------------------------------------

  /** 发一条请求并等它的回执；`call` 在这里挡住「还没握手就发方法」 */
  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closing) {
      return Promise.reject(
        localError("closed", {
          language: this.configuredLanguage,
          params: { endpoint: this.endpoint },
        }),
      );
    }
    const socket = this.socket;
    if (!socket || !this.helloResult) {
      return Promise.reject(
        localError("not_connected", {
          language: this.configuredLanguage,
          params: { method, endpoint: this.endpoint },
        }),
      );
    }

    const id = this.nextId;
    this.nextId = id >= MAX_REQUEST_ID ? HELLO_ID + 1 : id + 1;
    return this.transmit(socket, id, method, params, timeoutMs ?? this.callTimeoutMs);
  }

  /** 真正写一条请求帧并在在飞表里等回执（握手也走这一条） */
  private transmit(
    socket: WebSocket,
    id: JsonRpcId & number,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          localError("call_timeout", {
            language: this.configuredLanguage,
            params: { method, timeoutMs, endpoint: this.endpoint },
          }),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      try {
        socket.send(encodeFrame(requestFrame(id, method, params)));
      } catch (error) {
        // 连接已经开始关了：这条调用当场失败，别挂到超时
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof ClientError ? error : this.lostError());
      }
    });
  }

  /** 一条入站消息 → 通知（事件）或回执（在飞表里的那一条） */
  private onMessage(raw: unknown): void {
    // 宿主不发二进制（它的结果全是 JSON），收到了说明对端搞错了
    if (typeof raw !== "string") return;
    const incoming = parseIncoming(raw);
    if (!incoming) return;

    switch (incoming.kind) {
      case "notification":
        this.dispatchEvent(incoming.frame.method, incoming.frame.params);
        return;
      case "success":
      case "error": {
        const id = incoming.frame.id;
        if (typeof id !== "number") return;
        const call = this.pending.get(id);
        // 认不到就静默丢弃：迟到的回执（已超时落定的）与根本不是我发的 id，都没有可做的事
        if (!call) return;
        this.pending.delete(id);
        clearTimeout(call.timer);
        if (incoming.kind === "success") call.resolve(incoming.frame.result);
        else call.reject(fromHostError(incoming.frame.error));
        return;
      }
      default:
        return;
    }
  }

  /**
   * 事件分派：按事件名找订阅者，载荷原样交出去。
   *
   * 客户端不维护第二份事件名清单：名字来自 `EventMap`，没人订阅的名字自然没有订阅者 —— 宿主
   * 加了新事件而客户端还不认识时，行为是「忽略」而不是「崩一下」。
   */
  private dispatchEvent(method: string, payload: unknown): void {
    const handlers = this.eventHandlers.get(method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch {
        // 一个监听器抛错不该弄坏连接，也不该连累同事件的其它监听器
      }
    }
  }

  /** 重连之后把 {@link Client.track} 过的对话逐段补回来 */
  private async resumeTracked(): Promise<void> {
    for (const conversationId of [...this.anchors.keys()]) {
      try {
        // 一段补不上（对话被删 / 那一刻宿主出错）不该拖住其它段，所以逐段 try：
        // 失败的这一段照旧留在表里，下次重连或调用方手动 `resume` 时再试
        await this.resume(conversationId);
      } catch (error) {
        this.notifyResume({ ok: false, conversationId, error: toClientError(error) });
      }
    }
  }

  private notifyResume(outcome: ResumeOutcome): void {
    for (const handler of [...this.resumeHandlers]) {
      try {
        handler(outcome);
      } catch {
        // 同 dispatchEvent：订阅者自己的错不该传出去
      }
    }
  }

  /** 连接不可用：让所有在飞的调用一起失败，且之后不再接受新调用 */
  private failPending(error: ClientError): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
  }
}

/** 任意抛出物收敛成 `ClientError`（本地兜底：原始信息进 `detail.reason`，不猜原因） */
function toClientError(error: unknown): ClientError {
  if (error instanceof ClientError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return localError("unexpected", { params: { reason }, detail: { reason } });
}
