/**
 * `WsHub` —— 一条 WebSocket 上的接线层（architecture A2 / §6）。
 *
 * 它只做四件事，一件也不多做：
 *
 *   1. **握手**：首帧必须是 `hello`（`{ token, language?, clientInfo }`）。没通过之前除了 `hello`
 *      什么都不接（一律 `unauthorized`），凭证不放在 URL 查询串里。`language` 挂在这条连接上、
 *      断开即忘（PRD D8）。
 *   2. **分发**：`MethodMap` 里的方法交给注入的 handler 表；没注册的方法回 `unsupported`
 *      （接线层自己代管的只有 `server.hello` / `server.setLanguage` 与上传三段）。
 *      业务逻辑一律不在本文件里。
 *   3. **推送**：JSON-RPC 通知（无 id），`params` 就是事件载荷。不重放、不需要 ack（PRD L5：
 *      断线重连由客户端自己拉）。受理即返回的方法（`conversation.send` 这类）会产生「事件早于回包」
 *      的顺序问题，所以按 `conversationId` 缓冲，回包写完再按序放行（裁定 R47）。
 *   4. **上传帧**：二进制帧交给 `UploadReceiver` 落盘；连接断开时把它名下未完成的上传清掉。
 *
 * 错误一律走 JSON-RPC `error`：`data.code` 是稳定业务码、`data.message` 是按**这条连接的语言**
 * 渲染好的句子、`data.detail` 是结构化事实。非 `ServerError` 的抛出收敛成 `internal` ——
 * 细节只进日志，栈与内部路径不出网。
 */

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { ListenTarget } from "../config.js";
import { normalizeLanguage, type Language } from "../i18n/index.js";
import {
  MAX_ASSETS_PER_MESSAGE,
  MAX_ASSET_BYTES,
  PROTOCOL_VERSION,
  ServerError,
  errResponse,
  isMethodName,
  notification,
  okResponse,
  parseFrame,
  type AssetBeginParams,
  type AssetEndParams,
  type CapabilityView,
  type ClientInfo,
  type EventMap,
  type EventName,
  type Frame,
  type JsonRpcErrorFrame,
  type JsonRpcId,
  type JsonRpcNotificationFrame,
  type JsonRpcResponseFrame,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type ServerHelloParams,
  type ServerHelloResult,
  type ServerSetLanguageResult,
  type TransferLimits,
} from "../wire/index.js";
import type { TokenVerifier } from "./auth.js";
import type { UploadReceiver } from "./UploadReceiver.js";

// ---------------------------------------------------------------------------
// 注入点
// ---------------------------------------------------------------------------

/** 一条连接对 handler 可见的事实（不把 socket 漏给业务层） */
export interface ConnectionInfo {
  /** 服务端分配的连接 id（问题对象的 `answeredBy` 这类「哪条连接」的事实用它） */
  id: string;
  /** 这条连接协商出的语言 */
  language: Language;
  /** 客户端自报的身份（`hello` 之后才有值） */
  clientInfo: ClientInfo | null;
  /** 这条连接用的是哪一串凭证（`hello` 之后才有值） */
  credentialId: string | null;
}

/** 一个方法的调用现场 */
export interface MethodCallContext<M extends MethodName> {
  method: M;
  /** 入参：以契约为准（`MethodMap[M]["params"]`），业务层自己按字段取值校验 */
  params: MethodParams<M>;
  connection: ConnectionInfo;
}

/**
 * 方法实现。
 *
 * 抛 `ServerError` 表达「可以给用户看的原因」，抛别的会被收敛成 `internal` 并进日志。
 */
export type MethodHandler<M extends MethodName> = (
  context: MethodCallContext<M>,
) => MethodResult<M> | Promise<MethodResult<M>>;

