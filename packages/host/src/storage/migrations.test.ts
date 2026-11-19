/**
 * 建表与迁移的验收：全新库能建起来、重复迁移幂等、外键级联真的删、FTS 索引与主表一致。
 *
 * 库与迁移整个文件只建一次（临时目录里，结束后删掉，不碰仓库与用户数据根），每个用例只清表；
 * 两条天生要全新库的用例（没迁移过的、要看着迁移刚跑过一趟的）自己另开一个库。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";
import { migrate, MIGRATIONS } from "./migrations.js";

/** 最新一级的版本号（断言「升到顶」而不是钉死某个数字） */
const LATEST_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version));
import { MetaRepository } from "./MetaRepository.js";

let dir: string;
let db: Database;

/**
 * 天生要自己的库的用例（没迁移过的全新库、要看着迁移真的跑一遍的）在这里另开一个库：
 * 同一个临时目录、另一个文件名，由 `afterAll` 统一关掉。
 *
 * 这些用例里用 `const db = ownDatabase(...)` 遮蔽外层那个共享库，所以用例正文（包括断言）
 * 一行不用改，读到的就是自己的那个。
 */
const ownDbs: Database[] = [];

function ownDatabase(fileName: string): Database {
  const own = new Database(join(dir, fileName));
  ownDbs.push(own);
  return own;
}

// 库与迁移整个文件只做一次（起 worker + migrate 是每条用例的大头），每个用例只清表。
// 用例正文里那几次 `migrate(db)` 保留原样：在共享库上它们退化成一次版本号读取（幂等），
// 正是这组用例要验的东西之一。
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-migrations-"));
  db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);
});

beforeEach(async () => {
  await db.tx((tx) => [
    // meta 不清：migrate 靠它判断跑不跑
    tx.run("DELETE FROM notices"),
    // workspaces 必须在 assets 之前：删 workspace 级联删掉 session_assets 关系行，
    // 之后 assets 的 ON DELETE RESTRICT 才不会拦
    tx.run("DELETE FROM workspaces"), // 级联 sessions → messages → session_assets
    tx.run("DELETE FROM assets"), // 级联 asset_vendor_files
    tx.run("DELETE FROM credentials"),
  ]);
});

