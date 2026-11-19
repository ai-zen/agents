/**
 * 镜像的验收：四条规矩各钉一遍。
 *
 *   1. `message.added` 插入、`message.delta` 用 core 的 `applyChunk` 增量、`message.changed`
 *      整条替换、`message.removed` 删除；子 Agent 的消息按 `toolCallId` 归栏。
 *   2. 重连补回来的那一份：锚点还在 → 替换 + 追加；锚点不在 → 整段替换。
 *   3. 打开期间攒下的那一批（`replay: true`）：属于快照已包含那些消息的增量不再折一遍。
 *   4. 与镜像无关的事件（`notice` / `question` / `error`）不认领；`session.changed` 认领，
 *      但它只改两处：死活那一格（`agent_started` / `agent_gone`）与交接态（`handoff_started` 置成
 *      「正在交接」、`memory_replaced` 清回 `null`），其余 change 一格不动。
 *   5. 四件事各占一格：忙闲来自 `state`、两道闸来自 `output:*` / `input:*`、死活来自
 *      `session.changed`；还没读到是 `null`（不借「死」或「闲」占位），`applyReadout` 一次补齐。
 *
 * 这里全是纯函数与纯对象：不起 socket、不调契约方法。
 */

import { describe, expect, it } from "vitest";

import type { SessionChangeKind, EventPayload } from "@ai-zen/agents-host";

import { SessionMirror, toMirrorEvent } from "./mirror.js";
import { assistantMessage, userMessage } from "./testSupport/fakeHost.js";

const AT = "2026-01-01T00:00:00.000Z";

function stateEvent(status: EventPayload<"state">["status"]): EventPayload<"state"> {
  return { sessionId: "c1", status, at: AT };
}

function addedEvent(
  message: EventPayload<"message.added">["message"],
  toolCallId?: string,
): EventPayload<"message.added"> {
  return { sessionId: "c1", message, at: AT, ...(toolCallId ? { toolCallId } : {}) };
}

function deltaEvent(
  messageId: string,
  delta: EventPayload<"message.delta">["delta"],
  toolCallId?: string,
): EventPayload<"message.delta"> {
  return { sessionId: "c1", messageId, delta, at: AT, ...(toolCallId ? { toolCallId } : {}) };
}

function changedEvent(
  message: EventPayload<"message.changed">["message"],
  toolCallId?: string,
): EventPayload<"message.changed"> {
  return { sessionId: "c1", message, at: AT, ...(toolCallId ? { toolCallId } : {}) };
}

function removedEvent(messageId: string, toolCallId?: string): EventPayload<"message.removed"> {
  return { sessionId: "c1", messageId, at: AT, ...(toolCallId ? { toolCallId } : {}) };
}

function sessionChangedEvent(
  change: SessionChangeKind,
  at = AT,
): EventPayload<"session.changed"> {
  return { sessionId: "c1", workspaceId: "w1", change, at };
}

function mirrorOf(): SessionMirror {
  // 刚建出来还没读 `session.state`：四件都是 `null`（还没读到），一格都不借来占位
  return new SessionMirror({ sessionId: "c1" });
}

/** 两道闸那四条事件的载荷：只带会话 id（哪一道、开还是关由事件名说） */
function pauseEvent() {
  return { sessionId: "c1", at: AT };
}

