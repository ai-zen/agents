/**
 * `WsHub` —— 一条 WebSocket 上的接线层（PLAN A2 / §8）。
 *
 * 它只做四件事，一件也不多做：
 *
 *   1. **握手**：首帧必须是 `hello`（`{ token, language?, clientInfo }`）。没通过之前除了 `hello`
 *      什么都不接（一律 `unauthorized`），凭证不放在 URL 查询串里。`language` 挂在这条连接上、
 *      断开即忘（PRD D8）。
 *   2. **分发**：`MethodMap` 里的方法交给注入的 handler 表；没注册的方法回 `unsupported`
 *      （接线层自己代管的只有 `host.hello` / `host.setLanguage` 与上传三段）。
 *      业务逻辑一律不在本文件里。
 *   3. **推送**：JSON-RPC 通知（无 id），`params` 就是事件载荷。不重放、不需要 ack（PRD L5：
 *      断线重连由客户端自己拉）。受理即返回的方法（`session.send` 这类）会产生「事件早于回包」
 *      的顺序问题，所以按 `sessionId` 缓冲，回包写完再按序放行（裁定 R47）。
 *   4. **上传帧**：二进制帧交给 `UploadReceiver` 落盘；连接断开时把它名下未完成的上传清掉。
 *
 * 错误一律走 JSON-RPC `error`：`data.code` 是稳定业务码、`data.message` 是按**这条连接的语言**
 * 渲染好的句子、`data.detail` 是结构化事实。非 `HostError` 的抛出收敛成 `internal` ——
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
  HostError,
  errResponse,
  isMethodName,
  notification,
  okResponse,
  parseFrame,
  type AssetBeginParams,
  type AssetEndParams,
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
  type HostHelloParams,
  type HostHelloResult,
  type HostSetLanguageResult,
  type TransferLimits,
} from "../wire/index.js";
import type { TokenVerifier } from "./auth.js";
import { decodeChunkFrame, type UploadReceiver } from "./UploadReceiver.js";

// ---------------------------------------------------------------------------
// 注入点
// ---------------------------------------------------------------------------

/** 一条连接对 handler 可见的事实（不把 socket 漏给业务层） */
export interface ConnectionInfo {
  /** 宿主分配的连接 id（问题对象的 `answeredBy` 这类「哪条连接」的事实用它） */
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
 * 抛 `HostError` 表达「可以给用户看的原因」，抛别的会被收敛成 `internal` 并进日志。
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

/**
 * 连接未声明语言时的缺省语言来源。
 *
 * 给函数时在每次握手那一刻求值：缺省语言是「配置里的那一项」（PRD D8 / R58），而配置可以在
 * 进程跑着的时候改，存成构造时的快照会让「刚改的缺省语言」对下一条连接不生效。
 */
export type DefaultLanguageSource = Language | (() => Language | Promise<Language>);

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
  /** 宿主版本（`hello` 的 `hostVersion`，升级判定要向客户端报这个） */
  hostVersion: string;
  /** 进程启动时刻（ISO 8601）；缺省取构造时的时钟 */
  startedAt?: string;
  /** 连接未声明语言时的缺省语言（PRD D8：缺省英文）；给函数时每次握手现算 */
  defaultLanguage?: DefaultLanguageSource;
  /** 推送出网前的按连接本地化（不注入则原样搬运） */
  localizeEvent?: EventLocalizer;
  /** 时钟，缺省 `Date.now` */
  clock?: () => number;
  /** 日志；缺省安静 */
  logger?: HubLogger;
}

// ---------------------------------------------------------------------------
// 连接状态
// ---------------------------------------------------------------------------

/**
 * 一段对话的推送：`depth` 是「还有几个请求没回包」，归零时把压着的帧按序放行。
 *
 * 压着的是「怎么造这一帧」的意图（惰性构造）而不是渲染好的帧：放行时才按那时的连接语言渲染。
 */
