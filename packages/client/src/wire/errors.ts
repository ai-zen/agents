/**
 * 错误码的**运行期**部分：造错、判错、取码。
 *
 * 码表本身是类型（`src/protocol/errors.ts`）；这里那串字面量是它的运行期镜像，只为
 * `isCodedError` 的结构判定而存在。两侧各一份 —— 协议只共享类型，不共享代码。
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
