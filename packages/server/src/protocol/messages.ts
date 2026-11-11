/**
 * 线上消息的**唯一**形状定义 —— 只有类型，没有一行运行期代码。
 *
 * 客户端（TUI / 桌面端 / 浏览器）只认这里的类型；服务端实现与传输（WebSocket / stdio / TCP）
 * 都不得额外约定格式。想加字段就加——但**不能改已有字段的语义**，客户端可能比服务端老。
 * 协议版本号变了就是断代，不做"尽力兼容"。
 *
 * ## 四类消息
 *
 * 外壳是 JSON-RPC 2.0，每条消息都带字面量 `jsonrpc: "2.0"`：
 *
 *   1. 请求（Request）          `{ jsonrpc, id, method, params? }`
 *   2. 通知（Notification）      `{ jsonrpc, method, params? }` —— 没有 `id`，不等回执
 *   3. 响应（Response）          `{ jsonrpc, id, result | error }` —— 对某条请求的回执
 *   4. 批量（Batch）             **本版不支持**：数组不是合法的请求对象
 *
 * ## 判别规则（只看两个键在不在）
 *
 *   · 有 `method`              → 请求；再看有没有 `id`：有 `id` 是请求，没 `id` 是通知
 *   · 没有 `method`、有 `id`   → 响应；`result` 与 `error` 恰有其一
 *
 * 也就是说「是不是请求」不靠某个专用字段，靠 `method` 的在场 —— 这正是把自定义 `kind`
 * 家族去掉之后唯一的判别依据。
 *
 * ## `id` 只允许 `0 … 2³²-1` 的整数
 *
 * JSON-RPC 2.0 允许两种 `id`：数字或字符串。本版只用**无符号 32 位整数**。原因是二进制：
 * 粘贴的图片等字节走同一条连接，不带 JSON 外壳，它用**前 4 字节**写这条请求的 `id`，
 * 好让服务端把字节与在飞的请求对上（可并发、可乱序，不靠先来后到）。4 字节前缀装不下
 * 字符串 `id`。将来要放宽成字符串 `id` 时，前缀改成「1 字节长度 + N 字节 tag」即可，
 * 不必换传输。
 *
 * ## 事件走通知：一条 method，载荷是判别联合
 *
 * 服务端推事件用的不是「一堆事件名各自当一个 method」，而是固定一条 `session.event`，
 * 具体是哪件事由 `params` 里的 `event` 字面量说（见 `EventNotification`）。这样请求方法名的
 * 空间不会被十几个「不可调用的名字」占掉。
 *
 * 版本号是个**类型**（`ProtocolVersion`），不是运行期常量：常量属于实现，见
 * `src/wire/messages.ts`。
 */

import type { AnyMethod, MethodApi } from "./api.js";
import type { ServerEvent } from "./sessions.js";

/** 协议版本：任何不兼容的字段变化都要 +1 */
export type ProtocolVersion = 2;

/**
 * `hello` 的参数 —— 建连后客户端发的**第一条请求**的参数。
 *
 * 握手是一条普通方法（`hello`），不是一种专门的帧：它的请求与响应和别的方法走同一条
 * 通路，也照样有 `id`。这样错误分级只剩一套（见 `errors.ts` 的 `handshake-required`）。
 */
export interface HelloParams {
  /** 客户端支持的协议版本（与服务端的 `ProtocolVersion` 必须相等，否则不连） */
  protocol: number;
  /** 客户端标识（只用于日志与本机调试，不参与鉴权） */
  client: {
    name: string;
    version: string;
  };
}

/** `hello` 的结果 —— 服务端的身份与它此刻的协议版本 */
export interface HelloResult {
  name: string;
  version: string;
  protocol: number;
  pid: number;
  startedAt: string;
}

/**
 * 请求帧（客户端 → 服务端）。
 *
 * 它是 **`MethodApi` 上的判别联合**：`method` 决定 `params` 的类型。构造一个请求即被这张表
 * 约束 —— 把 `SessionSendParams` 塞给 `session.attach`、或者把方法名拼错，都编译不过。
 * 没参数的方法（`ping` / `config.get` …）不允许带 `params`。
 */
export type RequestFrame = { [M in AnyMethod]: FrameFor<M> }[AnyMethod];

/** 某一个方法的请求帧形状 */
type FrameFor<M extends AnyMethod> = { jsonrpc: "2.0"; id: number; method: M } & ([
  MethodApi[M]["params"],
] extends [void]
  ? { params?: void }
  : { params: MethodApi[M]["params"] });

/**
 * 解码出来、**还没校验**的请求帧 —— 传输层只认这个形状。
 *
 * 为什么不让传输层直接用 `RequestFrame`：线上的字节是 JSON，任何一侧收到的都是
 * `unknown`。判别联合描述的是「合法请求长什么样」，而「这串字节是不是合法请求」只能靠
 * 运行期校验。把两者混成一个类型，等于让类型系统替 JSON 背书。
 */
export interface RawRequestFrame {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

/** 成功的响应：`result` 的形状由 `MethodApi` 决定，这里只搬运 */
export interface ResultFrame {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

/**
 * 错误对象 —— `code` 是 JSON-RPC 的数字码（见 `RpcErrorCode`），`data.code` 是原来的字符串码。
 *
 * 两层码各管一件事：数字码让「是不是协议级失败、该不该改请求」在标准位置就能判；字符串码
 * 保留业务语义（客户端靠它查 i18n 与应用内分支），所以它对客户端是**必填**的 —— 比规范
 * 严一档，这是有意的：只有数字码时，客户端还得从 `message` 里猜是哪一种业务失败。
 */
export interface ErrorObject {
  code: number;
  message: string;
  data: { code: string };
}

/**
 * 失败的响应。
 *
 * `id` 比成功响应多一个 `null`：**归不到任何请求**的错误（顶层数组、缺 `method`、来得
 * 不是时候的通知 / 响应）也必须能回一条错误，而不能因此把连接断了。JSON-RPC 2.0 对这种
 * 情形在原文里就是 `id: null` —— 它表示「这条错误不属于你问过的任何一件事」，不是「id 缺了」。
 *
 * 其余情形恒为数字：只要请求的 `id` 能读出来，错误就挂回那个 `id` 上。
 */
export interface ErrorFrame {
  jsonrpc: "2.0";
  id: number | null;
  error: ErrorObject;
}

/** 响应 = 成功或失败，两者恰有其一 */
export type ResponseFrame = ResultFrame | ErrorFrame;

/**
 * 事件通知（服务端 → 客户端，无 `id`，不等回执）。
 *
 * method 固定 `session.event`，载荷是 `ServerEvent` 这条判别联合（靠 `event` 字面量分派）。
 * 用 `unknown` / `any` / 通用袋子装载荷是不行的：客户端那边靠穷尽 `switch` 才能让「漏处理
 * 一个事件」变成编译错误。
 */
export interface EventNotification {
  jsonrpc: "2.0";
  method: "session.event";
  params: ServerEvent;
}
