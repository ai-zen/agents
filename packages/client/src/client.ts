/**
 * 一条到 `agents-host` 的连接（一条 WebSocket + JSON-RPC 2.0）。
 *
 * ## 四件事
 *
 * `connect` / `call` / `subscribe` / `close`，就这四件：
 *   · `connect` 里把**握手**一次做完（`host.hello`），拿到 `Client` 就能直接调方法；
 *   · `call` 的入参与出参由宿主的 `MethodMap` 推出来（`MethodParams` / `MethodResult`）；
 *   · `subscribe` 按 `EventMap` 收窄载荷（`message.added` / `message.delta` / `state` / … 九个事件）；
 *   · `close` 之后不再可用，要恢复就 `reconnect()`。
 *
 * 另有一层不在 JSON-RPC 里的东西：{@link Client.open} 用的**镜像**（`mirror.ts` —— 按事件重建
 * `messages` 与四格），以及 {@link Client.sendBinary}（上传分片的二进制帧）。后者的帧格式收在
 * `chunkFrame.ts`，上传本身是一次三段式（见 `upload.ts`）。
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
 * 事件是 JSON-RPC 通知（无 `id`），断线即作废。重连之后由 {@link Client.resync} 把镜像补回来
 * （`conversation.state` 读四格 + `message.list({ after })` 拉增量，见 `mirror.ts`）。所以这里没有
 * 「补发」的逻辑，也没有「确认收到」的往返。
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
import { ConversationMirror, toMirrorEvent, type MirrorEvent } from "./mirror.js";

/** 取消订阅（`subscribe` / `onClose` / `onSync` 的返回值） */
export type Unsubscribe = () => void;

/** 单次调用的选项 */
export interface CallOptions {
  /** 这次调用等多久算超时；缺省用客户端的 `callTimeoutMs` */
  timeoutMs?: number;
}

/**
 * 「能调契约方法」这一件事。
 *
 * `Client` 结构上满足它；上传、取素材这些只关心帧的内容的模块只认这一个面——
 * 于是它们不必起 socket 就能单独验。
 */
export interface ContractCaller {
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
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

/** 一次补镜像的结果：补上了给镜像，没补上给原因（两条路都要让调用方看见） */
export type SyncOutcome =
  | { ok: true; conversationId: string; mirror: ConversationMirror }
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
  private readonly syncHandlers = new Set<(outcome: SyncOutcome) => void>();
  /**
   * 打开着的镜像（`conversationId` → 镜像）。这张表就是「我要跟着哪几段对话」的全部依据：
   * 重连之后按它逐段补回。
   */
  private readonly mirrors = new Map<string, ConversationMirror>();
  /**
   * 拉快照期间到达的事件先攒在这里（`conversationId` → 按到达顺序排的队）。
   *
   * 有键 = 这一段正在拉快照。没键 = 事件直接折进镜像。
   */
  private readonly buffers = new Map<string, MirrorEvent[]>();
  /** 正在路上的那一次快照（同一段不并发拉两份） */
  private readonly snapshots = new Map<string, Promise<void>>();

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

  /** 订阅「镜像补好了 / 补失败」（`reconnect()` 之后自动补、或手动 `resync()` 时）；返回取消订阅的函数 */
  onSync(handler: (outcome: SyncOutcome) => void): Unsubscribe {
    this.syncHandlers.add(handler);
    return () => this.syncHandlers.delete(handler);
  }

  // -------------------------------------------------------------------------
  // 重连与镜像
  // -------------------------------------------------------------------------

