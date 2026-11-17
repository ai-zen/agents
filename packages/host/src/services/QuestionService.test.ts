/**
 * 问题对象的验收，按「题不落库」之后的口径（PRD 4.10 / PLAN §5.2）：
 *
 *   - 题只活在进程里：造题后库里什么也不写，重开库题就没了；
 *   - 死的那一刻跟着没，且不再挡 `conversation.send`；
 *   - 答题**不被「忙」拦住**：先答完，再判能不能立刻交接 —— 能就当场交接，不能就在会话行上留
 *     `pendingHandoff`；
 *   - 「不交接」把自动交接开关关掉（答案的后果要落），并推一条 `settings_changed`；
 *   - 越线两端都拒时题继续挂着（D23）；
 *   - 存码不存句子，按连接语言渲染（D8）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { HandoffRefusalReason } from "../runtime/ChatRunner.js";
import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import type { HandoffStartParams } from "../wire/index.js";
import {
  createConversationGuardProbe,
  HANDOFF_OPTION_DECLINE,
  HANDOFF_OPTION_SELF,
  QuestionService,
} from "./QuestionService.js";
import type { QuestionGuardProbe } from "./QuestionService.js";

interface HandoffCall {
  params: HandoffStartParams;
  language: string | undefined;
}

interface Harness {
  /** 服务（多端 = 多条连接共用的就是这同一个对象） */
  service: QuestionService;
  conversations: ConversationRepository;
  /**
   * 交接能不能立刻开始（`ChatRunner.canHandoffNow` 的替身）。
   *
   * 一个可改的格子：判据是现读的，用例在答题前把它拨成 `working` 就演成了「这段正忙着」。
   */
  availability: { result: { ok: true } | { ok: false; reason: HandoffRefusalReason } };
  guard: { overGuard: boolean };
  handoffCalls: HandoffCall[];
  events: Array<{ name: string; payload: unknown }>;
}

let dir: string;
let db: Database;
let conversations: ConversationRepository;
let workspaces: WorkspaceRepository;

/** 实例级状态（事件、假判据、交接替身）每用例重建；仓储与库复用 */
function makeHarness(): Harness {
  const availability: { result: { ok: true } | { ok: false; reason: HandoffRefusalReason } } = {
    result: { ok: true },
  };
  const guard = { overGuard: false };
  const handoffCalls: HandoffCall[] = [];
  const events: Array<{ name: string; payload: unknown }> = [];
  let tick = 1_700_000_000_000;
  let counter = 0;

  const make = (): QuestionService =>
    new QuestionService({
      conversations,
      // 能不能立刻交接：全仓只有一处判据，这里给它的替身
      availability: { canHandoffNow: () => availability.result },
      guard: { overGuard: async () => guard.overGuard } satisfies QuestionGuardProbe,
      handoff: {
        start: async (params: HandoffStartParams, language?: string) => {
          handoffCalls.push({ params, language });
          return { started: true };
        },
      },
      now: () => (tick += 1000),
      newId: () => `q-${++counter}`,
      emit: (name, payload) => {
        events.push({ name, payload });
      },
    });

  return {
    service: make(),
    conversations,
    availability,
    guard,
    handoffCalls,
    events,
  };
}

/** 问一个交接问题（最常用的一条） */
async function askHandoff(harness: Harness, conversationId = "c1"): Promise<string> {
  const asked = await harness.service.askHandoff({
    conversationId,
    promptTokens: 800,
    handoffTokens: 1000,
  });
  return asked.id;
}

