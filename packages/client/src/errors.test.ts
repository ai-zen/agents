/**
 * 错误的验收：宿主那个码能还原成能分支的东西、它渲染好的那句原样带出来、没有 `hostCode` 时
 * 退回 tRPC 那套码，客户端自己那几句按语言给。
 */

import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";

import { ClientError, fromTRPCError, isClientError, localError } from "./errors.js";

/** 一帧宿主回来的错误：形状照 `packages/host/src/modules/api/errors.ts` 那一份 */
function hostError(input: {
  /** 宿主自己的码（`data.hostCode`）；不给就是「还没升级的宿主」那种帧 */
  hostCode?: string;
  code: string;
  message: string;
  details?: unknown;
}): TRPCClientError<never> {
  return TRPCClientError.from({
    error: {
      code: -32603,
      message: input.message,
      data: {
        ...(input.hostCode === undefined ? {} : { hostCode: input.hostCode }),
        code: input.code,
        path: "session.open",
        ...(input.details === undefined ? {} : { details: input.details }),
      },
    },
  });
}

describe("fromTRPCError：宿主回的那些码", () => {
  it("把 data.hostCode 还原成码、message 原样、details 进 detail", () => {
    const error = fromTRPCError(
      hostError({
        hostCode: "not_found",
        code: "NOT_FOUND",
        message: "找不到 id 为 c1 的会话",
        details: { entity: "session", sessionId: "c1" },
      }),
    );

    expect(error.code).toBe("not_found");
    expect(error.message).toBe("找不到 id 为 c1 的会话");
    expect(error.detail).toEqual({ entity: "session", sessionId: "c1" });
  });

  it("宿主那八个码原样还原：`busy` 与 `conflict`、`not_found` 与 `not_available` 分得开", () => {
    const hostCodes = [
      "not_found",
      "invalid_params",
      "conflict",
      "busy",
      "unsupported",
      "config_invalid",
      "not_available",
      "unauthorized",
    ];
    for (const hostCode of hostCodes) {
      // 八个人一个 tRPC 码都可能（对应关系在宿主那一侧），客户端只认自己这一格
      expect(fromTRPCError(hostError({ hostCode, code: "CONFLICT", message: "x" })).code).toBe(
        hostCode,
      );
    }
  });

  it("没有 hostCode（还没升级的宿主）：退回 data.code 那套 tRPC 码", () => {
    const trpcCodes = [
      "UNAUTHORIZED",
      "BAD_REQUEST",
      "NOT_FOUND",
      "CONFLICT",
      "NOT_IMPLEMENTED",
      "PRECONDITION_FAILED",
      "INTERNAL_SERVER_ERROR",
    ];
    for (const code of trpcCodes) {
      expect(fromTRPCError(hostError({ code, message: "x" })).code).toBe(code);
    }
  });

  it("两格都在时以 hostCode 为准（它是语义层，code 是传输层）", () => {
    const error = fromTRPCError(hostError({ hostCode: "busy", code: "CONFLICT", message: "x" }));

    expect(error.code).toBe("busy");
  });

  it("认不出的码照样递出去（宿主加了新码，客户端不必先认识它）", () => {
    expect(
      fromTRPCError(hostError({ hostCode: "rate_limited", code: "BAD_REQUEST", message: "x" }))
        .code,
    ).toBe("rate_limited");
  });
});

describe("fromTRPCError：不是宿主说的话", () => {
  it("客户端自己抛的（本端关掉）：从 cause 里取回原物", () => {
    const closed = localError("closed", { params: {} });
    const error = fromTRPCError(TRPCClientError.from(closed));

    expect(error).toBe(closed);
    expect(error.code).toBe("closed");
  });

  it("连接断了：传输层那句英文原样留着，码是 connection_lost", () => {
    const error = fromTRPCError(TRPCClientError.from(new Error("WebSocket closed")));

    expect(error.code).toBe("connection_lost");
    expect(error.message).toBe("WebSocket closed");
    expect(error.detail).toEqual({ reason: "WebSocket closed" });
  });

  it("根本不是 tRPC 的错误：unexpected，原始信息进 detail", () => {
    const error = fromTRPCError(new TypeError("x is not a function"));

    expect(error.code).toBe("unexpected");
    expect(error.detail).toEqual({ reason: "x is not a function" });
  });

  it("已经是 ClientError 的原样返回（不重复包一层）", () => {
    const original = new ClientError("invalid_params", "x");
    expect(fromTRPCError(original)).toBe(original);
    expect(isClientError(original)).toBe(true);
  });
});

describe("localError：本地那几句按语言给", () => {
  it("中文 / 英文各一份，缺省英文", () => {
    const zh = localError("host_unavailable", { language: "zh-CN", params: { endpoint: "h:1" } });
    const en = localError("host_unavailable", { params: { endpoint: "h:1" } });

    expect(zh.message).toContain("连不上宿主（h:1）");
    expect(en.message).toBe("Could not reach the host (h:1)");
  });

  it("缺参数时占位符原样留着（不把 undefined 印到界面上）", () => {
    expect(localError("host_unavailable", { params: {} }).message).toContain("{endpoint}");
  });
});