/** 分量读数的现读值（`session.state` 拿回来的那一份：四件事 + 名册 + 交接态） */
function readout(overrides: {
  status?: "working" | "idle";
  inputPaused?: boolean;
  outputPaused?: boolean;
  alive?: boolean;
  subAgents?: Array<{ toolCallId: string; name: string; state: "working" | "idle" | "ended" }>;
  handoff?: { since: string } | null;
} = {}) {
  return {
    status: "idle" as const,
    inputPaused: false,
    outputPaused: false,
    alive: true,
    subAgents: [],
    handoff: null,
    ...overrides,
  };
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

  it("还没读到四件事时每一格都是 null（既不借「死」也不借「闲」占位）", () => {
    const mirror = mirrorOf();
    // 打开对话的那一刻：事件还没到、`session.state` 也还没读
    expect(mirror.snapshot()).toMatchObject({
      status: null,
      inputPaused: null,
      outputPaused: null,
      alive: null,
    });

    // 读到现读值之后四件一次补齐，之后各自被自己的事件换下去
    mirror.applyReadout(readout({ status: "working", outputPaused: true, alive: true }));
    expect(mirror.snapshot()).toMatchObject({
      status: "working",
      inputPaused: false,
      outputPaused: true,
      alive: true,
    });
  });

  it("`state` 只换忙闲那一格：两个值，不碰两道闸与死活", () => {
    const mirror = mirrorOf();
    mirror.applyReadout(readout({ alive: true }));

    mirror.apply({ kind: "state", payload: stateEvent("working") });
    expect(mirror.snapshot()).toMatchObject({
      status: "working",
      inputPaused: false,
      outputPaused: false,
      alive: true,
    });

    mirror.apply({ kind: "state", payload: stateEvent("idle") });
    expect(mirror.snapshot()).toMatchObject({ status: "idle", alive: true });
  });

  it("两道闸各换自己的那一格（关着 = `true`），忙闲与死活一格不动", () => {
    const mirror = mirrorOf();
    mirror.applyReadout(readout({ status: "idle" }));

    mirror.apply({ kind: "output:paused", payload: pauseEvent() });
    expect(mirror.snapshot()).toMatchObject({ outputPaused: true, inputPaused: false });

    mirror.apply({ kind: "input:paused", payload: pauseEvent() });
    expect(mirror.snapshot()).toMatchObject({ outputPaused: true, inputPaused: true });

    mirror.apply({ kind: "output:resumed", payload: pauseEvent() });
    expect(mirror.snapshot()).toMatchObject({
      outputPaused: false,
      inputPaused: true,
      status: "idle",
      alive: true,
    });

    mirror.apply({ kind: "input:resumed", payload: pauseEvent() });
    expect(mirror.snapshot()).toMatchObject({ outputPaused: false, inputPaused: false });
  });

  it("死活那一格由 `agent_started` / `agent_gone` 换（不经过 `state`）", () => {
    const mirror = mirrorOf();
    mirror.apply({
      kind: "session.changed",
      payload: sessionChangedEvent("agent_started"),
    });
    expect(mirror.alive).toBe(true);

    mirror.apply({
      kind: "session.changed",
      payload: sessionChangedEvent("agent_gone"),
    });
    expect(mirror.alive).toBe(false);
    // 死了也照旧有自己的忙闲（「手上没活」与「没有 agent」是两件事）
    expect(mirror.status).not.toBe(undefined);
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
    mirror.applyReadout(
      readout({
        status: "working",
        subAgents: [{ toolCallId: "call-1", name: "explore", state: "working" }],
        handoff: { since: AT },
      }),
    );

    expect(mirror.status).toBe("working");
    expect(mirror.roster).toEqual([{ toolCallId: "call-1", name: "explore", state: "working" }]);
    // 名册上有的栏先摆出来（还是空的），之后的事件往里面长
    expect(mirror.subAgent("call-1")).toEqual([]);
    expect(mirror.handoff).toEqual({ since: AT });

    mirror.apply({ kind: "message.added", payload: addedEvent(assistantMessage("s1", "子"), "call-1") });
    expect(mirror.subAgent("call-1").map((message) => message.id)).toEqual(["s1"]);

    // 下一批开始了：名册空了，但说过的话还在那一栏里
    mirror.applyReadout(readout({ status: "idle" }));
    expect(mirror.roster).toEqual([]);
    expect(mirror.handoff).toBeNull();
    expect(mirror.subAgent("call-1").map((message) => message.id)).toEqual(["s1"]);
  });
});