let harness: Harness;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-questions-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  conversations = new ConversationRepository(db);
  workspaces = new WorkspaceRepository(db);
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM workspaces"),
    tx.run("DELETE FROM assets"),
    tx.run("DELETE FROM credentials"),
  ]);
  // 硬线那条用例会在共享目录里写一份 config.json：每用例先回到「没有这份文件」的基准
  await rm(join(dir, "config.json"), { force: true });

  await workspaces.create({ id: "w1", name: "项目一", cwd: join(dir, "project"), createdAt: 1 });
  await conversations.create({
    id: "c1",
    workspaceId: "w1",
    name: "2026-01-01 00:00",
    agentId: "a1",
    modelId: "m1",
    // 用户建的那一侧：撞线问一句（没有待交接）
    autoHandoff: false,
    createdAt: 1,
    updatedAt: 1,
  });
  await conversations.create({
    id: "c2",
    workspaceId: "w1",
    name: "2026-01-01 00:01",
    agentId: "a1",
    modelId: "m1",
    autoHandoff: false,
    createdAt: 2,
    updatedAt: 2,
  });

  harness = makeHarness();
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("题只活在进程里（PRD 4.10）", () => {
  it("造题之后库里什么也不写（表都不存在了）", async () => {
    const asked = await harness.service.askHandoff({
      conversationId: "c1",
      promptTokens: 800,
      handoffTokens: 1000,
    });

    expect(asked.id.length).toBeGreaterThan(0);
    expect(asked.state).toBe("pending");
    expect(asked.kind).toBe("handoff");
    expect(asked.conversationId).toBe("c1");
    expect(asked.blocking).toBe(true);
    expect(asked.options.map((option) => option.value)).toEqual(["self", "summary", "decline"]);
    expect(asked.prompt.params).toEqual({ percent: 80 });
    expect(asked.answer).toBeNull();

    // 题没有落点：`questions` 表已经不在了（v5）
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'questions'",
    );
    expect(tables).toEqual([]);
  });

  it("拿同一个库重开一个库句柄，题也不在里面（它只在这个进程的内存里）", async () => {
    const ownDir = await mkdtemp(join(tmpdir(), "ai-zen-questions-reopen-"));
    const ownFile = join(ownDir, "ai-zen.db");
    let reopened: Database | undefined;
    const own = new Database(ownFile);
    try {
      await migrate(own);
      const ownConversations = new ConversationRepository(own);
      await new WorkspaceRepository(own).create({
        id: "w1",
        name: "项目一",
        cwd: join(ownDir, "project"),
        createdAt: 1,
      });
      await ownConversations.create({
        id: "c1",
        workspaceId: "w1",
        name: "2026-01-01 00:00",
        agentId: "a1",
        modelId: "m1",
        createdAt: 1,
        updatedAt: 1,
      });

      const service = new QuestionService({
        conversations: ownConversations,
        handoff: { start: async () => ({ started: true }) },
      });
      const asked = await service.askHandoff({
        conversationId: "c1",
        promptTokens: 800,
        handoffTokens: 1000,
      });
      expect(asked.state).toBe("pending");

      // 关库再重开：题不在（题的生命 = 这段对话活着的这段时间，而「进程重启」不算）
      await own.close();
      reopened = new Database(ownFile);
      await migrate(reopened);
      const reopenedService = new QuestionService({
        conversations: new ConversationRepository(reopened),
      });
      const listed = await reopenedService.list({ conversationId: "c1" });
      expect(listed.questions).toEqual([]);
    } finally {
      await own.close();
      await reopened?.close();
      await rm(ownDir, { recursive: true, force: true });
    }
  });

  it("库里存的是码 + 参数，按连接语言渲染出句子", async () => {
    const id = await askHandoff(harness);
    const chinese = await harness.service.list({ conversationId: "c1" }, "zh");
    const english = await harness.service.list({ conversationId: "c1" }, "en");

    expect(chinese.questions[0]?.id).toBe(id);
    expect(chinese.questions[0]?.prompt.message).toContain("接下来怎么办");
    expect(english.questions[0]?.prompt.message).toContain("How should we continue");
    expect(chinese.questions[0]?.options.map((option) => option.label.message)).toEqual([
      "让助手自己写交接",
      "改成摘要历史",
      "就在这段对话里继续",
    ]);
    expect(english.questions[0]?.options.map((option) => option.label.message)).toEqual([
      "Let the assistant write the handoff itself",
      "Summarise the history instead",
      "Keep going in this conversation",
    ]);
    expect(chinese.questions[0]?.prompt.params).toEqual({ percent: 80 });
  });

  it("list 只看这一段对话（没有跨对话的那个入口）", async () => {
    const first = await askHandoff(harness);
    const second = (
      await harness.service.askHandoff({ conversationId: "c2", promptTokens: 800, handoffTokens: 1000 })
    ).id;

    const scoped = await harness.service.list({ conversationId: "c1" });
    expect(scoped.questions.map((question) => question.id)).toEqual([first]);

    const other = await harness.service.list({ conversationId: "c2" });
    expect(other.questions.map((question) => question.id)).toEqual([second]);
  });

  it("答过的题也还在这段里（多端要看到「答了 + 谁答的」）", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_DECLINE }, {
      answeredBy: "conn-2",
    });

    const listed = await harness.service.list({ conversationId: "c1" });
    expect(listed.questions[0]?.state).toBe("answered");
    expect(listed.questions[0]?.answer).toMatchObject({ value: "decline", answeredBy: "conn-2" });
    expect(listed.questions[0]?.answer?.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 侧栏那个圆点只数还挂着的
    expect(harness.service.countPending("c1")).toBe(0);
  });

  it("问题不存在时 answer 报 not_found", async () => {
    await expect(
      harness.service.answer({ questionId: "没有这条", value: "self" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("不给 conversationId 是类型错误（没有「全库问题列表」这种读法）", async () => {
    await askHandoff(harness);
    // @ts-expect-error `conversationId` 必填：题只属于某一段对话（PRD 4.10 的「明确不做」）
    const listed = await harness.service.list({});
    // 运行时也读不到别人的题：没有「跨对话」这个入口
    expect(listed.questions).toEqual([]);
  });
});

describe("死的那一刻跟着没（PRD 4.10）", () => {
  it("清掉挂着的题、清掉会话行上的待交接", async () => {
    await askHandoff(harness);
    await harness.service.writePendingHandoff("c1", "summary");
    expect((await conversations.get("c1"))?.pendingHandoff).toBe("summary");

    await harness.service.dropConversation("c1");

    expect((await harness.service.list({ conversationId: "c1" })).questions).toEqual([]);
    expect(harness.service.countPending("c1")).toBe(0);
    expect((await conversations.get("c1"))?.pendingHandoff).toBeNull();
  });

  it("题没了之后不再挡 conversation.send", async () => {
    await askHandoff(harness);
    await expect(harness.service.assertSendable("c1")).rejects.toMatchObject({
      code: "question_pending",
    });

    await harness.service.dropConversation("c1");

    await expect(harness.service.assertSendable("c1")).resolves.toBeUndefined();
  });

  it("已经答过的题也一起清（题的生命只有这段对话活着的时间）", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_DECLINE });
    await harness.service.dropConversation("c1");
    expect((await harness.service.list({ conversationId: "c1" })).questions).toEqual([]);
  });
});

