/**
 * 问题对象的验收：有 id / 有状态 / 有生命周期 / 可持久化（D22）、多端看同一个（F-I9）、
 * 答完接着往下走（D22）、越线两端都拒绝时问题继续挂着（D23 / F-D10）、按语言渲染（D8）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { MessageRepository } from "../storage/MessageRepository.js";
import { QuestionRepository } from "../storage/QuestionRepository.js";
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
  dir: string;
  db: Database;
  questions: QuestionRepository;
  conversations: ConversationRepository;
  service: QuestionService;
  /** 第二个实例指向同一个库：模拟另一条连接 / 另一个窗口 */
  otherConnection: QuestionService;
  running: Set<string>;
  guard: { overGuard: boolean };
  handoffCalls: HandoffCall[];
  /** 交接替身这一轮的行为（用例可以换掉它来演「取消」「失败」） */
  handoffBehaviour: { run: () => Promise<{ started: true }> };
  events: Array<{ name: string; payload: unknown }>;
  clock: { value: number };
}

let dir: string;
let db: Database;
let questions: QuestionRepository;
let conversations: ConversationRepository;
let workspaces: WorkspaceRepository;

/** 实例级状态（事件、时钟、假运行时、交接替身）每用例重建；仓储与库复用 */
function makeHarness(): Harness {
  const running = new Set<string>();
  const guard = { overGuard: false };
  const handoffCalls: HandoffCall[] = [];
  const events: Array<{ name: string; payload: unknown }> = [];
  const clock = { value: 1_700_000_000_000 };

  const handoffBehaviour: { run: () => Promise<{ started: true }> } = {
    run: async () => ({ started: true }),
  };

  const make = (): QuestionService =>
    new QuestionService({
      questions,
      // 那边忙不忙是现读的一格（从前问的是运行表）
      runtime: {
        status: (conversationId: string) => (running.has(conversationId) ? "busy" : "idle"),
      },
      guard: { overGuard: async () => guard.overGuard } satisfies QuestionGuardProbe,
      handoff: {
        start: async (params: HandoffStartParams, language?: string) => {
          handoffCalls.push({ params, language });
          return await handoffBehaviour.run();
        },
      },
      now: () => (clock.value += 1000),
      emit: (name, payload) => {
        events.push({ name, payload });
      },
    });

  return {
    dir,
    db,
    questions,
    conversations,
    service: make(),
    otherConnection: make(),
    running,
    guard,
    handoffCalls,
    handoffBehaviour,
    events,
    clock,
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

// 整个文件共用一个库：`new + migrate` 每用例 55ms，清表只是一条 DELETE 批次。
// 真要「关库再重开」的那条用例自带库（见「生命周期」那一段）。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-questions-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  questions = new QuestionRepository(db);
  conversations = new ConversationRepository(db);
  workspaces = new WorkspaceRepository(db);
});

