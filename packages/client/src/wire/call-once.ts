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
 * 那个是**一条长连接**：在飞调用、事件订阅、断开通知、重连。这个是**一次问话**：问完就挂断，
 * 没有状态、没有订阅、没有 id 分配（握手与请求各用一个固定 id）。判据是「我要不要一直在
 * 线上」——诊断（`status`）、收摊（`stop`）、探活（`ping`）都只是问一句，用长连接反而要管它
 * 的生命周期（谁 close、什么时候 close）。
 *
 * ## 握手也是一条普通请求
 *
 * 没有专门的握手帧：第一条请求就是 `hello`（`MethodApi` 里的普通方法），所以这里与
 * `SocketServerClient` 走的是同一个形状 —— `id` + `method` + `params`，回执也是普通的成功 /
 * 失败响应。版本号放在 `hello` 的 `params.protocol` 里；服务端不匹配就回一条
 * `version-mismatch` 的错误响应，然后**断连**。凭证同样在 `hello` 里（`params.token`，见
 * {@link CallOnceOptions.token}）：不对回 `unauthorized`，那一条**不断连**（换一条 `hello`
 * 就能继续说），而这一次问话到此为止。
 *
 * ## 错误形态与 `SocketServerClient` 一致
 *
 * 服务端回的失败响应会被转成 `Error`，`data.code`（字符串码）挂在 `.code` 上 —— 调用方靠它判
 * 「哪一类失败」。两处形态一样，调用方就不必按「我用的是哪条路」分支出两套错误处理。
 *
 * ## 为什么用全局 `WebSocket`
 *
 * 本包**不许**把 `ws` 变成运行期依赖（cli / desktop 打包会把 `dependencies` 里的一切拖进产物），
 * 而 Node 26 的全局 `WebSocket` 就是浏览器那个。代价：它的 `error` 事件不带底层原因
 * （`ECONNREFUSED` 之类在 undici 内部被吞掉了），所以「连不上谁」由这里的消息补上 —— 探活失败
 * 时那句话就是给人看的答案。
 *
 * ## 只用 `frames` / `messages` / `server-url` + 全局 `WebSocket`
 *
 * 没有第三方依赖 —— 本包的运行期依赖图必须保持零（见 `index.ts` 文件头）。
 */

import { encodeFrame } from "./frames.js";
import { PROTOCOL_VERSION } from "./messages.js";
import type { ServerTarget } from "./server-url.js";
import { webSocketUrl } from "./server-url.js";
import type {
  AnyMethod,
  HelloParams,
  MethodApi,
  ResponseFrame,
} from "@ai-zen/agents-server/protocol";

/**
 * 连哪儿。
 *
 * 是 `wire/server-url.ts` 的 {@link ServerTarget} 的别名，**不是**第二份形状：`CallOnceAddress`
 * 曾经逐字重复了一遍 `{ host; port }`（理由写的是「那是客户端的类型」），而 `wire/` 本来就在客
 * 户端里面 —— 于是包内有两处形状定义，`webSocketUrl` 也有两份逐字相同的实现。名字保留（避免
 * 全仓改名噪声），定义只剩一处。
 */
export type CallOnceAddress = ServerTarget;

export interface CallOnceOptions {
  /** 整次问话的时限（建连 + 握手 + 调用），缺省 2000ms */
  timeoutMs?: number;
  /**
   * 握手的凭证（`hello` 的 `params.token`）。
   *
   * 为什么不走 `Authorization` 头：浏览器的 `new WebSocket()` **不允许**设自定义请求头 —— 那会
   * 让将来的 webui 一步都走不了；也不走 query string（会进日志 / 历史 / Referer）。
   *
   * 不给就发一个空串，与服务端那份 `callOnce` 同一条口径：调用方确实有一个凭证位置，只是没有
   * 值可放 —— 服务端据此回 `unauthorized`，比“整个字段缺失（`bad-params`）”更接近事实。
   */
  token?: string;
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
const DEFAULT_CLIENT = { name: "@ai-zen/agents-client", version: "1" };

/**
 * 两条请求的固定 `id`。
 *
 * 只有两条，所以不需要分配器。用 `1` / `2` 而不是都从 0 起：`id` 是**有主**的（回执挂回它），
 * 两条请求共用一个 id 会让「这条回执是谁的」不再成立。
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

    socket.addEventListener("open", () => {
      const hello: HelloParams = {
        protocol: PROTOCOL_VERSION,
        token: options?.token ?? "",
        client,
      };
      socket.send(encodeFrame({ jsonrpc: "2.0", id: HELLO_ID, method: "hello", params: hello }));
    });
    // 底层原因（`ECONNREFUSED` / 被拒的升级）全局 WebSocket 不会递上来，所以消息里带端点
    socket.addEventListener("error", () =>
      finish(new Error(`connection error (${address.host}:${address.port})`)),
    );
    // 对端先挂断（服务端在回了回执之后立刻收摊就是一个正常场景）：没拿到回执就算失败
    socket.addEventListener("close", () =>
      finish(new Error(`connection closed before replying (${address.host}:${address.port})`)),
    );

    socket.addEventListener("message", (event) => {
      // 回执只有文本；二进制在这一条路上不会出现（这里没有带字节的方法）
      if (typeof event.data !== "string") return;
      const frame = parseResponse(event.data);
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
            codedFailure(frame.error.data.code, `${frame.error.data.code}: ${frame.error.message}`),
          );
      }
    });
  });
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
