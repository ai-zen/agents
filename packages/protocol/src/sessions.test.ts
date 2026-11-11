/**
 * 事件表的几条不变量 —— 用用例钉住，而不是靠人眼数。
 *
 * 事件面分成三张表：`AGENT_EVENTS` 10 条（core `Agent.events` 的原名）、`SESSION_EVENTS`
 * 7 条（服务端派生 / 自己决定的事）、`SERVER_EVENTS` 1 条（服务端自己的通知）。这些都是
 * **静态事实**，而它们错了之后没有任何编译错误：把 `chunk-parsed` 写成 `session-delta`
 * 照样能编译、照样能跑，只是客户端订阅的那一条静默失效（永远是「生成中」）。所以在这里钉住。
 */

import { describe, expect, it } from "vitest";
import { AGENT_EVENTS, SERVER_EVENTS, SESSION_EVENTS } from "./sessions.js";

describe("事件表", () => {
  it("Agent 8 条、会话 6 条、服务端 1 条（改数量就该回来改这里与文档）", () => {
    expect(Object.keys(AGENT_EVENTS)).toHaveLength(8);
    expect(Object.keys(SESSION_EVENTS)).toHaveLength(6);
    expect(Object.keys(SERVER_EVENTS)).toHaveLength(1);
  });

  it("Agent 表的 8 个值逐字等于 core `Agent.events` 的原名（照抄 core 是规则，不是巧合）", () => {
    // 顺序与 `packages/core/src/Agent.ts` 的「事件系统」一节一致：改名 / 加一条就要同时
    // 想一次「core 那边叫什么」。逐字比较而不是 startsWith：这些条的意义就在于**同名**。
    //
    // 只有被转出去的才在表里：core 的 `chunk-parsed`（正文增量）与 `message`（整条消息）
    // 不上线 —— 前者客户端折 `chunk` 就有，后者被 `tool-call-end` 与快照覆盖。
    expect(Object.values(AGENT_EVENTS)).toEqual([
      "open",
      "chunk",
      "parsed",
      "tool-call-end",
      "error",
      "finally",
      "sub-agent-start",
      "sub-agent-end",
    ]);
    // 这两条确实不在线上事件里（免得有人「顺手补回来」）
    expect(Object.values(AGENT_EVENTS) as string[]).not.toContain("chunk-parsed");
    expect(Object.values(AGENT_EVENTS) as string[]).not.toContain("message");
  });

  it("事件名一律 kebab-case：不许点号，也不许驼峰（属性名可以驼峰，值不行）", () => {
    const all = [
      ...Object.values(AGENT_EVENTS),
      ...Object.values(SESSION_EVENTS),
      ...Object.values(SERVER_EVENTS),
    ];
    for (const value of all) {
      expect(value).toMatch(/^[a-z][a-z-]*$/);
      expect(value.includes(".")).toBe(false);
    }
    // 作用域靠前缀认：会话事件 `session-`，服务端通知 `server-`
    for (const value of Object.values(SESSION_EVENTS))
      expect(value.startsWith("session-")).toBe(true);
    expect(SERVER_EVENTS.notice).toBe("server-notice");
  });

  it("三张表里没有重名的值（重名 = 一条事件有两个作用域，接收方无法分辨）", () => {
    const all = [
      ...Object.values(AGENT_EVENTS),
      ...Object.values(SESSION_EVENTS),
      ...Object.values(SERVER_EVENTS),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