  /**
   * 换一条 socket 重新握手（连上之后**自动把打开着的镜像补回来**，见 {@link Client.resync}）。
   *
   * 旧连接上的在飞调用在这里一并失败（它们本来就随断线作废），事件不重放 —— 断线期间发生的事
   * 由补镜像回答。要不要一直重试、试几次由调用方决定（见 `reconnect.ts`）。
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
    await this.resyncAll();
  }

  // -------------------------------------------------------------------------
  // 镜像（打开 / 补回 / 关掉）
  // -------------------------------------------------------------------------

  /**
   * 打开一段对话：**先订阅、再拉全量、把拉取期间到达的事件按序补上**。
   *
   * 这四步的先后不能换（也是这个方法的全部内容）：
   *   1. **先订阅**：镜像先进 {@link Client.mirrors} 表，并给它开一个缓冲队列。从这一刻起，
   *      与镜像有关的事件一律先进队列 —— 拉取期间发生的事一条都不会丢。
   *   2. **读四格**（`conversation.state`）：先读它，是因为之后再到达的事件总比这个读数值新，
   *      补在它后面不会把状态往回拨；反过来的话（先读消息、后读状态），补的那一批就会把新的
   *      状态覆盖成旧的。
   *   3. **拉全量**（`message.list`，不带 `after`）：整段主线消息。
   *   4. **补事件**：快照落地之后，把队列里的那一批按**到达顺序**折进镜像；属于快照已包含
   *      那些消息的增量不再折一遍（否则同一段字会写两遍，见 `mirror.ts`）。
   *
   * 已经在镜像表里的对话直接回那一个（同一段不并发拉两份快照）。拉取失败时**不留半份镜像**：
   * 一个只有事件、没有历史的镜像比没有更糟。
   */
  async open(conversationId: string): Promise<ConversationMirror> {
    const existing = this.mirrors.get(conversationId);
    if (existing) {
      // 正在拉快照就跟它一起等：第二个调用方拿到的不该是「还没拉全」的那一份
      await this.snapshots.get(conversationId);
      return existing;
    }

    // 状态先用「死」占位：四格读到之前它什么都还不是，读到现读值就换掉
    const mirror = new ConversationMirror({ conversationId, status: "dead" });
    this.mirrors.set(conversationId, mirror);
    try {
      await this.snapshotWhileBuffering(conversationId, async () => {
        const { state } = await this.call("conversation.state", { conversationId });
        // 四格 + 名册 + 交接态一起收下：名册用来铺子 agent 那几栏（栏里的消息只来自事件）
        mirror.applyReadout(state);
        const listed = await this.call("message.list", { conversationId });
        mirror.replaceAll(listed.messages);
      });
    } catch (error) {
      this.mirrors.delete(conversationId);
      this.buffers.delete(conversationId);
      this.snapshots.delete(conversationId);
      throw error;
    }
    return mirror;
  }

  /** 这段对话的镜像（没打开过就是空） */
  mirror(conversationId: string): ConversationMirror | undefined {
    return this.mirrors.get(conversationId);
  }

  /** 不再跟着这段对话（关掉它 / 换对话时调） */
  closeMirror(conversationId: string): void {
    this.mirrors.delete(conversationId);
    this.buffers.delete(conversationId);
  }

