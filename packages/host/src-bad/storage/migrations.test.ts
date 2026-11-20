/**
 * 建表与迁移的验收：全新库一次建齐当前形状、重复迁移幂等、外键级联真的删、FTS 索引与主表一致。
 *
 * 这里钉的是**当前形状**本身（有哪些表、哪些列、哪些索引与触发器、哪些东西特意不存在），
 * 不是它是怎么长出来的 —— 库里没有旧版本（PRD 1.9「明确不做」：迁移或识别旧数据），
 * 所以没有「跑过某一级之后多出两列」这类只描述演进过程的断言。
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
    tx.run("DELETE FROM workspaces"), // 级联 sessions → messages / inbox / session_assets
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

/** 一条列的全貌：[列名, 类型, 非空, 缺省值, 主键序号（0 = 不是主键）] */
type ColumnShape = [string, string, number, string | null, number];

/**
 * 当前形状的显式清单：十张表各有哪几列、什么类型、可不可空、缺省值是什么。
 *
 * **列的顺序也在里面** —— SQLite 里它就是表的一部分（`SELECT *` 的顺序），
 * 顺序一乱，两个库就不是同一个形状了。
 *
 * `messages_fts` 与它那几张 `messages_fts_*` 影子表不在这里：虚表的列由 fts5 定，见下面
 * 「全文检索」那条用例与 FTS 的完整性检查。
 */
const EXPECTED_COLUMNS: Record<string, ColumnShape[]> = {
  meta: [
    ["id", "INTEGER", 0, null, 1],
    ["schemaVersion", "INTEGER", 1, null, 0],
    ["createdAt", "INTEGER", 1, null, 0],
  ],
  workspaces: [
    ["id", "TEXT", 0, null, 1],
    ["name", "TEXT", 1, null, 0],
    ["cwd", "TEXT", 1, null, 0],
    ["createdAt", "INTEGER", 1, null, 0],
  ],
  sessions: [
    ["id", "TEXT", 0, null, 1],
    ["workspaceId", "TEXT", 1, null, 0],
    ["name", "TEXT", 1, null, 0],
    ["nameIsAuto", "INTEGER", 1, "1", 0],
    ["pinned", "INTEGER", 1, "0", 0],
    ["agentId", "TEXT", 1, null, 0],
    ["modelId", "TEXT", 1, null, 0],
    ["thinkingLevel", "TEXT", 0, null, 0],
    ["createdAt", "INTEGER", 1, null, 0],
    ["updatedAt", "INTEGER", 1, null, 0],
    ["compactedAt", "INTEGER", 0, null, 0],
    ["compactionMode", "TEXT", 0, null, 0],
    ["handoffThreshold", "INTEGER", 0, null, 0],
    ["guardThreshold", "INTEGER", 0, null, 0],
    ["autoHandoff", "INTEGER", 1, "0", 0],
    ["lineage", "TEXT", 0, null, 0],
    ["pendingHandoff", "TEXT", 0, null, 0],
  ],
  // `messages` 只有这六列在这里：`hidden` 是**生成列**，`PRAGMA table_info` 不列它
  // （它在 `table_xinfo` 里，flag = 2；单独那条用例盯它）
  messages: [
    ["id", "TEXT", 0, null, 1],
    ["sessionId", "TEXT", 1, null, 0],
    ["seq", "INTEGER", 1, null, 0],
    ["createdAt", "INTEGER", 1, null, 0],
    ["payload", "TEXT", 1, null, 0],
    ["searchText", "TEXT", 1, "''", 0],
  ],
  inbox: [
    ["messageId", "TEXT", 0, null, 1],
    ["sessionId", "TEXT", 1, null, 0],
    ["source", "TEXT", 1, null, 0],
    ["content", "TEXT", 1, null, 0],
    ["createdAt", "TEXT", 1, null, 0],
    ["seq", "INTEGER", 1, null, 0],
  ],
  assets: [
    ["id", "TEXT", 0, null, 1],
    ["name", "TEXT", 0, null, 0],
    ["path", "TEXT", 1, null, 0],
    ["mime", "TEXT", 1, null, 0],
    ["bytes", "INTEGER", 1, null, 0],
    ["sha256", "TEXT", 1, null, 0],
    ["width", "INTEGER", 0, null, 0],
    ["height", "INTEGER", 0, null, 0],
    ["createdAt", "INTEGER", 1, null, 0],
  ],
  session_assets: [
    ["sessionId", "TEXT", 1, null, 0],
    ["messageId", "TEXT", 1, null, 0],
    ["assetId", "TEXT", 1, null, 0],
    ["createdAt", "INTEGER", 1, null, 0],
  ],
  asset_vendor_files: [
    ["assetId", "TEXT", 1, null, 0],
    ["endpointId", "TEXT", 1, null, 0],
    ["vendorFileId", "TEXT", 1, null, 0],
    ["createdAt", "INTEGER", 1, null, 0],
  ],
  notices: [
    ["id", "TEXT", 0, null, 1],
    ["level", "TEXT", 1, null, 0],
    ["code", "TEXT", 1, null, 0],
    ["params", "TEXT", 0, null, 0],
    ["durationMs", "INTEGER", 0, null, 0],
    ["sessionId", "TEXT", 0, null, 0],
    ["origin", "TEXT", 1, "'app'", 0],
    ["createdAt", "INTEGER", 1, null, 0],
  ],
  credentials: [
    ["id", "TEXT", 0, null, 1],
    ["note", "TEXT", 1, "''", 0],
    ["hash", "TEXT", 1, null, 0],
    ["createdAt", "INTEGER", 1, null, 0],
    ["revokedAt", "INTEGER", 0, null, 0],
  ],
};

