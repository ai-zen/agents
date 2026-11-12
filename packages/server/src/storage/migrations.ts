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
 * 迁移列表。眼下只有 v1：这套表结构还没随版本发出去，PM 在 W1 之后的裁定（cwd 唯一、
 * 身份列非空）直接落进了 v1 的建表语句。再往后改结构时追加新条目 —— 已经装上升过级的库
 * 不会重跑旧条目，改旧条目会让两台机器的表结构悄悄分叉。
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

      // workspaces：一个工作目录登记一次。cwd 不可变（PRD D9），所以没有更新的入口。
      // cwd 唯一：同一个目录登记两次会出现两个 Scope 抢同一目录；唯一约束自带的索引
      // 就是「这个 cwd 登记过没有」（PRD D10 的问一次）的查询路径，不再另建普通索引
      `CREATE TABLE IF NOT EXISTS workspaces (
         id        TEXT PRIMARY KEY,
         name      TEXT NOT NULL,
         cwd       TEXT NOT NULL UNIQUE,
         createdAt INTEGER NOT NULL
       )`,

      // conversations：项目 / 助手创建时定死，模型与思考档位是这段会话自己的（可以改）。
      // agentId / modelId 不允许为空 —— 解析不出助手或模型时在创建处就失败，不落半成品行。
      // nameIsAuto 记住「这个名字是不是自动起的」（R35）：创建时的原名算自动，用户改名置 0，
      // 自动命名写入新名并置 1。
      // thinkingLevel 存档位名（可空）：空 = 跟随助手定义上的那份参数；非空 = 这一段会话选的档位，
      // 装配 agent 时按该模型的思考策略表展开成参数补丁。
      `CREATE TABLE IF NOT EXISTS conversations (
         id            TEXT PRIMARY KEY,
         workspaceId   TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
         name          TEXT NOT NULL,
         nameIsAuto    INTEGER NOT NULL DEFAULT 1,
         pinned        INTEGER NOT NULL DEFAULT 0,
         agentId       TEXT NOT NULL,
         modelId       TEXT NOT NULL,
         thinkingLevel TEXT,
         createdAt     INTEGER NOT NULL,
         updatedAt     INTEGER NOT NULL
       )`,
      // 侧栏排序 = 置顶优先、再按创建时间倒序（PRD D13）；活动/改名不影响顺序
      `CREATE INDEX IF NOT EXISTS idx_conversations_workspace
         ON conversations (workspaceId, pinned DESC, createdAt DESC)`,

      // messages：边流边写，同一条消息按 id 反复覆盖（PRD D15）。
      // parentToolCallId 记录子 Agent 消息挂在哪次工具调用上（R37），顶层消息为空。
      `CREATE TABLE IF NOT EXISTS messages (
         id               TEXT PRIMARY KEY,
         conversationId   TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
         seq              INTEGER NOT NULL,
         role             TEXT NOT NULL,
         status           TEXT NOT NULL,
         omit             INTEGER NOT NULL DEFAULT 0,
         content          TEXT NOT NULL DEFAULT '',
         data             TEXT,
         searchText       TEXT NOT NULL DEFAULT '',
         parentToolCallId TEXT,
         createdAt        INTEGER NOT NULL,
         updatedAt        INTEGER NOT NULL,
         UNIQUE (conversationId, seq)
       )`,
      // 按对话顺序读取，以及 `after=<消息 id>` 定位
      `CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq
         ON messages (conversationId, seq)`,
      // 按父工具调用取子 Agent 的消息（R37 的读取路径）；NULL 行不进索引，顶层消息不受影响
      `CREATE INDEX IF NOT EXISTS idx_messages_parent_tool_call
         ON messages (parentToolCallId)`,

      // assets：二进制素材的唯一真相（PRD L2 / F-H8）—— 文件在 assets/ 下，这一行记的是引用、
      // 大小、类型、内容摘要与像素尺寸。消息里只写 `asset://<id>`，历史图因此能被任何模型重放。
      // messageId 用 SET NULL：撤回硬删消息时素材行要留着，否则文件变成没人认领的孤儿（PRD D17）
      // sha256 非空：它是「对话内去重」的键（同一张图贴两次只占一份磁盘、一次上行）。
      // width / height 可空：要解码图片才拿得到，本波不引入图像库，未知就是 NULL。
      `CREATE TABLE IF NOT EXISTS assets (
         id             TEXT PRIMARY KEY,
         conversationId TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
         messageId      TEXT REFERENCES messages (id) ON DELETE SET NULL,
         name           TEXT,
         path           TEXT NOT NULL,
         mime           TEXT NOT NULL,
         bytes          INTEGER NOT NULL,
         sha256         TEXT NOT NULL,
         width          INTEGER,
         height         INTEGER,
         createdAt      INTEGER NOT NULL,
         UNIQUE (conversationId, sha256)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_assets_conversation ON assets (conversationId)`,
      `CREATE INDEX IF NOT EXISTS idx_assets_message ON assets (messageId)`,

      // asset_vendor_files：厂商侧文件 id 的可失效缓存（端点维度、会过期）。
      // 它**不是**真相：删光之后从 assets 重建即可（下次发送时重新上传一遍），所以这里只记
      // 「哪个素材在哪个端点上对应哪个 file_id」与最后一次用它的时刻；素材没了就跟着走。
      `CREATE TABLE IF NOT EXISTS asset_vendor_files (
         assetId      TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
         endpointId   TEXT NOT NULL,
         vendorFileId TEXT NOT NULL,
         createdAt    INTEGER NOT NULL,
         lastUsedAt   INTEGER NOT NULL,
         UNIQUE (assetId, endpointId)
       )`,
      // 清理时按「最近用过的」判（哪一段对话的哪些缓存已经放了很久）
      `CREATE INDEX IF NOT EXISTS idx_asset_vendor_files_lastUsedAt
         ON asset_vendor_files (lastUsedAt)`,
      // 「这段对话在这个端点上的缓存」靠 UNIQUE (assetId, endpointId) 那条索引 join assets 拿到，
      // 不再另建一份（按 assetId 的前缀查询也走那条）

      // notices：持久化，durationMs 为 null 表示永久（PRD L3）。
      // conversationId 是「这条通知与哪段对话有关」的真值（可空 = 全局通知）：按对话过滤、
      // 按对话清都走这一列；对话没了它也就没有意义，所以跟着级联删除。
      `CREATE TABLE IF NOT EXISTS notices (
         id             TEXT PRIMARY KEY,
         level          TEXT NOT NULL,
         code           TEXT NOT NULL,
         params         TEXT,
         durationMs     INTEGER,
         conversationId TEXT REFERENCES conversations (id) ON DELETE CASCADE,
         createdAt      INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_notices_createdAt ON notices (createdAt)`,
      `CREATE INDEX IF NOT EXISTS idx_notices_conversation ON notices (conversationId)`,

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
