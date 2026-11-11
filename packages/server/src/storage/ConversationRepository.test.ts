/**
 * `ConversationRepository` 的验收：身份字段落库、侧栏排序口径（置顶 + 创建时间倒序，
 * PRD D13）、改名不改顺序、按名字搜索与 LIKE 通配符转义。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { ConversationRepository } from "./ConversationRepository.js";

let dir: string;
let db: Database;
let repo: ConversationRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-conversations-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new ConversationRepository(db);

  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w1",
    "项目一",
    "/tmp/one",
    1,
  ]);
  await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
    "w2",
    "项目二",
    "/tmp/two",
    2,
  ]);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("ConversationRepository", () => {
  it("创建时定下的身份（workspace / 助手 / 模型）能原样读回", async () => {
    await repo.create({
      id: "c1",
      workspaceId: "w1",
      name: "2026-11-12 10:00",
      agentId: "agent-1",
      modelId: "model-1",
      createdAt: 500,
    });

    const conversation = await repo.get("c1");
    expect(conversation).toEqual({
      id: "c1",
      workspaceId: "w1",
      name: "2026-11-12 10:00",
      pinned: false,
      agentId: "agent-1",
      modelId: "model-1",
      createdAt: 500,
      updatedAt: 500,
    });
  });

  it("列表：置顶优先，其次创建时间倒序", async () => {
    await repo.create({ id: "old", workspaceId: "w1", name: "旧", createdAt: 100 });
    await repo.create({ id: "new", workspaceId: "w1", name: "新", createdAt: 300 });
    await repo.create({ id: "mid", workspaceId: "w1", name: "中", createdAt: 200 });
    await repo.create({ id: "other-ws", workspaceId: "w2", name: "别处", createdAt: 400 });

    expect((await repo.listByWorkspace("w1")).map((row) => row.id)).toEqual(["new", "mid", "old"]);

    await repo.setPinned("old", true, 600);
    expect((await repo.listByWorkspace("w1")).map((row) => row.id)).toEqual(["old", "new", "mid"]);
  });

  it("改名、活动都不改变排序（PRD D13）", async () => {
    await repo.create({ id: "a", workspaceId: "w1", name: "甲", createdAt: 100 });
    await repo.create({ id: "b", workspaceId: "w1", name: "乙", createdAt: 200 });

    await repo.rename("a", "甲（改过名）", 900);
    await repo.touch("a", 1000);

    expect((await repo.listByWorkspace("w1")).map((row) => row.id)).toEqual(["b", "a"]);
    expect((await repo.get("a"))?.name).toBe("甲（改过名）");
  });

  it("按名字搜索：子串命中、可按 workspace 过滤、通配符被转义", async () => {
    await repo.create({ id: "c1", workspaceId: "w1", name: "重写存储层", createdAt: 100 });
    await repo.create({ id: "c2", workspaceId: "w1", name: "100% 命中率", createdAt: 200 });
    await repo.create({ id: "c3", workspaceId: "w2", name: "重写接线层", createdAt: 300 });

    expect((await repo.searchByName("重写", undefined, 10)).map((row) => row.id).sort()).toEqual([
      "c1",
      "c3",
    ]);
    expect((await repo.searchByName("重写", "w1", 10)).map((row) => row.id)).toEqual(["c1"]);
    // "%" 被转义成普通字符，不能变成「匹配任意内容」
    expect((await repo.searchByName("100%", undefined, 10)).map((row) => row.id)).toEqual(["c2"]);
    expect(await repo.searchByName("%", undefined, 10)).toHaveLength(1);
  });

  it("limit 与计数", async () => {
    await repo.create({ id: "c1", workspaceId: "w1", name: "甲", createdAt: 100 });
    await repo.create({ id: "c2", workspaceId: "w1", name: "乙", createdAt: 200 });

    expect(await repo.searchByName("", undefined, 1)).toHaveLength(1);
    expect(await repo.countByWorkspace("w1")).toBe(2);
    expect(await repo.countByWorkspace("w2")).toBe(0);
  });

  it("删对话是硬删（PRD D17）", async () => {
    await repo.create({ id: "c1", workspaceId: "w1", name: "甲", createdAt: 100 });
    expect(await repo.delete("c1")).toBe(1);
    expect(await repo.get("c1")).toBeUndefined();
    expect(await repo.delete("c1")).toBe(0);
  });

  it("list() 跨 Workspace 取全部", async () => {
    await repo.create({ id: "c1", workspaceId: "w1", name: "甲", createdAt: 100 });
    await repo.create({ id: "c2", workspaceId: "w2", name: "乙", createdAt: 200 });
    expect((await repo.list()).map((row) => row.id)).toEqual(["c2", "c1"]);
  });
});