/** 全部表（含 FTS5 的虚表与它自己那四张影子表），按名字排好 —— 多一张少一张都算形状变了 */
const EXPECTED_TABLES = [
  "asset_vendor_files",
  "assets",
  "credentials",
  "inbox",
  "messages",
  "messages_fts",
  "messages_fts_config",
  "messages_fts_data",
  "messages_fts_docsize",
  "messages_fts_idx",
  "meta",
  "notices",
  "session_assets",
  "sessions",
  "workspaces",
];

/** 自己起的索引（不含主键 / UNIQUE 自动生成的那批 `sqlite_autoindex_*`）与它们的列 */
const EXPECTED_INDEXES: Record<string, string[]> = {
  idx_sessions_workspace: ["workspaceId", "pinned", "createdAt"],
  idx_messages_session_seq: ["sessionId", "seq"],
  idx_inbox_session: ["sessionId", "seq"],
  idx_session_assets_asset: ["assetId"],
  idx_session_assets_session: ["sessionId"],
  idx_notices_createdAt: ["createdAt"],
  idx_notices_session: ["sessionId"],
  idx_credentials_hash: ["hash"],
};

/** FTS 同步靠这三条触发器（都在 messages 上） */
const EXPECTED_TRIGGERS = [
  "messages_fts_after_delete",
  "messages_fts_after_insert",
  "messages_fts_after_update",
];

