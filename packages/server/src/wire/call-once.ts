/**
 * `callOnce` —— 「连上 → 握手 → 发一帧 → 等回执 → 挂断」的最小可用形态。
 *
 * ## 为什么它属于契约层
 *
 * 它只依赖帧与握手 —— 正是本包的词汇。放在这里，是因为它是**契约的人体工学**：协议除了说
 * 「线上长什么样」，还该说「只想问一句的时候怎么写」。
 *
 * ## 与 `SocketServerClient` 的分工
 *
 * 那个是**一条长连接**：在飞调用、事件订阅、断开通知、重连。这个是**一次问话**：
 * 问完就挂断，没有状态、没有订阅、没有 id 分配（永远用 `1`）。
 * 判据是「我要不要一直在线上」——诊断（`status`）、收摊（`stop`）、探活（`ping`）都
 * 只是问一句，用长连接反而要管它的生命周期（谁 close、什么时候 close）。
 *
 * ## 错误形态与 `SocketServerClient` 一致
 *
 * 服务端回的失败帧会被转成 `Error`，`code` 挂在 `.code` 上（调用方靠它判「哪一类失败」）。
 * 两处形态一样，调用方就不必按「我用的是哪条路」分支出两套错误处理。
 *
 * ## 只用 `frames` / `messages` + `node:net`
 *
 * 没有第三方依赖 —— 本包的运行期依赖图必须保持零（见 `index.ts` 文件头）。
 */

import { createConnection, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "./frames.js";
import { PROTOCOL_VERSION } from "./messages.js";
import type { AnyMethod, MethodApi } from "../protocol/api.js";
import type { HelloResponse, ResponseFrame } from "../protocol/messages.js";

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

/** 只有一条请求，所以 id 恒为 1（不需要分配器） */
const REQUEST_ID = 1;

/**
 * 连上服务端问一句，拿回结果，然后挂断。
 *
 * @throws 建连失败 / 握手被拒 / 超时 / 服务端回失败帧 —— 失败帧的 `code` 挂在 `.code` 上
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
    const socket: Socket = createConnection({ host: address.host, port: address.port });
    const decoder = new FrameDecoder();
    let settled = false;

    const finish = (fail: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (fail) reject(fail);
      // 边界断言：`result` 是解出来的 JSON，类型由方法表声明（运行时校验不在这里）
      else resolve(result as MethodApi[M]["result"]);
    };

    const timer = setTimeout(() => {
      finish(new Error(`timeout after ${timeoutMs}ms calling ${method}`));
    }, timeoutMs);

    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.write(encodeFrame({ kind: "hello", protocol: PROTOCOL_VERSION, client }));
    });
    socket.on("error", (error: Error) => finish(error));
    // 对端先挂断（服务端在回了回执之后立刻收摊就是一个正常场景）：没拿到回执就算失败
    socket.on("close", () =>
      finish(new Error(`connection closed before replying (${address.host}:${address.port})`)),
    );

    socket.on("data", (chunk: string) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        finish(error as Error);
        return;
      }
      for (const frame of frames) {
        const value = frame as Record<string, any> | null;

        if (value?.kind === "hello") {
          const hello = value as HelloResponse;
          if (!hello.ok) {
            const code = hello.error?.code ?? "bad-handshake";
            finish(
              codedFailure(code, `handshake rejected: ${code}: ${hello.error?.message ?? ""}`),
            );
            return;
          }
          // `params` 为 undefined 时 JSON.stringify 会整键丢掉，帧里就只剩 `{ id, method }`
          socket.write(encodeFrame({ id: REQUEST_ID, method, params }));
          continue;
        }

        if (value?.id === REQUEST_ID) {
          const response = value as ResponseFrame;
          if (response.ok) finish(null, response.result);
          else
            finish(
              codedFailure(
                response.error.code,
                `${response.error.code}: ${response.error.message}`,
              ),
            );
        }
      }
    });
  });
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
