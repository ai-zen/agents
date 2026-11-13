import { describe, expect, it } from "vitest";

import {
  errResponse,
  isErrorFrame,
  isNotificationFrame,
  isRequestFrame,
  isResponseFrame,
  isSuccessFrame,
  notification,
  okResponse,
  parseFrame,
} from "./frames.js";
import { HostError } from "./errors.js";
import { en, zh } from "../i18n/index.js";

function expectHostError(fn: () => unknown, code: string): HostError {
  try {
    fn();
  } catch (error) {
    expect(HostError.is(error)).toBe(true);
    expect((error as HostError).code).toBe(code);
    return error as HostError;
  }
  throw new Error("这段代码本该抛错");
}

describe("帧守卫", () => {
  it("请求帧：有 id + method + jsonrpc:2.0", () => {
    expect(isRequestFrame({ jsonrpc: "2.0", id: 1, method: "host.version" })).toBe(true);
    expect(isRequestFrame({ jsonrpc: "2.0", id: "abc", method: "message.list", params: {} })).toBe(
      true,
    );
  });

  it("请求帧的反例", () => {
    expect(isRequestFrame(null)).toBe(false);
    expect(isRequestFrame("{}")).toBe(false);
    expect(isRequestFrame([])).toBe(false);
    expect(isRequestFrame({ id: 1, method: "host.version" })).toBe(false);
    expect(isRequestFrame({ jsonrpc: "1.0", id: 1, method: "host.version" })).toBe(false);
    expect(isRequestFrame({ jsonrpc: "2.0", id: 1 })).toBe(false);
    expect(isRequestFrame({ jsonrpc: "2.0", id: 1, method: "" })).toBe(false);
    expect(isRequestFrame({ jsonrpc: "2.0", id: {}, method: "host.version" })).toBe(false);
    expect(isRequestFrame({ jsonrpc: "2.0", id: Number.NaN, method: "host.version" })).toBe(
      false,
    );
  });

  it("通知帧：无 id（或 id 为 null）", () => {
    expect(isNotificationFrame({ jsonrpc: "2.0", method: "run.state", params: {} })).toBe(true);
    expect(isNotificationFrame({ jsonrpc: "2.0", id: null, method: "run.state" })).toBe(true);
    expect(isNotificationFrame({ jsonrpc: "2.0", id: 2, method: "run.state" })).toBe(false);
    expect(isNotificationFrame({ jsonrpc: "2.0" })).toBe(false);
    expect(isNotificationFrame(undefined)).toBe(false);
  });

  it("响应帧：成功与错误分开认", () => {
    expect(isSuccessFrame({ jsonrpc: "2.0", id: 1, result: null })).toBe(true);
    expect(isSuccessFrame({ jsonrpc: "2.0", id: 1, result: {}, error: {} })).toBe(false);
    expect(isErrorFrame({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "x" } })).toBe(
      true,
    );
    expect(isErrorFrame({ jsonrpc: "2.0", id: null, error: { code: -32600 } })).toBe(true);
    expect(isErrorFrame({ jsonrpc: "2.0", id: 1, error: "boom" })).toBe(false);
    expect(isResponseFrame({ jsonrpc: "2.0", id: 1, result: 1 })).toBe(true);
    expect(isResponseFrame({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(false);
  });
});

describe("parseFrame", () => {
  it("解析请求（字符串与对象两种入参）", () => {
    const fromString = parseFrame(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "message.list", params: { a: 1 } }),
    );
    expect(fromString).toEqual({
      kind: "request",
      id: 7,
      method: "message.list",
      params: { a: 1 },
    });

    const fromObject = parseFrame({ jsonrpc: "2.0", id: "x", method: "host.version" });
    expect(fromObject.kind).toBe("request");
    if (fromObject.kind === "request") {
      expect(fromObject.params).toEqual({});
    }
  });

  it("解析通知", () => {
    const frame = parseFrame({ jsonrpc: "2.0", method: "notice", params: { hello: 1 } });
    expect(frame).toEqual({ kind: "notification", method: "notice", params: { hello: 1 } });
  });

  it("解析响应与错误响应（客户端侧复用同一份代码）", () => {
    expect(parseFrame({ jsonrpc: "2.0", id: 3, result: { ok: true } })).toEqual({
      kind: "response",
      id: 3,
      result: { ok: true },
    });

    const errorFrame = parseFrame({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32005, message: "busy", data: { code: "busy", message: "忙", params: {} } },
    });
    expect(errorFrame.kind).toBe("error");
    if (errorFrame.kind === "error") {
      expect(errorFrame.error.code).toBe(-32005);
      expect(errorFrame.error.data?.code).toBe("busy");
    }
  });

  it("批量请求直接拒（PRD A4：不用标准的那部分）", () => {
    const error = expectHostError(
      () =>
        parseFrame([
          { jsonrpc: "2.0", id: 1, method: "host.version" },
          { jsonrpc: "2.0", id: 2, method: "host.version" },
        ]),
      "unsupported",
    );
    expect(error.detail).toEqual({ reason: "batch_not_supported", count: 2 });
  });

  it("不是合法 JSON 时报 invalid_params，并指出坏在哪一步", () => {
    const error = expectHostError(() => parseFrame("{ not json"), "invalid_params");
    expect(error.detail).toMatchObject({ reason: "not_json" });
    expect(error.params).toEqual({ field: "jsonrpc" });
  });

  it("缺 jsonrpc 版本时报 invalid_params", () => {
    const error = expectHostError(() => parseFrame({ id: 1, method: "host.version" }), "invalid_params");
    expect(error.detail).toEqual({ reason: "bad_protocol", got: null });
  });

  it("id 类型不对时报 invalid_params", () => {
    const error = expectHostError(
      () => parseFrame({ jsonrpc: "2.0", id: { nested: true }, method: "host.version" }),
      "invalid_params",
    );
    expect(error.detail).toMatchObject({ reason: "bad_id" });
  });

  it("既没有 method 也没有 result 时报 invalid_params", () => {
    const error = expectHostError(() => parseFrame({ jsonrpc: "2.0", id: 1 }), "invalid_params");
    expect(error.detail).toEqual({ reason: "neither_method_nor_result" });
  });

  it("数组以外的非对象（数字、null）也拒", () => {
    expectHostError(() => parseFrame(42), "invalid_params");
    expectHostError(() => parseFrame(null), "invalid_params");
  });
});