describe("migrate", () => {
  it("全新库跑一次就建齐所有表，版本号落到最新", async () => {
    // 这条要的是「迁移刚刚真的跑过一趟」（下面断言建库时间 >= 本用例开始），
    // 共享库的 meta 是文件级那一趟写的，不成立 —— 所以自己开一个全新库。
    const db = ownDatabase("fresh-migrate.db");
    const before = Date.now();
    await migrate(db);

    const meta = new MetaRepository(db);
    // 一条迁移都没跑过 = 空库；跑完一级就是当前形状，所以最新版本号是 1
    expect(MIGRATIONS).toHaveLength(1);
    expect(await meta.getSchemaVersion()).toBe(1);
    expect(LATEST_VERSION).toBe(1);
    expect((await meta.getState())?.createdAt).toBeGreaterThan(0);
    // 建库时间就是这一跳写的（不是 0、也不是未来时间）
    expect((await meta.getState())?.createdAt).toBeGreaterThanOrEqual(before);

    const names = await tableNames(db);
    for (const expected of [
      "workspaces",
      "sessions",
      "messages",
      "inbox",
      "assets",
      "session_assets",
      "asset_vendor_files",
      "notices",
      "credentials",
      "meta",
      "messages_fts",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("新库跑完就是最终形状：表 / 列 / 索引 / 触发器逐项对上", async () => {
    // 这条要一个刚建出来的库，所以自己开一个
    const db = ownDatabase("fresh-shape.db");
    await migrate(db);

    // 1. 表：一张不多、一张不少
    expect(await tableNames(db)).toEqual(EXPECTED_TABLES);

    // 2. 列：每张表的列名、类型、可不可空、缺省值、主键，按顺序逐格对上
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const columns = await db.all<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>(`PRAGMA table_info('${table}')`);
      expect(
        columns.map((column) => [
          column.name,
          column.type,
          column.notnull,
          column.dflt_value,
          column.pk,
        ]),
      ).toEqual(expected);
    }

    // 3. 索引：自己起的那些都在，且都在该在的列上
    const indexRows = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
    );
    expect(indexRows.map((row) => row.name)).toEqual(Object.keys(EXPECTED_INDEXES).sort());
    for (const [name, expected] of Object.entries(EXPECTED_INDEXES)) {
      const columns = await db.all<{ name: string }>(`PRAGMA index_info('${name}')`);
      expect(columns.map((column) => column.name)).toEqual(expected);
    }

    // 4. 触发器：FTS 同步那三条
    const triggers = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    );
    expect(triggers.map((row) => row.name)).toEqual(EXPECTED_TRIGGERS);
  });

  it("同一个库跑两次是幂等的：已经是最新版本时一条语句都不执行", async () => {
    // 共享库已经迁过，但这里要看「第一次真的跑过之后」的对照，所以自己开一个全新库
    const db = ownDatabase("fresh-migrate-idempotent.db");
    const meta = new MetaRepository(db);

    await migrate(db);
    const first = await meta.getState();
    expect(first?.schemaVersion).toBe(LATEST_VERSION);

    // 再跑两次：不炸，版本号不倒退，建库时间也不被重写（那一格只在迁移那一跳写一次）
    await expect(migrate(db)).resolves.toBeUndefined();
    await expect(migrate(db)).resolves.toBeUndefined();
    expect(await meta.getState()).toEqual(first);
    expect(await meta.getSchemaVersion()).toBe(LATEST_VERSION);

    // 「不再执行」不是从「没有副作用」猜出来的：把一张表删掉再 migrate，它不会被建回来 ——
    // 版本号已经是最新，整条迁移被跳过。这正是幂等要的那件事（而不是「重复跑也不报错」）。
    await db.run("DROP TABLE inbox");
    await migrate(db);
    expect(await tableNames(db)).not.toContain("inbox");
    expect(await meta.getSchemaVersion()).toBe(LATEST_VERSION);
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

  it("表结构钉住两列真值：名字是否自动起（R35）与「消息只有一套取法」", async () => {
    await migrate(db);

    type ColumnInfo = { name: string; notnull: number; dflt_value: string | null };
    const sessionColumns = await db.all<ColumnInfo>("PRAGMA table_info('sessions')");
    const nameIsAuto = sessionColumns.find((column) => column.name === "nameIsAuto");
    // 非空且默认 1：创建时的原名算自动起的名字
    expect(nameIsAuto).toMatchObject({ notnull: 1, dflt_value: "1" });

    const messageColumns = await db.all<ColumnInfo>("PRAGMA table_info('messages')");
    // 消息只有一套取法：subagent 的话不入库（CORE.md §17），所以没有
    // `parentToolCallId` 那种「挂在哪次工具调用上」的列，也没有按它取的索引
    expect(messageColumns.some((column) => column.name === "parentToolCallId")).toBe(false);
    expect(
      await db.all(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_parent_tool_call'",
      ),
    ).toEqual([]);
  });

  it("sessions 行上的格子：哪些可空、自动交接开关的缺省落在「问」那一侧（0）", async () => {
    await migrate(db);

    type ColumnInfo = { name: string; notnull: number; dflt_value: string | null };
    const columns = await db.all<ColumnInfo>("PRAGMA table_info('sessions')");
    // 压缩两格 + 两条阈值 + 血缘：可空、无缺省。NULL 分别是「从来没压过」/「跟模型走」/「用户建的」
    for (const name of [
      "compactedAt",
      "compactionMode",
      "handoffThreshold",
      "guardThreshold",
      "lineage",
    ]) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        notnull: 0,
        dflt_value: null,
      });
    }
    // 待交接那一格也可空：NULL = 没有待交接
    expect(columns.find((column) => column.name === "pendingHandoff")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    // 自动交接开关非空、缺省 **0**：0 就是常态那一侧 —— 撞线停下来问一句（PRD 4.10）。
    // 「不问」是例外（平级会话，创建那一刻显式写 1），而缺省值只在这种时候说话：写入方漏写了。
    expect(columns.find((column) => column.name === "autoHandoff")).toMatchObject({
      notnull: 1,
      dflt_value: "0",
    });
  });

  it("messages 表只有七列：整条消息一个 `payload`，`hidden` 是生成列", async () => {
    await migrate(db);

    type ColumnInfo = { name: string; notnull: number; dflt_value: string | null; hidden: number };
    // 用 `table_xinfo` 而不是 `table_info`：生成列只在前者里出现
    const columns = await db.all<ColumnInfo>("PRAGMA table_xinfo('messages')");
    expect(columns.map((column) => column.name)).toEqual([
      "id",
      "sessionId",
      "seq",
      "createdAt",
      "payload",
      "searchText",
      "hidden",
    ]);

    // 把消息拆开存的那七列不该在：消息是整条存的，读写两侧都只有 stringify / parse
    for (const name of ["role", "status", "omit", "content", "data", "source", "updatedAt"]) {
      expect(columns.some((column) => column.name === name)).toBe(false);
    }

    // `payload` / `searchText` 必须有值
    expect(columns.find((column) => column.name === "payload")).toMatchObject({ notnull: 1 });
    expect(columns.find((column) => column.name === "searchText")).toMatchObject({
      notnull: 1,
      dflt_value: "''",
    });
    // `seq` / `createdAt` 留着是为了 SQL 里排序与定位，不是消息对象的字段
    expect(columns.find((column) => column.name === "seq")).toMatchObject({ notnull: 1 });
    expect(columns.find((column) => column.name === "createdAt")).toMatchObject({ notnull: 1 });

    // `hidden` 是 VIRTUAL 生成列（`table_info` 里 hidden = 2 就是动态生成），JS 侧不维护它
    expect(columns.find((column) => column.name === "hidden")).toMatchObject({ hidden: 2 });

    await db.run(
      "INSERT INTO workspaces (id, name, cwd, createdAt) VALUES ('w1', '项目', '/tmp/s', 1)",
    );
    await db.run(
      `INSERT INTO sessions (id, workspaceId, name, agentId, modelId, createdAt, updatedAt)
       VALUES ('c1', 'w1', '会话', 'a1', 'm1', 2, 2)`,
    );
    // 写进去的就是整条消息；`hidden` 不用写，库自己从 `payload` 里取
    await db.run(
      `INSERT INTO messages (id, sessionId, seq, createdAt, payload, searchText)
       VALUES ('m1', 'c1', 1, 3, '{"id":"m1","role":"user","status":"completed","content":"你好","hidden":true}', '你好')`,
    );
    // `payload` 里没有 `hidden` 时生成列是 NULL
    await db.run(
      `INSERT INTO messages (id, sessionId, seq, createdAt, payload, searchText)
       VALUES ('m2', 'c1', 2, 4, '{"id":"m2","role":"system","status":"completed","content":"cwd"}', 'cwd')`,
    );
    expect(await db.all("SELECT id, hidden FROM messages ORDER BY seq")).toEqual([
      { id: "m1", hidden: 1 },
      { id: "m2", hidden: null },
    ]);
    // 所以「给用户看」的条件是 `hidden IS NOT 1`：NULL 与 0 都算看得见
    expect(await db.all("SELECT id FROM messages WHERE hidden IS NOT 1")).toEqual([{ id: "m2" }]);
    // 整列读回来还是那一条：没被拆成列、也没被改写
    expect(
      (await db.get<{ payload: string }>("SELECT payload FROM messages WHERE id = 'm1'"))?.payload,
    ).toBe('{"id":"m1","role":"user","status":"completed","content":"你好","hidden":true}');
  });

  it("库里不该有的东西：没有题表，也没有第二套取法的列与索引", async () => {
    await migrate(db);

    // 题改成进程内对象（PRD 4.10 的「只做实时」）：表与它的索引都不该存在
    const tables = await tableNames(db);
    expect(tables).not.toContain("questions");
    expect(
      await db.all(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_questions_session'",
      ),
    ).toEqual([]);

    // 消息的第二套取法（parentToolCallId）连同它的索引一起不该存在
    const messageColumns = await db.all<{ name: string }>("PRAGMA table_info('messages')");
    expect(messageColumns.some((column) => column.name === "parentToolCallId")).toBe(false);
    expect(
      await db.all(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_parent_tool_call'",
      ),
    ).toEqual([]);
  });

  it("inbox 表按「条目上有什么就存什么」建起来，顺序列与按会话取的索引都在", async () => {
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
      `INSERT INTO messages (id, sessionId, seq, createdAt, payload, searchText)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "msg1",
        "c1",
        1,
        3,
        '{"id":"msg1","role":"user","status":"completed","content":"你好"}',
        "你好",
      ],
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
    // 排在队列里还没被取走的一条条目：会话/工作区没了它也就没有去处（inbox 的级联）
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
    // inbox 行跟着会话/项目一起没：不留孤儿
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
    // 条目也是：它排在那个会话的 inbox 里，会话没了它也就没有去处
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
        `INSERT INTO messages (id, sessionId, seq, createdAt, payload, searchText)
         VALUES ('x', 'does-not-exist', 1, 1, '{"id":"x","role":"user"}', '')`,
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("FTS 索引与主表一致（integrity-check 通过）", async () => {
    await seed();
    const result = await db.run(
      "INSERT INTO messages_fts (messages_fts) VALUES ('integrity-check')",
    );
    expect(result.changes).toBeGreaterThanOrEqual(0);
  });
});
