import { AgentNS, applyChunk } from "@ai-zen/agents-core";
import { describe, expect, it } from "vitest";

import {
  EVENT_NAMES,
  isEventName,
  type SessionChangeKind,
  type EventName,
  type EventPayload,
  type MessageDeltaPayload,
} from "./events.js";

const NOW = "2026-01-01T00:00:00.000Z";

const localized = (key: "question.handoff.prompt") =>
  ({ code: key, messageKey: key, params: {}, message: key }) as const;

describe("事件表", () => {
  it("消息四件 + 忙闲一条 + 两道闸四条 + 出错 + 结构变化 + 通知 + 题：13 条", () => {
    expect([...EVENT_NAMES]).toEqual([
      "message.added",
      "message.delta",
      "message.changed",
      "message.removed",
      "state",
      "output:paused",
      "output:resumed",
      "input:paused",
      "input:resumed",
      "error",
      "session.changed",
      "notice",
      "question",
    ]);
  });

  it("EVENT_NAMES 覆盖 EventMap 的每一个事件（漏写会在编译期露馅）", () => {
    type Missing = Exclude<EventName, (typeof EVENT_NAMES)[number]>;
    const noMissing: Missing extends never ? true : false = true;
    expect(noMissing).toBe(true);
  });

  it("isEventName 只认表里的事件", () => {
    expect(isEventName("state")).toBe(true);
    expect(isEventName("notice")).toBe(true);
    expect(isEventName("run.phase")).toBe(false);
    expect(isEventName(null)).toBe(false);
  });

  it("message.delta 的增量就是 core 的 Delta，属于哪一段由它自己的字段说明", () => {
    const textDelta: MessageDeltaPayload = {
      sessionId: "c-1",
      messageId: "m-2",
      delta: { content: "你好" },
      at: NOW,
    };
    expect(textDelta.delta.content).toBe("你好");
    expect(textDelta.delta.reasoning_content).toBeUndefined();

    const thinkingDelta: MessageDeltaPayload = {
      ...textDelta,
      delta: { reasoning_content: "先看文件" },
    };
    expect(thinkingDelta.delta.reasoning_content).toBe("先看文件");

    // 工具调用的增量也是 core 的形状：id 先到、名字与参数可能后到
    const toolDelta: MessageDeltaPayload = {
      ...textDelta,
      delta: {
        tool_calls: [
          { index: 0, id: "t-1", type: "function", function: { name: "read", arguments: '{"pa' } },
        ],
      },
    };
    const call = toolDelta.delta.tool_calls?.[0];
    expect(call?.id).toBe("t-1");
    expect(call?.function?.arguments).toBe('{"pa');

    // 内容段数组（图片 / 文件）走的也是同一份 Delta
    const sectionDelta: MessageDeltaPayload = {
      ...textDelta,
      delta: {
        content: [
          { index: 0, type: "image_url", image_url: { url: "https://example.test/a.png" } },
        ],
      },
    };
    expect(Array.isArray(sectionDelta.delta.content) && sectionDelta.delta.content[0].type).toBe(
      "image_url",
    );
  });

  it("message.delta 的增量能用 core 的 applyChunk 攒成一条消息", () => {
    const receiver: AgentNS.Message = { id: "m-2", role: AgentNS.Role.Assistant };
    const payload: MessageDeltaPayload = {
      sessionId: "c-1",
      messageId: "m-2",
      delta: { content: "你好", reasoning_content: "先看文件" },
      at: NOW,
    };

    // 载荷里的那一片增量本身就是 `applyChunk` 的入参（都是 core 的 `AgentNS.Delta`，
    // 中间不包 `choices[0]`）：字段名对不上就会攒不进去
    applyChunk(receiver, payload.delta);

    expect(receiver.content).toBe("你好");
    expect(receiver.reasoning_content).toBe("先看文件");
    // 用量与结束原因不属于这一片增量：它们由跑流的那一侧钉到消息上（这里不该冒出来）
    expect(receiver.usage).toBeUndefined();
    expect(receiver.finish_reason).toBeUndefined();
  });

  it("session.changed 覆盖结构变化的那几种（死活那一件也在这里）", () => {
    // 消息的增删改有自己的事件（带整条消息），所以这里没有「消息落库了」/「消息删了」两格，
    // 也不带消息条数 —— 条数客户端自己数。死活（有没有 agent 实例）也走这一条：它不是忙闲。
    const kinds: SessionChangeKind[] = [
      "created",
      "renamed",
      "pinned",
      "settings_changed",
      "agent_started",
      "agent_gone",
      "handoff_started",
      "memory_replaced",
      "deleted",
    ];
    for (const change of kinds) {
      const payload: EventPayload<"session.changed"> = {
        sessionId: "c-1",
        workspaceId: "w-1",
        change,
        at: NOW,
      };
      expect(payload.change).toBe(change);
    }
  });

  it("state 只报忙闲（`working` / `idle`）：闸与死活不在这一条上", () => {
    const payload: EventPayload<"state"> = { sessionId: "c-1", status: "working", at: NOW };
    expect(payload.status).toBe("working");
    for (const status of ["working", "idle"] as const) {
      const changed: EventPayload<"state"> = { ...payload, status };
      expect(changed.status).toBe(status);
      // 载荷里只有「哪一段、手上有没有活、什么时候」：一道闸、一条死活都不许挤进来
      expect(Object.keys(changed).sort()).toEqual(["at", "sessionId", "status"]);
    }
  });

  it("两道闸各有自己的开与关：载荷只带会话 id（事件名已经说清哪一道、开还是关）", () => {
    const names = ["output:paused", "output:resumed", "input:paused", "input:resumed"] as const;
    for (const name of names) {
      const payload: EventPayload<typeof name> = { sessionId: "c-1", at: NOW };
      expect(Object.keys(payload).sort()).toEqual(["at", "sessionId"]);
      expect(isEventName(name)).toBe(true);
    }
  });

  it("notice / question 推的是完整对象", () => {
    const notice: EventPayload<"notice"> = {
      notice: {
        id: "n-1",
        level: "warning",
        duration: null,
        text: localized("question.handoff.prompt"),
        sessionId: "c-1",
        createdAt: NOW,
        origin: "app",
      },
      at: NOW,
    };
    expect(notice.notice.duration).toBeNull();

    const question: EventPayload<"question"> = {
      question: {
        id: "q-1",
        sessionId: "c-1",
        kind: "handoff",
        state: "pending",
        prompt: localized("question.handoff.prompt"),
        options: [{ value: "self", label: localized("question.handoff.prompt"), detail: null }],
        answer: null,
        blocking: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      at: NOW,
    };
    expect(question.question.options[0].value).toBe("self");
  });
});
