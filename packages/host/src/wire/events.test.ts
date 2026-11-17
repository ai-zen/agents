import { AgentNS, applyChunk } from "@ai-zen/agents-core";
import { describe, expect, it } from "vitest";

import {
  EVENT_NAMES,
  isEventName,
  type ConversationChangeKind,
  type EventName,
  type EventPayload,
  type MessageDeltaPayload,
} from "./events.js";

const NOW = "2026-01-01T00:00:00.000Z";

const localized = (key: "question.handoff.prompt") =>
  ({ code: key, messageKey: key, params: {}, message: key }) as const;

describe("事件表", () => {
  it("就是 PLAN §6 的那九个事件", () => {
    expect([...EVENT_NAMES]).toEqual([
      "message.added",
      "message.delta",
      "message.changed",
      "message.removed",
      "state",
      "error",
      "conversation.changed",
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
      conversationId: "c-1",
      messageId: "m-2",
      seq: 3,
      delta: { content: "你好" },
      at: NOW,
    };
    expect(textDelta.delta.content).toBe("你好");
    expect(textDelta.delta.reasoning_content).toBeUndefined();

    const thinkingDelta: MessageDeltaPayload = {
      ...textDelta,
      seq: 0,
      delta: { reasoning_content: "先看文件" },
    };
    expect(thinkingDelta.delta.reasoning_content).toBe("先看文件");

    // 工具调用的增量也是 core 的形状：id 先到、名字与参数可能后到
    const toolDelta: MessageDeltaPayload = {
      ...textDelta,
      seq: 1,
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
      seq: 2,
      delta: { content: [{ index: 0, type: "image_url", image_url: { url: "https://example.test/a.png" } }] },
    };
    expect(Array.isArray(sectionDelta.delta.content) && sectionDelta.delta.content[0].type).toBe(
      "image_url",
    );
  });

  it("message.delta 的增量能用 core 的 applyChunk 攒成一条消息", () => {
    const receiver: AgentNS.Message = { id: "m-2", role: AgentNS.Role.Assistant };
    const payload: MessageDeltaPayload = {
      conversationId: "c-1",
      messageId: "m-2",
      seq: 0,
      delta: { content: "你好", reasoning_content: "先看文件" },
      at: NOW,
    };

    // 按 core 的 chunk 形状把这一片喂给 applyChunk：字段名对不上就会攒不进去
    const chunk = {
      choices: [{ index: 0, delta: payload.delta, finish_reason: null }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
    applyChunk(receiver, chunk as unknown as Parameters<typeof applyChunk>[1]);

    expect(receiver.content).toBe("你好");
    expect(receiver.reasoning_content).toBe("先看文件");
    expect(receiver.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it("conversation.changed 覆盖结构变化的那几种", () => {
    // 消息的增删改有自己的事件（带整条消息），所以这里没有「消息落库了」/「消息删了」两格，
    // 也不带消息条数 —— 条数客户端自己数。
    const kinds: ConversationChangeKind[] = [
      "created",
      "renamed",
      "pinned",
      "settings_changed",
      "handoff_started",
      "memory_replaced",
      "deleted",
    ];
    for (const change of kinds) {
      const payload: EventPayload<"conversation.changed"> = {
        conversationId: "c-1",
        workspaceId: "w-1",
        change,
        at: NOW,
      };
      expect(payload.change).toBe(change);
    }
  });

  it("state 的载荷就是那一格本身（变了才发，不带别的）", () => {
    const payload: EventPayload<"state"> = { conversationId: "c-1", status: "busy", at: NOW };
    expect(payload.status).toBe("busy");
    // 四格都装得下；死 = 宿主那边连 agent 对象都没有
    for (const status of ["dead", "busy", "idle", "paused"] as const) {
      const changed: EventPayload<"state"> = { ...payload, status };
      expect(changed.status).toBe(status);
    }
  });

  it("notice / question 推的是完整对象", () => {
    const notice: EventPayload<"notice"> = {
      notice: {
        id: "n-1",
        level: "warning",
        duration: null,
        text: localized("question.handoff.prompt"),
        conversationId: "c-1",
        createdAt: NOW,
      },
      at: NOW,
    };
    expect(notice.notice.duration).toBeNull();

    const question: EventPayload<"question"> = {
      question: {
        id: "q-1",
        conversationId: "c-1",
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
