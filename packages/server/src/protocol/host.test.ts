/**
 * `isLoopbackHost` 的判据表 —— 服务端「能不能绑这个地址」与客户端「服务端是不是本机」
 * 都读它，所以它值得有自己的用例。
 */

import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./host.js";

describe("isLoopbackHost", () => {
  it("整段 127/8 都算本机（不只 127.0.0.1）", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "127.1.2.3"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("localhost 与 ::1（含带方括号的写法）都算本机", () => {
    for (const host of ["localhost", "LOCALHOST", " ::1 ", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("监听地址与局域网地址都不算：`0.0.0.0` 是监听用的，不是连接目标", () => {
    for (const host of ["0.0.0.0", "192.168.1.10", "::", "example.com", "127.0.0.1.example"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
