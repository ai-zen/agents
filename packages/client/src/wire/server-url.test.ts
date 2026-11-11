/**
 * 地址形状与 URL 的用例 —— 两条判据：**解析出来的字段对不对**、**拼出去的 URL 长什么样**。
 *
 * 这里刻意用一个字面量对象做期望（`toEqual({ host, port })`）而不是断言某个字段：形状是多出来
 * 一个键还是少一个键，对 `isLoopbackHost(target.host)` 那条工作区判据是「能用」与「会话跑错目
 * 录」的差别，多出来的键（`path: "/"`、`secure: false`）会让下游每一处 `??` 白发一次。
 */

import { describe, expect, it } from "vitest";
import { parseServerUrl, webSocketUrl } from "./server-url.js";

describe("parseServerUrl", () => {
  it("ws:// 带端口：端口原样，明文（不多带 secure 键）", () => {
    expect(parseServerUrl("ws://127.0.0.1:8790")).toEqual({ host: "127.0.0.1", port: 8790 });
  });

  it("wss:// 不给端口：缺省 443，且 secure", () => {
    expect(parseServerUrl("wss://example.com")).toEqual({
      host: "example.com",
      port: 443,
      secure: true,
    });
  });

  it("https://…/ai-zen：映射成 wss + 子路径（nginx 子路径挂载就是这一支）", () => {
    expect(parseServerUrl("https://example.com/ai-zen")).toEqual({
      host: "example.com",
      port: 443,
      path: "/ai-zen",
      secure: true,
    });
  });

  it("http:// 不给端口：缺省 80，明文（`http → ws` 是同一个端口、同一条连接）", () => {
    expect(parseServerUrl("http://127.0.0.1:8790")).toEqual({ host: "127.0.0.1", port: 8790 });
    expect(parseServerUrl("http://example.com")).toEqual({ host: "example.com", port: 80 });
  });

  it("IPv6 字面量：方括号是 URL 的语法，取出来的 host 不带它", () => {
    expect(parseServerUrl("ws://[::1]:8790")).toEqual({ host: "::1", port: 8790 });
  });

  it("首尾空白不算内容（环境变量里带一个换行是常事）", () => {
    expect(parseServerUrl("  ws://127.0.0.1:8790\n")).toEqual({ host: "127.0.0.1", port: 8790 });
  });

  it("非法输入抛错，且错误信息里带原值", () => {
    // scheme 不在四种里、以及压根不是 URL：两种都要报错，而且要看得出「哪一个字符串不对」
    for (const input of ["ftp://x", "不是URL"]) {
      expect(() => parseServerUrl(input)).toThrow(input);
    }
  });
});

describe("webSocketUrl", () => {
  it("明文：ws://host:port，没有多余斜杠", () => {
    expect(webSocketUrl({ host: "127.0.0.1", port: 8790 })).toBe("ws://127.0.0.1:8790");
  });

  it("secure：wss://", () => {
    expect(webSocketUrl({ host: "example.com", port: 443, secure: true })).toBe(
      "wss://example.com:443",
    );
  });

  it("带 path：原样接在端口后面（子路径挂载）", () => {
    expect(webSocketUrl({ host: "example.com", port: 443, secure: true, path: "/ai-zen" })).toBe(
      "wss://example.com:443/ai-zen",
    );
    // 少写前导斜杠是同一件事，不该拼出 `example.com:443ai-zen`
    expect(webSocketUrl({ host: "example.com", port: 80, path: "ai-zen" })).toBe(
      "ws://example.com:80/ai-zen",
    );
  });

  it("path 是 `/` 与没有 path 同义：不多出一个斜杠", () => {
    expect(webSocketUrl({ host: "127.0.0.1", port: 8790, path: "/" })).toBe("ws://127.0.0.1:8790");
    expect(webSocketUrl({ host: "127.0.0.1", port: 8790, path: "" })).toBe("ws://127.0.0.1:8790");
  });

  it("IPv6 字面量：出去时加方括号（进来时带不带都行）", () => {
    expect(webSocketUrl({ host: "::1", port: 8790 })).toBe("ws://[::1]:8790");
    expect(webSocketUrl({ host: "[::1]", port: 8790 })).toBe("ws://[::1]:8790");
  });

  it("与 parseServerUrl 对得上：`https://…/ai-zen` 一路拼回 wss 子路径", () => {
    expect(webSocketUrl(parseServerUrl("https://example.com/ai-zen"))).toBe(
      "wss://example.com:443/ai-zen",
    );
  });
});
