/**
 * 地址形状的验收：用户填什么都能认、拼出去的 URL 一定对（IPv6 加方括号、子路径、加密）。
 */

import { describe, expect, it } from "vitest";

import {
  addressLabel,
  isLoopbackHost,
  normalizeAddress,
  parseAddress,
  webSocketUrl,
} from "./address.js";
import type { ClientError } from "./errors.js";

describe("parseAddress", () => {
  it("四种 scheme 都认，http/https 按 ws/wss 理解", () => {
    expect(parseAddress("ws://127.0.0.1:8790")).toEqual({ host: "127.0.0.1", port: 8790 });
    expect(parseAddress("wss://example.test")).toEqual({
      host: "example.test",
      port: 443,
      secure: true,
    });
    expect(parseAddress("http://example.test/ai-zen")).toEqual({
      host: "example.test",
      port: 80,
      path: "/ai-zen",
    });
    expect(parseAddress("https://example.test/ai-zen")).toEqual({
      host: "example.test",
      port: 443,
      path: "/ai-zen",
      secure: true,
    });
  });

  it("没写 scheme 就补 ws://（终端里最自然的写法）", () => {
    expect(normalizeAddress("10.0.0.5:8790")).toBe("ws://10.0.0.5:8790");
    expect(parseAddress("10.0.0.5:8790")).toEqual({ host: "10.0.0.5", port: 8790 });
  });

  it("不合法时给出带原始字符串的本地错误", () => {
    const error = (() => {
      try {
        parseAddress("ftp://example.test");
        return null;
      } catch (caught) {
        return caught as ClientError;
      }
    })();
    expect(error?.code).toBe("bad_address");
    expect(error?.message).toContain("ftp://example.test");
  });
});

describe("webSocketUrl", () => {
  it("IPv6 加方括号，没有子路径时不多出斜杠", () => {
    expect(webSocketUrl({ host: "::1", port: 8790 })).toBe("ws://[::1]:8790");
    expect(webSocketUrl({ host: "[::1]", port: 8790 })).toBe("ws://[::1]:8790");
    expect(webSocketUrl({ host: "127.0.0.1", port: 8790 })).toBe("ws://127.0.0.1:8790");
    expect(webSocketUrl({ host: "h", port: 1, secure: true, path: "/ai-zen" })).toBe(
      "wss://h:1/ai-zen",
    );
  });

  it("解析出来的地址能原样拼回去", () => {
    const target = parseAddress("https://example.test/ai-zen");
    expect(webSocketUrl(target)).toBe("wss://example.test:443/ai-zen");
  });
});

describe("给人看的地址", () => {
  it("IPv6 带方括号（否则 `::1:8790` 读不出端口在哪）", () => {
    expect(addressLabel({ host: "::1", port: 8790 })).toBe("[::1]:8790");
    expect(addressLabel({ host: "127.0.0.1", port: 8790 })).toBe("127.0.0.1:8790");
  });

  it("回环判据（决定本机那串凭证有没有意义）", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });
});
