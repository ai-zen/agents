/**
 * 事件表的两条不变量 —— 用用例钉住，而不是靠人眼数。
 *
 * D4 把事件拆成两张表（`SESSION_EVENTS` 11 条 / `SERVER_EVENTS` 1 条）并统一了命名空间
 * （`session.*` / `server.*`）。这两件事都是**静态事实**，但它们错了之后没有任何编译错误：
 * 加一条 `message.delta` 这样的事件照样能编译、照样能跑，只是客户端「按前缀过滤」的那套
 * 就静默失效。所以在这里钉住。
 */

import { describe, expect, it } from "vitest";
import { SERVER_EVENTS, SESSION_EVENTS } from "./sessions.js";

describe("事件表", () => {
  it("会话事件 11 条、服务端事件 1 条（改数量就该回来改这里与文档）", () => {
    expect(Object.keys(SESSION_EVENTS)).toHaveLength(11);
    expect(Object.keys(SERVER_EVENTS)).toHaveLength(1);
  });

  it("会话事件全部以 `session.` 开头（前缀就是作用域，客户端靠它过滤）", () => {
    for (const value of Object.values(SESSION_EVENTS)) {
      expect(value.startsWith("session.")).toBe(true);
    }
  });

  it("服务端事件全部以 `server.` 开头（不绑会话的东西不许混进会话表）", () => {
    for (const value of Object.values(SERVER_EVENTS)) {
      expect(value.startsWith("server.")).toBe(true);
    }
  });

  it("两张表里没有重名的值（重名 = 一条事件有两个作用域，接收方无法分辨）", () => {
    const all = [...Object.values(SESSION_EVENTS), ...Object.values(SERVER_EVENTS)];
    expect(new Set(all).size).toBe(all.length);
  });
});
