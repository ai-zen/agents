import { describe, expect, it } from "vitest";

import {
  EVENT_NAMES,
  isEventName,
  type ConversationChangeKind,
  type EventName,
  type EventPayload,
  type MessageDeltaPayload,
} from "./events.js";
import { zeroUsage } from "./states.js";

const NOW = "2026-01-01T00:00:00.000Z";

const localized = (key: "status.idle" | "label.cwd") =>
  ({ code: key, messageKey: key, params: {}, message: key }) as const;

describe("事件表", () => {
  it("就是 architecture §7 的那六个事件", () => {
    expect([...EVENT_NAMES]).toEqual([
      "run.state",
      "message.delta",
      "conversation.changed",
      "notice",
      "question",
      "usage",
    ]);
  });

  it("EVENT_NAMES 覆盖 EventMap 的每一个事件（漏写会在编译期露馅）", () => {
    type Missing = Exclude<EventName, (typeof EVENT_NAMES)[number]>;
    const noMissing: Missing extends never ? true : false = true;
    expect(noMissing).toBe(true);
  });

  it("isEventName 只认表里的事件", () => {
    expect(isEventName("run.state")).toBe(true);
    expect(isEventName("notice")).toBe(true);
    expect(isEventName("run.phase")).toBe(false);
    expect(isEventName(null)).toBe(false);
  });

  it("run.state 带完整运行状态（六态、结局、子 Agent、用量）", () => {
    const payload: EventPayload<"run.state"> = {
      conversationId: "c-1",
      at: NOW,
      run: {
        conversationId: "c-1",
        status: "running",
        assistantMessageId: "m-2",
        startedAt: NOW,
        settledAt: null,
        generation: { phase: "awaiting_tools", since: NOW, runningTools: [] },
        outcome: null,
        problem: null,
        subagents: [],
        usage: zeroUsage(NOW),
      },
    };
    expect(payload.run.generation?.phase).toBe("awaiting_tools");
    expect(payload.run.status).toBe("running");
  });

  it("message.delta 的增量能按段类型收窄", () => {
    const payload: MessageDeltaPayload = {
      conversationId: "c-1",
      messageId: "m-2",
      seq: 3,
      segment: "text",
      delta: { kind: "text", delta: "你好" },
      messageStatus: "streaming",
      at: NOW,
    };
    if (payload.delta.kind === "text") {
      expect(payload.delta.delta).toBe("你好");
    }
    expect(payload.segment).toBe("text");

    const toolDelta: MessageDeltaPayload = {
      ...payload,
      segment: "tool_call",
      delta: { kind: "tool_call", toolCallId: "t-1", name: "read", argumentsDelta: '{"pa', status: "assembling" },
    };
    expect(toolDelta.delta.kind === "tool_call" && toolDelta.delta.status).toBe("assembling");
  });

  it("conversation.changed 覆盖结构变化的那几种", () => {
    const kinds: ConversationChangeKind[] = [
      "created",
      "renamed",
      "pinned",
      "messages_persisted",
      "message_removed",
      "settings_changed",
      "deleted",
    ];
    for (const change of kinds) {
      const payload: EventPayload<"conversation.changed"> = {
        conversationId: "c-1",
        workspaceId: "w-1",
        change,
        messageCount: change === "deleted" ? null : 3,
        at: NOW,
      };
      expect(payload.change).toBe(change);
    }
  });

  it("notice / question 推的是完整对象；usage 推三个数字", () => {
    const notice: EventPayload<"notice"> = {
      notice: {
        id: "n-1",
        level: "warning",
        duration: null,
        text: localized("label.cwd"),
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
        prompt: localized("status.idle"),
        options: [{ value: "self", label: localized("status.idle"), detail: null }],
        answer: null,
        blocking: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      at: NOW,
    };
    expect(question.question.options[0].value).toBe("self");

    const usage: EventPayload<"usage"> = { conversationId: "c-1", usage: zeroUsage(NOW), at: NOW };
    expect(usage.usage.turn.total).toBe(0);
  });
});