describe("答题不被「忙」拦住（PRD 4.10）", () => {
  it("这段正忙着：题照答，答完把「待交接」写进会话行", async () => {
    const id = await askHandoff(harness);
    // 这段手上有活（或没有驱动者）：不能立刻交接
    harness.availability.result = { ok: false, reason: "working" };

    const answered = await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_SELF });

    expect(answered.question.state).toBe("answered");
    // 没当场交接，但**答了**：回执说清为什么没开始
    expect(answered.effects).toEqual({
      handoffStarted: false,
      handoffDeferredReason: "working",
    });
    expect(harness.handoffCalls).toEqual([]);
    // 待交接落在会话行上（带着 mode），等下一次变闲再做
    expect((await conversations.get("c1"))?.pendingHandoff).toBe("self");
    // 题不再是 pending：它不再挡这一段
    expect(harness.service.countPending("c1")).toBe(0);
  });

  it("待交接的写读：写下 → 读回来 → 清掉", async () => {
    expect(await harness.service.readPendingHandoff("c1")).toBeNull();
    await harness.service.writePendingHandoff("c1", "summary");
    expect(await harness.service.readPendingHandoff("c1")).toBe("summary");
    await harness.service.writePendingHandoff("c1", null);
    expect(await harness.service.readPendingHandoff("c1")).toBeNull();
  });
});

