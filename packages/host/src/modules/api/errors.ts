import type { TRPCError, TRPCDefaultErrorShape } from "@trpc/server";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";

import { HostError, type ErrorCode } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";

/**
 * `HostError.code` 到 tRPC 自带码的对应。
 *
 * 这张表管的是 `data.code` 那一格，它不是客户端分支用的那一格（客户端认的是 `data.hostCode`，
 * 见下面那一层）。留着它是为了两件事：tRPC 自己的机制要一个这样的码才发得出那一帧；还没升级的
 * 客户端只读这一格，按它分支。
 *
 * 八个码落到七个 tRPC 码上，合起来的两对正是这一套分不开的地方：`busy` 与 `conflict` 都在
 * `CONFLICT` 上，`not_available` 与 `not_found` 都在 `NOT_FOUND` 上。「这段会话还在跑，等它
 * 停下来」与「有人先动了一步」是两件事，「换个版本再挑」与「你给的不是一个版本号」也是两件事，
 * 各要一条分支 —— 这就是 `hostCode` 那一格存在的理由。
 */
const TRPC_CODES: Record<ErrorCode, keyof typeof TRPC_ERROR_CODES_BY_KEY> = {
  not_found: "NOT_FOUND",
  invalid_params: "BAD_REQUEST",
  conflict: "CONFLICT",
  busy: "CONFLICT",
  unsupported: "NOT_IMPLEMENTED",
  config_invalid: "PRECONDITION_FAILED",
  not_available: "NOT_FOUND",
  unauthorized: "UNAUTHORIZED",
};

/**
 * 失败出网的那一层。
 *
 * tRPC 把 resolver 抛出的 `HostError` 包成一个 `INTERNAL_SERVER_ERROR`，原错误只剩在 `cause`
 * 里；默认形状因此会把 `code` 折成 `INTERNAL_SERVER_ERROR`、把 `details` 整个丢掉。这里按
 * `HostError` 的三格重建，另加一格 `hostCode`：`data.hostCode` 是宿主自己的那个码（语义层，
 * 客户端按它分支）、`data.code` 换成 tRPC 的码（传输层，以及只读这一格的老客户端）、
 * `message` 用已经渲染好的那一句成品、`details` 原样带出去。
 *
 * 非 `HostError` 的异常是宿主自己的运行事故（英文原文 + `cause`），它那句话不出网：它是写给
 * 开发者的，原样丢给用户看等于把内部细节当成了「发生了什么」的说明。原始错误的去处是日志
 * —— tRPC 把它交给适配器上的 `onError`，而这一层还没有接 logger，接上之后它写 `host.log`。
 * 所以这里只换掉句子，其余仍是 tRPC 的默认形状。
 *
 * 这一支也罩住了 tRPC 在边界上拒掉的入参（`BAD_REQUEST`）：那一种的原文说的是调用方哪个字段
 * 不对，不是宿主内部发生了什么，同样被换成下面这句兜底话。
 *
 * 语言在调用那一刻由 `t` 现读：这个函数拿的是装配根上那一份翻译函数，不是语言快照。
 */
export function hostErrorFormatter(t: Translator) {
  return ({ error, shape }: { error: TRPCError; shape: TRPCDefaultErrorShape }) => {
    const cause = error.cause;
    if (cause instanceof HostError) {
      const code = TRPC_CODES[cause.code];
      return {
        message: cause.message,
        code: TRPC_ERROR_CODES_BY_KEY[code],
        // 不带 `httpStatus`：它说的是 `code` 换掉之前那个码的状态，留着就与 `code` 自相矛盾。
        // `path` 是 tRPC 自己往 `data` 里放的那一格（哪个 procedure 抛的），照旧留着。
        data: {
          hostCode: cause.code,
          code,
          path: shape.data.path,
          details: cause.details,
        },
      };
    }

    return { ...shape, message: t("宿主内部出错，这次调用没有完成") };
  };
}