  /**
   * 把镜像补回现在（重连之后自动走一次，也可以手动调）。
   *
   * 补法只有一条：`message.list { after: 本地主线最后一条 id }`。
   *   · 那条还在 → 回的就是「它最新内容 + 之后全部」，本地在它之前的部分留着，从它起整段换成
   *     宿主的（替换 + 追加）；
   *   · 那条不在（被撤回 / 删掉）→ 宿主回全量，本地整段替换。
   * 两者接在哪里只看回执里的 `anchor`（`mirror.mergeFrom` 一处判定）。本地一条都没有时就相当于
   * 一次全量拉取。
   *
   * 没打开过的对话就是一次 `open`。拉取期间到达的事件同样先攒后补（与 {@link Client.open} 同一条规矩）。
   */
  async resync(conversationId: string): Promise<ConversationMirror> {
    const mirror = this.mirrors.get(conversationId);
    if (!mirror) return this.open(conversationId);

    await this.snapshotWhileBuffering(conversationId, async () => {
      const { state } = await this.call("conversation.state", { conversationId });
      // 交接态在这里也会被读到：交接收尾时宿主推一条 `memory_replaced`（见下面那段），
      // 于是重连中的窗口里「正在交接」不会一直挂着
      mirror.applyReadout(state);
      const after = mirror.lastMessageId();
      const listed = await this.call("message.list", {
        conversationId,
        ...(after === undefined ? {} : { after }),
      });
      mirror.mergeFrom(listed.anchor, listed.messages);
    });
    return mirror;
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
   * 事件分派：先把与镜像有关的那几条折进镜像，再把载荷原样交给订阅者。
   *
   * 顺序是故意的：订阅者拿到事件时去读镜像，读到的应当已经包含这一条。
   *
   * 客户端不维护第二份事件名清单：名字来自 `EventMap`，没人订阅的名字自然没有订阅者 —— 宿主
   * 加了新事件而客户端还不认识时，行为是「忽略」而不是「崩一下」。
   */
  private dispatchEvent(method: string, payload: unknown): void {
    this.routeToMirror(method, payload);
    this.reloadOnMemoryReplaced(method, payload);

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

  /**
   * 一条事件 → 镜像：那段对话正在拉快照就先进队列，否则当场折进去。
   *
   * 事件带 `conversationId` 是契约里每一条事件都有的定位信息；没有它的（将来的新事件）这里
   * 就不认领 —— 与镜像无关的事件（`notice` / `question` / `error` / `conversation.changed`）
   * 由 `toMirrorEvent` 回空。
   */
  private routeToMirror(method: string, payload: unknown): void {
    const mirror = this.mirrors.size > 0 ? this.mirrorByPayload(payload) : undefined;
    if (!mirror) return;
    const event = toMirrorEvent(method, payload);
    if (!event) return;

    const queue = this.buffers.get(mirror.conversationId);
    if (queue) {
      queue.push(event);
      return;
    }
    mirror.apply(event);
  }

  private mirrorByPayload(payload: unknown): ConversationMirror | undefined {
    if (payload === null || typeof payload !== "object") return undefined;
    const conversationId = (payload as { conversationId?: unknown }).conversationId;
    if (typeof conversationId !== "string") return undefined;
    return this.mirrors.get(conversationId);
  }

  /**
   * `conversation.changed` 里唯一需要客户端**动一次**的那一格：`memory_replaced`。
   *
   * 交接期间这段对话写出来的那几条只在内存里、从不落库（宿主那边只跳过写库，事件照推）。所以
   * 提交或回滚之后，客户端手里那几条是**库里根本不存在**的消息 —— 宿主推这一条就是让这里
   * **整段替换**：重拉一次 `conversation.state`（顺带把「正在交接」收掉）与 `message.list` 全量。
   *
   * 同这一段正在拉快照时不再并发拉第二份（`snapshotWhileBuffering` 自己会串起来），拉取期间
   * 到达的事件照旧先攒后补。
   *
   * 没打开过这段对话就什么都不做：下次 `open` 本来就是一次全量。
   */
  private reloadOnMemoryReplaced(method: string, payload: unknown): void {
    if (method !== "conversation.changed") return;
    if (payload === null || typeof payload !== "object") return;
    const fact = payload as { conversationId?: unknown; change?: unknown };
    if (fact.change !== "memory_replaced") return;
    const conversationId = typeof fact.conversationId === "string" ? fact.conversationId : "";
    const mirror = this.mirrors.get(conversationId);
    if (!mirror) return;
    // 拉失败不吵：镜像留在上一份，下一次 `resync`（或再一条 `memory_replaced`）会补上
    void this.reloadMirror(conversationId, mirror).catch(() => undefined);
  }

  /** 整段重拉（`memory_replaced` 的唯一出口）：状态与主线一次拿齐，主线整段替换 */
  private async reloadMirror(
    conversationId: string,
    mirror: ConversationMirror,
  ): Promise<void> {
    await this.snapshotWhileBuffering(conversationId, async () => {
      const { state } = await this.call("conversation.state", { conversationId });
      mirror.applyReadout(state);
      const listed = await this.call("message.list", { conversationId });
      mirror.replaceAll(listed.messages);
    });
  }

  /**
   * 拉一次快照，并把拉取期间到达的事件按序补上 —— `open` 与 `resync` 共用的那一条规矩。
   *
   * 快照落地之后才补：补的那一批用 `replay: true` 折进去（快照已包含的那几条不再折增量），
   * 补完调 `endReplay()` 解除这条限制（之后到达的增量照常折）。
   *
   * 同一段已有一次快照在路上时，第二个调用方等那一次（同一时刻不并发拉两份）。
   */
  private async snapshotWhileBuffering(
    conversationId: string,
    load: () => Promise<void>,
  ): Promise<void> {
    const running = this.snapshots.get(conversationId);
    if (running) return running;

    const queue: MirrorEvent[] = [];
    this.buffers.set(conversationId, queue);
    const task = (async () => {
      try {
        await load();
      } finally {
        this.buffers.delete(conversationId);
        this.snapshots.delete(conversationId);
        const mirror = this.mirrors.get(conversationId);
        if (mirror) {
          for (const event of queue) mirror.apply(event, { replay: true });
          mirror.endReplay();
        }
      }
    })();
    this.snapshots.set(conversationId, task);
    return task;
  }

  /** 重连之后把打开着的镜像逐段补回来 */
  private async resyncAll(): Promise<void> {
    for (const conversationId of [...this.mirrors.keys()]) {
      try {
        // 一段补不上（对话被删 / 那一刻宿主出错）不该拖住其它段，所以逐段 try：
        // 失败的这一段照旧留在表里，下次重连或调用方手动 `resync` 时再试
        const mirror = await this.resync(conversationId);
        this.notifySync({ ok: true, conversationId, mirror });
      } catch (error) {
        this.notifySync({ ok: false, conversationId, error: toClientError(error) });
      }
    }
  }

  private notifySync(outcome: SyncOutcome): void {
    for (const handler of [...this.syncHandlers]) {
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
