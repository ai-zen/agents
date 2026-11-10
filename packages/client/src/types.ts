/**
 * 客户端侧对「服务端」的全部认知。
 *
 * 这里只有**端口**（能力接口），没有实现：TUI / 命令层只认 {@link ServerClient}，
 * 不认 TCP、不认 HTTP，也不知道服务端跑在同机还是别处。将来换传输（WebSocket / stdio /
 * ssh 隧道）只换实现类，调用点一行不改 —— 这是「传输自由」在类型上的落点。
 */

import type { ServerEvent } from "@ai-zen/agents-server/protocol";

/**
 * 服务端在哪。
 *
 * 单独起个名字（而不是到处写 `{ host: string; port: number }`）：将来换 unix socket
 * 或 URL 时，改的是这一个类型，不是二十九处字面量。
 */
export interface ServerAddress {
  host: string;
  port: number;
}

/** 客户端身份：握手首帧的 `client` 字段，只进日志与服务端回执，**不参与鉴权** */
export interface ClientInfo {
  name: string;
  version: string;
}

export interface CallOptions {
  /** 本次调用的时限；不传就用客户端默认值 */
  timeoutMs?: number;
}

/**
 * 服务端连接的端口。
 *
 * ## 为什么叫 ServerClient 而不是 SessionClient
 *
 * 它是一条**到服务端的连接**，承载的是全部方法：`ping` / `workspace.*` / `session.*`。
 * 而 `session` 在本项目里特指「与某个 Agent 进行的一段会话」（workspace 的下级对象），
 * 拿它当“连接”用会让两层概念糊在一起 —— 一条连接可以陆续服务好几个会话。
 *
 * `call` 是请求/响应，`on` 是服务端主动推的事件（阶段、增量、轮次收尾）—— 两者
 * 共用一条连接，事件的载荷形状由 `@ai-zen/agents-server` 的 `protocol/sessions.ts` 定义。
 */
export interface ServerClient {
  readonly address: ServerAddress;
  /**
   * 这条连接是否已经断了。
   *
   * 断开之后**不能再用**：`call` 会直接拒绝，事件也不会再来。要恢复只能新建一条
   * （见 `RemoteChatSession` 的重连）。把“活着没”放在端口上，是因为调用方不该去摸
   * `SocketServerClient` 的私有字段 —— 那是实现细节。
   */
  readonly closed: boolean;
  call<T = unknown>(method: string, params?: unknown, options?: CallOptions): Promise<T>;
  /**
   * 订阅某个事件；返回取消订阅的函数。
   *
   * 事件名绑到 `ServerEvent` 上：写错事件名是编译错误，而不是"订阅了但永远收不到"。
   */
  on<E extends ServerEvent["event"]>(
    event: E,
    listener: (payload: Extract<ServerEvent, { event: E }>) => void,
  ): () => void;
  close(): void;
  /**
   * 订阅“连接断了”。返回取消订阅的函数。
   *
   * 与 `on(事件名)` 分开：事件是**服务端说的**，断开是**传输层说的** —— 断的那一刻
   * 已经没有东西能替服务端发言了，而「要不要重连」是客户端的決定。
   * 主动 `close()` 也会触发它（重连逻辑要能分辨“我自己关的”）。
   */
  onClose(listener: () => void): () => void;
}
