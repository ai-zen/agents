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

/** 请求帧（客户端 → 服务端；见文件头的「本版只有一个方向」） */
export interface RequestFrame {
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

/** 事件帧（服务端 → 客户端，无 id） */
export interface EventFrame {
  event: string;
  [key: string]: unknown;
}
