/**
 * 消息层的**运行期**部分：版本号常量、请求帧的入站判定、二进制消息的 `id` 前缀。
 *
 * 形状在 `src/protocol/messages.ts`（纯类型）；这里放实现。两侧各自有一份
 * （`packages/client/src/wire/messages.ts`）—— 协议只共享类型，不共享代码。
 */

import type { RawRequestFrame } from "../protocol/messages.js";

/** 协议版本：任何不兼容的字段变化都要 +1，两端必须一致 */
export const PROTOCOL_VERSION = 3 satisfies import("../protocol/messages.js").ProtocolVersion;

/**
 * `id` 的上界：无符号 32 位整数的最大值（= `0xffffffff`）。
 *
 * 这个上界不是审美选择，是二进制帧逼出来的：带字节的请求与它的 payload 是**两条** WS
 * 消息，payload 那条用**前 4 字节**写请求 `id`（见 {@link REQUEST_ID_BYTES}），4 字节无符号
 * 大端装不下更大的东西。将来要放宽成字符串 `id`，前缀改成「1 字节长度 + N 字节 tag」即可。
 */
export const MAX_REQUEST_ID = 0xffff_ffff;

/**
 * 二进制消息里 `id` 前缀的字节数（大端无符号）。
 *
 * 二进制消息的形状：`[4 字节 id][载荷…]` —— 载荷本身没有任何头部，长度就是消息剩下的部分。
 */
export const REQUEST_ID_BYTES = 4;

/**
 * 入站请求帧的形状判定 —— **只看外壳，不看 `params` 里有什么**（那是方法表的活）。
 *
 * 四条同时成立才算一条请求：
 *
 *   1. 是个对象（**不是数组**：本版不支持批量，数组不是合法请求对象）；
 *   2. `jsonrpc` 逐字等于 `"2.0"`；
 *   3. `method` 是非空字符串 —— 「是不是请求」只靠这个键在场，没有其它判别字段；
 *   4. `id` 是 `0 … 2³²-1` 的整数（见 {@link MAX_REQUEST_ID}）。
 *
 * 四条的失败都会走到 `invalid-request`（不区分，客户端要做的事一样：改请求对象）。没有
 * `id` 的消息（JSON-RPC 的通知）也不在这里通过 —— 通知不需要回执，而这条连接上「谁在等
 * 什么」是靠 `id` 记账的。它被拒**不是**一条错误：上游把它认成通知之后**静默丢弃**（JSON-RPC
 * 原文：服务端 MUST NOT reply to a Notification，见 `Daemon.handleConnection`）。这个函数
 * 只回答「是不是一条请求」，不回答「该回什么」。
 */
export function isRequestFrame(frame: unknown): frame is RawRequestFrame {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return false;
  const value = frame as Partial<RawRequestFrame>;
  return (
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    value.method.length > 0 &&
    typeof value.id === "number" &&
    Number.isInteger(value.id) &&
    value.id >= 0 &&
    value.id <= MAX_REQUEST_ID
  );
}

/**
 * 从二进制消息里读出它对应的请求 `id`；不足 4 字节返回 `null`（读不出来，也就不可能对上
 * 任何在飞请求）。
 */
export function readRequestId(bytes: Buffer): number | null {
  if (bytes.byteLength < REQUEST_ID_BYTES) return null;
  return bytes.readUInt32BE(0);
}
