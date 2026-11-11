import { describe, it, expect } from "vitest";
import {
  isNotification,
  isRequestFrame,
  MAX_REQUEST_ID,
  PROTOCOL_VERSION,
  readRequestId,
  REQUEST_ID_BYTES,
} from "./messages.js";

/**
 * `wire/messages.ts` 是本包自己那一份实现（与服务端那份**逐字同构**，两边各一份、不共享代码）。
 *
 * 既然有两份，判据就得在两边各钉一遍：这里的每一条在服务端都有同名用例，任何一侧改了口径而
 * 另一侧没跟上，就会有一套红。
 */
describe("isRequestFrame", () => {
  const request = { jsonrpc: "2.0", id: 1, method: "ping" };

  it("最小合法请求：四条同时成立就过（`id` 的两端都在值域内）", () => {
    expect(isRequestFrame(request)).toBe(true);
    expect(isRequestFrame({ ...request, params: { any: "thing" } })).toBe(true);
    expect(isRequestFrame({ ...request, id: 0 })).toBe(true);
    expect(isRequestFrame({ ...request, id: MAX_REQUEST_ID })).toBe(true);
  });

  it("顶层数组（批量）不算请求：批量本版不支持", () => {
    expect(isRequestFrame([request])).toBe(false);
  });

  it("缺 `jsonrpc` 字面量 / 缺 `method` / `id` 不合规，一律不算", () => {
    expect(isRequestFrame({ id: 1, method: "ping" })).toBe(false);
    expect(isRequestFrame({ jsonrpc: "2.0", id: 1 })).toBe(false);
    for (const id of ["1", -1, 1.5, Number.NaN, MAX_REQUEST_ID + 1, undefined]) {
      expect(isRequestFrame({ ...request, id })).toBe(false);
    }
    for (const value of [null, 42, "ping", undefined, true]) {
      expect(isRequestFrame(value)).toBe(false);
    }
  });
});

describe("isNotification", () => {
  it("有 `method`、没有 `id` 才是通知（有 `id` 的是请求，没 `method` 的是回执）", () => {
    expect(isNotification({ jsonrpc: "2.0", method: "session.event", params: {} })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", id: 1, method: "ping" })).toBe(false);
    expect(isNotification({ jsonrpc: "2.0", id: 1, result: null })).toBe(false);
    expect(isNotification({ jsonrpc: "2.0", method: "" })).toBe(false);
    expect(isNotification([{ method: "ping" }])).toBe(false);
    expect(isNotification(null)).toBe(false);
  });
});

describe("二进制消息的 id 前缀", () => {
  it("前 4 字节按**大端无符号**读（与写出去的那一侧同一条约定）", () => {
    expect(readRequestId(Buffer.from([0x01, 0x02, 0x03, 0x04, 0xaa]))).toBe(0x01020304);
    // 最高位不当符号位：0xFFFFFFFF 就是 4294967295，不是 -1
    expect(readRequestId(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(MAX_REQUEST_ID);
  });

  it("不足 4 字节读不出 id；前缀长度与上界是同一个事实的两面", () => {
    expect(readRequestId(Buffer.alloc(0))).toBeNull();
    expect(readRequestId(Buffer.from([0x01, 0x02, 0x03]))).toBeNull();
    expect(REQUEST_ID_BYTES).toBe(4);
    expect(MAX_REQUEST_ID).toBe(2 ** (REQUEST_ID_BYTES * 8) - 1);
  });
});

describe("协议版本", () => {
  it("本版是 3（E1：断代，版本不匹配即不连；`hello` 加必填的 `token` 就是那次断代）", () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});
