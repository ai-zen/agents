/**
 * `QuestionRepository` 的验收：问题对象可持久化、状态和回答分开存、只改 state 时不会
 * 把已有回答抹掉（PRD D22：问题有状态、有生命周期、多端看同一个）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { QuestionRepository } from "./QuestionRepository.js";

let dir: string;
let db: Database;
let repo: QuestionRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-questions-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new QuestionRepository(db);

  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w1",
    "项目一",
    "/tmp/one",
    1,
  ]);
  await db.run(
    `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
     VALUES ('c1', 'w1', '对话', 0, NULL, NULL, 2, 2)`,
  );
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("QuestionRepository", () => {
  it("创建后读回：载荷是结构化对象，初始没有回答", async () => {
    await repo.create({
      id: "q1",
      conversationId: "c1",
      kind: "handoff",
      payload: { options: ["自交接", "独立摘要"], reason: "接近交接线" },
      state: "open",
      createdAt: 100,
    });

    const question = await repo.get("q1");
    expect(question).toEqual({
      id: "q1",
      conversationId: "c1",
      kind: "handoff",
      payload: { options: ["自交接", "独立摘要"], reason: "接近交接线" },
      state: "open",
      answer: null,
      createdAt: 100,
      updatedAt: 100,
      answeredAt: null,
    });
  });

  it("记录回答：状态、回答内容、时间一起更新", async () => {
    await repo.create({ id: "q1", conversationId: "c1", kind: "handoff", payload: {}, state: "open", createdAt: 100 });

    expect(
      await repo.update("q1", { state: "answered", answer: { choice: 0 }, answeredAt: 300, updatedAt: 300 }),
    ).toBe(1);

    const question = await repo.get("q1");
    expect(question?.state).toBe("answered");
    expect(question?.answer).toEqual({ choice: 0 });
    expect(question?.answeredAt).toBe(300);
    expect(question?.updatedAt).toBe(300);
  });

  it("只改 state 时已有回答不会被抹掉", async () => {
    await repo.create({ id: "q1", conversationId: "c1", kind: "handoff", payload: {}, state: "open", createdAt: 100 });
    await repo.update("q1", { answer: { choice: 1 }, answeredAt: 200, updatedAt: 200 });

    await repo.update("q1", { state: "dismissed", updatedAt: 300 });

    const question = await repo.get("q1");
    expect(question?.state).toBe("dismissed");
    expect(question?.answer).toEqual({ choice: 1 });
  });

  it("按对话列出，可按状态过滤（状态取值由上层决定，存储层只比较字符串）", async () => {
    await repo.create({ id: "q1", conversationId: "c1", kind: "handoff", payload: {}, state: "open", createdAt: 100 });
    await repo.create({ id: "q2", conversationId: "c1", kind: "handoff", payload: {}, state: "answered", createdAt: 200 });

    expect((await repo.listByConversation("c1")).map((row) => row.id)).toEqual(["q1", "q2"]);
    expect((await repo.listByConversation("c1", "open")).map((row) => row.id)).toEqual(["q1"]);
    expect(await repo.listByConversation("c2")).toEqual([]);
  });

  it("删对话时它的问题一并消失；也能单独删", async () => {
    await repo.create({ id: "q1", conversationId: "c1", kind: "handoff", payload: {}, state: "open", createdAt: 100 });
    await repo.create({ id: "q2", conversationId: "c1", kind: "handoff", payload: {}, state: "open", createdAt: 200 });

    expect(await repo.delete("q1")).toBe(1);
    await db.run("DELETE FROM conversations WHERE id = ?", ["c1"]);
    expect(await repo.get("q2")).toBeUndefined();
  });
});
