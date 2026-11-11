/**
 * 错误码的**运行期**部分：造错、判错、取码。
 *
 * 码表本身是类型（服务端的 `src/protocol/errors.ts`）；这里那串字面量是它的运行期镜像，只为
 * `isCodedError` 的结构判定而存在。两侧各一份 —— 协议只共享类型，不共享代码。
 *
 * ## 为什么协议级的八个码也在这张表里
 *
 * `bad-frame` / `invalid-request` / `handshake-required` / `unauthorized` / `bad-handshake` /
 * `version-mismatch` / `unknown-method` / `internal` 不是业务层 `throw` 出来的，但它们一样会出现在
 * 失败响应的 `error.data.code` 上。不在表里的话 `isCodedError` 不认它们，客户端拿到手就是一个**裸
 * 字符串**：`codeOf()` 返回 `undefined`，于是「版本不匹配」与「未知失败」在调用点看起来一模一样。
 *
 * ## 为什么没有 `frame-too-large`
 *
 * 本版永不会收到它（A19）：单条消息的体积上限交给 WebSocket 的 `maxPayload`，超了由传输层直接
 * 断连 —— 那时没有一条错误响应能回来。码表里留着它只会让 `switch` 多一条永远不走的分支。
 */

import type { CodedError, ErrorCode } from "@ai-zen/agents-server/protocol";

/**
 * 造一个带码的错误。
 *
 * 不用 `class`：多个服务模块各自 `throw`，而跨包/跨版本时 `instanceof` 会漏（同一个码
 * 可能由别的实现抛出）。形状统一就够了。
 */
export function codedError(code: ErrorCode, message: string): CodedError {
  // `Object.assign` 直接把 `code` 挂上去，返回值天然是 `Error & { code }`：
  // 不用 `as` 断言（`Error` 上本来没有 `code`，硬断不过类型检查），也不改错误原型。
  return Object.assign(new Error(message), { code });
}

/** 已知错误码的运行期集合（与 `protocol/errors.ts` 的联合类型对应） */
export const ERROR_CODES: readonly ErrorCode[] = [
  "no-store",
  "unknown-workspace",
  "turn-in-flight",
  "session-exists",
  "bad-params",
  "session-missing",
  "workspace-required",
  "workspace-path-missing",
  "workspace-exists",
  "unknown-session",
  "unknown-model",
  "unknown-agent",
  "turn-busy",
  "sub-agent-missing",
  "nothing-to-handoff",
  "no-handoff",
  "handoff-in-flight",
  "handoff-aborted",
  "bad-index",
  // 协议级的码：不是业务层 `throw` 的，但一样会出现在 `error.data.code` 上，
  // 所以它们必须在集合里 —— 否则 `isCodedError` 不认它们，客户端拿到手就是一个裸字符串
  "bad-frame",
  "invalid-request",
  "handshake-required",
  // 凭证不对：`hello` 的 `params.token` 与服务端手上那串不相等。它必须在这张表里，
  // 否则 `explainUnauthorized` 拿到的 `codeOf()` 是 `undefined` —— 那两句话就永远说不出来，
  // 用户看到的只剩服务端那句 `token does not match this server`
  "unauthorized",
  "bad-handshake",
  "version-mismatch",
  "unknown-method",
  "internal",
];

const ERROR_CODE_SET = new Set<string>(ERROR_CODES);

function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_SET.has(value);
}

/** `value` 是不是一个带已知错误码的错误（跨包边界也成立，不看原型链） */
export function isCodedError(value: unknown): value is CodedError {
  if (!(value instanceof Error)) return false;
  const code = (value as Error & { code?: unknown }).code;
  return typeof code === "string" && isErrorCode(code);
}

/**
 * 取错误码；不是本表里的码就返回 `undefined`。
 *
 * 契约的读端：客户端拿到一个错误之后**唯一的**判断入口（而不是自己去摸 `.code` 再转字面量）。
 */
export function codeOf(value: unknown): ErrorCode | undefined {
  return isCodedError(value) ? value.code : undefined;
}