describe("交接态：`session.changed` 那一格", () => {
  it("`handoff_started` → 「正在交接」，不用重拉 `session.state` 也能学到", () => {
    const mirror = mirrorOf();
    // 刚打开时不在交接（这一格来自 `applyReadout`，或就是 `null`）
    expect(mirror.handoff).toBeNull();

    mirror.apply({
      kind: "session.changed",
      payload: sessionChangedEvent("handoff_started", "2026-01-01T00:00:07.000Z"),
    });

    // 形状与 `applyReadout` 收到的那一格一致：开始时刻就是这条事件的 `at`
    expect(mirror.handoff).toEqual({ since: "2026-01-01T00:00:07.000Z" });
    expect(mirror.snapshot().handoff).toEqual({ since: "2026-01-01T00:00:07.000Z" });
  });

  it("随后 `memory_replaced` → 交接收口，`handoff` 回到 `null`", () => {
    const mirror = mirrorOf();
    mirror.apply({
      kind: "session.changed",
      payload: sessionChangedEvent("handoff_started"),
    });
    expect(mirror.handoff).not.toBeNull();

    mirror.apply({
      kind: "session.changed",
      payload: sessionChangedEvent("memory_replaced"),
    });
    expect(mirror.handoff).toBeNull();
    expect(mirror.snapshot().handoff).toBeNull();
  });

  it("其余 change 一格都不动（既不清，也不置起来）", () => {
    const others: SessionChangeKind[] = [
      "created",
      "renamed",
      "pinned",
      "settings_changed",
      "deleted",
    ];

    // 不在交接时：它们也不会把它变成「正在交接」
    const idle = mirrorOf();
    for (const change of others) {
      idle.apply({ kind: "session.changed", payload: sessionChangedEvent(change) });
      expect(idle.handoff).toBeNull();
    }

    // 正在交接时：它们不会把它收掉（收口只认 `memory_replaced`）
    const busy = mirrorOf();
    busy.apply({
      kind: "session.changed",
      payload: sessionChangedEvent("handoff_started", "2026-01-01T00:00:07.000Z"),
    });
    for (const change of others) {
      busy.apply({ kind: "session.changed", payload: sessionChangedEvent(change) });
      expect(busy.handoff).toEqual({ since: "2026-01-01T00:00:07.000Z" });
    }
  });

  it("`session.changed` 只改它该改的那一格：消息与其余几格一个字不动", () => {
    const mirror = mirrorOf();
    mirror.applyReadout(readout({ status: "working", outputPaused: true }));
    mirror.apply({ kind: "message.added", payload: addedEvent(userMessage("m1", "问")) });

    mirror.apply({
      kind: "session.changed",
      payload: sessionChangedEvent("handoff_started"),
    });

    expect(mirror.snapshot()).toMatchObject({
      status: "working",
      outputPaused: true,
      alive: true,
      handoff: { since: AT },
    });
    expect(mirror.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(mirror.roster).toEqual([]);
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
  it("与镜像有关的事件各自折出来", () => {
    expect(toMirrorEvent("message.added", addedEvent(userMessage("m1", "问")))?.kind).toBe("message.added");
    expect(toMirrorEvent("message.delta", deltaEvent("m1", { content: "x" }))?.kind).toBe("message.delta");
    expect(toMirrorEvent("message.changed", changedEvent(userMessage("m1", "问")))?.kind).toBe("message.changed");
    expect(toMirrorEvent("message.removed", removedEvent("m1"))?.kind).toBe("message.removed");
    expect(toMirrorEvent("state", stateEvent("working"))?.kind).toBe("state");
    // `session.changed` 认领（死活与交接态都用它）；里面是哪一格由 `apply` 那一步判
    expect(
      toMirrorEvent("session.changed", sessionChangedEvent("handoff_started"))?.kind,
    ).toBe("session.changed");
  });

  it("两道闸的四条事件各自折成同名的那一格（名字自己说清哪一道、开还是关）", () => {
    expect(toMirrorEvent("output:paused", pauseEvent())?.kind).toBe("output:paused");
    expect(toMirrorEvent("output:resumed", pauseEvent())?.kind).toBe("output:resumed");
    expect(toMirrorEvent("input:paused", pauseEvent())?.kind).toBe("input:paused");
    expect(toMirrorEvent("input:resumed", pauseEvent())?.kind).toBe("input:resumed");
  });

  it("另外三个事件不认领（它们说的不是消息，也不是那四件事）", () => {
    for (const event of ["notice", "question", "error", "some.future.event"]) {
      expect(toMirrorEvent(event, { sessionId: "c1" })).toBeNull();
    }
  });
});