describe("帧构造", () => {
  it("okResponse 形状符合标准", () => {
    expect(okResponse(9, { ok: true })).toEqual({ jsonrpc: "2.0", id: 9, result: { ok: true } });
  });

  it("errResponse 把业务码、数字码与人话一起给出", () => {
    const error = new HostError("busy");
    const zhFrame = errResponse(5, error, "zh");
    expect(zhFrame.id).toBe(5);
    expect(zhFrame.error.code).toBe(-32005);
    expect(zhFrame.error.data.code).toBe("busy");
    expect(zhFrame.error.data.message).toBe(zh["error.busy"]);
    expect(zhFrame.error.message).toBe(zh["error.busy"]);

    const enFrame = errResponse(5, error, "en");
    expect(enFrame.error.data.message).toBe(en["error.busy"]);
  });

  it("errResponse 收得下任意抛出物，id 可以是 null", () => {
    const frame = errResponse(null, new Error("boom"), "en");
    expect(frame.id).toBeNull();
    expect(frame.error.code).toBe(-32603);
    expect(frame.error.data.code).toBe("internal");
    expect(frame.error.data.detail).toEqual({ reason: "boom" });
  });

  it("notification 造出无 id 的推送帧", () => {
    const payload = {
      notice: {
        id: "n-1",
        level: "info" as const,
        duration: 1,
        text: {
          code: "notice.settingsSaved",
          messageKey: "notice.settingsSaved" as const,
          params: {},
          message: "ok",
        },
        conversationId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      at: "2026-01-01T00:00:00.000Z",
    };
    const frame = notification("notice", payload);
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.method).toBe("notice");
    expect("id" in frame).toBe(false);
    expect(frame.params).toEqual(payload);
  });
});