interface DeferredPush {
  depth: number;
  /** 压着的帧（惰性构造：放行时才按那时的连接语言渲染） */
  queue: (() => JsonRpcNotificationFrame)[];
}

interface ConnectionState {
  id: string;
  socket: WebSocket;
  language: Language;
  clientInfo: ClientInfo | null;
  credentialId: string | null;
  authorized: boolean;
  /** sessionId → 压着还没放行的推送 */
  deferred: Map<string, DeferredPush>;
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
const HELLO_METHOD = "host.hello";

export class WsHub {
  private readonly options: WsHubOptions;
  private readonly logger: HubLogger;
  private readonly clock: () => number;
  private readonly startedAt: string;
  /** 缺省语言来源（可能是函数：配置里的那一项可改，每次握手现算） */
  private readonly defaultLanguageSource: DefaultLanguageSource;
  /** connectionId → 连接状态（关闭即移除；推送只发给还在这里面的连接） */
  private readonly connections = new Map<string, ConnectionState>();
  private server: WebSocketServer | null = null;
  private closing: Promise<void> | null = null;

  constructor(options: WsHubOptions) {
    this.options = options;
    this.logger = options.logger ?? QUIET_LOGGER;
    this.clock = options.clock ?? Date.now;
    this.startedAt = options.startedAt ?? new Date(this.clock()).toISOString();
    this.defaultLanguageSource = options.defaultLanguage ?? "en";
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
        state.socket.close(1001, "host shutting down");
      } catch {
        // 已经断了：下面统一按「连接没了」处理
      }
      await this.options.uploads?.abortConnection(state.id).catch((error: unknown) => {
        this.logger.warn("清理上传失败", { error });
      });
      state.deferred.clear();
      this.connections.delete(state.id);
    }