afterAll(async () => {
  for (const own of ownDbs) await own.close();
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
    // 这条要的是「迁移刚刚真的跑过一趟」（下面断言建库时间 >= 本用例开始），
    // 共享库的 meta 是文件级那一趟写的，不成立 —— 所以自己开一个全新库。
    const db = ownDatabase("fresh-migrate.db");
    const before = Date.now();
    await migrate(db);

    const meta = new MetaRepository(db);
    expect(await meta.getSchemaVersion()).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 1);
    expect((await meta.getState())?.createdAt).toBeGreaterThan(0);
    // 建库时间就是这一跳写的（不是 0、也不是未来时间）
    expect((await meta.getState())?.createdAt).toBeGreaterThanOrEqual(before);

    const names = await tableNames(db);
    for (const expected of [
      "workspaces",
      "sessions",
      "messages",
      "assets",
      "session_assets",
      "asset_vendor_files",
      "notices",
      "credentials",
      "inbox",
      "meta",
      "messages_fts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("重复迁移不炸，版本号不会倒退", async () => {
    // 这条验的是「全新库上第一次 migrate 真的跑完、再跑两次也不炸」：
    // 共享库已经迁过，第一次就退化成空跑了，所以自己开一个全新库
    const db = ownDatabase("fresh-migrate-repeat.db");
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

    const sessionColumns = await db.all<{ name: string; notnull: number }>(
      "PRAGMA table_info('sessions')",
    );
    for (const name of ["agentId", "modelId"]) {
      expect(sessionColumns.find((column) => column.name === name)?.notnull).toBe(1);
    }
    // 思考档位存档位名，可空 = 跟随助手定义（F-B6）
    expect(sessionColumns.find((column) => column.name === "thinkingLevel")?.notnull).toBe(0);
  });

  it("表结构钉住两列真值：名字是否自动起（R35）与subagent 的父工具调用（R37）", async () => {
    await migrate(db);
    void LATEST_VERSION;

    type ColumnInfo = { name: string; notnull: number; dflt_value: string | null };
    const sessionColumns = await db.all<ColumnInfo>("PRAGMA table_info('sessions')");
    const nameIsAuto = sessionColumns.find((column) => column.name === "nameIsAuto");
    // 非空且默认 1：创建时的原名算自动起的名字
    expect(nameIsAuto).toMatchObject({ notnull: 1, dflt_value: "1" });

    const messageColumns = await db.all<ColumnInfo>("PRAGMA table_info('messages')");
    // v5 之后库里只有一套取法：`parentToolCallId` 那一列已经不在了
    expect(messageColumns.some((column) => column.name === "parentToolCallId")).toBe(false);
  });

  it("v2：新库直接到最新版本，压缩两列存在且可空", async () => {
    const db = ownDatabase("fresh-v2.db");
    await migrate(db);

    // 版本号跟的是「最新那一级」（v3 加的是 messages.source）
    expect(await new MetaRepository(db).getSchemaVersion()).toBe(LATEST_VERSION);
    const columns = await db.all<{ name: string; notnull: number; dflt_value: string | null }>(
      "PRAGMA table_info('sessions')",
    );
    for (const name of ["compactedAt", "compactionMode"]) {
      const column = columns.find((candidate) => candidate.name === name);
      // 可空、无缺省：NULL 就是「从来没压过」
      expect(column).toMatchObject({ notnull: 0, dflt_value: null });
    }
  });

  it("v2：已经升过 v1 的库跑一次 upgrade，两列补上且旧行是 NULL", async () => {
    const db = ownDatabase("upgrade-v1-to-v2.db");
    // 只跑 v1 那一条，模拟「上一版已经装上升过级的库」
    const v1 = MIGRATIONS.find((migration) => migration.version === 1);
    if (!v1) throw new Error("MIGRATIONS 里没有 v1");
    await db.tx((tx) => {
      for (const statement of v1.statements) tx.run(statement);
      tx.run("INSERT INTO meta (id, schemaVersion, createdAt) VALUES (1, 1, ?)", [1]);
    });
    // 旧库里的一行（v1 的表结构里没有压缩那两列）
    await db.run(
      "INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', '项目一', '/tmp/v1', 1)",
    );
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES ('c1', 'w1', '旧会话', 0, 'a1', 'm1', 2, 2)`,
    );

    await migrate(db);

    expect(await new MetaRepository(db).getSchemaVersion()).toBe(LATEST_VERSION);
    const row = await db.get<{ compactedAt: number | null; compactionMode: string | null }>(
      "SELECT compactedAt, compactionMode FROM sessions WHERE id = 'c1'",
    );
    // 旧数据的真相就是「没压过」：两列都是 NULL
    expect(row).toEqual({ compactedAt: null, compactionMode: null });
  });

  it("v3：messages 多一列 source（存来源判别结构的 JSON），旧行是 NULL", async () => {
    const db = ownDatabase("upgrade-v2-to-v3.db");
    // 只跑到 v2，模拟「上一版已经装上升过级的库」
    const older = MIGRATIONS.filter((migration) => migration.version <= 2);
    await db.tx((tx) => {
      for (const migration of older) for (const statement of migration.statements) tx.run(statement);
      tx.run("INSERT INTO meta (id, schemaVersion, createdAt) VALUES (1, 2, ?)", [1]);
    });
    await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', '项目', '/tmp/v2', 1)");
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, agentId, modelId, createdAt, updatedAt)
       VALUES ('c1', 'w1', '旧会话', 'a1', 'm1', 2, 2)`,
    );
    await db.run(
      `INSERT INTO messages (id, sessionId, seq, role, status, content, createdAt, updatedAt)
       VALUES ('m1', 'c1', 1, 'user', 'completed', '"老消息"', 3, 3)`,
    );

    await migrate(db);

    expect(await new MetaRepository(db).getSchemaVersion()).toBe(LATEST_VERSION);
    const column = (
      await db.all<{ name: string; notnull: number; dflt_value: string | null }>(
        "PRAGMA table_info('messages')",
      )
    ).find((candidate) => candidate.name === "source");
    // 可空：旧行没有记过来源，那不是「用户说的」，而是「不知道」
    expect(column).toMatchObject({ notnull: 0, dflt_value: null });
    const row = await db.get<{ source: string | null }>("SELECT source FROM messages WHERE id = 'm1'");
    expect(row).toEqual({ source: null });
  });

  it("v4：老库升上来，四列都在；自动交接开关的缺省值落在「问」那一侧（0）", async () => {
    const db = ownDatabase("upgrade-v3-to-v4.db");
    // 只跑到 v3，模拟「上一版已经装上升过级的库」
    const older = MIGRATIONS.filter((migration) => migration.version <= 3);
    await db.tx((tx) => {
      for (const migration of older) for (const statement of migration.statements) tx.run(statement);
      tx.run("INSERT INTO meta (id, schemaVersion, createdAt) VALUES (1, 3, ?)", [1]);
    });
    await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', '项目', '/tmp/v3', 1)");
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, agentId, modelId, createdAt, updatedAt)
       VALUES ('c1', 'w1', '旧会话', 'a1', 'm1', 2, 2)`,
    );

    await migrate(db);

    expect(await new MetaRepository(db).getSchemaVersion()).toBe(LATEST_VERSION);
    const columns = await db.all<{ name: string; notnull: number; dflt_value: string | null }>(
      "PRAGMA table_info('sessions')",
    );
    // 两条阈值与血缘可空、无缺省：NULL 就是「跟模型走」/「用户建的」
    for (const name of ["handoffThreshold", "guardThreshold", "lineage"]) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        notnull: 0,
        dflt_value: null,
      });
    }
    // 自动交接开关非空、缺省 **0**：`ADD COLUMN ... NOT NULL` 在 SQLite 里必须给缺省值，
    // 而 0 就是常态那一侧 —— 撞线停下来问一句（PRD 4.10）。「不问」是例外（平级会话，
    // 创建那一刻显式写 1）。
    expect(columns.find((column) => column.name === "autoHandoff")).toMatchObject({
      notnull: 1,
      dflt_value: "0",
    });

    const row = await db.get<{
      handoffThreshold: number | null;
      guardThreshold: number | null;
      autoHandoff: number;
      lineage: string | null;
    }>(
      "SELECT handoffThreshold, guardThreshold, autoHandoff, lineage FROM sessions WHERE id = 'c1'",
    );
    // 旧库不迁移（用户：「旧户直接删了都没关系」）：漏写那一列的行读成 0，
    // 也就是「撞线问一句」。猜错的代价不对称：多问一句用户答「不交接」就再也不问；
    // 猜成「不问」则是用户从头到尾不知道发生过什么。
    expect(row).toEqual({
      handoffThreshold: null,
      guardThreshold: null,
      autoHandoff: 0,
      lineage: null,
    });
  });

  it("v5：题表没了、会话行多一格待交接、消息表删掉第二套取法", async () => {
    const db = ownDatabase("upgrade-v4-to-v5.db");
    // 只跑到 v4，模拟「上一版已经装上升过级的库」（那时还有 questions 表与 parentToolCallId）
    const older = MIGRATIONS.filter((migration) => migration.version <= 4);
    await db.tx((tx) => {
      for (const migration of older) for (const statement of migration.statements) tx.run(statement);
      tx.run("INSERT INTO meta (id, schemaVersion, createdAt) VALUES (1, 4, ?)", [1]);
    });
    await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', '项目', '/tmp/v4', 1)");
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, agentId, modelId, createdAt, updatedAt)
       VALUES ('c1', 'w1', '旧会话', 'a1', 'm1', 2, 2)`,
    );
    await db.run(
      `INSERT INTO messages (id, sessionId, seq, role, status, content, searchText, createdAt, updatedAt)
       VALUES ('m1', 'c1', 1, 'user', 'completed', '"老消息"', '老消息', 3, 3)`,
    );
    // 旧库里挂着的一道题：v5 之后它不该再有任何落点
    await db.run(
      `INSERT INTO questions (id, sessionId, kind, payload, state, createdAt, updatedAt)
       VALUES ('q1', 'c1', 'handoff', '{}', 'pending', 4, 4)`,
    );

    await migrate(db);

    expect(await new MetaRepository(db).getSchemaVersion()).toBe(LATEST_VERSION);
    // 1. 题表与它的索引一起消失
    const tables = await tableNames(db);
    expect(tables).not.toContain("questions");
    expect(
      await db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_questions_session'"),
    ).toEqual([]);

    // 2. 会话行多一格待交接：可空，NULL = 没有待交接
    const sessionColumns = await db.all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>("PRAGMA table_info('sessions')");
    expect(sessionColumns.find((column) => column.name === "pendingHandoff")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    expect(await db.get("SELECT pendingHandoff FROM sessions WHERE id = 'c1'")).toEqual({
      pendingHandoff: null,
    });

    // 3. 消息表删掉那个列与它的索引（旧行照旧读得出来）
    const messageColumns = await db.all<{ name: string }>("PRAGMA table_info('messages')");
    expect(messageColumns.some((column) => column.name === "parentToolCallId")).toBe(false);
    expect(
      await db.all(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_parent_tool_call'",
      ),
    ).toEqual([]);
    expect(await db.all("SELECT id FROM messages")).toEqual([{ id: "m1" }]);
  });

  it("v6：inbox 表按「条目上有什么就存什么」建起来，顺序列与按会话取的索引都在", async () => {
    await migrate(db);

    const columns = await db.all<{ name: string; type: string; notnull: number; pk: number }>(
      "PRAGMA table_info('inbox')",
    );
    // 六列各就各位：主键 / 归属 / 来源 JSON / 内容 JSON / 入队时刻 ISO 串 / 顺序
    expect(columns.map((column) => column.name)).toEqual([
      "messageId",
      "sessionId",
      "source",
      "content",
      "createdAt",
      "seq",
    ]);
    // messageId 是主键（全库的行都一样，主键列自己不带 notnull 标记）；其余五格都必须有值
    expect(columns.find((column) => column.name === "messageId")?.pk).toBe(1);
    for (const name of ["sessionId", "source", "content", "createdAt", "seq"]) {
      expect(columns.find((column) => column.name === name)?.notnull).toBe(1);
    }
    // `createdAt` 是条目自带的 ISO 串，不是全库惯用的毫秒整数（存就存原样）
    expect(columns.find((column) => column.name === "createdAt")?.type).toBe("TEXT");
    expect(columns.find((column) => column.name === "seq")?.type).toBe("INTEGER");

    const indexColumns = await db.all<{ name: string }>("PRAGMA index_info('idx_inbox_session')");
    // 按会话取、且顺序即入队顺序（唯一的读取路径，一条复合索引就够）
    expect(indexColumns.map((column) => column.name)).toEqual(["sessionId", "seq"]);
  });

  it("迁移后仍然是 WAL 且外键约束是开着的", async () => {
    await migrate(db);
    const journal = await db.get<{ journal_mode: string }>("PRAGMA journal_mode");
    expect(journal?.journal_mode).toBe("wal");
    const foreignKeys = await db.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(foreignKeys?.foreign_keys).toBe(1);
  });

  it("全新库（还没跑迁移）读 schemaVersion 得到 0 而不是抛错", async () => {
    // 要一个**没迁移过**的库：共享库已经迁完，这里自己开一个
    const db = ownDatabase("fresh-unmigrated.db");
    const meta = new MetaRepository(db);
    expect(await meta.getSchemaVersion()).toBe(0);
    expect(await meta.getState()).toBeUndefined();
  });
});

