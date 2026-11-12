/**
 * 建表与迁移的验收：全新库能建起来、重复迁移幂等、外键级联真的删、FTS 索引与主表一致。
 *
 * 每个用例自己开一次性临时目录里的库，结束后删掉，不碰仓库与用户数据根。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate, MIGRATIONS } from "./migrations.js";
import { MetaRepository } from "./MetaRepository.js";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-migrations-"));
  db = new Database(join(dir, "ai-zen.db"));
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function tableNames(database: Database): Promise<string[]> {
  const rows = await database.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

describe("migrate", () => {
  it("全新库跑一次就建齐所有表，版本号落到最新", async () => {
    await migrate(db);

    const meta = new MetaRepository(db);
    expect(await meta.getSchemaVersion()).toBe(1);
    expect((await meta.getState())?.createdAt).toBeGreaterThan(0);

    const names = await tableNames(db);
    for (const expected of [
      "workspaces",
      "conversations",
      "messages",
      "assets",
      "asset_vendor_files",
      "notices",
      "questions",
      "credentials",
      "meta",
      "messages_fts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("重复迁移不炸，版本号不会倒退", async () => {
    await migrate(db);
    await expect(migrate(db)).resolves.toBeUndefined();
    await expect(migrate(db)).resolves.toBeUndefined();

    const meta = new MetaRepository(db);
    expect(await meta.getSchemaVersion()).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 1);
  });

  it("表结构钉住 cwd 唯一与身份列非空", async () => {
    await migrate(db);

    const workspaceColumns = await db.all<{ name: string; notnull: number }>(
      "PRAGMA table_info('workspaces')",
    );
    expect(workspaceColumns.find((column) => column.name === "cwd")?.notnull).toBe(1);

    const workspaceIndexes = await db.all<{ name: string; unique: number }>(
      "PRAGMA index_list('workspaces')",
    );
    const uniqueIndexColumns: string[][] = [];
    for (const index of workspaceIndexes.filter((candidate) => candidate.unique === 1)) {
      const columns = await db.all<{ name: string }>(`PRAGMA index_info('${index.name}')`);
      uniqueIndexColumns.push(columns.map((column) => column.name));
    }
    // cwd 上有一条唯一索引（id 主键那条另算）
    expect(uniqueIndexColumns).toContainEqual(["cwd"]);

    const conversationColumns = await db.all<{ name: string; notnull: number }>(
      "PRAGMA table_info('conversations')",
    );
    for (const name of ["agentId", "modelId"]) {
      expect(conversationColumns.find((column) => column.name === name)?.notnull).toBe(1);
    }
    // 思考档位存档位名，可空 = 跟随助手定义（F-B6）
    expect(conversationColumns.find((column) => column.name === "thinkingLevel")?.notnull).toBe(0);
  });

  it("表结构钉住两列真值：名字是否自动起（R35）与子 Agent 的父工具调用（R37）", async () => {
    await migrate(db);

    type ColumnInfo = { name: string; notnull: number; dflt_value: string | null };
    const conversationColumns = await db.all<ColumnInfo>("PRAGMA table_info('conversations')");
    const nameIsAuto = conversationColumns.find((column) => column.name === "nameIsAuto");
    // 非空且默认 1：创建时的原名算自动起的名字
    expect(nameIsAuto).toMatchObject({ notnull: 1, dflt_value: "1" });

    const messageColumns = await db.all<ColumnInfo>("PRAGMA table_info('messages')");
    const parentToolCallId = messageColumns.find((column) => column.name === "parentToolCallId");
    // 可空：顶层消息没有父工具调用
    expect(parentToolCallId).toMatchObject({ notnull: 0, dflt_value: null });
  });

  it("迁移后仍然是 WAL 且外键约束是开着的", async () => {
    await migrate(db);
    const journal = await db.get<{ journal_mode: string }>("PRAGMA journal_mode");
    expect(journal?.journal_mode).toBe("wal");
    const foreignKeys = await db.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(foreignKeys?.foreign_keys).toBe(1);
  });

  it("全新库（还没跑迁移）读 schemaVersion 得到 0 而不是抛错", async () => {
    const meta = new MetaRepository(db);
    expect(await meta.getSchemaVersion()).toBe(0);
    expect(await meta.getState()).toBeUndefined();
  });
});

describe("外键与级联", () => {
  /** 建一套 "workspace → conversation → message → asset" 的最小数据 */
  async function seed(): Promise<void> {
    await migrate(db);
    await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
      "w1",
      "项目一",
      "/tmp/project-one",
      1,
    ]);
    await db.run(
      `INSERT INTO conversations (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      ["c1", "w1", "对话一", "a1", "m1", 2, 2],
    );
    await db.run(
      `INSERT INTO messages (id, conversationId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ["msg1", "c1", 1, "user", "completed", '"你好"', "你好", 3, 3],
    );
    await db.run(
      `INSERT INTO assets (id, conversationId, messageId, name, path, mime, bytes, sha256, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["as1", "c1", "msg1", "a.png", "assets/a.png", "image/png", 1024, "digest-1", 4],
    );
  }

  it("删 workspace 连带删它的 conversations / messages / assets", async () => {
    await seed();
    await db.run("DELETE FROM workspaces WHERE id = ?", ["w1"]);

    expect(await db.all("SELECT id FROM conversations")).toEqual([]);
    expect(await db.all("SELECT id FROM messages")).toEqual([]);
    expect(await db.all("SELECT id FROM assets")).toEqual([]);
  });

  it("删 conversation 连带删 messages 与 assets", async () => {
    await seed();
    await db.run("DELETE FROM conversations WHERE id = ?", ["c1"]);

    expect(await db.all("SELECT id FROM messages")).toEqual([]);
    expect(await db.all("SELECT id FROM assets")).toEqual([]);
  });

  it("删消息时素材行保留、messageId 置空（文件路径不能丢，PRD D17 按引用清理）", async () => {
    await seed();
    await db.run("DELETE FROM messages WHERE id = ?", ["msg1"]);

    const assets = await db.all<{ id: string; messageId: string | null; path: string }>(
      "SELECT id, messageId, path FROM assets",
    );
    expect(assets).toEqual([{ id: "as1", messageId: null, path: "assets/a.png" }]);
  });

  it("外键真的在拦：插一条指向不存在对话的消息会失败", async () => {
    await migrate(db);
    await expect(
      db.run(
        `INSERT INTO messages (id, conversationId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
         VALUES ('x', 'does-not-exist', 1, 'user', 'completed', 0, '""', '', 1, 1)`,
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("FTS 索引与主表一致（integrity-check 通过）", async () => {
    await seed();
    const result = await db.run("INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')");
    expect(result.changes).toBeGreaterThanOrEqual(0);
  });
});
