/**
 * 一条到 `agents-host` 的连接：一条 WebSocket，上面跑 tRPC v11 的那条 ws 链路。
 *
 * ## 四件事
 *
 * {@link connect}（建连 + 握手）、`api`（`TRPCClient<AppRouter>`，类型直接从宿主推出来）、
 * `subscribe`（宿主那一条事件流）、`close`（幂等）。另有 `reconnect()`，它是 `reconnect.ts`
 * 认得的那一个口。
 *
 * ## 令牌只从握手帧上来
 *
 * 令牌放进 `createWSClient` 的 `connectionParams` —— tRPC 在 socket 开了之后把它作为**第一帧**
 * 送上去，宿主拿这一帧建上下文（`createContext` 校验它，验不过就回一帧错误并关掉连接）。它不进
 * URL 查询串：查询串会进访问日志、进程表与反向代理的访问记录。
 *
 * ## 断线之后补什么，不由这里决定
 *
 * socket 断了之后 tRPC 按它自己的退避重开一条，并把挂着的订阅搬过去；要不要一直试、试到什么时候
 * 放弃由调用方按 `reconnect.ts` 决定。**补什么也由调用方决定**：宿主有 `session.open`，一次就把
 * 状态、消息与排队区全部取回，所以这里不维护任何本地镜像 —— 留一份副本只会多一份会和宿主对不上
 * 的事实。
 *
 * ## 契约类型只从宿主的类型上来
 *
 * `AppRouter` / `HostEvent` 都是 `import type`：这个包被 cli 与桌面端各自捆进产物，运行期一个
 * 字节都不 import `@ai-zen/agents-host`（它的包根会把整个宿主 —— 单根、SQLite worker、SDK 装配
 * —— 拉进产物）。
 *
 * ## 传输用 Node 内建的全局 `WebSocket`
 *
 * 不引 `ws`：本包被捆进别人的产物，运行期依赖越少越好，而 Node 26 自带全局 `WebSocket` —— 它实现
 * 的是浏览器那一套接口（WHATWG WebSocket：`addEventListener` + `send`），不是另一个方言。桌面端
 * 要换成自己的实现时从 {@link ClientOptions.WebSocket} 进来。
 *
 * 代价记在明处：它的 `error` 事件不带底层原因（`ECONNREFUSED` 之类在内部被吞掉了），所以本地
 * 错误文案里自己带上端点 —— 连不上谁，是必须说出来的那一半。
 */

import {
  createTRPCClient,
  createWSClient,
  wsLink,
  type TRPCClient,
  type TRPCLink,
  type TRPCWebSocketClient,
} from "@trpc/client";
import type { AppRouter, HostEvent } from "@ai-zen/agents-host";

import { ClientError, fromTRPCError, localError, type HostErrorCode } from "./errors.js";

/** 取消订阅（{@link HostClient.subscribe} 的返回值） */
export type Unsubscribe = () => void;

/** 建连参数 */
export interface ClientOptions {
  /** 连哪儿：`ws://` / `wss://`，地址由 `address.ts` 算（`webSocketUrl`） */
  readonly url: string;
  /** 握手凭证：只进握手帧，不进 URL */
  readonly token: string;
  /** socket 实现；缺省用运行期的全局 `WebSocket`（Node 26 与浏览器各有一份） */
  readonly WebSocket?: typeof globalThis.WebSocket;
  /**
   * 本地文案用哪种语言。不上 wire：语言是宿主的用户级全局设置（`host` 那边的配置），
   * 不属于任何一条连接。
   */
  readonly language?: string;
  /** 建连之后多久还没调通一次调用就放弃；缺省 10 秒 */
  readonly handshakeTimeoutMs?: number;
}