/**
 * handler 表：注册哪些方法就有哪些方法，其余一律 `unsupported`。
 *
 * 用 `Partial` + 映射类型，是为了让「注册时的入参/出参类型」跟着方法名走 ——
 * 写错一个字段名在编译期就露出来，而不是等客户端连上来才发现。
 */
export type HandlerTable = {
  [M in MethodName]?: MethodHandler<M>;
};

/** 日志口子：连接事件与内部错误往哪写 */
export interface HubLogger {
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/**
 * 推送的按连接本地化（PRD D8）：事件里的 `LocalizedText` 在产生现场渲染，而语言挂在连接上，
 * 所以出网前最后一道是「按这条连接的语言把句子换掉」。注入方（W4 的通知/问题层）重渲染
 * `message` 字段后原样返回；不改载荷时直接返回 `payload`。
 */
export type EventLocalizer = <E extends EventName>(
  event: E,
  payload: EventMap[E],
  language: Language,
) => EventMap[E];

export interface WsHubOptions {
  /** 监听地址（由调用方按 `resolveListenTarget` 算好传进来，本文件不判断本地/对外） */
  host: string;
  /** 监听端口；`0` 表示由系统分配（用例与「端口被占时退回临时端口」都靠它） */
  port: number;
  /** 凭证校验（`auth.createTokenVerifier`；用例注入假实现） */
  verifyToken: TokenVerifier;
  /** 方法表 */
  handlers: HandlerTable;
  /** 上传接收器；不给时 `asset.begin` / `asset.end` 与二进制帧都按 `unsupported` 处理 */
  uploads?: UploadReceiver;
  /** 服务端版本（`hello` 的 `serverVersion`，升级判定要向客户端报这个） */
  serverVersion: string;
  /** 进程启动时刻（ISO 8601）；缺省取构造时的时钟 */
  startedAt?: string;
  /** 能力清单（PRD F-E5：帮助页与指令菜单从这一份渲染）；缺省为空 */
  capabilities?: () => CapabilityView[];
  /** 连接未声明语言时的缺省语言（PRD D8：缺省英文） */
  defaultLanguage?: Language;
  /** 推送出网前的按连接本地化（不注入则原样搬运） */
  localizeEvent?: EventLocalizer;
  /**
   * 连接数变化时回调（参数是这一刻的连接数）。
   *
   * 单根靠它发现「最后一条连接走了」：那正是退出判据的一个触发源（PRD L4 / A10：
   * 回收计时只有一处，所以这里只报事实、不自带定时器）。
   */
  onConnectionsChanged?: (count: number) => void;
  /** 时钟，缺省 `Date.now` */
  clock?: () => number;
  /** 日志；缺省安静 */
  logger?: HubLogger;
}

// ---------------------------------------------------------------------------
// 连接状态
// ---------------------------------------------------------------------------

/** 一段对话的推送缓冲：`depth` 是「还有几个请求没回包」，归零时按序放行 */
interface PushHold {
  depth: number;
  /** 排队的帧（惰性构造：放行时才按那时的连接语言渲染） */
  queue: (() => JsonRpcNotificationFrame)[];
}

interface ConnectionState {
  id: string;
  socket: WebSocket;
  language: Language;
  clientInfo: ClientInfo | null;
  credentialId: string | null;
  authorized: boolean;
  /** conversationId → 尚未放行的推送 */
  holds: Map<string, PushHold>;
}

/** 安静日志（缺省值，不导出：不让它变成别处共享的全局） */
const QUIET_LOGGER: HubLogger = {
  warn: () => undefined,
  error: () => undefined,
};

/** 分发处的统一调用形状：名字已经过 `isMethodName` 收窄，参数原样交给 handler */
type AnyMethodHandler = (context: {
  method: MethodName;
  params: unknown;
  connection: ConnectionInfo;
}) => unknown;

/** `hello` 之前唯一允许的方法 */
const HELLO_METHOD = "server.hello";

export class WsHub {
  private readonly options: WsHubOptions;
  private readonly logger: HubLogger;
  private readonly clock: () => number;
  private readonly startedAt: string;
  private readonly defaultLanguage: Language;
  /** connectionId → 连接状态（关闭即移除；推送只发给还在这里面的连接） */
  private readonly connections = new Map<string, ConnectionState>();
  private server: WebSocketServer | null = null;
  private closing: Promise<void> | null = null;

