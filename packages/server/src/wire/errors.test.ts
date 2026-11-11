import { describe, expect, it } from "vitest";

import {
  BIZ_CODES,
  ServerError,
  defaultMessageKey,
  isBizCode,
  jsonRpcCode,
  toErrorData,
} from "./errors.js";
import { en, zh, hasMessage } from "../i18n/index.js";

describe("业务码", () => {
  it("覆盖任务要求的那些码", () => {
    const required = [
      "unauthorized",
      "invalid_params",
      "not_found",
      "busy",
      "payload_too_large",
      "unsupported",
      "internal",
      "config_invalid",
      "mcp_unavailable",
      "model_unsupported",
      "handoff_declined",
      "question_pending",
    ] as const;
    for (const code of required) {
      expect(BIZ_CODES).toContain(code);
    }
  });

  it("命名是小写下划线，没有重复", () => {
    expect(new Set(BIZ_CODES).size).toBe(BIZ_CODES.length);
    for (const code of BIZ_CODES) {
      expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it("每个码都有文案键，且两个语言都有那一句", () => {
    for (const code of BIZ_CODES) {
      const key = defaultMessageKey(code);
      expect(hasMessage(key), code).toBe(true);
      expect(en[key].trim(), code).not.toBe("");
      expect(zh[key].trim(), code).not.toBe("");
    }
  });

  it("每个码都有数字码，且落在 JSON-RPC 的合法区间", () => {
    for (const code of BIZ_CODES) {
      const numeric = jsonRpcCode(code);
      expect(Number.isInteger(numeric), code).toBe(true);
      expect(numeric, code).toBeLessThan(-32000);
    }
  });

  it("isBizCode 只认已知码", () => {
    expect(isBizCode("busy")).toBe(true);
    expect(isBizCode("busy!")).toBe(false);
    expect(isBizCode(undefined)).toBe(false);
    expect(isBizCode(7)).toBe(false);
  });
});

describe("ServerError", () => {
  it("按业务码取默认文案键，并渲染成 data", () => {
    const error = new ServerError("busy");
    expect(error.code).toBe("busy");
    expect(error.messageKey).toBe("error.busy");

    const enData = error.toErrorData("en");
    expect(enData.code).toBe("busy");
    expect(enData.message).toBe(en["error.busy"]);
    expect(enData.params).toEqual({});

    const zhData = error.toErrorData("zh");
    expect(zhData.message).toBe(zh["error.busy"]);
  });

  it("data 里同时能带 code / message / detail / params", () => {
    const error = new ServerError("invalid_params", {
      params: { field: "conversationId" },
      detail: { failures: [{ path: "conversationId", reason: "missing" }] },
    });
    const data = error.toErrorData("en");
    expect(data.code).toBe("invalid_params");
    expect(data.message).toContain("conversationId");
    expect(data.params).toEqual({ field: "conversationId" });
    expect(data.detail).toEqual({ failures: [{ path: "conversationId", reason: "missing" }] });
  });

  it("没有 detail 时 data 里不出现 detail 字段", () => {
    const data = new ServerError("not_found").toErrorData("zh");
    expect("detail" in data).toBe(false);
  });

  it("可以换文案键与追加 detail，都返回新实例", () => {
    const base = new ServerError("not_found", { params: { entity: "conversation" } });
    const withMessage = base.withMessage("model.visionRequired", { model: "gpt-4o-mini" });
    expect(withMessage.code).toBe("not_found");
    expect(withMessage.messageKey).toBe("model.visionRequired");
    expect(withMessage.toErrorData("en").message).toContain("gpt-4o-mini");
    expect(base.toErrorData("en").message).toContain("conversation");

    const withDetail = base.withDetail({ conversationId: "c-1" });
    expect(withDetail.detail).toEqual({ conversationId: "c-1" });
    expect(withDetail.params).toEqual({ entity: "conversation" });
  });

  it("Error.message 有一句默认语言的渲染结果，日志里不会是空串", () => {
    const error = new ServerError("unauthorized");
    expect(error.message).toBe(en["error.unauthorized"]);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ServerError");
  });

  it("ServerError.is 认得自己、不认别的", () => {
    expect(ServerError.is(new ServerError("busy"))).toBe(true);
    expect(ServerError.is(new Error("boom"))).toBe(false);
    expect(ServerError.is("busy")).toBe(false);
  });
});

describe("toErrorData", () => {
  it("非 ServerError 一律收敛成 internal，原始信息留在 detail", () => {
    const data = toErrorData(new TypeError("x is not a function"), "zh");
    expect(data.code).toBe("internal");
    expect(data.message).toBe(zh["error.internal"]);
    expect(data.detail).toEqual({ reason: "x is not a function" });
  });

  it("字符串抛出物也能收敛，界面不会看到异常对象", () => {
    const data = toErrorData("boom", "en");
    expect(data.code).toBe("internal");
    expect(data.message).toBe(en["error.internal"]);
    expect(data.detail).toEqual({ reason: "boom" });
  });
});
