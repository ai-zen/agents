/**
 * 客户端侧对「服务端」的全部认知。
 *
 * 这里只有**端口**（能力接口），没有实现：TUI / 命令层只认 {@link ServerClient}，不认
 * WebSocket、不认 `ws://`，也不知道服务端跑在同机还是别处。将来换传输（stdio / ssh 隧道 /
 * 内存双工）只换实现类，调用点一行不改 —— 这是「传输自由」在类型上的落点。
 *
 * 线上形状是 JSON-RPC 2.0 over WebSocket（见 `@ai-zen/agents-server/protocol`）；本文件只
 * 描述「调用方看到的那三件事」：调用、事件、断开。
 */

import type { ServerEvent } from "@ai-zen/agents-server/protocol";
import type { ServerTarget } from "./wire/server-url.js";

/**
 * 服务端在哪。
 *
 * **这是 {@link ServerTarget} 的类型别名，不再是一份独立定义**：形状（`host` / `port` /
 * `path?` / `secure?`）只在 `wire/server-url.ts` 里写一次 —— 那里同时是 URL 的唯一实现处。
 * 两份逐字相同的形状看起来无害，代价却在「哪个才是权威」：改了 `webSocketUrl` 认识的那一份、
 * 忘了另一份，编译照样通过，而线上会少一段 path 或多一个斜杠。
 *
 * 名字保留（而不是让全仓改叫 `ServerTarget`）只是为了少一片改名噪声：`ServerClient.address`、
 * 会话层的错误文案、两个前端的 import 都还认这个名字。
 */
export type ServerAddress = ServerTarget;

/** 客户端身份：握手请求 `hello` 的 `params.client`，只进日志与服务端回执，**不参与鉴权** */
export interface ClientInfo {
  name: string;
  version: string;
}

export interface CallOptions {
  /** 本次调用的时限；不传就用客户端默认值 */
  timeoutMs?: number;
  /**
   * 同时发出去的**原始字节**：这次调用在线上是**两条** WS 消息 —— 先一条文本请求，再一条
   * 二进制消息（前 4 字节是该请求 `id` 的大端无符号数，其余就是这些字节）。
   *
   * 为什么挂在 options 上而不是 params 里：文本消息是 JSON，字节进去只能被 base64 一遍
   * （体积涨三分之一、还得先整块驻留成字符串）。分开之后载荷长度只有一个来源 —— 二进制消息
   * 自己的长度（所以 `params` 里**没有**「字节数」这个字段，A24）。
   */
  bytes?: Uint8Array;
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
 * 共用一条连接，事件的载荷形状由 `@ai-zen/agents-server/protocol` 的 `sessions.ts` 定义。
 */
export interface ServerClient {
  readonly address: ServerAddress;
  /**
   * 这条连接是否已经断了。
   *
   * 断开之后**不能再用**：`call` 会直接拒绝，事件也不会再来。要恢复只能新建一条
   * （见 `SessionChannel` 的重连）。把“活着没”放在端口上，是因为调用方不该去摸
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
