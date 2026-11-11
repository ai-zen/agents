/**
 * `QuestionBroker` 的用例：服务端提问、客户端回答，以及**题目是槽位**这件事。
 *
 * 这一组的中心是那四条约束（先登记再发 / 没人看也登记 / 有时限 / 三个出口都清表）：
 * 少任何一条，症状都是「这一轮永远收不了尾」，或者「后连上来的客户端看不见那道题」。
 *
 * 共用脚手架见 `SessionTestSupport.ts`。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "./SessionManager.js";
import type { HandoffMode, ServerEvent } from "../../protocol/index.js";
import { EventHub } from "../../lib/events.js";
import {
  pick,
  MemoryStore,
  RecordingHub,
  agent,
  manager,
  events,
  counter,
  resetEvents,
  settled,
  useSessionKit,
} from "./SessionTestSupport.js";

useSessionKit();

describe("SessionManager：自动迁移用哪种方式交接，由客户端回答（session-question）", () => {
  /** 装配方收到的两个钩子 —— 就是「SDK 插件 → 会话层」那条路的两端 */
  interface Hooks {
    autoMigrate?: (mode?: HandoffMode) => Promise<void>;
    resolveMode?: (info: {
      promptTokens: number;
      handoffTokens: number;
    }) => Promise<HandoffMode | null>;
  }

  let store: MemoryStore;
  let workspace: string;
  let hub: RecordingHub;
  let hooks: Hooks;
  let auto: SessionManager;
  /** 用例里另外造的管理器：统一在 afterEach 收掉 */
  let extras: SessionManager[];
  let counter = 0;

  /**
   * 造一个把两个钩子收起来的会话层。
   *
   * `hub` 决定「有没有客户端在看」，`askTimeoutMs` 是超时（用例不能等 5 分钟）。
   */
  function assemble(options: { hub?: EventHub; askTimeoutMs?: number } = {}) {
    const captured: Hooks = {};
    const manager = new SessionManager({
      createAgent: async (input) => {
        captured.autoMigrate = input.autoMigrate;
        captured.resolveMode = input.resolveMode;
        return agent;
      },
      nextSessionId: () => `chat_${++counter}`,
      storeFor: () => store,
      handoff: { aiZenDir: join(workspace, "ai-zen"), homeDir: workspace },
      ...options,
    });
    return { manager, hooks: captured };
  }

  /**
   * 走一遍 SDK 插件 `onAfterSend` 的那两步：先问「用哪种方式交接」，用户选不交接
   * （`null`）就直接返回，否则才让会话层动手迁移。
   *
   * 为什么直接调这两个钩子而不是装上真的 `AutoMigratePlugin`：这里测的是会话层
   * 「怎么问、怎么等、怎么认领」，插件本身的触发时机不在本用例的范围内（那边由
   * `SessionAgentFactory.test.ts` 用真插件测）。
   */
  async function triggerAutoMigrate(
    target: Hooks,
    info = { promptTokens: 999, handoffTokens: 500 },
  ): Promise<void> {
    const mode = await target.resolveMode!(info);
    if (mode === null) return;
    await target.autoMigrate!(mode);
  }

  beforeEach(async () => {
    store = new MemoryStore();
    workspace = await fs.mkdtemp(join(tmpdir(), "aiz-ask-mode-"));
    counter = 0;
    extras = [];
    hub = new RecordingHub();
    const assembled = assemble({ hub });
    auto = assembled.manager;
    hooks = assembled.hooks;
    // 模拟「有客户端在看」：订阅了才谈得上向客户端提问
    resetEvents();
    auto.subscribe((event) => events.push(event));
  });

  afterEach(async () => {
    for (const manager of extras) manager.dispose();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("有客户端在看：触发时先问「用哪种方式交接」，带上触发上下文（两个 token 数）", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(hooks);

    const questions = pick("session-question");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      event: "session-question",
      sessionId,
      kind: "handoff-mode",
      // 能怎么答：两个选项 + 允许「不交接」
      input: "select",
      options: ["self", "summary"],
      allowSkip: true,
      // 兜底是「什么都不做」：没人答就跳过这次迁移（不是替用户选 self）
      fallback: null,
      // 选择器的标题要显示「已用 X / 上限 Y」：这两个数只有服务端手里有
      params: { promptTokens: 999, handoffTokens: 500 },
    });
    expect(questions[0].questionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);

    // 不回答的话这一轮就悬着（并占用迁移的并发闸门）：用例自己把它收掉
    expect(auto.answer(questions[0].questionId, "self")).toEqual({ answered: true });
    await pending;
  });

  it("回答 summary：交接那条路径收到的就是 summary，同一个问题不能再答一次", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(hooks);
    const question = pick("session-question")[0];

    expect(auto.answer(question.questionId, "summary")).toEqual({ answered: true });
    // 同一个 questionId 再答一次：来晚了 —— 不抛错、也不用重试（服务端已经继续跑了）
    expect(auto.answer(question.questionId, "self")).toEqual({ answered: false });
    await pending;

    // 交接服务收到的「请求执行者」就是用户选的那个：请求 self 时会降级到 summary 并多一条
    // `migrationDegraded`，这里没有 —— 说明请求的本来就是 summary，不是默认值碰巧一样
    const notices = pick("session-notice");
    expect(
      notices.filter((notice) => notice.code === "handoffWriting").map((notice) => notice.params),
    ).toEqual([{ mode: "summary" }]);
    expect(notices.some((notice) => notice.code === "migrationDegraded")).toBe(false);
    // 迁移真的发生了（换 id 走事件）
    expect(pick("session-id-changed")).toHaveLength(1);
  });

  it("回答 null（用户选「不交接」）：跳过本次迁移 —— 会话 id 不变，也没有 idChanged", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(hooks);
    const question = pick("session-question")[0];
    expect(auto.answer(question.questionId, null)).toEqual({ answered: true });
    await pending;

    expect(pick("session-id-changed")).toEqual([]);
    expect((await auto.list("ws-1")).map((item) => item.sessionId)).toEqual([sessionId]);
    // 什么都没发生：连旧会话都没进存档（那是迁移的第一步）
    expect(store.records.size).toBe(0);
  });

  it("没有客户端在看：题目照样登记在槽位上（不是一次性广播），后来接上的客户端看得见、答得了", async () => {
    // 独立的一套：hub 上一个订阅者都没有 —— 客户端已退出，而会话仍在服务端活着
    const silentHub = new RecordingHub();
    const silent = assemble({ hub: silentHub, askTimeoutMs: 30_000 });
    extras.push(silent.manager);
    const { sessionId } = await silent.manager.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(silent.hooks);
    await settled(); // 让它跑到「等答案」那一步（没人在看也不会自己走完）
    expect(silentHub.watcherCount()).toBe(0);

    // 快照是它的**第二个出口**：题目在槽位上，带着答它所需的一切
    const snapshot = await silent.manager.snapshot(sessionId);
    expect(snapshot.pendingQuestions).toHaveLength(1);
    const question = snapshot.pendingQuestions[0]!;
    expect(question).toMatchObject({
      event: "session-question",
      sessionId,
      kind: "handoff-mode",
      input: "select",
      options: ["self", "summary"],
      allowSkip: true,
      fallback: null,
      params: { promptTokens: 999, handoffTokens: 500 },
    });

    // 后来接上的客户端答它：认领成功，且这一轮按**用户的决定**继续（不是按兜底跳过）
    expect(silent.manager.answer(question.questionId, "summary")).toEqual({ answered: true });
    await pending;

    const notices = silentHub.published.filter(
      (event): event is Extract<ServerEvent, { event: "session-notice" }> =>
        event.event === "session-notice",
    );
    expect(notices.some((notice) => notice.code === "handoffWriting")).toBe(true);
    expect(notices.some((notice) => notice.code === "migrationSkipped")).toBe(false);
    expect(
      silentHub.published.filter((event) => event.event === "session-id-changed"),
    ).toHaveLength(1);
  });

  it("确认即消：答掉的那道题从槽位上消失，第二个客户端既看不到也答不了", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(hooks);
    await settled();
    const question = (await auto.snapshot(sessionId)).pendingQuestions[0]!;
    expect(question).toBeDefined();

    expect(auto.answer(question.questionId, null)).toEqual({ answered: true });

    // 一份状态：任意客户端确认即消 —— 不是「每个客户端各存一份已读」
    expect((await auto.snapshot(sessionId)).pendingQuestions).toEqual([]);
    expect(auto.answer(question.questionId, "self")).toEqual({ answered: false });
    await pending;
  });

  it("没人回答（超时）：按兜底跳过迁移，并把挂着的提问清掉", async () => {
    // 超时注入成 10ms：等 5 分钟才能验证的用例只能靠 sleep(300000)，那是把「超时」测成「时钟」
    const fastHub = new RecordingHub();
    fastHub.subscribe((event) => events.push(event));
    const fast = assemble({ hub: fastHub, askTimeoutMs: 10 });
    extras.push(fast.manager);
    await fast.manager.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(fast.hooks);
    const question = pick("session-question")[0];

    await pending; // 不回答：等它自己按超时收场

    const notices = pick("session-notice");
    // 超时与「没人在看」同一个落点：兜底 = 什么都不做
    expect(notices.some((notice) => notice.code === "handoffWriting")).toBe(false);
    expect(notices.some((notice) => notice.code === "migrationSkipped")).toBe(true);
    expect(pick("session-id-changed")).toHaveLength(0);
    // 表已清：这个问题现在谁也答不了（迟到的回答只能是「来晚了」）
    const remaining = (await fast.manager.list("ws-1"))[0]!.sessionId;
    expect(fast.manager.answer(question.questionId, "summary")).toEqual({
      answered: false,
    });
    // 快照里也没了：超时之后那道题不能再被谁看到、更不能再被回答
    expect((await fast.manager.snapshot(remaining)).pendingQuestions).toEqual([]);
  });

  it("跨会话不撞号：两段会话各问一问，两个 questionId 不同，answer 按 id 定位到对的那一段", async () => {
    const localHub = new RecordingHub();
    const hooksList: Hooks[] = [];
    let seq = 0;
    const local = new SessionManager({
      hub: localHub,
      createAgent: async (input) => {
        hooksList.push({ autoMigrate: input.autoMigrate, resolveMode: input.resolveMode });
        return agent;
      },
      nextSessionId: () => `chat_cross_${++seq}`,
      storeFor: () => store,
      handoff: { aiZenDir: join(workspace, "ai-zen"), homeDir: workspace },
      askTimeoutMs: 30_000,
    });
    extras.push(local);
    const first = await local.create({ workspaceId: "ws-1", path: workspace });
    const second = await local.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    // 两段会话各问一次（都在「没人答」的状态下挂着）
    const pendingA = triggerAutoMigrate(hooksList[0]!);
    const pendingB = triggerAutoMigrate(hooksList[1]!);
    await settled();

    const questionA = (await local.snapshot(first.sessionId)).pendingQuestions[0]!;
    const questionB = (await local.snapshot(second.sessionId)).pendingQuestions[0]!;
    expect(questionA.questionId).not.toBe(questionB.questionId);
    expect(questionA.sessionId).toBe(first.sessionId);
    expect(questionB.sessionId).toBe(second.sessionId);

    // 只答第一段：只有它那张表被清，第二段的题目原封不动（这就是「按 id 定位」的意思）
    expect(local.answer(questionA.questionId, null)).toEqual({ answered: true });
    expect((await local.snapshot(first.sessionId)).pendingQuestions).toEqual([]);
    expect(
      (await local.snapshot(second.sessionId)).pendingQuestions.map((q) => q.questionId),
    ).toEqual([questionB.questionId]);

    expect(local.answer(questionB.questionId, null)).toEqual({ answered: true });
    await Promise.all([pendingA, pendingB]);
  });

  it("answer 一个不认识的 questionId：answered:false（来晚了，不是拿错了会话）", () => {
    // 不再有 `unknown-session` 那条分支：只认 questionId，而「这个 id 不在任何表里」
    // 对客户端就是「不用重试」 —— 与超时 / 已答过 / 会话已收是同一件事。
    expect(auto.answer("q-404", "self")).toEqual({ answered: false });
  });
});
