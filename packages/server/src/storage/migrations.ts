/**
 * 建表与迁移。
 *
 * `meta.schemaVersion` 是唯一的版本真相：`migrate` 从当前版本往上逐级执行，
 * 每一级的所有语句 + 版本号推进都在**同一个事务**里 —— 结构改了一半而版本号没动，
 * 或者版本号动了而结构没改，都会让下次启动跑在错误的假设上。
 *
 * 不识别任何旧数据、不做数据搬迁（PRD L1：新库从空开始）。
 */

import type { Database } from "./Database.js";
import { MetaRepository } from "./MetaRepository.js";

export interface Migration {
  /** 目标版本号：跑完这一级后 `meta.schemaVersion` 即为此值 */
  version: number;
  /** 这一级要执行的语句，按顺序在同一事务内执行 */
  statements: string[];
}

/**
 * 迁移列表。只追加、不改写已发布的条目：已经装在别人机器上升过级的库不会再跑旧条目，
 * 改旧条目等于让两台机器的表结构悄悄分叉。
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      // meta：单行表（id 固定为 1），存 schemaVersion 与建库时间
      `CREATE TABLE IF NOT EXISTS meta (
         id            INTEGER PRIMARY KEY CHECK (id = 1),
         schemaVersion INTEGER NOT NULL,
         createdAt     INTEGER NOT NULL
       )`,

      // workspaces：一个工作目录登记一次。cwd 不可变（PRD D9），所以没有更新的入口
      `CREATE TABLE IF NOT EXISTS workspaces (
         id        TEXT PRIMARY KEY,
         name      TEXT NOT NULL,
         cwd       TEXT NOT NULL,
         createdAt INTEGER NOT NULL
       )`,
      // 「这个 cwd 登记过没有」（PRD D10 的问一次）走这条索引
      `CREATE INDEX IF NOT EXISTS idx_workspaces_cwd ON workspaces (cwd)`,

      // conversations：身份（workspace / 助手 / 模型）创建时定死（PRD L7）
      `CREATE TABLE IF NOT EXISTS conversations (
         id          TEXT PRIMARY KEY,
         workspaceId TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
         name        TEXT NOT NULL,
         pinned      INTEGER NOT NULL DEFAULT 0,
         agentId     TEXT,
         modelId     TEXT,
         createdAt   INTEGER NOT NULL,
         updatedAt   INTEGER NOT NULL
       )`,
      // 侧栏排序 = 置顶优先、再按创建时间倒序（PRD D13）；活动/改名不影响顺序
      `CREATE INDEX IF NOT EXISTS idx_conversations_workspace
         ON conversations (workspaceId, pinned DESC, createdAt DESC)`,

      // messages：边流边写，同一条消息按 id 反复覆盖（PRD D15）
      `CREATE TABLE IF NOT EXISTS messages (
         id             TEXT PRIMARY KEY,
         conversationId TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
         seq            INTEGER NOT NULL,
         role           TEXT NOT NULL,
         status         TEXT NOT NULL,
         omit           INTEGER NOT NULL DEFAULT 0,
         content        TEXT NOT NULL DEFAULT '',
         data           TEXT,
         searchText     TEXT NOT NULL DEFAULT '',
         createdAt      INTEGER NOT NULL,
         updatedAt      INTEGER NOT NULL,
         UNIQUE (conversationId, seq)
       )`,
      // 按对话顺序读取，以及 `after=<消息 id>` 定位
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq
         ON messages (conversationId, seq)`,

      // assets：二进制素材落 assets/，库里只存引用（PRD L2）
      // messageId 用 SET NULL：撤回硬删消息时素材行要留着，否则文件变成没人认领的孤儿（PRD D17）
      `CREATE TABLE IF NOT EXISTS assets (
         id             TEXT PRIMARY KEY,
         conversationId TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
         messageId      TEXT REFERENCES messages (id) ON DELETE SET NULL,
         name           TEXT,
         path           TEXT NOT NULL,
         mime           TEXT NOT NULL,
         bytes          INTEGER NOT NULL,
         sha256         TEXT,
         createdAt      INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_assets_conversation ON assets (conversationId)`,
      `CREATE INDEX IF NOT EXISTS idx_assets_message ON assets (messageId)`,

      // notices：持久化，durationMs 为 null 表示永久（PRD L3）
      `CREATE TABLE IF NOT EXISTS notices (
         id         TEXT PRIMARY KEY,
         level      TEXT NOT NULL,
         code       TEXT NOT NULL,
         params     TEXT,
         durationMs INTEGER,
         createdAt  INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_notices_createdAt ON notices (createdAt)`,

      // questions：有状态、可持久化、多端共享（PRD D22 / F-I9）
      `CREATE TABLE IF NOT EXISTS questions (
         id             TEXT PRIMARY KEY,
         conversationId TEXT REFERENCES conversations (id) ON DELETE CASCADE,
         kind           TEXT NOT NULL,
         payload        TEXT NOT NULL,
         state          TEXT NOT NULL,
         answer         TEXT,
         createdAt      INTEGER NOT NULL,
         updatedAt      INTEGER NOT NULL,
         answeredAt     INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS idx_questions_conversation
         ON questions (conversationId, createdAt)`,

      // credentials：只存 sha256 摘要，明文不在库里（PRD L11：多串、带备注、可单独吊销）
      `CREATE TABLE IF NOT EXISTS credentials (
         id        TEXT PRIMARY KEY,
         note      TEXT NOT NULL DEFAULT '',
         hash      TEXT NOT NULL,
         createdAt INTEGER NOT NULL,
         revokedAt INTEGER
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_hash ON credentials (hash)`,

      // 全文检索：外部内容表挂在 messages 上，只索引 searchText（正文纯文本，不含 JSON 键名）。
      // tokenize='trigram'：默认的 unicode61 会把整段中文当成一个 token，那样中文搜索永远
      // 命中不了；trigram 按三字符切分，中文子串才搜得到（代价是查询词至少 3 个字符，
      // 少于 3 个字符的查询在仓储里退化到 LIKE，见 MessageRepository.search）
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
         searchText,
         content='messages',
         content_rowid='rowid',
         tokenize='trigram'
       )`,
      // 用触发器同步索引：写路径只有一条（都走 messages 表），不存在「仓储忘了同步」的情况
      `CREATE TRIGGER IF NOT EXISTS messages_fts_after_insert AFTER INSERT ON messages BEGIN
         INSERT INTO messages_fts (rowid, searchText) VALUES (new.rowid, new.searchText);
       END`,
      `CREATE TRIGGER IF NOT EXISTS messages_fts_after_delete AFTER DELETE ON messages BEGIN
         INSERT INTO messages_fts (messages_fts, rowid, searchText)
           VALUES ('delete', old.rowid, old.searchText);
       END`,
      `CREATE TRIGGER IF NOT EXISTS messages_fts_after_update AFTER UPDATE OF searchText ON messages BEGIN
         INSERT INTO messages_fts (messages_fts, rowid, searchText)
           VALUES ('delete', old.rowid, old.searchText);
         INSERT INTO messages_fts (rowid, searchText) VALUES (new.rowid, new.searchText);
       END`,
    ],
  },
];

/**
 * 把库升到最新版本。重复调用是幂等的：已经跑过的版本会跳过，不会再执行一遍语句。
 */
export async function migrate(db: Database): Promise<void> {
  const meta = new MetaRepository(db);
  let current = await meta.getSchemaVersion();
  const now = Date.now();

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const target = migration.version;
    await db.tx((tx) => {
      for (const statement of migration.statements) tx.run(statement);
      // 版本号与结构改动同一次事务提交，两者不会分叉
      tx.run(
        `INSERT INTO meta (id, schemaVersion, createdAt) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET schemaVersion = excluded.schemaVersion`,
        [target, now],
      );
    });
    current = target;
  }
}
