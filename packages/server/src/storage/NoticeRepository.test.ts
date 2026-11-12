/**
 * `NoticeRepository` 的验收：永久通知只能手动清、带时长的到点消失（PRD L3）、
 * 存的是码 + 参数而不是渲染好的句子。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate } from "./migrations.js";
import { NoticeRepository } from "./NoticeRepository.js";

let dir: string;
let db: Database;
let repo: NoticeRepository;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-notices-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
  repo = new NoticeRepository(db);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("NoticeRepository", () => {
  it("存的是码 + 参数，读回来还是结构化的（可用别的语言重新渲染）", async () => {
    await repo.create({
      id: "n1",
      level: "warn",
      code: "config.endpoint.missing",
      params: { endpoint: "openai" },
      durationMs: null,
      createdAt: 100,
    });

    const notice = await repo.get("n1");
    expect(notice).toEqual({
      id: "n1",
      level: "warn",
      code: "config.endpoint.missing",
      params: { endpoint: "openai" },
      durationMs: null,
      // 没挂对话的通知是全局的
      conversationId: null,
      createdAt: 100,
    });
  });

  it("永久通知不会自己消失；带时长的到点就查不到", async () => {
    await repo.create({ id: "forever", level: "info", code: "saved", createdAt: 100 });
    await repo.create({
      id: "brief",
      level: "info",
      code: "saved",
      durationMs: 1000,
      createdAt: 100,
    });

    // 两条同一时刻创建，按 id 排序：brief 在前
    expect((await repo.listActive(200)).map((row) => row.id)).toEqual(["brief", "forever"]);
    // 100 + 1000 已经过去
    expect((await repo.listActive(1200)).map((row) => row.id)).toEqual(["forever"]);
  });

  it("deleteExpired 只清到点的，返回清掉的条数", async () => {
    await repo.create({ id: "forever", level: "info", code: "saved", createdAt: 100 });
    await repo.create({ id: "brief", level: "info", code: "saved", durationMs: 50, createdAt: 100 });

    expect(await repo.deleteExpired(200)).toBe(1);
    expect(await repo.get("brief")).toBeUndefined();
    expect(await repo.get("forever")).toBeDefined();
  });

  it("按对话挂着、按对话清掉（`notices.conversationId` 是一列真值）", async () => {
    // 通知挂在对话上，所以先要有那个对话（外键是开着的）
    await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', 'p', '/tmp/p', 1)");
    await db.run(
      `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES ('c1', 'w1', 'one', 0, 'a', 'm', 1, 1)`,
    );
    await db.run(
      `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES ('c2', 'w1', 'two', 0, 'a', 'm', 1, 1)`,
    );

    await repo.create({ id: "scoped1", level: "info", code: "a", conversationId: "c1", createdAt: 100 });
    await repo.create({ id: "scoped2", level: "info", code: "a", conversationId: "c2", createdAt: 100 });
    await repo.create({ id: "global", level: "info", code: "a", createdAt: 100 });

    expect((await repo.get("scoped1"))?.conversationId).toBe("c1");
    expect(await repo.clearByConversation("c1")).toBe(1);
    expect(await repo.get("scoped1")).toBeUndefined();
    expect(await repo.get("scoped2")).toBeDefined();
    expect(await repo.get("global")).toBeDefined();
  });

  it("对话被删时它名下的通知跟着走（ON DELETE CASCADE）", async () => {
    await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', 'p', '/tmp/p', 1)");
    await db.run(
      `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES ('c1', 'w1', 'one', 0, 'a', 'm', 1, 1)`,
    );
    await repo.create({ id: "scoped", level: "info", code: "a", conversationId: "c1", createdAt: 100 });

    await db.run("DELETE FROM conversations WHERE id = 'c1'");
    expect(await repo.get("scoped")).toBeUndefined();
  });

  it("手动清一条 / 清全部", async () => {
    await repo.create({ id: "n1", level: "info", code: "a", createdAt: 100 });
    await repo.create({ id: "n2", level: "error", code: "b", createdAt: 200 });

    expect(await repo.clear("n1")).toBe(1);
    expect(await repo.clear("n1")).toBe(0);
    expect(await repo.clearAll()).toBe(1);
    expect(await repo.listActive(0)).toEqual([]);
  });
});