  constructor(options: WsHubOptions) {
    this.options = options;
    this.logger = options.logger ?? QUIET_LOGGER;
    this.clock = options.clock ?? Date.now;
    this.startedAt = options.startedAt ?? new Date(this.clock()).toISOString();
    this.defaultLanguage = options.defaultLanguage ?? "en";
  }

  // -------------------------------------------------------------------------
  // 启停
  // -------------------------------------------------------------------------

  /**
   * 开始监听。
   *
   * 返回**实际**监听地址：端口给 `0` 时由系统分配，回调里拿到的才是真端口 ——
   * 调用方要把它写进发现文件（客户端读的是那里，不是启动参数）。
   */
  async listen(): Promise<ListenTarget> {
    if (this.server) throw new Error("WsHub 已经在监听");
    const server = new WebSocketServer({ host: this.options.host, port: this.options.port });
    server.on("connection", (socket: WebSocket) => this.accept(socket));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
    });

    // 监听成功之后的错误（某个连接上的异常等）记日志，不让它变成未捕获异常
    server.on("error", (error: Error) => this.logger.error("WebSocket 服务器出错", { error }));
    this.server = server;
    const address = server.address();
    if (typeof address === "string" || address === null) {
      return { host: this.options.host, port: this.options.port };
    }
    const info: AddressInfo = address;
    return { host: info.address, port: info.port };
  }

  /** 实际监听地址；没在监听时为 `null` */
  address(): ListenTarget | null {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    return { host: address.address, port: address.port };
  }

  /**
   * 收尾：先给每条连接一个正常的关闭帧，再关服务器；有连接迟迟不断就强制断开。
   *
   * 收尾之后不再接受新连接，也不再持有任何连接状态与上传状态。
   */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    const server = this.server;
    this.server = null;

    const states = [...this.connections.values()];
    for (const state of states) {
      try {
        state.socket.close(1001, "server shutting down");
      } catch {
        // 已经断了：下面统一按「连接没了」处理
      }
      await this.options.uploads?.abortConnection(state.id).catch((error: unknown) => {
        this.logger.warn("清理上传失败", { error });
      });
      state.holds.clear();
      this.connections.delete(state.id);
    }
    this.notifyConnectionsChanged();

    if (!server) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 兜底：还在半开状态的连接直接断掉，避免关服务端时挂在这里
        for (const client of server.clients) client.terminate();
      }, 200);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // 推送（服务端 → 客户端）
  // -------------------------------------------------------------------------

  /**
   * 推一个事件给所有已握手的连接。
   *
   * 形状与 `ChatRunner` 的 `ChatEventEmitter` 一致，所以单根可以把它直接当 `emit` 注入。
   * 事件里带 `conversationId` 的（全部事件都带）会受该对话的缓冲控制：有请求还没回包时先排队。
   */
  push<E extends EventName>(event: E, payload: EventMap[E]): void {
    const key = conversationKeyOf(event, payload);
    for (const state of this.connections.values()) {
      this.deliver(state, key, () => this.frameFor(state, event, payload));
    }
  }

  /** 推一个事件给指定连接；连接不在（已断开）时返回 `false` */
  pushTo<E extends EventName>(
    connectionId: string,
    event: E,
    payload: EventMap[E],
  ): boolean {
    const state = this.connections.get(connectionId);
    if (!state) return false;
    this.deliver(state, conversationKeyOf(event, payload), () =>
      this.frameFor(state, event, payload),
    );
    return true;
  }

  /**
   * 把事件载荷变成这条连接要收的通知帧。
   *
   * 注入了 `localizeEvent` 时先过一道：事件里的 `LocalizedText` 是在产生现场渲染的（那时不知道
   * 收件人是谁），而语言挂在连接上（D8），所以真正的「按这条连接的语言说这句话」发生在这里。
   * 没注入时原样搬运（测试与不关心多语言的场合）。
   */
  private frameFor<E extends EventName>(
    state: ConnectionState,
    event: E,
    payload: EventMap[E],
  ): JsonRpcNotificationFrame {
    const localize = this.options.localizeEvent;
    const body = localize ? localize(event, payload, state.language) : payload;
    return notification(event, body);
  }

  /** 当前在线的连接（只给事实，不给 socket） */
  connectionInfos(): ConnectionInfo[] {
    return [...this.connections.values()].map((state) => toConnectionInfo(state));
  }

  /** 报一次连接数变化；回调自己抛错不影响连接本身 */
  private notifyConnectionsChanged(): void {
    const listener = this.options.onConnectionsChanged;
    if (!listener) return;
    try {
      listener(this.connections.size);
    } catch (error) {
      this.logger.warn("连接数变化回调抛错", { error: describeError(error) });
    }
  }

  // -------------------------------------------------------------------------
  // 连接
  // -------------------------------------------------------------------------

  private accept(socket: WebSocket): void {
    const state: ConnectionState = {
      id: randomUUID(),
      socket,
      language: this.defaultLanguage,
      clientInfo: null,
      credentialId: null,
      authorized: false,
      holds: new Map(),
    };
    this.connections.set(state.id, state);
    this.notifyConnectionsChanged();

    socket.on("message", (data: RawData, isBinary: boolean) => {
      void this.onFrame(state, data, isBinary).catch((error: unknown) => {
        // 兜底：任何没被分支捕获的抛出都只能进日志（连接已经没法给出更具体的回答）
        this.logger.error("处理帧时出现未捕获的错误", { error: describeError(error) });
      });
    });
    socket.on("close", () => this.drop(state));
    socket.on("error", (error: Error) => {
      this.logger.warn("连接出错", { connectionId: state.id, error });
    });
  }

  /** 连接断开：把它的上传与缓冲一起扔掉（订阅就是「它在不在这个集合里」） */
  private drop(state: ConnectionState): void {
    if (!this.connections.delete(state.id)) return;
    state.holds.clear();
    this.notifyConnectionsChanged();
    void this.options.uploads?.abortConnection(state.id).catch((error: unknown) => {
      this.logger.warn("断线清理上传失败", { connectionId: state.id, error });
    });
  }

  // -------------------------------------------------------------------------
  // 入站帧
  // -------------------------------------------------------------------------

  private async onFrame(state: ConnectionState, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      await this.onBinary(state, toBytes(data));
      return;
    }

    let frame: Frame;
    try {
      frame = parseFrame(toText(data));
    } catch (error) {
      this.send(state, this.errorFrame(extractId(toText(data)), error, state.language));
      return;
    }

    if (frame.kind === "request") {
      await this.onRequest(state, frame.id, frame.method, frame.params);
      return;
    }
    if (frame.kind === "notification") {
      await this.onNotification(state, frame.method, frame.params);
      return;
    }
    // 客户端发来的响应：我们的协议里没有「服务端向客户端请求」这回事
    this.send(
      state,
      this.errorFrame(
        null,
        new ServerError("invalid_params", {
          detail: { reason: "unexpected_response", got: frame.kind },
        }),
        state.language,
      ),
    );
  }

  /** 二进制帧：只可能是上传分片 */
  private async onBinary(state: ConnectionState, bytes: Uint8Array): Promise<void> {
    const uploads = this.options.uploads;
    if (!uploads) {
      this.send(
        state,
        this.errorFrame(
          null,
          new ServerError("unsupported", {
            params: { what: "binary uploads" },
            detail: { reason: "uploads_not_enabled" },
          }),
          state.language,
        ),
      );
      return;
    }
    if (!state.authorized) {
      this.send(
        state,
        this.errorFrame(
          null,
          new ServerError("unauthorized", { detail: { reason: "hello_required" } }),
          state.language,
        ),
      );
      return;
    }
    try {
      await uploads.receiveBinary(state.id, bytes);
    } catch (error) {
      this.send(state, this.errorFrame(null, error, state.language));
    }
  }

  /**
   * 请求帧：先按对话挂起推送，再分发，最后写回包，回包写完按序放行该对话的推送（R47）。
   *
   * 「先挂起再分发」是关键：事件可能在分发的第一行就产生（受理即返回的方法正是这样），
   * 挂起晚一步就会出现「客户端还没拿到 id 就收到事件」。
   */
  private async onRequest(
    state: ConnectionState,
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const holdKey = conversationKeyOfParams(params);
    if (holdKey !== null) this.hold(state, holdKey);

    let response: JsonRpcResponseFrame;
    try {
      const result = await this.invoke(state, method, params);
      response = okResponse(id, result);
    } catch (error) {
      response = this.errorFrame(id, error, state.language);
    }

    this.send(state, response);
    // 回包已经交给 socket（ws 按调用顺序写出），这时候放行不会插到回包前面
    if (holdKey !== null) this.release(state, holdKey);
  }

  /** 通知帧（客户端发来的、不需要回包）：照常执行，出错时用 `id: null` 报一次 */
  private async onNotification(
    state: ConnectionState,
    method: string,
    params: unknown,
  ): Promise<void> {
    const holdKey = conversationKeyOfParams(params);
    if (holdKey !== null) this.hold(state, holdKey);
    try {
      await this.invoke(state, method, params);
    } catch (error) {
      this.send(state, this.errorFrame(null, error, state.language));
    }
    if (holdKey !== null) this.release(state, holdKey);
  }

  // -------------------------------------------------------------------------
  // 分发
  // -------------------------------------------------------------------------

  /**
   * 方法名 → 结果。
   *
   * 顺序是有意的：`hello` 永远放行（握手本身不需要先握手）；其余方法在未握手时一律
   * `unauthorized`（连方法名都不判断，免得「未授权的连接能探出服务端有哪些方法」）。
   */
  private async invoke(state: ConnectionState, method: string, params: unknown): Promise<unknown> {
    if (method === HELLO_METHOD) return await this.handleHello(state, params);

    if (!state.authorized) {
      throw new ServerError("unauthorized", { detail: { reason: "hello_required" } });
    }

    if (!isMethodName(method)) {
      throw new ServerError("unsupported", {
        params: { what: method },
        detail: { method, reason: "unknown_method" },
      });
    }

    // 语言是连接状态，接线层自己管（业务层不该知道「这条连接说哪种语言」之外的任何事）
    if (method === "server.setLanguage") return this.handleSetLanguage(state, params);

    if (this.options.uploads) {
      if (method === "asset.begin") {
        return await this.options.uploads.begin(state.id, params as AssetBeginParams);
      }
      if (method === "asset.end") {
        return await this.options.uploads.end(state.id, params as AssetEndParams);
      }
    }

    const handler: unknown = this.options.handlers[method];
    if (typeof handler !== "function") {
      throw new ServerError("unsupported", {
        params: { what: method },
        detail: { method, reason: "handler_not_registered" },
      });
    }
    const call = handler as AnyMethodHandler;
    return await call({ method, params, connection: toConnectionInfo(state) });
  }

  /**
   * 握手。
   *
   * `language` 认不出来时回落英文（PRD D8）；不传就用配置的默认语言。
   * 失败不改变这条连接已经有的授权状态（重复握手是客户端自己的选择，失败不该把现有连接打回未授权）。
   */
  private async handleHello(state: ConnectionState, params: unknown): Promise<ServerHelloResult> {
    const hello = asHelloParams(params);
    const verified = await this.options.verifyToken.verify(hello.token);
    if (verified === null) {
      throw new ServerError("unauthorized", { detail: { reason: "token_rejected" } });
    }

    state.authorized = true;
    state.credentialId = verified.id;
    state.clientInfo = hello.clientInfo;
    state.language =
      typeof hello.language === "string" && hello.language.trim() !== ""
        ? normalizeLanguage(hello.language)
        : this.defaultLanguage;

    return {
      language: state.language,
      serverVersion: this.options.serverVersion,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: this.startedAt,
      capabilities: this.options.capabilities?.() ?? [],
      limits: this.transferLimits(),
    };
  }

  /** `server.setLanguage`：改这条连接的语言，断开即忘（PRD D8 / F-E4） */
  private handleSetLanguage(state: ConnectionState, params: unknown): ServerSetLanguageResult {
    const record = asRecord(params, "params");
    const language = record.language;
    if (typeof language !== "string" || language.trim() === "") {
      throw new ServerError("invalid_params", {
        params: { field: "language" },
        detail: { field: "language", reason: "missing_language" },
      });
    }
    state.language = normalizeLanguage(language);
    return { language: state.language };
  }

  private transferLimits(): TransferLimits {
    return {
      maxAssetBytes: this.options.uploads?.maxAssetBytes ?? MAX_ASSET_BYTES,
      maxAssetsPerMessage: MAX_ASSETS_PER_MESSAGE,
    };
  }

  // -------------------------------------------------------------------------
  // 推送缓冲（R47）
  // -------------------------------------------------------------------------

  private hold(state: ConnectionState, key: string): void {
    const existing = state.holds.get(key);
    if (existing) {
      existing.depth += 1;
      return;
    }
    state.holds.set(key, { depth: 1, queue: [] });
  }

  /**
   * 放行一段对话的推送。
   *
   * 只有最后一层请求回包之后才真的放（同一对话同时有两个请求在飞时，先回包的那一个不该把
   * 后一个还没回包时产生的事件抢在前面发出去）。
   */
  private release(state: ConnectionState, key: string): void {
    const hold = state.holds.get(key);
    if (!hold) return;
    hold.depth -= 1;
    if (hold.depth > 0) return;
    state.holds.delete(key);
    for (const makeFrame of hold.queue) this.send(state, makeFrame());
  }

  /** 发一帧：按对话的缓冲、连接状态一起看，该排队就排队 */
  private deliver(
    state: ConnectionState,
    conversationId: string | null,
    makeFrame: () => JsonRpcNotificationFrame,
  ): void {
    if (!state.authorized) return;
    if (conversationId !== null) {
      const hold = state.holds.get(conversationId);
      if (hold) {
        // 排队的是一段「怎么造这一帧」的意图，不是某个已经渲染好的帧：放行时用那时的语言重算
        hold.queue.push(makeFrame);
        return;
      }
    }
    this.send(state, makeFrame());
  }

  private send(state: ConnectionState, frame: JsonRpcResponseFrame | JsonRpcNotificationFrame): void {
    if (state.socket.readyState !== WebSocket.OPEN) return;
    try {
      state.socket.send(JSON.stringify(frame));
    } catch (error) {
      this.logger.warn("发送帧失败", { connectionId: state.id, error });
    }
  }

  /**
   * 抛出的东西 → 错误帧。
   *
   * `ServerError` 原样出网（业务码 + 按连接语言渲染的句子 + detail）；其余一律收敛成 `internal`，
   * 细节（含栈）只进日志 —— 客户端看到的是「服务端出错了，日志里有细节」。
   */
  private errorFrame(id: JsonRpcId | null, error: unknown, language: Language): JsonRpcErrorFrame {
    if (ServerError.is(error)) return errResponse(id, error, language);
    this.logger.error("处理请求时抛出非业务错误", { error: describeError(error) });
    return errResponse(id, new ServerError("internal"), language);
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

function toConnectionInfo(state: ConnectionState): ConnectionInfo {
  return {
    id: state.id,
    language: state.language,
    clientInfo: state.clientInfo,
    credentialId: state.credentialId,
  };
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

/** 入站字节：`ws` 可能给 Buffer、ArrayBuffer 或 Buffer 数组（分片） */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** 入站文本：同样要能吃分片 */
function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/**
 * 从一段坏帧里尽量捞出 `id`，好让错误响应能对上是哪个请求。
 *
 * 两步：能整段解析就取 `id`；解析不了（半截 JSON、多了个逗号）再用一次文本扫描 ——
 * 这是尽力而为：扫不到就回 `null`，错误帧允许 `id` 为 `null`（标准里就是「连 id 都没解析出来」）。
 * 扫描可能误命中嵌套对象里的 `id`，所以它只作为整段解析失败后的退路。
 */
function extractId(text: string): JsonRpcId | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null) {
      return asId((value as Record<string, unknown>).id);
    }
  } catch {
    // 坏到解析不了：往下走文本扫描
  }
  const matched = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?)/.exec(text);
  const raw = matched?.[1];
  if (raw === undefined) return null;
  if (raw.startsWith("\"")) {
    try {
      return asId(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return asId(Number(raw));
}

function asId(value: unknown): JsonRpcId | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** 请求参数里的 `conversationId`：有就按它缓冲该对话的推送（R47） */
function conversationKeyOfParams(params: unknown): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>).conversationId;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * 事件载荷里的对话 id。
 *
 * 六种事件都挂着某段对话（通知与问题的 `conversationId` 可能是 `null`：那是全局的，
 * 不受任何对话的缓冲影响）。这一处让 `push` 的调用方不必自己传 key。
 */
function conversationKeyOf<E extends EventName>(event: E, payload: EventMap[E]): string | null {
  switch (event) {
    case "run.state":
    case "message.delta":
    case "conversation.changed":
    case "usage":
      return nonEmpty((payload as EventMap["run.state"]).conversationId);
    case "notice":
      return nonEmpty((payload as EventMap["notice"]).notice.conversationId);
    case "question":
      return nonEmpty((payload as EventMap["question"]).question.conversationId);
    default:
      return null;
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerError("invalid_params", {
      params: { field },
      detail: { field, reason: "not_an_object" },
    });
  }
  return value as Record<string, unknown>;
}

/**
 * `hello` 入参的校验。
 *
 * 只校验「少了就完全没法握手」的三样：`token`、`clientInfo`（客户端自报身份，用于连接列表与日志）、
 * 以及可选的 `language`（不是字符串就当没给）。
 */
function asHelloParams(value: unknown): ServerHelloParams {
  const record = asRecord(value, "params");
  const token = record.token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new ServerError("invalid_params", {
      params: { field: "token" },
      detail: { field: "token", reason: "missing_token" },
    });
  }
  return {
    token: token.trim(),
    language: typeof record.language === "string" ? record.language : undefined,
    clientInfo: asClientInfo(record.clientInfo),
  };
}

function asClientInfo(value: unknown): ClientInfo {
  const record = asRecord(value, "clientInfo");
  const name = record.name;
  const version = record.version;
  if (typeof name !== "string" || name.trim() === "") {
    throw new ServerError("invalid_params", {
      params: { field: "clientInfo.name" },
      detail: { field: "clientInfo.name", reason: "missing_name" },
    });
  }
  if (typeof version !== "string" || version.trim() === "") {
    throw new ServerError("invalid_params", {
      params: { field: "clientInfo.version" },
      detail: { field: "clientInfo.version", reason: "missing_version" },
    });
  }
  const platform = record.platform;
  return {
    name: name.trim(),
    version: version.trim(),
    platform: typeof platform === "string" && platform.trim() !== "" ? platform.trim() : undefined,
  };
}
