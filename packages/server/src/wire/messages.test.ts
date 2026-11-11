import { describe, it, expect } from "vitest";
import {
  isRequestFrame,
  MAX_REQUEST_ID,
  PROTOCOL_VERSION,
  readRequestId,
  REQUEST_ID_BYTES,
} from "./messages.js";

/**
 * 入站判定的用例 —— 判错的代价是「一条本该被回错误的请求被悄悄接受」或反过来，
 * 所以每种拒绝理由各钉一条。
 *
 * 判别规则只回答一个问题：**这个东西是不是一条请求**。参数里有什么不归它管。
 */
describe("isRequestFrame", () => {
  const request = { jsonrpc: "2.0", id: 1, method: "ping" };

  it("最小合法请求：四条同时成立就过", () => {
    expect(isRequestFrame(request)).toBe(true);
    expect(isRequestFrame({ ...request, params: { any: "thing" } })).toBe(true);
    // `id` 的两端都在值域内
    expect(isRequestFrame({ ...request, id: 0 })).toBe(true);
    expect(isRequestFrame({ ...request, id: MAX_REQUEST_ID })).toBe(true);
  });

  it("顶层是数组（批量）不算请求：批量本版不支持", () => {
    expect(isRequestFrame([request])).toBe(false);
  });

  it("缺 `jsonrpc: \"2.0\"` 字面量不算请求", () => {
    expect(isRequestFrame({ id: 1, method: "ping" })).toBe(false);
    expect(isRequestFrame({ jsonrpc: "1.0", id: 1, method: "ping" })).toBe(false);
  });

  it("没有 method 不算请求（通知与响应都不走这条路；通知由上游认出来后静默丢弃）", () => {
    expect(isRequestFrame({ jsonrpc: "2.0", id: 1 })).toBe(false);
    expect(isRequestFrame({ jsonrpc: "2.0", id: 1, result: null })).toBe(false);
    // 通知：有 method、没有 id
    expect(isRequestFrame({ jsonrpc: "2.0", method: "ping" })).toBe(false);
    // 空方法名
    expect(isRequestFrame({ ...request, method: "" })).toBe(false);
  });

  it("`id` 只允许 `0 … 2³²-1` 的整数（字符串 id 是规范允许、本版不用的那一半）", () => {
    for (const id of ["1", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_REQUEST_ID + 1]) {
      expect(isRequestFrame({ ...request, id })).toBe(false);
    }
    expect(isRequestFrame({ ...request, id: undefined })).toBe(false);
  });

  it("不是对象的东西一律不算（`null` / 数字 / 字符串 / undefined）", () => {
    for (const value of [null, 42, "ping", undefined, true]) {
      expect(isRequestFrame(value)).toBe(false);
    }
  });
});

describe("二进制消息的 id 前缀", () => {
  it("前 4 字节按**大端无符号**读", () => {
    // 0x01020304：大端就是 1,2,3,4 的顺序（小端会读成 0x04030201）
    expect(readRequestId(Buffer.from([0x01, 0x02, 0x03, 0x04, 0xaa]))).toBe(0x01020304);
    // 最高位不当符号位：0xFFFFFFFF 就是 4294967295，不是 -1
    expect(readRequestId(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(MAX_REQUEST_ID);
  });

  it("不足 4 字节读不出 id（= 对不上任何在飞请求）", () => {
    expect(readRequestId(Buffer.alloc(0))).toBeNull();
    expect(readRequestId(Buffer.from([0x01, 0x02, 0x03]))).toBeNull();
  });

  it("前缀长度是 4 字节（与 `MAX_REQUEST_ID` 是同一个事实的两面）", () => {
    expect(REQUEST_ID_BYTES).toBe(4);
    expect(MAX_REQUEST_ID).toBe(2 ** (REQUEST_ID_BYTES * 8) - 1);
  });
});

describe("协议版本", () => {
  it("本版是 2（E1：断代，版本不匹配即不连）", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});
