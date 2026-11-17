/**
 * 镜像的验收：四条规矩各钉一遍。
 *
 *   1. `message.added` 插入、`message.delta` 用 core 的 `applyChunk` 增量、`message.changed`
 *      整条替换、`message.removed` 删除；子 Agent 的消息按 `toolCallId` 归栏。
 *   2. 重连补回来的那一份：锚点还在 → 替换 + 追加；锚点不在 → 整段替换。
 *   3. 打开期间攒下的那一批（`replay: true`）：属于快照已包含那些消息的增量不再折一遍。
 *   4. 与镜像无关的事件（`notice` / `question` / `error` / `conversation.changed`）不认领。
 *   5. `status`：还没读到是 `null`（不借「死」那一格占位），`applyReadout` 之后才有一格。
 *
 * 这里全是纯函数与纯对象：不起 socket、不调契约方法。
 */

import { describe, expect, it } from "vitest";

import type { EventPayload } from "@ai-zen/agents-host";

import { ConversationMirror, toMirrorEvent } from "./mirror.js";
import { assistantMessage, userMessage } from "./testSupport/fakeHost.js";

const AT = "2026-01-01T00:00:00.000Z";

function stateEvent(status: EventPayload<"state">["status"]): EventPayload<"state"> {
  return { conversationId: "c1", status, at: AT };
}

function addedEvent(
  message: EventPayload<"message.added">["message"],
  toolCallId?: string,
): EventPayload<"message.added"> {
  return { conversationId: "c1", message, at: AT, ...(toolCallId ? { toolCallId } : {}) };
}

function deltaEvent(
  messageId: string,
  delta: EventPayload<"message.delta">["delta"],
  toolCallId?: string,
): EventPayload<"message.delta"> {
  return { conversationId: "c1", messageId, delta, at: AT, ...(toolCallId ? { toolCallId } : {}) };
}

function changedEvent(
  message: EventPayload<"message.changed">["message"],
  toolCallId?: string,
): EventPayload<"message.changed"> {
  return { conversationId: "c1", message, at: AT, ...(toolCallId ? { toolCallId } : {}) };
}

function removedEvent(messageId: string, toolCallId?: string): EventPayload<"message.removed"> {
  return { conversationId: "c1", messageId, at: AT, ...(toolCallId ? { toolCallId } : {}) };
}

function mirrorOf(): ConversationMirror {
  // 刚建出来还没读 `conversation.state`：那一格是 `null`（还没读到），不是四格里的任何一格
  return new ConversationMirror({ conversationId: "c1", status: null });
}