describe("外键与级联", () => {
  /** 建一套 "workspace → session → message → asset" 的最小数据 */
  async function seed(): Promise<void> {
    await migrate(db);
    await db.run("INSERT INTO workspaces (id, name, cwd, createdAt) VALUES (?, ?, ?, ?)", [
      "w1",
      "项目一",
      "/tmp/project-one",
      1,
    ]);
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, pinned, agentId, modelId, createdAt, updatedAt)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      ["c1", "w1", "会话一", "a1", "m1", 2, 2],
    );
    await db.run(
      `INSERT INTO messages (id, sessionId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ["msg1", "c1", 1, "user", "completed", '"你好"', "你好", 3, 3],
    );
    await db.run(
      `INSERT INTO assets (id, name, path, mime, bytes, sha256, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["as1", "a.png", "assets/a.png", "image/png", 1024, "digest-1", 4],
    );
    await db.run(
      `INSERT INTO session_assets (sessionId, messageId, assetId, createdAt)
       VALUES (?, ?, ?, ?)`,
      ["c1", "msg1", "as1", 5],
    );
    // 挂在会话上的通知：级联的另一半（这张表的 CASCADE 只在这里钉）
    await db.run(
      `INSERT INTO notices (id, level, code, params, durationMs, sessionId, createdAt)
       VALUES ('n1', 'info', 'notice.settingsSaved', NULL, NULL, 'c1', 6)`,
    );
    // 排在队列里还没被取走的一条条目：会话/工作区没了它也就没有去处（v6 的级联）
    await db.run(
      `INSERT INTO inbox (messageId, sessionId, source, content, createdAt, seq)
       VALUES ('msg2', 'c1', '{"kind":"user"}', '"还没被处理的一句"', '2026-01-02T03:04:05.000Z', 1)`,
    );
  }

  it("删 workspace 连带删它的 sessions / messages / 引用关系", async () => {
    await seed();
    await db.run("DELETE FROM workspaces WHERE id = ?", ["w1"]);

    expect(await db.all("SELECT id FROM sessions")).toEqual([]);
    expect(await db.all("SELECT id FROM messages")).toEqual([]);
    expect(await db.all("SELECT assetId FROM session_assets")).toEqual([]);
    // inbox 行跟着会话/项目一起没：不留孤儿（v6 的级联）
    expect(await db.all("SELECT messageId FROM inbox")).toEqual([]);
    // 素材行不跟着会话走：字节是全局的，删不删由「还几张引用」决定
    expect(await db.all("SELECT id FROM assets")).toEqual([{ id: "as1" }]);
  });

  it("删 session 连带删 messages / 引用关系 / 通知（素材行留着）", async () => {
    await seed();
    await db.run("DELETE FROM sessions WHERE id = ?", ["c1"]);

    expect(await db.all("SELECT id FROM messages")).toEqual([]);
    expect(await db.all("SELECT assetId FROM session_assets")).toEqual([]);
    // 通知是挂在会话上的：会话没了它也没有落脚的语义（题已经不落库了，没有这一层）
    expect(await db.all("SELECT id FROM notices")).toEqual([]);
    // 条目也是：它排在那个会话的 inbox 里，会话没了它也就没有去处（v6 的级联）
    expect(await db.all("SELECT messageId FROM inbox")).toEqual([]);
    expect(await db.all("SELECT id FROM assets")).toEqual([{ id: "as1" }]);
  });

  it("删消息只带走它自己的关系行（素材行与文件路径还在）", async () => {
    await seed();
    await db.run("DELETE FROM messages WHERE id = ?", ["msg1"]);

    expect(await db.all("SELECT assetId FROM session_assets")).toEqual([]);
    const assets = await db.all<{ id: string; path: string }>("SELECT id, path FROM assets");
    expect(assets).toEqual([{ id: "as1", path: "assets/a.png" }]);
  });

  it("还有引用时素材行删不掉（assetId 是 ON DELETE RESTRICT 的护栏）", async () => {
    await seed();
    await expect(db.run("DELETE FROM assets WHERE id = ?", ["as1"])).rejects.toThrow(
      /FOREIGN KEY/i,
    );
  });

  it("同一份摘要只能落一行（sha256 全局唯一）", async () => {
    await seed();
    await expect(
      db.run(
        `INSERT INTO assets (id, name, path, mime, bytes, sha256, createdAt)
         VALUES ('as2', NULL, 'assets/b.png', 'image/png', 8, 'digest-1', 6)`,
      ),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("外键真的在拦：插一条指向不存在会话的消息会失败", async () => {
    await migrate(db);
    await expect(
      db.run(
        `INSERT INTO messages (id, sessionId, seq, role, status, omit, content, searchText, createdAt, updatedAt)
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
