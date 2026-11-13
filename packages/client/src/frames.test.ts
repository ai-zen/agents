/**
 * 帧判别的验收：入站只有「通知」与「响应」两种，其余一律当噪声丢掉。
 */

import { describe, expect, it } from "vitest";

import { encodeFrame, parseIncoming, requestFrame } from "./frames.js";

describe("出站", () => {
  it("请求帧的标准形状（没有 params 时不带这个键）", () => {
    expect(requestFrame(7, "host.version", undefined)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "host.version",
    });
    expect(encodeFrame(requestFrame(1, "host.hello", { token: "t" }))).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"host.hello","params":{"token":"t"}}',
    );
  });
});

describe("入站", () => {
  it("无 id 的帧是通知（事件就是这么来的）", () => {
    const frame = parseIncoming('{"jsonrpc":"2.0","method":"run.state","params":{"a":1}}');
    expect(frame?.kind).toBe("notification");
    if (frame?.kind === "notification") {
      expect(frame.frame.method).toBe("run.state");
      expect(frame.frame.params).toEqual({ a: 1 });
    }
  });

  it("有 id + result 是成功，有 id + error 是失败", () => {
    expect(parseIncoming('{"jsonrpc":"2.0","id":2,"result":{"ok":true}}')?.kind).toBe("success");
    expect(
      parseIncoming('{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"x","data":{}}}')
        ?.kind,
    ).toBe("error");
  });

  it("坏 JSON / 不是 2.0 / 宿主发请求 / 什么都没有：一律 null", () => {
    expect(parseIncoming("{ 半个")).toBeNull();
    expect(parseIncoming('{"id":2,"result":1}')).toBeNull();
    expect(parseIncoming('{"jsonrpc":"2.0","id":3,"method":"x"}')).toBeNull();
    expect(parseIncoming('{"jsonrpc":"2.0","id":2}')).toBeNull();
    expect(parseIncoming("[]")).toBeNull();
  });
});
