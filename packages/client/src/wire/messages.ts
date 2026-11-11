/**
 * 消息层的**运行期**部分：版本号常量、入站消息的判定、二进制消息的 `id` 前缀。
 *
 * 形状在服务端的 `src/protocol/messages.ts`（纯类型）；这里放实现。两侧各自有一份
 * （`packages/server/src/wire/messages.ts` 与本文）—— 协议只共享类型，不共享代码。两份必须
 * **逐字同构**：改一边就得同时改另一边（`encodeFrame` 与两个上限同理，见 `frames.ts`）。
 *
 * 客户端用得到的是三件：版本号（握手时报上去）、`id` 的取值域与前缀长度（发二进制消息时要
 * 把请求 `id` 写进前 4 字节）、以及 `isNotification` / `readRequestId` 这两条判据 —— 前者让
 * 「服务端推来的通知」与「回执」分成两条路，后者是二进制消息在服务端的读法（客户端只写，
 * 读法是同一件事实的另一面，放在一份里免得两边对不上）。
 */

import type { ProtocolVersion, RawRequestFrame } from "@ai-zen/agents-server/protocol";

/** 协议版本：任何不兼容的字段变化都要 +1，两端必须一致（E1：本版断代，不匹配即不连） */
export const PROTOCOL_VERSION = 3 satisfies ProtocolVersion;

/**
 * `id` 的上界：无符号 32 位整数的最大值（= `0xffffffff`）。
 *
 * 这个上界不是审美选择，是二进制消息逼出来的：带字节的请求与它的载荷是**两条** WS 消息，
 * 载荷那条用**前 4 字节**写请求 `id`（见 {@link REQUEST_ID_BYTES}），4 字节无符号大端装不下
 * 更大的东西。将来要放宽成字符串 `id`，前缀改成「1 字节长度 + N 字节 tag」即可。
 */
export const MAX_REQUEST_ID = 0xffff_ffff;

/**
 * 二进制消息里 `id` 前缀的字节数（大端无符号）。
 *
 * 二进制消息的形状：`[4 字节 id][载荷…]` —— 载荷本身没有任何头部，长度就是消息剩下的部分
 * （A24：`params` 里没有「字节数」这个字段，载荷长度只有一个来源）。
 */
export const REQUEST_ID_BYTES = 4;

/**
 * 入站请求的形状判定 —— **只看外壳，不看 `params` 里有什么**（那是方法表的活）。
 *
 * 四条同时成立才算一条请求：
 *
 *   1. 是个对象（**不是数组**：本版不支持批量，数组不是合法请求对象）；
 *   2. `jsonrpc` 逐字等于 `"2.0"`；
 *   3. `method` 是非空字符串 —— 「是不是请求」只靠这个键在场，没有其它判别字段；
 *   4. `id` 是 `0 … 2³²-1` 的整数（见 {@link MAX_REQUEST_ID}）。
 *
 * 四条的失败都会走到 `invalid-request`（服务端那边不区分：客户端要做的事一样 —— 改请求对象）。
 * 没有 `id` 的请求（JSON-RPC 的通知）也在这里被拒：本版服务端不收通知 —— 通知不需要回执，而
 * 那条连接上「谁在等什么」是靠 `id` 记账的。
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
 * 这一条是不是一条 **JSON-RPC 通知**（有 `method`、没有 `id`）。
 *
 * 判据只取这两个键：方法名是不是认识的不重要 —— 通知本来就没有回执，也就不存在「方法不存在」
 * 的告诉方式。数组不是通知（本版不支持批量）。
 *
 * 客户端用它把入站消息分成两条路：通知 → 事件分发（`session.event`），其余 → 按 `id` 认领
 * 回执。不认识的 `method` 直接忽略（本版服务端不主动发请求）。
 */
export function isNotification(frame: unknown): boolean {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return false;
  const value = frame as { method?: unknown; id?: unknown };
  return typeof value.method === "string" && value.method.length > 0 && value.id === undefined;
}

/**
 * 从二进制消息里读出它对应的请求 `id`；不足 4 字节返回 `null`（读不出来，也就不可能对上任何
 * 在飞请求）。
 *
 * 客户端只**写**这个前缀（{@link REQUEST_ID_BYTES} + 大端无符号），读法是同一件事的另一半：
 * 放在一份里，「字节序」与「前缀长度」就只有一处约定。
 */
export function readRequestId(bytes: Buffer): number | null {
  if (bytes.byteLength < REQUEST_ID_BYTES) return null;
  return bytes.readUInt32BE(0);
}
