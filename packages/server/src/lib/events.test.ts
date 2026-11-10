import { beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "./events.js";
import { SESSION_EVENTS, SERVER_EVENTS, type ServerEvent } from "@ai-zen/agents-protocol";

let hub: EventHub;
let received: ServerEvent[];

beforeEach(() => {
  hub = new EventHub();
  received = [];
  hub.subscribe((event) => received.push(event));
});

const phase: ServerEvent = {
  event: SESSION_EVENTS.phase,
  sessionId: "chat_1",
  turnId: 1,
  phase: { kind: "queued" },
};

describe("EventHub", () => {
  it("推给所有订阅方", () => {
    const alsoMine: ServerEvent[] = [];
    hub.subscribe((event) => alsoMine.push(event));

    hub.publish(phase);
    expect(received).toEqual([phase]);
    expect(alsoMine).toEqual([phase]);
  });

  it("取消订阅后不再收到", () => {
    const mine: ServerEvent[] = [];
    const off = hub.subscribe((event) => mine.push(event));
    hub.publish(phase);
    off();
    hub.publish(phase);
    expect(mine).toHaveLength(1);
  });

  it("一个订阅方抛错不影响其他订阅方", () => {
    hub.subscribe(() => {
      throw new Error("这条连接写失败了");
    });
    const survivor: ServerEvent[] = [];
    hub.subscribe((event) => survivor.push(event));

    hub.publish(phase);
    expect(survivor).toEqual([phase]);
  });

  it("watcherCount 报出当前订阅者数量（没人看的时候不能向客户端提问）", () => {
    // 基线：`beforeEach` 已经订了一个
    expect(hub.watcherCount()).toBe(1);

    const off = hub.subscribe(() => {});
    expect(hub.watcherCount()).toBe(2);

    // 客户端断开 = 退订：会话层据此判断「问题发出去有没有人看得见」
    off();
    expect(hub.watcherCount()).toBe(1);

    hub.clear();
    expect(hub.watcherCount()).toBe(0);
  });

  it("clear 断掉全部订阅（关停时用）", () => {
    hub.clear();
    hub.publish(phase);
    expect(received).toEqual([]);
  });

  it("全局通知走同一条线：不带 sessionId，也不该被会话过滤掉", () => {
    hub.publish({
      event: SERVER_EVENTS.notice,
      level: "warn",
      code: "mcpUnavailable",
      params: { name: "github" },
    });
    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty("sessionId");
  });
});