describe("答完之后接着往下走（PRD 4.10 / PLAN §5.2）", () => {
  it("能立刻交接就当场开始（回执只说触发了它）", async () => {
    const id = await askHandoff(harness);
    const answered = await harness.service.answer(
      { questionId: id, value: HANDOFF_OPTION_SELF },
      { language: "zh" },
    );

    expect(harness.handoffCalls).toHaveLength(1);
    expect(harness.handoffCalls[0]?.params).toEqual({
      conversationId: "c1",
      mode: "self",
      then: "new_conversation",
    });
    // 交接回合说的是这条连接的语言
    expect(harness.handoffCalls[0]?.language).toBe("zh");
    expect(answered.effects).toEqual({ handoffStarted: true, handoffDeferredReason: null });
    // 当场交接了：不留待办
    expect(await harness.service.readPendingHandoff("c1")).toBeNull();
  });

  it("选「独立摘要」用 summary 那一档", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer({ questionId: id, value: "summary" });
    expect(harness.handoffCalls[0]?.params.mode).toBe("summary");
  });

  it("选「不交接」：不触发交接，关掉自动交接开关，并推一条 `settings_changed`", async () => {
    expect((await conversations.get("c1"))?.autoHandoff).toBe(false);
    // 先开一次，验证这一手真的写了库
    const id = await askHandoff(harness);
    await conversations.setAutoHandoff("c1", true, 10);
    expect((await conversations.get("c1"))?.autoHandoff).toBe(true);

    const changedBefore = harness.events.filter(
      (event) => event.name === "conversation.changed",
    ).length;
    const answered = await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_DECLINE });

    expect(harness.handoffCalls).toEqual([]);
    expect(answered.effects).toEqual({ handoffStarted: false, handoffDeferredReason: null });
    expect(answered.question.state).toBe("answered");
    // 以后不问
    expect((await conversations.get("c1"))?.autoHandoff).toBe(false);

    // 这一格是会话行上的设置：别的窗口的状态栏得跟着变 —— 恰好多一条，`workspaceId` 照实给 `null`
    // （会话行是异步读的，同一个口径见 `ChatRunner.beginHandoff`）
    const changed = harness.events.filter((event) => event.name === "conversation.changed");
    expect(changed).toHaveLength(changedBefore + 1);
    expect(changed.at(-1)?.payload).toMatchObject({
      conversationId: "c1",
      workspaceId: null,
      change: "settings_changed",
    });
  });

  it("参数不对时按参数不对拒，题仍是 pending", async () => {
    const id = await askHandoff(harness);
    await expect(
      harness.service.answer({ questionId: id, value: "自交接" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const listed = await harness.service.list({ conversationId: "c1" });
    expect(listed.questions[0]?.state).toBe("pending");
  });
});

describe("同一个对象、多条连接（PRD 4.10）", () => {
  it("同一个服务上再拉一次看到「答了 + 谁答的」", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer(
      { questionId: id, value: HANDOFF_OPTION_SELF },
      { answeredBy: "conn-2" },
    );

    const fromFirst = await harness.service.list({ conversationId: "c1" });
    expect(fromFirst.questions[0]?.state).toBe("answered");
    expect(fromFirst.questions[0]?.answer).toMatchObject({
      value: "self",
      answeredBy: "conn-2",
    });
  });

  it("后到的那一端再答一次不会重复触发副作用", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_SELF });
    expect(harness.handoffCalls).toHaveLength(1);

    const again = await harness.service.answer({ questionId: id, value: "summary" });
    expect(again.question.answer?.value).toBe("self");
    expect(again.effects).toEqual({ handoffStarted: false, handoffDeferredReason: null });
    expect(harness.handoffCalls).toHaveLength(1);
  });

  it("每次状态变化都推一条 question 事件（题没了不推事件）", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_SELF });
    await harness.service.dropConversation("c1");
    expect(harness.events.map((event) => event.name)).toEqual(["question", "question"]);
  });
});