/** 一条连上了的宿主 */
export interface HostClient {
  /** 类型推导直达宿主：`client.api.session.open.query({ sessionId })` */
  readonly api: TRPCClient<AppRouter>;
  /** 订阅宿主那一条事件流；返回退订函数（幂等） */
  subscribe(onEvent: (event: HostEvent) => void, onError?: (error: unknown) => void): Unsubscribe;
  /** 等到这条连接又能调通（`reconnect.ts` 的那个口）；断线之后补什么由调用方决定 */
  reconnect(): Promise<void>;
  /** 关掉这条连接；幂等。之后这个 client 上的调用直接失败 */
  close(): Promise<void>;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 连上一台宿主。
 *
 * 返回时一定已经调通过一次调用 —— 宿主拒一条连接的做法是「回一帧错误、再关掉 socket」，socket
 * 开着并不等于这条连接被接受过。所以握手就是「第一条成功的调用」，而不是「socket open 了」。
 */
export async function connect(options: ClientOptions): Promise<HostClient> {
  const client = new Connection(options);
  await client.handshake();
  return client;
}

/** 一条连接的全部状态。用 {@link connect} 建，不要自己 `new` */
class Connection implements HostClient {
  readonly api: TRPCClient<AppRouter>;

  private readonly socket: TRPCWebSocketClient;
  private readonly endpoint: string;
  private readonly language: string | undefined;
  private readonly handshakeTimeoutMs: number;

  /** 关掉之后一直拿它失败；`null` = 这条连接还活着 */
  private closed: ClientError | null = null;
  /** 宿主在这条 socket 上拒过连接时留下的那一帧（握手要说得清是哪一种拒） */
  private rejection: { code: string; message: string } | null = null;

  constructor(options: ClientOptions) {
    this.endpoint = options.url;
    this.language = options.language;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

    const Base = options.WebSocket ?? globalThis.WebSocket;
    this.socket = createWSClient({
      url: options.url,
      connectionParams: () => ({ token: options.token }),
      WebSocket: watchingSocket(Base, (rejection) => {
        this.rejection = rejection;
      }),
    });
    this.api = createTRPCClient<AppRouter>({
      links: [refusingWhenClosed(() => this.closed), wsLink<AppRouter>({ client: this.socket })],
    });
  }

