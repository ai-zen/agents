/**
 * 线上消息的**唯一**形状定义 —— 只有类型，没有一行运行期代码。
 *
 * 客户端（TUI / 桌面端 / 浏览器）只认这里的类型；服务端实现与传输（TCP / WebSocket /
 * stdio）都不得额外约定格式。想加字段就加——但**不能改已有字段的语义**，客户端可能比
 * 服务端老。协议版本号变了就是断代，不做"尽力兼容"。
 *
 * 三类帧：
 *   1. 握手：客户端先发 `hello`，服务端回 `hello` 的回执。**没有例外**——即使当前还没
 *      鉴权，也必须先握手：鉴权只能加在握手里，改为后置就得改所有客户端的建连逻辑。
 *   2. 请求/响应：`{ id, method, params }` → `{ id, ok, result | error }`。**本版只有一个
 *      方向**：客户端发、服务端回。
 *   3. 事件：服务端主动推，无 `id`，不等回。
 *
 * 服务端需要「问客户端一件事」时走的**不是**请求帧，而是「事件问 + 方法答」
 * （`session-question` → `session.answer`）：这样帧层的 `id` 空间只有一方在分配，
 * 不必处理两个方向撞号。
 *
 * 版本号是个**类型**（`ProtocolVersion`），不是运行期常量：常量属于实现，见
 * `src/wire/messages.ts`。
 */

import type { AnyMethod, MethodApi } from "./api.js";
import type { ServerEvent } from "./sessions.js";

/** 协议版本：任何不兼容的字段变化都要 +1 */
export type ProtocolVersion = 1;

/** 客户端 → 服务端的第一帧，必须发 */
export interface HelloRequest {
  /** 固定 `hello`，用来和普通请求区分（首帧还没握手，此时不该有 id） */
  kind: "hello";
  /** 客户端支持的协议版本 */
  protocol: number;
  /** 客户端标识（只用于日志与本机调试，不参与鉴权） */
  client: {
    name: string;
    version: string;
  };
}

export interface HelloResponse {
  kind: "hello";
  ok: boolean;
  /** 握手失败时的机器可判原因 */
  error?: { code: string; message: string };
  /** 握手成功时的服务端身份 */
  server?: {
    name: string;
    version: string;
    protocol: number;
    pid: number;
    startedAt: string;
  };
}

/**
 * 请求帧（客户端 → 服务端；见文件头的「本版只有一个方向」）。
 *
 * 它是 **`MethodApi` 上的判别联合**：`method` 决定 `params` 的类型。构造一个帧即被这张表
 * 约束 —— 把 `SessionSendParams` 塞给 `session.attach`、或者把方法名拼错，都编译不过。
 * 没参数的方法（`ping` / `config.get` …）不允许带 `params`。
 */
export type RequestFrame = { [M in AnyMethod]: FrameFor<M> }[AnyMethod];

/** 某一个方法的请求帧形状 */
type FrameFor<M extends AnyMethod> = { id: number; method: M } & ([MethodApi[M]["params"]] extends [
  void,
]
  ? { params?: void }
  : { params: MethodApi[M]["params"] });

/**
 * 解码出来、**还没校验**的帧 —— 传输层只认这个形状。
 *
 * 为什么不让传输层直接用 `RequestFrame`：线上的字节是 JSON，任何一侧收到的都是
 * `unknown`。判别联合描述的是「合法帧长什么样」，而「这串字节是不是合法帧」只能靠运行时
 * 校验（`isRawRequestFrame`）。把两者混成一个类型，等于让类型系统替 JSON 背书。
 */
export interface RawRequestFrame {
  id: number;
  method: string;
  params?: unknown;
}

export interface ResultFrame {
  id: number;
  ok: true;
  result: unknown;
}

export interface ErrorFrame {
  id: number;
  ok: false;
  error: { code: string; message: string };
}

export type ResponseFrame = ResultFrame | ErrorFrame;

/** 事件帧（服务端 → 客户端，无 id）：就是服务端能推的那三种事件的联合，每个成员都带字面量 `event` */
export type EventFrame = ServerEvent;
