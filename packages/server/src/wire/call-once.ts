/**
 * `callOnce` —— 「连上 → 握手 → 发一条请求 → 等回执 → 挂断」的最小可用形态。
 *
 * ## 为什么它属于契约层
 *
 * 它只依赖线上消息与握手 —— 正是本包的词汇。放在这里，是因为它是**契约的人体工学**：协议
 * 除了说「线上长什么样」，还该说「只想问一句的时候怎么写」。
 *
 * ## 与 `SocketServerClient` 的分工
 *
 * 那个是**一条长连接**：在飞调用、事件订阅、断开通知、重连。这个是**一次问话**：
 * 问完就挂断，没有状态、没有订阅、没有 id 分配（握手与请求各用一个固定 id）。
 * 判据是「我要不要一直在线上」——诊断（`status`）、收摊（`stop`）、探活（`ping`）都
 * 只是问一句，用长连接反而要管它的生命周期（谁 close、什么时候 close）。
 *
 * ## 握手也是一条普通请求
 *
 * 没有专门的握手帧：第一条请求就是 `hello`（`MethodApi` 里的普通方法），所以这里与
 * `SocketServerClient` 走的是同一个形状 —— `id` + `method` + `params`，回执也是普通的
 * 成功 / 失败响应。版本号放在 `hello` 的 `params.protocol` 里；服务端不匹配就回一条
 * `version-mismatch` 的错误响应，然后**断连**。
 *
 * ## 错误形态与 `SocketServerClient` 一致
 *
 * 服务端回的失败响应会被转成 `Error`，`data.code` 挂在 `.code` 上（调用方靠它判「哪一类
 * 失败」）。两处形态一样，调用方就不必按「我用的是哪条路」分支出两套错误处理。
 *
 * ## 为什么用 `ws` 的客户端
 *
 * 本包已经依赖 `ws`（服务端的 WebSocket 实现），而它的 `error` 事件会把**底层原因**原样递
 * 上来（`ECONNREFUSED` 之类）—— 探活失败时那句话就是答案，不该被自己的包装糊掉。
 */

import { WebSocket, type RawData } from "ws";
import { encodeFrame } from "./frames.js";
import { PROTOCOL_VERSION } from "./messages.js";
import type { AnyMethod, MethodApi } from "../protocol/api.js";
import type { HelloParams, ResponseFrame } from "../protocol/messages.js";

/** 连哪儿（与客户端 `ServerAddress` 逐字同形，但不引用它 —— 那是客户端的类型） */
export interface CallOnceAddress {
  host: string;
  port: number;
}

export interface CallOnceOptions {
  /** 整次问话的时限（建连 + 握手 + 调用），缺省 2000ms */
  timeoutMs?: number;
  /**
   * 握手时自称的身份（只进服务端日志，不参与鉴权）。
   *
   * 有缺省值：绝大多数调用方（诊断 / 收摊 / 探活）不需要为此多写一行；而它仍然可注入，
   * 因为「这条连接是谁连的」在排查时是有用的事实，不该被本包统一冒名。
   */
  client?: { name: string; version: string };
}

const DEFAULT_TIMEOUT_MS = 2000;

/** 缺省身份：本包（`callOnce` 的调用方多半是诊断 / 收摊脚本，不署名就以此出场） */
const DEFAULT_CLIENT = { name: "@ai-zen/agents-server", version: "1" };

/**
 * 两条请求的固定 `id`。
 *
 * 只有两条，所以不需要分配器。用 `1` / `2` 而不是都从 0 起：`id` 是**有主**的（回执挂回
 * 它），两条请求共用一个 id 会让「这条回执是谁的」不再成立。
 */
const HELLO_ID = 1;
const REQUEST_ID = 2;

/**
 * 连上服务端问一句，拿回结果，然后挂断。
 *
 * @throws 建连失败 / 握手被拒 / 超时 / 服务端回失败响应 —— 失败响应的 `data.code` 挂在 `.code` 上
 */
export async function callOnce<M extends AnyMethod>(
  address: CallOnceAddress,
  method: M,
  params?: MethodApi[M]["params"],
  options?: CallOnceOptions,
): Promise<MethodApi[M]["result"]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = options?.client ?? DEFAULT_CLIENT;

  return await new Promise<MethodApi[M]["result"]>((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl(address));
    let settled = false;

    const finish = (fail: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (fail) reject(fail);
      // 边界断言：`result` 是解出来的 JSON，类型由方法表声明（运行时校验不在这里）
      else resolve(result as MethodApi[M]["result"]);
    };

    const timer = setTimeout(() => {
      finish(new Error(`timeout after ${timeoutMs}ms calling ${method}`));
    }, timeoutMs);

    socket.on("open", () => {
      const hello: HelloParams = { protocol: PROTOCOL_VERSION, client };
      socket.send(encodeFrame({ jsonrpc: "2.0", id: HELLO_ID, method: "hello", params: hello }));
    });
    // 底层原因（`ECONNREFUSED` / 被拒的升级）原样递出去：探活失败时那句话就是答案
    socket.on("error", (error: Error) => finish(error));
    // 对端先挂断（服务端在回了回执之后立刻收摊就是一个正常场景）：没拿到回执就算失败
    socket.on("close", () =>
      finish(new Error(`connection closed before replying (${address.host}:${address.port})`)),
    );

    socket.on("message", (data: RawData, isBinary: boolean) => {
      // 回执只有文本；二进制在这一次问话里不会出现（这条路上没有带字节的方法）
      if (isBinary) return;
      const frame = parseResponse(data.toString());
      if (!frame) return;

      if (frame.id === HELLO_ID) {
        if ("error" in frame) {
          const code = frame.error.data.code;
          finish(codedFailure(code, `handshake rejected: ${code}: ${frame.error.message}`));
          return;
        }
        // 握手过了才发真正的请求。`params` 为 undefined 时 `JSON.stringify` 会整键丢掉，
        // 消息里就只剩 `{ jsonrpc, id, method }` —— 没参数的方法不该带一个 `null`
        socket.send(encodeFrame({ jsonrpc: "2.0", id: REQUEST_ID, method, params }));
        return;
      }

      if (frame.id === REQUEST_ID) {
        if (!("error" in frame)) finish(null, frame.result);
        else
          finish(
            codedFailure(
              frame.error.data.code,
              `${frame.error.data.code}: ${frame.error.message}`,
            ),
          );
      }
    });
  });
}

/** `ws://host:port` —— IPv6 字面量要加方括号（`::1` 是允许的监听地址之一） */
function webSocketUrl(address: CallOnceAddress): string {
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  return `ws://${host}:${address.port}`;
}

/**
 * 一条文本消息 → 响应；不是响应（不是合法 JSON、没有 `id`、事件通知、带字节的响应）就丢掉。
 *
 * 调用方只等自己那两条 `id`，其余消息与这次问话无关 —— 丢掉比因此报错更接近事实。
 */
function parseResponse(text: string): ResponseFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const frame = value as Partial<ResponseFrame>;
  if (typeof frame.id !== "number") return null;
  if (!("result" in frame) && !("error" in frame)) return null;
  return value as ResponseFrame;
}

/**
 * 把服务端的 `code` 挂到 `Error` 上。
 *
 * 码可能是本包 `ERROR_CODES` 之外的值（服务端新增了一类失败，老客户端还不认识）——
 * 那也照样递出去，只是不经过 `CodedError` 的类型收窄：**未知的码比丢掉的码有用**。
 */
function codedFailure(code: string, message: string): Error & { code?: string } {
  const failure = new Error(message) as Error & { code?: string };
  failure.code = code;
  return failure;
}