  /** 等到这条连接真的调得通一次；不成就把 socket 收干净再抛 */
  async handshake(): Promise<void> {
    try {
      await this.probe("connect");
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  subscribe(onEvent: (event: HostEvent) => void, onError?: (error: unknown) => void): Unsubscribe {
    if (this.closed !== null) return () => {};
    const subscription = this.api.events.subscribe(undefined, {
      onData: (event) => {
        try {
          // 事件过了一条 JSON 通道：推过来的是它的序列化形状（类的身份不剩，字段一个不少），
          // 而调用方要的是宿主那个 `HostEvent`
          onEvent(event as HostEvent);
        } catch {
          // 一个订阅者抛错不该弄坏这条事件流，也不该连累别的订阅
        }
      },
      onError: (error) => {
        onError?.(fromTRPCError(error));
      },
    });
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      subscription.unsubscribe();
    };
  }

  /**
   * 等到这条连接又能调通（`reconnect.ts` 认的就是这个口）。
   *
   * 它不自己换 socket：换 socket 是 tRPC 那一层的事（断了它按退避重开一条，挂着的订阅跟着搬过去），
   * 两边各开一条只会让排进去的请求落在已经退下来的那条上。这里只回答「现在能不能调通」，
   * 调不通就把最后一次失败抛给调用方（试不试、试多久是 `reconnect.ts` 的事）。
   *
   * 连上之后的**补什么**也不在这里：宿主有 `session.open`，由调用方再取一次。
   */
  async reconnect(): Promise<void> {
    const closed = this.closed;
    if (closed !== null) throw closed;
    await this.probe("reconnect");
  }

  async close(): Promise<void> {
    if (this.closed !== null) return;
    // 先立起这一格：从那句话开始，新的调用由守卫直接拒，不必等 socket 收完
    this.closed = localError("closed", { language: this.language });
    await this.socket.close();
  }

  /**
   * 等到一次调用成功。
   *
   * 两条出口都可能是真的：宿主回了话（成功，或者一句带码的错），或者到了时限还没人应。前者按
   * 宿主说的算 —— 令牌不对时它回的那一帧由 {@link watchingSocket} 记下来，那句话与那个码原样
   * 上抛。
   *
   * `reason` 只影响宿主没说话时用哪个本地码：`connect` 是「还没连上过」（`host_unavailable`），
   * `reconnect` 是「连过又没了」（`connection_lost`）。两者对 `connection.ts` 的轮询都是
   * 「现在不行、等会儿再试」，分开是为了上屏那句话说得准。
   */
  private async probe(reason: "connect" | "reconnect"): Promise<void> {
    const timeoutMs = this.handshakeTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            localError("handshake_timeout", {
              language: this.language,
              params: { endpoint: this.endpoint, timeoutMs },
            }),
          ),
        timeoutMs,
      );
    });

    try {
      await Promise.race([this.api.host.version.query(), timedOut]);
      this.rejection = null;
      return;
    } catch (error) {
      const rejection = this.rejection;
      this.rejection = null;
      if (rejection !== null) {
        throw new ClientError(rejection.code as HostErrorCode, rejection.message);
      }
      const failure = fromTRPCError(error);
      // 宿主回过一句带码的错（入参、权限……）：那是它说的话，原样出去
      if (failure.code !== "connection_lost") throw failure;
      throw localError(reason === "connect" ? "host_unavailable" : "connection_lost", {
        language: this.language,
        params: { endpoint: this.endpoint },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 关掉之后的调用当场失败。
 *
 * 不能只靠 `WsClient.close()`：它关完之后，下一条调用会让它重新开一条 socket，于是「已经关掉」
 * 在调用方眼里变成「又连上了」。守卫立在链路最前面，关掉之后一次网络动作都不发生。
 *
 * 抛出去的 `ClientError` 由 tRPC 包成它自己的错误类型给调用方；`fromTRPCError` 认得这一层，
 * 会把原物取回来。
 */
function refusingWhenClosed(closed: () => ClientError | null): TRPCLink<AppRouter> {
  return () => (opts) => {
    const error = closed();
    if (error !== null) throw error;
    return opts.next(opts.op);
  };
}

/**
 * 在 socket 上看一眼「宿主拒了这条连接」的那一帧。
 *
 * 令牌验不过时宿主回 `{ id: null, error }` 再关连接（它 `createContext` 抛错那条路），而 tRPC
 * 的客户端把这种帧只记成「这条连接被拒了」，不把码与句子交出来 —— 到了调用方手里只剩「连接
 * 断了」。「令牌不对」与「宿主没起来」的处置不同（前者要改凭证，后者等一等就好），所以握手这
 * 一层自己看这一帧。
 */
function watchingSocket(
  base: typeof globalThis.WebSocket,
  onRejection: (rejection: { code: string; message: string }) => void,
): typeof globalThis.WebSocket {
  return class extends base {
    constructor(url: string | URL) {
      super(url);
      this.addEventListener("message", (event) => {
        const rejection = rejectionOf(event.data);
        if (rejection !== null) onRejection(rejection);
      });
    }
  };
}

/** 一帧 `{ id: null, error }` → 它的码与句子；别的（结果帧、`PING`、二进制）都不认领 */
function rejectionOf(raw: unknown): { code: string; message: string } | null {
  if (typeof raw !== "string") return null;
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (frame === null || typeof frame !== "object") return null;
  const envelope = frame as { id?: unknown; error?: unknown };
  if (envelope.id !== null) return null;
  if (envelope.error === null || typeof envelope.error !== "object") return null;

  const error = envelope.error as { code?: unknown; message?: unknown; data?: unknown };
  const data = error.data === null || typeof error.data !== "object" ? undefined : error.data;
  const code = data === undefined ? undefined : (data as { code?: unknown }).code;
  const named = typeof code === "string" ? code : typeof error.code === "string" ? error.code : "";
  if (named === "") return null;
  return { code: named, message: typeof error.message === "string" ? error.message : "" };
}