describe("越过硬线两端都拒绝，题继续挂着（D23 / F-D10）", () => {
  it("过了硬线却选「就在这段里继续」→ 宿主拒绝，题仍是 pending", async () => {
    const id = await askHandoff(harness);
    harness.guard.overGuard = true;

    await expect(
      harness.service.answer({ questionId: id, value: HANDOFF_OPTION_DECLINE }),
    ).rejects.toMatchObject({ code: "context_guard", detail: { reason: "over_guard" } });

    const listed = await harness.service.list({ conversationId: "c1" });
    expect(listed.questions[0]?.state).toBe("pending");
    expect(listed.questions[0]?.answer).toBeNull();
    // 那一手也没把开关关掉（拒就是拒，一个字节都不写）
    expect((await conversations.get("c1"))?.autoHandoff).toBe(false);
  });

  it("过了硬线选交接照旧可以（交接是越线的出路）", async () => {
    const id = await askHandoff(harness);
    harness.guard.overGuard = true;

    const answered = await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_SELF });
    expect(answered.question.state).toBe("answered");
    expect(answered.effects.handoffStarted).toBe(true);
  });

  it("有挡着的问题时发消息被拒，并指出是哪一道题", async () => {
    const id = await askHandoff(harness);
    await expect(harness.service.assertSendable("c1")).rejects.toMatchObject({
      code: "question_pending",
      detail: { conversationId: "c1", questionId: id, kind: "handoff" },
    });
  });

  it("答掉之后就不再挡着了", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_SELF });
    await expect(harness.service.assertSendable("c1")).resolves.toBeUndefined();
  });
});

describe("硬线判定（createConversationGuardProbe）", () => {
  it("按模型的 guard 阈值与最近一条带用量的消息判定", async () => {
    const { writeFile } = await import("node:fs/promises");
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        endpoints: [],
        models: [{ id: "m1", name: "模型一", endpointId: "e1", tokenThresholds: { guard: 1000 } }],
      }),
      "utf-8",
    );

    const { ConfigManager } = await import("@ai-zen/agents-sdk");
    const messages = new MessageRepository(db);
    const probe = createConversationGuardProbe({
      conversations,
      messages,
      configManager: new ConfigManager(configPath),
    });

    // 还没有带用量的消息：不算过线
    expect(await probe.overGuard("c1")).toBe(false);

    await messages.upsert({
      id: "msg-1",
      conversationId: "c1",
      role: "assistant",
      status: "completed",
      content: "答完了",
      data: { usage: { prompt_tokens: 400, completion_tokens: 10, total_tokens: 410 } },
      createdAt: 10,
    });
    expect(await probe.overGuard("c1")).toBe(false);

    await messages.upsert({
      id: "msg-2",
      conversationId: "c1",
      role: "assistant",
      status: "completed",
      content: "又答了一轮",
      data: { usage: { prompt_tokens: 1200, completion_tokens: 20, total_tokens: 1220 } },
      createdAt: 11,
    });
    expect(await probe.overGuard("c1")).toBe(true);

    // 对话不存在时不算过线
    expect(await probe.overGuard("没有这段")).toBe(false);
  });
});