beforeEach(async () => {
  // 只清业务表；`meta` 绝不碰（migrate 靠 meta.schemaVersion 判断跑不跑）
  await db.tx((tx) => [
    tx.run("DELETE FROM notices"),
    tx.run("DELETE FROM questions"),
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
    createdAt: 1,
    updatedAt: 1,
  });
  await conversations.create({
    id: "c2",
    workspaceId: "w1",
    name: "2026-01-01 00:01",
    agentId: "a1",
    modelId: "m1",
    createdAt: 2,
    updatedAt: 2,
  });

  harness = makeHarness();
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("问题对象的基本形状（D22）", () => {
  it("有 id、有状态、三个候选、落库", async () => {
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

    const rows = await harness.db.all<{ state: string; kind: string }>(
      "SELECT state, kind FROM questions",
    );
    expect(rows).toEqual([{ state: "pending", kind: "handoff" }]);
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

  it("list 不给对话就是全库，给了就只看那一段（R61）", async () => {
    const first = await askHandoff(harness);
    // 另一段对话上的问题
    const second = (await harness.service.askHandoff({ conversationId: "c2", promptTokens: 800, handoffTokens: 1000 })).id;

    const all = await harness.service.list({});
    expect(all.questions.map((question) => question.id)).toEqual([first, second]);

    const scoped = await harness.service.list({ conversationId: "c1" });
    expect(scoped.questions.map((question) => question.id)).toEqual([first]);

    // `state` 在全库查询上也生效
    await harness.service.answer({ questionId: first, value: HANDOFF_OPTION_DECLINE });
    const pendingOnly = await harness.service.list({ state: "pending" });
    expect(pendingOnly.questions.map((question) => question.id)).toEqual([second]);
  });

  it("问题不存在时 answer 报 not_found", async () => {
    await expect(
      harness.service.answer({ questionId: "没有这条", value: "self" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("多端看到同一个问题（D22 / F-I9）", () => {
  it("另一条连接看到的是同一个问题、同一份状态", async () => {
    const id = await askHandoff(harness);

    const fromOther = await harness.otherConnection.list({ conversationId: "c1" });
    expect(fromOther.questions.map((question) => question.id)).toEqual([id]);
    expect(fromOther.questions[0]?.state).toBe("pending");

    const answered = await harness.otherConnection.answer(
      { questionId: id, value: HANDOFF_OPTION_SELF },
      { answeredBy: "conn-2" },
    );
    expect(answered.question.state).toBe("answered");

    const fromFirst = await harness.service.list({ conversationId: "c1" });
    expect(fromFirst.questions[0]?.state).toBe("answered");
    expect(fromFirst.questions[0]?.answer).toMatchObject({
      value: "self",
      answeredBy: "conn-2",
    });
    expect(fromFirst.questions[0]?.answer?.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("后到的那一端再答一次不会重复触发副作用", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_SELF });
    expect(harness.handoffCalls).toHaveLength(1);

    const again = await harness.otherConnection.answer({ questionId: id, value: "summary" });
    expect(again.question.answer?.value).toBe("self");
    expect(again.effects).toEqual({ handoffStarted: false });
    expect(harness.handoffCalls).toHaveLength(1);
  });

  it("每次状态变化都推一条 question 事件", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_SELF });
    expect(harness.events.map((event) => event.name)).toEqual(["question", "question"]);
  });
});

describe("答完之后接着往下走（D22）", () => {
  it("选「自交接」就当场开始交接（回执只说触发了它）", async () => {
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
    // 回执只有「触发了交接」：文档写到哪、有没有降级走通知（PRD 4.9）
    expect(answered.effects).toEqual({ handoffStarted: true });
  });

  it("选「独立摘要」用 summary 那一档", async () => {
    const id = await askHandoff(harness);
    await harness.service.answer({ questionId: id, value: "summary" });
    expect(harness.handoffCalls[0]?.params.mode).toBe("summary");
  });

  it("选「不交接」只是把问题答了，不触发交接", async () => {
    const id = await askHandoff(harness);
    const answered = await harness.service.answer({ questionId: id, value: HANDOFF_OPTION_DECLINE });
    expect(harness.handoffCalls).toHaveLength(0);
    expect(answered.effects).toEqual({ handoffStarted: false });
    expect(answered.question.state).toBe("answered");
  });

  it("交接入口当场就拒（参数不对这类）时照样抛出去：不能假装答完就没事", async () => {
    harness.handoffBehaviour.run = async () => {
      const { HostError } = await import("../wire/errors.js");
      throw new HostError("internal", { messageKey: "error.handoffFailed", params: { reason: "x" } });
    };
    const id = await askHandoff(harness);
    await expect(
      harness.service.answer({ questionId: id, value: HANDOFF_OPTION_SELF }),
    ).rejects.toMatchObject({ code: "internal" });
  });

  it("值不在候选里按参数不对拒，问题仍是 pending", async () => {
    const id = await askHandoff(harness);
    await expect(
      harness.service.answer({ questionId: id, value: "自交接" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    const listed = await harness.service.list({ conversationId: "c1" });
    expect(listed.questions[0]?.state).toBe("pending");
  });
});

describe("交接在那边闲下来之后才做（D22）", () => {
  it("那边正忙着时拒绝回答，问题继续挂着", async () => {
    const id = await askHandoff(harness);
    harness.running.add("c1");

    await expect(
      harness.service.answer({ questionId: id, value: HANDOFF_OPTION_SELF }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(harness.handoffCalls).toHaveLength(0);
    const listed = await harness.service.list({ conversationId: "c1", state: "pending" });
    expect(listed.questions.map((question) => question.id)).toEqual([id]);
  });
});

describe("越过硬线两端都拒绝，问题继续挂着（D23 / F-D10）", () => {
  it("过了硬线却选「就在这段里继续」→ 宿主拒绝，问题仍是 pending", async () => {
    const id = await askHandoff(harness);
    harness.guard.overGuard = true;

    await expect(
      harness.service.answer({ questionId: id, value: HANDOFF_OPTION_DECLINE }),
    ).rejects.toMatchObject({ code: "context_guard", detail: { reason: "over_guard" } });

    const listed = await harness.service.list({ conversationId: "c1" });
    expect(listed.questions[0]?.state).toBe("pending");
    expect(listed.questions[0]?.answer).toBeNull();
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

describe("生命周期（D22：有状态、可持久化）", () => {
  it("重开库之后问题与回答都还在", async () => {
    // 这条要真「关库再重开」：共享夹具下 close 会把整个文件共用的库关掉，所以自带一个库
    const ownDir = await mkdtemp(join(tmpdir(), "ai-zen-questions-reopen-"));
    const ownFile = join(ownDir, "ai-zen.db");
    let reopened: Database | undefined;
    const own = new Database(ownFile);
    try {
      await migrate(own);
      const ownWorkspaces = new WorkspaceRepository(own);
      const ownConversations = new ConversationRepository(own);
      await ownWorkspaces.create({
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
        questions: new QuestionRepository(own),
        handoff: { start: async () => ({ started: true }) },
      });
      const asked = await service.askHandoff({
        conversationId: "c1",
        promptTokens: 800,
        handoffTokens: 1000,
      });
      const id = asked.id;
      await service.answer({ questionId: id, value: "summary" }, { answeredBy: "conn-1" });

      await own.close();
      reopened = new Database(ownFile);
      await migrate(reopened);
      const reopenedService = new QuestionService({ questions: new QuestionRepository(reopened) });
      const listed = await reopenedService.list({ conversationId: "c1" });
      expect(listed.questions[0]?.state).toBe("answered");
      expect(listed.questions[0]?.answer?.value).toBe("summary");
    } finally {
      await own.close();
      await reopened?.close();
      await rm(ownDir, { recursive: true, force: true });
    }
  });
});

describe("硬线判定（createConversationGuardProbe）", () => {
  it("按模型的 guard 阈值与最近一条带用量的消息判定", async () => {
    const { writeFile } = await import("node:fs/promises");
    const configPath = join(harness.dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        endpoints: [],
        models: [{ id: "m1", name: "模型一", endpointId: "e1", tokenThresholds: { guard: 1000 } }],
      }),
      "utf-8",
    );

    const { ConfigManager } = await import("@ai-zen/agents-sdk");
    const messages = new MessageRepository(harness.db);
    const probe = createConversationGuardProbe({
      conversations: harness.conversations,
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
