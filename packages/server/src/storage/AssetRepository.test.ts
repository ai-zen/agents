/**
 * `AssetRepository` 的验收：素材行只存引用、能挂到消息上、消息被删时行保留而引用置空、
 * 对话被删时行跟着走。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { AssetRepository } from "./AssetRepository.js";

let dir: string;
let db: Database;
let repo: AssetRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-assets-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new AssetRepository(db);

  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w1",
    "项目一",
    "/tmp/one",
    1,
  ]);
  await db.run(
    `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
     VALUES ('c1', 'w1', '对话', 0, 'agent-1', 'model-1', 2, 2)`,
  );
  await db.run(
    `INSERT INTO messages (id, conversationId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
     VALUES ('m1', 'c1', 1, 'user', 'completed', 0, '""', '', 3, 3)`,
  );
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("AssetRepository", () => {
  it("上传时还没有消息：messageId 为空，之后可以挂上去", async () => {
    await repo.create({
      id: "a1",
      conversationId: "c1",
      name: "photo.png",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 2048,
      sha256: "abc",
      createdAt: 10,
    });

    const before = await repo.get("a1");
    expect(before?.messageId).toBeNull();
    expect(await repo.listByMessage("m1")).toEqual([]);

    expect(await repo.linkToMessage("a1", "m1")).toBe(1);
    expect((await repo.listByMessage("m1")).map((row) => row.id)).toEqual(["a1"]);
    expect((await repo.listByConversation("c1")).map((row) => row.id)).toEqual(["a1"]);
  });

  it("删消息后素材行还在、引用置空（文件路径不能丢）", async () => {
    await repo.create({
      id: "a1",
      conversationId: "c1",
      messageId: "m1",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 1,
      createdAt: 10,
    });

    await db.run("DELETE FROM messages WHERE id = ?", ["m1"]);

    const asset = await repo.get("a1");
    expect(asset?.messageId).toBeNull();
    expect(asset?.path).toBe("assets/a1.png");
  });

  it("删对话时素材行一并消失", async () => {
    await repo.create({
      id: "a1",
      conversationId: "c1",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 1,
      createdAt: 10,
    });

    await db.run("DELETE FROM conversations WHERE id = ?", ["c1"]);
    expect(await repo.get("a1")).toBeUndefined();
  });

  it("单独删素材行", async () => {
    await repo.create({
      id: "a1",
      conversationId: "c1",
      path: "assets/a1.png",
      mime: "image/png",
      bytes: 1,
      createdAt: 10,
    });

    expect(await repo.delete("a1")).toBe(1);
    expect(await repo.get("a1")).toBeUndefined();
  });
});
