/**
 * `question.*` 的接线验收：语言与连接 id 从 ConnectionInfo 传下去（D8 / D22），
 * 出参原样交回。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Language } from "../i18n/index.js";
import type { MethodCallContext } from "../net/WsHub.js";
import { ConversationRepository } from "../storage/ConversationRepository.js";
import { Database } from "../storage/Database.js";
import { QuestionRepository } from "../storage/QuestionRepository.js";
import { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import { migrate } from "../storage/migrations.js";
import { isMethodName } from "../wire/index.js";
import type { MethodName, MethodParams } from "../wire/index.js";
import { QuestionService } from "../services/QuestionService.js";
import { createQuestionHandlers } from "./questionHandlers.js";

function call<M extends MethodName>(
  method: M,
  params: MethodParams<M>,
  language: Language,
  connectionId = "conn-1",
): MethodCallContext<M> {
  return {
    method,
    params,
    connection: { id: connectionId, language, clientInfo: null, credentialId: null },
  };
}

interface Harness {
  dir: string;
  db: Database;
  questions: QuestionService;
  repository: QuestionRepository;
}

async function setup(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "ai-zen-question-handlers-"));
  const db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  const workspaces = new WorkspaceRepository(db);
  const conversations = new ConversationRepository(db);
  await workspaces.create({ id: "w1", name: "项目一", cwd: join(dir, "p"), createdAt: 1 });
  await conversations.create({
    id: "c1",
    workspaceId: "w1",
    name: "2026-01-01 00:00",
    agentId: "a1",
    modelId: "m1",
    createdAt: 1,
    updatedAt: 1,
  });

  const repository = new QuestionRepository(db);
  const questions = new QuestionService({
    questions: repository,
    handoff: { start: async () => ({ newConversationId: "c2" }) },
    now: () => 1_700_000_000_000,
  });
  return { dir, db, questions, repository };
}

let harness: Harness;

beforeEach(async () => {
  harness = await setup();
});

afterEach(async () => {
  await harness.db.close();
  await rm(harness.dir, { recursive: true, force: true });
});

describe("question.* 接线", () => {
  it("列表按连接语言渲染", async () => {
    const handlers = createQuestionHandlers({ questions: harness.questions });
    await harness.questions.askHandoff({
      conversationId: "c1",
      promptTokens: 500,
      handoffTokens: 1000,
    });

    const chinese = await handlers["question.list"]?.(call("question.list", { conversationId: "c1" }, "zh"));
    const english = await handlers["question.list"]?.(call("question.list", { conversationId: "c1" }, "en"));

    expect(chinese?.questions[0]?.prompt.message).toContain("接下来怎么办");
    expect(english?.questions[0]?.prompt.message).toContain("How should we continue");
  });

  it("回答时把「哪条连接答的」写进回答里", async () => {
    const handlers = createQuestionHandlers({ questions: harness.questions });
    const asked = await harness.questions.askHandoff({
      conversationId: "c1",
      promptTokens: 500,
      handoffTokens: 1000,
    });

    const answered = await handlers["question.answer"]?.(
      call("question.answer", { questionId: asked.id, value: "decline" }, "en", "conn-42"),
    );
    expect(answered?.question.answer).toMatchObject({ value: "decline", answeredBy: "conn-42" });
    expect(answered?.effects).toEqual({ handoffStarted: false, newConversationId: null });

    const stored = await harness.repository.get(asked.id);
    expect(stored?.state).toBe("answered");
  });

  it("答「自交接」时把副作用带回来", async () => {
    const handlers = createQuestionHandlers({ questions: harness.questions });
    const asked = await harness.questions.askHandoff({
      conversationId: "c1",
      promptTokens: 500,
      handoffTokens: 1000,
    });
    const answered = await handlers["question.answer"]?.(
      call("question.answer", { questionId: asked.id, value: "self" }, "en"),
    );
    expect(answered?.effects).toEqual({ handoffStarted: true, newConversationId: "c2" });
  });

  it("错误原样抛给接线层（ServerError 由它渲染）", async () => {
    const handlers = createQuestionHandlers({ questions: harness.questions });
    await expect(
      handlers["question.answer"]?.(call("question.answer", { questionId: "没有这条", value: "self" }, "en")),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("方法表里这两个方法都注册了", () => {
    const handlers = createQuestionHandlers({ questions: harness.questions });
    // 注册的键必须是方法表里认得的方法名（isMethodName 是运行期的同一份真相）
    const names = Object.keys(handlers).filter(isMethodName);
    expect(names.sort()).toEqual(["question.answer", "question.list"]);
  });
});
