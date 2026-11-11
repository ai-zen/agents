/**
 * 线上错误码 —— 只有类型，没有运行期表。
 *
 * ## 为什么它是协议的一部分
 *
 * 这些码会原样出现在 `{ ok: false, error: { code, message } }` 帧里，客户端靠它决定
 * 「是改请求（`bad-params` / `bad-index`）、还是重试（`turn-busy`）、还是换一段会话
 * （`session-missing` / `unknown-session`）」。
 *
 * ## 只增不改语义
 *
 * 一个码一旦发出去就是协议的一部分：改它的值等于让老客户端的 `switch` 落到 `default`。
 * 要换语义就新增一个码。
 *
 * ## 为什么 `CodedError` 是 `Error & { code }` 而不是一个类
 *
 * 抛错的是多个服务模块，它们各自 `throw`；用 `instanceof` 收口会让「不是本包造的错误」
 * 全被漏掉（例如 SDK 抛出来的、带同样 `code` 形状的错误）。判断靠结构检查，跨包、
 * 跨版本都成立 —— 实现见 `src/wire/errors.ts`，两侧各一份。
 */

/** 线上错误码：值就是帧里 `error.code` 的字面量 */
export type ErrorCode =
  | "no-store"
  | "unknown-workspace"
  | "turn-in-flight"
  | "session-exists"
  | "bad-params"
  | "session-missing"
  | "workspace-required"
  | "workspace-path-missing"
  | "workspace-exists"
  | "unknown-session"
  | "unknown-model"
  | "unknown-agent"
  | "turn-busy"
  | "sub-agent-missing"
  | "nothing-to-handoff"
  | "no-handoff"
  | "handoff-in-flight"
  | "handoff-aborted"
  | "bad-index";

/** 带机器可判别 `code` 的错误 —— 帧层原样把 `code` 递给客户端 */
export interface CodedError extends Error {
  code: ErrorCode;
}