    if (!server) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 兜底：还在半开状态的连接直接断掉，避免关宿主时挂在这里
        for (const client of server.clients) client.terminate();
      }, 200);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // 推送（宿主 → 客户端）
  // -------------------------------------------------------------------------

  /**
   * 推一个事件给所有已握手的连接。
   *
   * 形状与 `ChatRunner` 的 `ChatEventEmitter` 一致，所以单根可以把它直接当 `emit` 注入。
   * 事件里带 `sessionId` 的（全部事件都带）会受该对话的缓冲控制：有请求还没回包时先排队。
   */
  push<E extends EventName>(event: E, payload: EventMap[E]): void {
    const key = sessionKeyOf(event, payload);
    for (const state of this.connections.values()) {
      this.dispatch(state, key, () => this.frameFor(state, event, payload));
    }
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

  // -------------------------------------------------------------------------
  // 连接
  // -------------------------------------------------------------------------

  private accept(socket: WebSocket): void {
    const state: ConnectionState = {
      id: randomUUID(),
      socket,
      // 握完手就换成协商出的那一份；这里是它之前的样子（同步可得的那个值）
      language: this.initialLanguage(),
      clientInfo: null,
      credentialId: null,
      authorized: false,
      deferred: new Map(),
    };
    this.connections.set(state.id, state);

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
    state.deferred.clear();
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
      this.writeFrame(state, this.errorFrame(extractId(toText(data)), error, state.language));
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
    // 客户端发来的响应：我们的协议里没有「宿主向客户端请求」这回事
    this.writeFrame(
      state,
      this.errorFrame(
        null,
        new HostError("invalid_params", {
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
      this.writeFrame(
        state,
        this.errorFrame(
          null,
          new HostError("unsupported", {
            params: { what: "binary uploads" },
            detail: { reason: "uploads_not_enabled" },
          }),
          state.language,
        ),
      );
      return;
    }
    if (!state.authorized) {
      this.writeFrame(
        state,
        this.errorFrame(
          null,
          new HostError("unauthorized", { detail: { reason: "hello_required" } }),
          state.language,
        ),
      );
      return;
    }
    try {
      await uploads.receiveBinary(state.id, bytes);
    } catch (error) {
      this.writeFrame(state, this.chunkErrorFrame(error, bytes, state.language));
    }
  }

  /**
   * 分片帧的错误帧。
   *
   * 二进制帧没有 `id`，所以「哪一趟上传被拒了」只能靠 `detail.uploadId` 认出来：这里尽力从帧头
   * 取一次 `uploadId` 补进 `detail`（原有的结构化事实不动，已经有 `uploadId` 就不覆盖）。
   * 业务错误原样出网；非业务错误按 `internal` 出网、细节只进日志。帧头坏到解不出 `uploadId` 时
   * 与原来一样，什么也不补。
   */
  private chunkErrorFrame(
    error: unknown,
    frame: Uint8Array,
    language: Language,
  ): JsonRpcErrorFrame {
    const uploadId = uploadIdOf(frame);
    if (uploadId === null) return this.errorFrame(null, error, language);
    if (HostError.is(error)) {
      return errResponse(null, withUploadId(error, uploadId), language);
    }
    this.logger.error("处理上传分片时出现非业务错误", { uploadId, error: describeError(error) });
    return errResponse(
      null,
      new HostError("internal", { detail: { reason: "chunk_failed", uploadId } }),
      language,
    );
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
    const holdKey = sessionKeyOfParams(params);
    if (holdKey !== null) this.defer(state, holdKey);

    let response: JsonRpcResponseFrame;
    try {
      const result = await this.invoke(state, method, params);
      response = okResponse(id, result);
    } catch (error) {
      response = this.errorFrame(id, error, state.language);
    }

    this.writeFrame(state, response);
    // 回包已经交给 socket（ws 按调用顺序写出），这时候放行不会插到回包前面
    if (holdKey !== null) this.flush(state, holdKey);
  }

  /** 通知帧（客户端发来的、不需要回包）：照常执行，出错时用 `id: null` 报一次 */
  private async onNotification(
    state: ConnectionState,
    method: string,
    params: unknown,
  ): Promise<void> {
    const holdKey = sessionKeyOfParams(params);
    if (holdKey !== null) this.defer(state, holdKey);
    try {
      await this.invoke(state, method, params);
    } catch (error) {
      this.writeFrame(state, this.errorFrame(null, error, state.language));
    }
    if (holdKey !== null) this.flush(state, holdKey);
  }

  // -------------------------------------------------------------------------
  // 分发
  // -------------------------------------------------------------------------

  /**
   * 方法名 → 结果。
   *
   * 顺序是有意的：`hello` 永远放行（握手本身不需要先握手）；其余方法在未握手时一律
   * `unauthorized`（连方法名都不判断，免得「未授权的连接能探出宿主有哪些方法」）。
   */
  private async invoke(state: ConnectionState, method: string, params: unknown): Promise<unknown> {
    if (method === HELLO_METHOD) return await this.handleHello(state, params);

    if (!state.authorized) {
      throw new HostError("unauthorized", { detail: { reason: "hello_required" } });
    }

    if (!isMethodName(method)) {
      throw new HostError("unsupported", {
        params: { what: method },
        detail: { method, reason: "unknown_method" },
      });
    }

    // 语言是连接状态，接线层自己管（业务层不该知道「这条连接说哪种语言」之外的任何事）
    if (method === "host.setLanguage") return this.handleSetLanguage(state, params);

    if (this.options.uploads) {
      if (method === "asset.begin") {
        // 语言是连接状态：草稿对话落库时要靠它渲染那条隐藏的 cwd 消息（D8）
        return await this.options.uploads.begin(
          state.id,
          params as AssetBeginParams,
          state.language,
        );
      }
      if (method === "asset.end") {
        return await this.options.uploads.end(state.id, params as AssetEndParams);
      }
    }

    const handler: unknown = this.options.handlers[method];
    if (typeof handler !== "function") {
      throw new HostError("unsupported", {
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
  private async handleHello(state: ConnectionState, params: unknown): Promise<HostHelloResult> {
    const hello = asHelloParams(params);
    const verified = await this.options.verifyToken.verify(hello.token);
    if (verified === null) {
      throw new HostError("unauthorized", { detail: { reason: "token_rejected" } });
    }

    state.authorized = true;
    state.credentialId = verified.id;
    state.clientInfo = hello.clientInfo;
    state.language =
      typeof hello.language === "string" && hello.language.trim() !== ""
        ? normalizeLanguage(hello.language)
        : await this.resolveDefaultLanguage();

    return {
      language: state.language,
      hostVersion: this.options.hostVersion,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: this.startedAt,
      limits: this.transferLimits(),
    };
  }

  /**
   * 连接没声明语言时用哪一种（PRD D8 / 裁定 R58）。
   *
   * 来源可以是函数（配置里的缺省语言可改），所以每次握手现算一次；算不出来就用英文 ——
   * 语言这件事不该让握手失败。
   */
  private async resolveDefaultLanguage(): Promise<Language> {
    const source = this.defaultLanguageSource;
    if (typeof source === "string") return source;
    try {
      return normalizeLanguage(await source());
    } catch (error) {
      this.logger.warn("读缺省语言失败，回落到英文", { error: describeError(error) });
      return "en";
    }
  }

  /** 握手之前的语言：来源不是函数时就是它，是函数时先用英文（拿不到同步值） */
  private initialLanguage(): Language {
    const source = this.defaultLanguageSource;
    return typeof source === "string" ? source : "en";
  }

  /** `host.setLanguage`：改这条连接的语言，断开即忘（PRD D8 / F-E4） */
  private handleSetLanguage(state: ConnectionState, params: unknown): HostSetLanguageResult {
    const record = asRecord(params, "params");
    const language = record.language;
    if (typeof language !== "string" || language.trim() === "") {
      throw new HostError("invalid_params", {
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
  // 推送：该压就压、该写就写（R47）
  // -------------------------------------------------------------------------

  /** 压住一段对话的推送：每来一个带 `sessionId` 的请求，这一段的深度加一 */
  private defer(state: ConnectionState, key: string): void {
    const existing = state.deferred.get(key);
    if (existing) {
      existing.depth += 1;
      return;
    }
    state.deferred.set(key, { depth: 1, queue: [] });
  }

  /**
   * 放行一段对话压着的推送。
   *
   * 只有最后一层请求回包之后才真的放（同一对话同时有两个请求在飞时，先回包的那一个不该把
   * 后一个还没回包时产生的事件抢在前面发出去）。
   */
  private flush(state: ConnectionState, key: string): void {
    const push = state.deferred.get(key);
    if (!push) return;
    push.depth -= 1;
    if (push.depth > 0) return;
    state.deferred.delete(key);
    for (const makeFrame of push.queue) this.writeFrame(state, makeFrame());
  }

  /**
   * 一个事件落到这条连接上：**该压就压、该写就写**。
   *
   * 两件事分得很清楚，名字就是它们的分界：
   *
   *   - **压**（{@link defer} 压出来的那一格还在）：这一段有请求没回包，先把「怎么造这一帧」
   *     的意图塞进队列，等回包写完那一拍由 {@link flush} 按序放行 —— 客户端不该在拿到 id
   *     之前就收到这段对话的事件（R47）；
   *   - **写**（{@link writeFrame}）：没有要等的回包，帧直接出去。
   *
   * 还没握手的连接一帧都不写（连推送都不给）。
   */
  private dispatch(
    state: ConnectionState,
    sessionId: string | null,
    makeFrame: () => JsonRpcNotificationFrame,
  ): void {
    if (!state.authorized) return;
    if (sessionId !== null) {
      const push = state.deferred.get(sessionId);
      if (push) {
        // 压着的是一段「怎么造这一帧」的意图，不是某个已经渲染好的帧：放行时用那时的语言重算
        push.queue.push(makeFrame);
        return;
      }
    }
    this.writeFrame(state, makeFrame());
  }

  /** 真的往 socket 上写一帧（连接已经不在就直接丢掉，不抛给调用方） */
  private writeFrame(
    state: ConnectionState,
    frame: JsonRpcResponseFrame | JsonRpcNotificationFrame,
  ): void {
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
   * `HostError` 原样出网（业务码 + 按连接语言渲染的句子 + detail）；其余一律收敛成 `internal`，
   * 细节（含栈）只进日志 —— 客户端看到的是「宿主出错了，日志里有细节」。
   */
  private errorFrame(id: JsonRpcId | null, error: unknown, language: Language): JsonRpcErrorFrame {
    if (HostError.is(error)) return errResponse(id, error, language);
    this.logger.error("处理请求时抛出非业务错误", { error: describeError(error) });
    return errResponse(id, new HostError("internal"), language);
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

/**
 * 从一帧分片里尽力取出 `uploadId`（解不出就是 `null`：帧已经坏到没有头可读）。
 */
function uploadIdOf(frame: Uint8Array): string | null {
  try {
    return decodeChunkFrame(frame).uploadId;
  } catch {
    return null;
  }
}

/**
 * 把 `uploadId` 补进错误的 `detail`（原有的事实保留，已有的 `uploadId` 不覆盖）。
 *
 * `detail` 不是对象时把它挪到 `detail.detail` 下而不是丢掉：错误帧里带出去的结构化事实
 * 都走 `detail`，一个非对象的值不能成为「既然不好合并就扔掉」的理由。
 */
function withUploadId(error: HostError, uploadId: string): HostError {
  const detail = error.detail;
  if (detail === undefined) return error.withDetail({ uploadId });
  if (typeof detail === "object" && detail !== null && !Array.isArray(detail)) {
    const record = detail as Record<string, unknown>;
    if (record.uploadId !== undefined) return error;
    return error.withDetail({ ...record, uploadId });
  }
  return error.withDetail({ detail, uploadId });
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

/** 请求参数里的 `sessionId`：有就按它缓冲该对话的推送（R47） */
function sessionKeyOfParams(params: unknown): string | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>).sessionId;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * 事件载荷里的对话 id。
 *
 * 多数事件直接在顶层带 `sessionId`（忙闲、两道闸、出错、结构变化、三条消息事件）；通知与
 * 问题是嵌套的，而且那个字段可以是
 * `null`（全局的：不受任何对话的缓冲影响）。这一处让 `push` 的调用方不必自己传 key。
 */
function sessionKeyOf<E extends EventName>(event: E, payload: EventMap[E]): string | null {
  switch (event) {
    case "notice":
      return nonEmpty((payload as EventMap["notice"]).notice.sessionId);
    case "question":
      return nonEmpty((payload as EventMap["question"]).question.sessionId);
    case "message.added":
    case "message.delta":
    case "message.changed":
    case "message.removed":
    case "state":
    // 两道闸那四条也带会话 id：它们同样要按「这一段有没有请求在飞」压住（R47）
    case "output:paused":
    case "output:resumed":
    case "input:paused":
    case "input:resumed":
    case "error":
    case "session.changed":
      return nonEmpty((payload as EventMap["state"]).sessionId);
    default:
      return null;
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostError("invalid_params", {
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
function asHelloParams(value: unknown): HostHelloParams {
  const record = asRecord(value, "params");
  const token = record.token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new HostError("invalid_params", {
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
    throw new HostError("invalid_params", {
      params: { field: "clientInfo.name" },
      detail: { field: "clientInfo.name", reason: "missing_name" },
    });
  }
  if (typeof version !== "string" || version.trim() === "") {
    throw new HostError("invalid_params", {
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
