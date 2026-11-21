/**
 * 失败出网那一层的验收：宿主自己那个码原样跟着出去、tRPC 那个码照旧写着、渲染好的句子与结构化
 * 事实一个不少。
 *
 * 这一份测的是「客户端拿到的那一帧长什么样」，所以照 tRPC 的调用次序造输入：一次调用抛出的东西
 * 先被它包成一个 `TRPCError`（原物只剩在 `cause` 里），格式化这一层再从 `cause` 把它认回来。
 */

import { TRPCError, type TRPCDefaultErrorShape, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";
import { describe, expect, it } from "vitest";

import { HostError, type ErrorCode } from "../../infra/errors.js";
import { createTranslator } from "../i18n/index.js";
import { hostErrorFormatter } from "./errors.js";

const t = createTranslator(() => "zh");

/** tRPC 在没有格式化函数时会发出去的那一帧（格式化函数的第二个入参就是它） */
function defaultShape(code: TRPC_ERROR_CODE_KEY, path: string): TRPCDefaultErrorShape {
  return {
    message: "原始那句（英文、写给开发者的）",
    code: TRPC_ERROR_CODES_BY_KEY[code],
    data: { code, httpStatus: 500, path },
  };
}

/** 格式化那一层发出去的那一帧（形状从它自己的签名上取，不在用例里再描一遍） */
type WireShape = ReturnType<ReturnType<typeof hostErrorFormatter>>;
/** 带 `hostCode` 的那一支：只有它才有那一格（`HostError` 走的就是这一支） */
type HostFrame = Extract<WireShape, { data: { hostCode: unknown } }>;

/** 一次 resolver 抛出 → tRPC 包一层 → 格式化那一层重建出来的那一帧 */
function wireOf(thrown: unknown, path = "session.rewind"): WireShape {
  return hostErrorFormatter(t)({
    error: new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "x", cause: thrown }),
    shape: defaultShape("INTERNAL_SERVER_ERROR", path),
  });
}

/** 同一件事，但断言的是带 `hostCode` 的那一支 */
function formatted(thrown: HostError, path = "session.rewind"): HostFrame {
  return wireOf(thrown, path) as HostFrame;
}

describe("hostErrorFormatter：宿主自己的码跟着出网", () => {
  it("data.hostCode 是宿主那个码，data.code 仍是 tRPC 那个码", () => {
    const shape = formatted(
      new HostError("busy", "这段会话还在跑，等它停下来再撤回", {
        entity: "session",
        sessionId: "s1",
      }),
    );

    expect(shape.data).toMatchObject({
      hostCode: "busy",
      code: "CONFLICT",
      path: "session.rewind",
      details: { entity: "session", sessionId: "s1" },
    });
    // 那句是宿主按语言渲染好的成品，原样出网
    expect(shape.message).toBe("这段会话还在跑，等它停下来再撤回");
    expect(shape.code).toBe(TRPC_ERROR_CODES_BY_KEY.CONFLICT);
  });

  it("busy 与 conflict 在 data.code 上是同一个码，在 data.hostCode 上分得开", () => {
    const busy = formatted(new HostError("busy", "等一下"));
    const conflict = formatted(new HostError("conflict", "等一下"));

    expect(busy.data.code).toBe(conflict.data.code);
    expect(busy.data.hostCode).toBe("busy");
    expect(conflict.data.hostCode).toBe("conflict");
  });

  it("八个码各带各的 hostCode，tRPC 那一格是它们的对应值（八个落到七个上）", () => {
    const expected: Record<ErrorCode, TRPC_ERROR_CODE_KEY> = {
      not_found: "NOT_FOUND",
      invalid_params: "BAD_REQUEST",
      conflict: "CONFLICT",
      busy: "CONFLICT",
      unsupported: "NOT_IMPLEMENTED",
      config_invalid: "PRECONDITION_FAILED",
      not_available: "NOT_FOUND",
      unauthorized: "UNAUTHORIZED",
    };

    for (const [hostCode, trpcCode] of Object.entries(expected) as [
      ErrorCode,
      TRPC_ERROR_CODE_KEY,
    ][]) {
      const shape = formatted(new HostError(hostCode, "x"));
      expect(shape.data.hostCode).toBe(hostCode);
      expect(shape.data.code).toBe(trpcCode);
    }
  });
});

describe("hostErrorFormatter：不是 HostError 的那些", () => {
  it("宿主自己的运行事故：句子换成兜底那句，没有 hostCode", () => {
    const shape = wireOf(new Error("SQLITE_BUSY: database is locked"));

    expect(shape.message).toBe("宿主内部出错，这次调用没有完成");
    expect(shape.data.code).toBe("INTERNAL_SERVER_ERROR");
    expect(shape.data).not.toHaveProperty("hostCode");
  });

  it("入参在边界上被 zod 拒掉：同样是兜底那句", () => {
    const shape = wireOf(
      new TRPCError({ code: "BAD_REQUEST", message: "入参不对：sessionId 缺失" }),
    );

    expect(shape.message).toBe("宿主内部出错，这次调用没有完成");
    expect(shape.data).not.toHaveProperty("hostCode");
  });
});
