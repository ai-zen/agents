/**
 * 错误码的**运行期**部分：造错、判错、取码、映射成 JSON-RPC 的数字码。
 *
 * 码表本身是类型（`src/protocol/errors.ts`）；这里那串字面量是它的运行期镜像（`isCodedError`
 * 的结构判定要用它），`rpcCodeOf()` 是类型级映射 `RpcCodeOf` 的运行期那一份 —— 类型在编译期
 * 就能把映射写死，真正执行映射的只有这里。两侧各一份 —— 协议只共享类型，不共享代码。
 */

import type { CodedError, ErrorCode, RpcErrorCode } from "../protocol/errors.js";

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
const ERROR_CODES: readonly ErrorCode[] = [
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
  // 协议级的码：不是业务层 `throw` 的，但一样会出现在 `data.code` 上，
  // 所以它们必须在集合里 —— 否则 `isCodedError` 不认它们，客户端拿到手就是一个裸字符串
  "bad-frame",
  "invalid-request",
  "handshake-required",
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

/**
 * 字符串码 → JSON-RPC 的 `error.code`（`RpcCodeOf` 的运行期那一份）。
 *
 * 放在实现层而不是契约层：契约只要那个**类型**（编译期就能把映射写死），真正要查表的是
 * 「把一条错误发给客户端」这个动作。
 *
 * 入参是 `string` 而不是 `ErrorCode`：handler 他乡抛过来的错误可能带着表外的码（服务端
 * 新加了一类失败、老客户端不认识）。表外的码一律落 `-32000` —— 不认识它并不等于「这次
 * 请求没失败」，更不等于该把连接断了。
 *
 * 五个专门码与 `RpcCodeOf` 逐字对应：`bad-frame` / `invalid-request` / `unknown-method` /
 * `bad-params` / `internal`；其余全部落 `-32000`。
 */
export function rpcCodeOf(code: string): RpcErrorCode {
  switch (code) {
    case "bad-frame":
      return -32700;
    case "invalid-request":
      return -32600;
    case "unknown-method":
      return -32601;
    case "bad-params":
      return -32602;
    case "internal":
      return -32603;
    default:
      return -32000;
  }
}