describe("四条到达事件", () => {
  it("added 插入、delta 增量、changed 整条替换、removed 删除", () => {
    const mirror = mirrorOf();

    mirror.apply({ kind: "message.added", payload: addedEvent(userMessage("m1", "问")) });
    mirror.apply({ kind: "message.added", payload: addedEvent(assistantMessage("m2", "答")) });
    expect(mirror.messages.map((message) => message.id)).toEqual(["m1", "m2"]);

    // 增量与宿主攒消息用的是同一个函数（core 的 applyChunk）：正文往后接
    mirror.apply({ kind: "message.delta", payload: deltaEvent("m2", { content: "到一半" }) });
    expect(mirror.messages[1]?.content).toBe("答到一半");

    // 整条替换，不做字段级合并
    const settled = { ...assistantMessage("m2", "答完了"), status: undefined };
    mirror.apply({ kind: "message.changed", payload: changedEvent(settled) });
    expect(mirror.messages[1]?.content).toBe("答完了");

    mirror.apply({ kind: "message.removed", payload: removedEvent("m1") });
    expect(mirror.messages.map((message) => message.id)).toEqual(["m2"]);
  });

  it("认不出那条消息的增量直接丢掉（它属于镜像之前的那一段）", () => {
    const mirror = mirrorOf();
    mirror.apply({ kind: "message.delta", payload: deltaEvent("没有这条", { content: "x" }) });
    expect(mirror.messages).toEqual([]);
  });

  it("子 Agent 的消息按 toolCallId 归栏，不进主线", () => {
    const mirror = mirrorOf();
    mirror.apply({ kind: "message.added", payload: addedEvent(userMessage("m1", "问")) });
    mirror.apply({ kind: "message.added", payload: addedEvent(assistantMessage("s1", "子"), "call-1") });
    mirror.apply({ kind: "message.delta", payload: deltaEvent("s1", { content: "agent" }, "call-1") });

    expect(mirror.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(mirror.subAgent("call-1").map((message) => message.content)).toEqual(["子agent"]);
    // 没那一栏就是空数组
    expect(mirror.subAgent("没有这一栏")).toEqual([]);
  });

  it("还没读到四格时 status 就是 null（不借「死」占位）", () => {
    const mirror = mirrorOf();
    // 打开对话的那一刻：事件还没到、`conversation.state` 也还没读
    expect(mirror.status).toBeNull();
    expect(mirror.snapshot().status).toBeNull();

    // 读到现读值之后才有一格，之后照旧由 `state` 事件换下去
    mirror.applyReadout({ status: "dead", subAgents: [], handoff: null });
    expect(mirror.status).toBe("dead");
    expect(mirror.snapshot().status).toBe("dead");
  });

  it("构造函数给的 status 可以是四格里的某一格（重连时手里已经有读数）", () => {
    const mirror = new ConversationMirror({ conversationId: "c1", status: "paused" });
    expect(mirror.status).toBe("paused");
  });

  it("state 事件换掉那一格", () => {
    const mirror = mirrorOf();
    mirror.apply({ kind: "state", payload: stateEvent("busy") });
    expect(mirror.status).toBe("busy");
    mirror.apply({ kind: "state", payload: stateEvent("paused") });
    expect(mirror.status).toBe("paused");
  });

  it("lastMessageId 是主线最后一条（子 Agent 那几栏不参与）", () => {
    const mirror = mirrorOf();
    expect(mirror.lastMessageId()).toBeUndefined();
    mirror.apply({ kind: "message.added", payload: addedEvent(userMessage("m1", "问")) });
    mirror.apply({ kind: "message.added", payload: addedEvent(assistantMessage("s1", "子"), "call-1") });
    expect(mirror.lastMessageId()).toBe("m1");
  });

  it("applyReadout 收下名册与交接态，名册只加栏不删栏", () => {
    const mirror = mirrorOf();
    mirror.applyReadout({
      status: "busy",
      subAgents: [{ toolCallId: "call-1", name: "explore", state: "working" }],
      handoff: { since: AT },
    });

    expect(mirror.status).toBe("busy");
    expect(mirror.roster).toEqual([{ toolCallId: "call-1", name: "explore", state: "working" }]);
    // 名册上有的栏先摆出来（还是空的），之后的事件往里面长
    expect(mirror.subAgent("call-1")).toEqual([]);
    expect(mirror.handoff).toEqual({ since: AT });

    mirror.apply({ kind: "message.added", payload: addedEvent(assistantMessage("s1", "子"), "call-1") });
    expect(mirror.subAgent("call-1").map((message) => message.id)).toEqual(["s1"]);

    // 下一批开始了：名册空了，但说过的话还在那一栏里
    mirror.applyReadout({ status: "idle", subAgents: [], handoff: null });
    expect(mirror.roster).toEqual([]);
    expect(mirror.handoff).toBeNull();
    expect(mirror.subAgent("call-1").map((message) => message.id)).toEqual(["s1"]);
  });
});

describe("快照的两种接法", () => {
  it("replaceAll：整段替换主线，子 Agent 那几栏留着", () => {
    const mirror = mirrorOf();
    mirror.apply({ kind: "message.added", payload: addedEvent(userMessage("old", "旧的")) });
    mirror.apply({ kind: "message.added", payload: addedEvent(assistantMessage("s1", "子"), "call-1") });

    mirror.replaceAll([userMessage("x1", "现在的")]);
    expect(mirror.messages.map((message) => message.id)).toEqual(["x1"]);
    expect(mirror.subAgent("call-1")).toHaveLength(1);
  });

  it("mergeFrom：锚点还在 → 本地之前的部分留着，从锚点起整段换成宿主的", () => {
    const mirror = mirrorOf();
    mirror.replaceAll([
      userMessage("m1", "问"),
      assistantMessage("m2", "答到一半"),
      userMessage("m3", "被撤回的那条"),
    ]);

    mirror.mergeFrom("m2", [assistantMessage("m2", "答完了"), userMessage("m4", "接着问")]);
    // 锚点那条是**替换**（内容换成最新的），不是又追加一条
    expect(mirror.messages.map((message) => message.content)).toEqual(["问", "答完了", "接着问"]);
  });

  it("mergeFrom：锚点不在（被撤回 / 换过库）→ 按全量整段替换", () => {
    const mirror = mirrorOf();
    mirror.replaceAll([userMessage("gone", "撤回过")]);
    mirror.mergeFrom(null, [userMessage("x1", "现在的")]);
    expect(mirror.messages.map((message) => message.id)).toEqual(["x1"]);

    // 回执说命中了、但本地根本没有那条：同样以宿主为准
    const other = mirrorOf();
    other.replaceAll([userMessage("gone", "撤回过")]);
    other.mergeFrom("其它那条", [userMessage("x2", "现在的")]);
    expect(other.messages.map((message) => message.id)).toEqual(["x2"]);
  });

  it("本地一条都没有时 mergeFrom 就是一次全量", () => {
    const mirror = mirrorOf();
    mirror.mergeFrom(null, [userMessage("m1", "问"), assistantMessage("m2", "答")]);
    expect(mirror.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  });
});

describe("打开期间攒下的那一批（replay）", () => {
  it("快照里已有的那条不再折一遍增量（同一段字不写两遍）", () => {
    const mirror = mirrorOf();
    // 快照里的 m1 已经是「答到一半」的最新样子
    mirror.replaceAll([userMessage("m0", "问"), assistantMessage("m1", "答到一半")]);

    // 拉取期间到过的那一片（快照已经含了它的效果）在补的时候被跳过
    mirror.apply({ kind: "message.delta", payload: deltaEvent("m1", { content: "到一半" }) }, { replay: true });
    expect(mirror.messages[1]?.content).toBe("答到一半");

    // 补完之后到达的增量照常折
    mirror.endReplay();
    mirror.apply({ kind: "message.delta", payload: deltaEvent("m1", { content: "，还差一点" }) });
    expect(mirror.messages[1]?.content).toBe("答到一半，还差一点");
  });

  it("补的那一批里新出现的消息照常插入", () => {
    const mirror = mirrorOf();
    mirror.replaceAll([userMessage("m0", "问")]);
    mirror.apply({ kind: "message.added", payload: addedEvent(assistantMessage("m1", "答")) }, { replay: true });
    expect(mirror.messages.map((message) => message.id)).toEqual(["m0", "m1"]);
  });

  it("补的那一批里重复的一条 added 以快照为准", () => {
    const mirror = mirrorOf();
    mirror.replaceAll([userMessage("m1", "快照里的样子")]);
    mirror.apply({ kind: "message.added", payload: addedEvent(userMessage("m1", "旧的样子")) }, { replay: true });
    expect(mirror.messages[0]?.content).toBe("快照里的样子");
  });
});

describe("toMirrorEvent", () => {
  it("五个与镜像有关的事件各自折出来", () => {
    expect(toMirrorEvent("message.added", addedEvent(userMessage("m1", "问")))?.kind).toBe("message.added");
    expect(toMirrorEvent("message.delta", deltaEvent("m1", { content: "x" }))?.kind).toBe("message.delta");
    expect(toMirrorEvent("message.changed", changedEvent(userMessage("m1", "问")))?.kind).toBe("message.changed");
    expect(toMirrorEvent("message.removed", removedEvent("m1"))?.kind).toBe("message.removed");
    expect(toMirrorEvent("state", stateEvent("busy"))?.kind).toBe("state");
  });

  it("另外四个事件不认领（它们说的不是消息，也不是四格）", () => {
    for (const event of ["notice", "question", "error", "conversation.changed", "some.future.event"]) {
      expect(toMirrorEvent(event, { conversationId: "c1" })).toBeNull();
    }
  });
});
