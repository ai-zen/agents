/**
 * 错误的验收：服务端回来的 `data.{code,message,detail}` 一个字不改；客户端自己那几句按语言给。
 */

import { describe, expect, it } from "vitest";

import { ClientError, fromServerError, isClientError, localError } from "./errors.js";

describe("fromServerError", () => {
  it("把 error.data 的三样原样搬进来", () => {
    const error = fromServerError({
      code: -32004,
      message: "这段对话不存在了",
      data: {
        code: "not_found",
        message: "这段对话不存在了",
        detail: { conversationId: "c1" },
        params: { what: "conversation" },
      },
    });

    expect(error).toBeInstanceOf(ClientError);
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("这段对话不存在了");
    expect(error.detail).toEqual({ conversationId: "c1" });
    expect(error.params).toEqual({ what: "conversation" });
    expect(error.rpcCode).toBe(-32004);
    expect(error.fromServer).toBe(true);
  });

  it("认不出来的业务码照样递出去（不吞、不改写成 internal）", () => {
    const error = fromServerError({
      code: -32099,
      message: "服务端新加的一类失败",
      data: { code: "brand_new_code", message: "服务端新加的一类失败", params: {} },
    });
    expect(error.code).toBe("brand_new_code");
    expect(error.message).toBe("服务端新加的一类失败");
  });

  it("data 缺字段时按 internal 兜底，而不是变成一条空消息", () => {
    const error = fromServerError({ code: -32603, message: "内部错误" });
    expect(error.code).toBe("internal");
    expect(error.message).toBe("内部错误");
  });
});

describe("localError", () => {
  it("按语言给句子，参数填进去", () => {
    const zh = localError("not_connected", {
      language: "zh",
      params: { method: "server.version" },
    });
    expect(zh.code).toBe("not_connected");
    expect(zh.message).toContain("server.version");
    expect(zh.message).toContain("握手");

    const en = localError("server_unavailable", {
      language: "en",
      params: { endpoint: "10.0.0.5:8790" },
    });
    expect(en.message).toContain("10.0.0.5:8790");
    expect(en.fromServer).toBe(false);
  });

  it("语言认不出来时按缺省（英文）", () => {
    const error = localError("closed", { language: "fr" });
    expect(error.message).toMatch(/closed/i);
  });
});

describe("isClientError", () => {
  it("只认自己的类型", () => {
    expect(isClientError(new ClientError("closed", "x"))).toBe(true);
    expect(isClientError(new Error("x"))).toBe(false);
    expect(isClientError(null)).toBe(false);
  });
});
