/**
 * 会话层的错误分类 —— 「这段会话还在不在」这一个判断，全项目只此一份。
 *
 * ## 为什么要单独一个文件
 *
 * `SessionChannel` 的重连要据它决定「还该不该继续试」：连接断了可以接回来，**会话没了**
 * 再试三次也是同一个答案（存档被删、服务端换了台实例）。这条判据写在重连循环里会变成
 * 一个藏在 `catch` 里的字面量比较，而它的两个码来自协议的两条不同方法：
 * `session-missing` 是 `attach` 的答案，`unknown-session` 是其余会话方法在会话消失后的答案 ——
 * 两者说的是同一件事，只认一个就会漏掉一半。
 *
 * ## 消费者只有一个（这里写清楚，免得后人以为有第二个）
 *
 * 今天唯一的消费者是 `channel.ts` 的重连判定（`restore()` 里那个 `isSessionGone(error)`）。调用
 * 失败的那一侧是调用方自己看错误，没有走这个判据。但它**仍然导出**：应用在「自己调的某个
 * 会话方法失败了，想知道是不是会话没了」时要复用它 —— 那正是「两个前端各写一份、迟早有一份
 * 只认一个码」要避免的形状（症状是「服务端重启之后，TUI 会重连、桌面端不会」）。
 */

import { ERROR_CODES, codeOf } from "@ai-zen/agents-protocol";
import type { ServerAddress } from "../types.js";

/**
 * 这个码是不是「会话已经没了」。
 *
 * `session-missing`（`attach` 的答案）与 `unknown-session`（其余会话方法的答案）**都算**：
 * 它们说的是同一件事，只认一个就会漏掉一半。按码判的那一半（{@link isSessionGone}）用的是
 * 同一份判据，所以这里不再各自列一遍字面量。
 */
export function isSessionGoneCode(code: string): boolean {
  return code === ERROR_CODES.sessionMissing || code === ERROR_CODES.unknownSession;
}

/**
 * 这个错误是不是「会话已经没了」。
 *
 * 先看**结构化** `code`（`SocketServerClient` 会把服务端帧里的 `code` 挂到 error 上），
 * 拿不到才退回看 message 前缀 —— 后者只对自造错误成立，但成本是一行，而漏判的代价是
 * 「对着一个已经不在的会话重试三次」。
 */
export function isSessionGone(error: unknown): boolean {
  const code = codeOf(error);
  if (code !== undefined) return isSessionGoneCode(code);
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith(ERROR_CODES.sessionMissing) || message.startsWith(ERROR_CODES.unknownSession)
  );
}

/**
 * 「连接没了」的错误（沿用 socket 断开时那个形状：主机 + 端口）。
 *
 * 重连三次都失败时它交给等着的 `waitForTurn()`：那一轮已经不可能结束了，但界面必须能
 * 恢复输入，所以只能以错失败 —— 与「连接断掉时在飞调用被拒」是同一个错误通道，
 * 不新造一套。
 *
 * `address` 可以不给：**连接从未建起来**时根本不知道自己会连到哪（`this.client` 还是
 * `null`），硬凑一个 `{host:"", port:0}` 会让文案印成 `connection closed (:0)` —— 一句
 * 用户看不懂、排查时还会把人往错方向带的话。没有地址就不带括号那一段。
 */
export function connectionLostError(address?: ServerAddress): Error {
  const where = address ? ` (${address.host}:${address.port})` : "";
  return new Error(`connection closed${where}, reconnect failed`);
}
