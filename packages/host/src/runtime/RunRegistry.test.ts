/**
 * `RunRegistry` 的用例：一段对话同时只跑一轮、忙即拒、中止是显式动作、结算后能再开一轮。
 */

import { beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../wire/errors.js";
import { RunRegistry } from "./RunRegistry.js";
import { ManualClock } from "./TestSupport.js";

let clock: ManualClock;
let runs: RunRegistry;

beforeEach(() => {
  clock = new ManualClock();
  runs = new RunRegistry({ clock });
});

describe("RunRegistry", () => {
  it("开始一轮之后 isRunning 为真，结算之后为假", () => {
    expect(runs.isRunning("c-1")).toBe(false);

    const handle = runs.start("c-1");
    expect(runs.isRunning("c-1")).toBe(true);
    expect(handle.conversationId).toBe("c-1");
    expect(runs.size()).toBe(1);

    expect(runs.finish("c-1")).toBe(true);
    expect(runs.isRunning("c-1")).toBe(false);
    // 重复结算不是错误，只是没东西可删
    expect(runs.finish("c-1")).toBe(false);
  });

  it("该对话已在跑：抛 busy（PRD D14：直接拒，不排队、不自动打断）", () => {
    const first = runs.start("c-1");

    let error: unknown;
    try {
      runs.start("c-1");
    } catch (caught) {
      error = caught;
    }

    expect(HostError.is(error)).toBe(true);
    const busy = error as HostError;
    expect(busy.code).toBe("busy");
    // 结构化事实里带上「上一次是什么时候开始的」，界面才能说清在忙什么
    expect(busy.detail).toMatchObject({ conversationId: "c-1", startedAt: first.startedAt });
    expect(runs.size()).toBe(1);
  });

  it("不同对话互不影响", () => {
    runs.start("c-1");
    runs.start("c-2");

    expect(runs.isRunning("c-1")).toBe(true);
    expect(runs.isRunning("c-2")).toBe(true);
    expect(runs.size()).toBe(2);
    expect(runs.list().map((run) => run.conversationId).sort()).toEqual(["c-1", "c-2"]);
  });

  it("summary 只问一段：在跑给开始时刻，没在跑给 null（活跃会话列表那一格）", () => {
    expect(runs.summary("c-1")).toBeNull();

    clock.advance(5_000);
    const handle = runs.start("c-1");

    // 与 list() 同一份内容，只是不必把全体扫一遍
    expect(runs.summary("c-1")).toEqual(runs.list()[0]);
    expect(runs.summary("c-1")?.startedAt).toBe(handle.startedAt);
    expect(runs.summary("c-2")).toBeNull();

    // 结算之后这一轮就没了：那一格回到「没在跑」
    runs.finish("c-1");
    expect(runs.summary("c-1")).toBeNull();
  });

  it("歧义：开始时刻用注入的时钟（ISO 8601）", () => {
    const handle = runs.start("c-1");
    expect(handle.startedAt).toBe(new Date(clock.now()).toISOString());
    expect(runs.list()[0]?.startedAt).toBe(handle.startedAt);
  });

  it("中止是显式动作：标记 + 通知已登记的执行者，重复调用只算一次", () => {
    const handle = runs.start("c-1");
    const seen: Array<string | undefined> = [];
    handle.onAbort((reason) => seen.push(reason));

    expect(handle.aborted).toBe(false);
    handle.abort("用户按了停");
    handle.abort("再按一次");
    handle.abort();

    expect(handle.aborted).toBe(true);
    expect(seen).toEqual(["用户按了停"]);
    // 中止不等于结算：这一轮还在跑，直到执行者写库收尾
    expect(runs.isRunning("c-1")).toBe(true);
  });

  it("中止来得比登记早：后登记的监听器也会立刻收到", () => {
    const handle = runs.start("c-1");
    runs.abort("c-1", "手快");

    const seen: Array<string | undefined> = [];
    handle.onAbort((reason) => seen.push(reason));

    expect(seen).toEqual(["手快"]);
  });

  it("按对话中止：没有在跑的一轮时返回 false（不是错误）", () => {
    expect(runs.abort("c-1")).toBe(false);

    runs.start("c-1");
    expect(runs.abort("c-1")).toBe(true);
    expect(runs.list()[0]?.aborted).toBe(true);
  });

  it("取消登记之后不再收到中止", () => {
    const handle = runs.start("c-1");
    const seen: string[] = [];
    const off = handle.onAbort((reason) => seen.push(String(reason)));
    off();
    handle.abort("停");
    expect(seen).toEqual([]);
  });

  it("结算之后可以再开一轮", () => {
    runs.start("c-1");
    runs.finish("c-1");
    const again = runs.start("c-1");

    expect(again.aborted).toBe(false);
    expect(runs.list()).toHaveLength(1);
  });
});
