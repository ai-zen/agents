/**
 * `QuestionBroker` 的用例：服务端提问、客户端回答、以及「没人在看就不问」。
 *
 * 这一组的中心是那四条约束（没人在看就不问 / 先登记再发 / 有时限 / 三个出口都清表）：
 * 少任何一条，症状都是「这一轮永远收不了尾」，而它在一轮对话里只表现成「界面卡住」。
 *
 * 共用脚手架见 `SessionTestSupport.ts`。
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "./SessionManager.js";
import type { HandoffMode, ServerEvent } from "@ai-zen/agents-protocol";
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
    expect(questions[0].questionId).toMatch(/^q-\d+$/);

    // 不回答的话这一轮就悬着（并占用迁移的并发闸门）：用例自己把它收掉
    expect(auto.answer(sessionId, questions[0].questionId, "self")).toEqual({ answered: true });
    await pending;
  });

  it("回答 summary：交接那条路径收到的就是 summary，同一个问题不能再答一次", async () => {
    const { sessionId } = await auto.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    const pending = triggerAutoMigrate(hooks);
    const question = pick("session-question")[0];

    expect(auto.answer(sessionId, question.questionId, "summary")).toEqual({ answered: true });
    // 同一个 questionId 再答一次：来晚了 —— 不抛错、也不用重试（服务端已经继续跑了）
    expect(auto.answer(sessionId, question.questionId, "self")).toEqual({ answered: false });
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
    expect(auto.answer(sessionId, question.questionId, null)).toEqual({ answered: true });
    await pending;

    expect(pick("session-id-changed")).toEqual([]);
    expect((await auto.list("ws-1")).map((item) => item.sessionId)).toEqual([sessionId]);
    // 什么都没发生：连旧会话都没进存档（那是迁移的第一步）
    expect(store.records.size).toBe(0);
  });

  it("没有客户端在看：不问，按兜底「什么都不做」跳过迁移（说一句 migrationSkipped）", async () => {
    // 独立的一套：hub 上一个订阅者都没有 —— 客户端已退出，而会话仍在服务端活着
    const silentHub = new RecordingHub();
    const silent = assemble({ hub: silentHub, askTimeoutMs: 30_000 });
    extras.push(silent.manager);
    const { sessionId } = await silent.manager.create({ workspaceId: "ws-1", path: workspace });
    agent.messages = [{ role: "user", content: "旧任务" }];

    // 全程没人回答却能跑完：若真问了，这一句会挂到 30 秒超时（用例先超时失败）
    await triggerAutoMigrate(silent.hooks);

    expect(silentHub.watcherCount()).toBe(0);
    expect(silentHub.published.filter((event) => event.event === "session-question")).toEqual([]);
    const notices = silentHub.published.filter(
      (event): event is Extract<ServerEvent, { event: "session-notice" }> =>
        event.event === "session-notice",
    );
    // 兜底 = 什么都不做：**不迁移**（旧版这里的默认是 self 自动迁移，按产品决定改掉了）
    expect(notices.some((notice) => notice.code === "handoffWriting")).toBe(false);
    expect(notices.some((notice) => notice.code === "migrationSkipped")).toBe(true);
    expect(
      silentHub.published.filter((event) => event.event === "session-id-changed"),
    ).toHaveLength(0);
    // 会话原封不动
    expect((await silent.manager.list("ws-1")).map((item) => item.sessionId)).toEqual([sessionId]);
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
    expect(fast.manager.answer(remaining, question.questionId, "summary")).toEqual({
      answered: false,
    });
  });

  it("answer 一个不存在的会话：unknown-session（拿错 id 是调用方的错，不是「来晚了」）", () => {
    expect(() => auto.answer("sess_404", "q-1", "self")).toThrow(/unknown session/);
    try {
      auto.answer("sess_404", "q-1", "self");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("unknown-session");
    }
  });
});
