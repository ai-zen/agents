/**
 * 建表与迁移。
 *
 * `meta.schemaVersion` 是唯一的版本真相：`migrate` 从当前版本往上逐级执行，
 * 每一级的所有语句 + 版本号推进都在**同一个事务**里 —— 结构改了一半而版本号没动，
 * 或者版本号动了而结构没改，都会让下次启动跑在错误的假设上。
 *
 * 不识别任何旧数据、不做数据搬迁（PRD 1.9「明确不做」：迁移或识别旧数据）。
 *
 * 眼下只有一条 v1，它是这套表结构的完整建表语句：所有表、所有列、所有索引一次建齐。库里
 * 没有旧版本要兼容，表名 / 列名 / 索引名就直接写在这一条里，不另做 `RENAME` 迁移，也不模拟
 * 「先缺几列、再 ADD COLUMN 补齐」那种演进史。
 *
 * 往后改结构靠追加新条目：一个库的版本号只往前走一次，跑过的条目不会重跑 —— 回头改旧条目
 * 会让两台机器的表结构悄悄分叉。各表的分工、「两个条数口径」、阈值的读写方见 PLAN §7。
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
 * 迁移列表：只有一条 v1，内容就是整套建表语句（新库只会经历 `0 → 1`）。
 *
 * 逐级执行、一级一个事务这套机制留着给往后改结构用：老库靠新追加的那一条补上，新库从 0
 * 跑到最新。
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

      // sessions：项目 / 助手创建时定死，模型与思考档位是这段会话自己的（可以改）。
      // agentId / modelId 不允许为空 —— 解析不出助手或模型时在创建处就失败，不落半成品行。
      // nameIsAuto 记住「这个名字是不是自动起的」：创建时的原名算自动，用户改名置 0，
      // 自动命名写入新名并置 1。thinkingLevel 存档位名（可空）：空 = 跟随助手定义上的那份参数，
      // 非空 = 这一段会话选的档位，装配 agent 时按该模型的策略表展开成参数补丁。
      //
      // compactedAt / compactionMode 是「压过」这件事的另外两格事实：光有消息上的 `omit` 位与
      // 一条交接断点消息，说不出「什么时候压的、自动还是手动」。前者是时刻（可空 = 从来没压过），
      // 后者是 `"auto"`（派生会话自动压）/ `"manual"`（用户答完交接问题后压）。
      //
      // handoffThreshold / guardThreshold 是两条阈值的会话级覆盖层（可空 = 跟模型走，读的
      // 那一侧见 PLAN §7）。autoHandoff 是自动交接开关：0 = 撞线停下来问一句、1 = 撞线自己
      // 交班；缺省 0 只在写入方漏写时说话，`registerSessionInsert` 两处都显式写
      // （用户建 0 / 平级会话 1）。lineage 是血缘：NULL = 用户建的，非空 = 开这段会话的那段
      // 会话 id。pendingHandoff 是「答完题之后当时不闲、等它闲下来再交接」的那一格
      // （`PLAN §5.2`）：`"self"` / `"summary"`，NULL = 没有待交接 —— 它必须落库，因为
      // 「等下一次变闲」可能跨重启，而题本身不落库（见下面「库里没有题表」那段）。
      `CREATE TABLE IF NOT EXISTS sessions (
         id               TEXT PRIMARY KEY,
         workspaceId      TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
         name             TEXT NOT NULL,
         nameIsAuto       INTEGER NOT NULL DEFAULT 1,
         pinned           INTEGER NOT NULL DEFAULT 0,
         agentId          TEXT NOT NULL,
         modelId          TEXT NOT NULL,
         thinkingLevel    TEXT,
         createdAt        INTEGER NOT NULL,
         updatedAt        INTEGER NOT NULL,
         compactedAt      INTEGER,
         compactionMode   TEXT,
         handoffThreshold INTEGER,
         guardThreshold   INTEGER,
         autoHandoff      INTEGER NOT NULL DEFAULT 0,
         lineage          TEXT,
         pendingHandoff   TEXT
       )`,
      // 侧栏排序 = 置顶优先、再按创建时间倒序（PRD D13）；活动/改名不影响顺序
      `CREATE INDEX IF NOT EXISTS idx_sessions_workspace
         ON sessions (workspaceId, pinned DESC, createdAt DESC)`,

      // messages：边流边写，同一条消息按 id 反复覆盖（PRD D15）。
      //
      // `payload` 是 core 的 `AgentNS.Message` **原样一份 JSON**：写进去什么、读出来还是什么
      // （读写两侧都只有 `JSON.stringify` / `JSON.parse`）。不拆成 role / status / content /
      // data 那些列 —— 拆了就得在两侧各维护一份字段清单，而那份清单的唯一作用是把同一条消息
      // 在库里和内存里存成两个样子（`CORE.md` §3）。
      //
      // 列里另外三格**不是消息身上的字段**，是 SQL 里有真实用途的东西：
      //   - `seq`：同会话内的顺序（按它排、`after` / `afterMessageId` 按它定位）；
      //   - `createdAt`：侧栏「最后一条什么时候说的」与搜索的排序；
      //   - `searchText`：FTS 的索引产物（正文纯文本，触发器只碰它）。
      //
      // `problem` 是**回显用的失败事实**（`ProblemFact`）：宿主附加的一条事实，活得比进程长
      // （PRD 4.15），所以它不在消息对象的 JSON 里，单独一列（没有就是 NULL）。
      //
      // `hidden` 是生成列：SQLite 自己从 `payload` 里取 `$.hidden`，JS 侧不维护它。取值只有
      // 1 / 0 / NULL（消息上没有这个键时是 NULL），所以「给用户看」的条件写 `hidden IS NOT 1`。
      //
      // 消息只有一套取法，会话里的每一条都在这张表里：subagent 的话从来不入库
      // （`CORE.md` §17），所以没有 `parentToolCallId` 那种「挂在哪次工具调用上」的列 ——
      // 它会永远 NULL，还顺手给出第二套「这段会话有多少条消息」的算法。
      `CREATE TABLE IF NOT EXISTS messages (
         id         TEXT PRIMARY KEY,
         sessionId  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
         seq        INTEGER NOT NULL,
         createdAt  INTEGER NOT NULL,
         payload    TEXT NOT NULL,
         problem    TEXT,
         searchText TEXT NOT NULL DEFAULT '',
         hidden     INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.hidden') = 1) VIRTUAL,
         UNIQUE (sessionId, seq)
       )`,
      // 按会话顺序读取，以及 `after=<消息 id>` 定位
      `CREATE INDEX IF NOT EXISTS idx_messages_session_seq
         ON messages (sessionId, seq)`,

      // inbox：队列里**还没被取走**的那些条目落库（PRD 1.2 / 4.12）—— 条目只活在 core 的
      // 队列里就会「关掉就丢东西」。列按「条目上有什么就存什么」：`source` / `content` 存
      // JSON 原文，`createdAt` 存条目自带的 ISO 串（所以是 TEXT，不是全库惯用的毫秒 INTEGER），
      // `seq` 是入队顺序（`createdAt` 只到毫秒会撞）。逐列的口径见 `InboxRepository`。
      `CREATE TABLE IF NOT EXISTS inbox (
         messageId      TEXT PRIMARY KEY,
         sessionId      TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
         source         TEXT NOT NULL,
         content        TEXT NOT NULL,
         createdAt      TEXT NOT NULL,
         seq            INTEGER NOT NULL
       )`,
      // 按会话取，且顺序即入队顺序（装配时按会话一次取干是唯一的读取路径）：一条复合索引就够了
      `CREATE INDEX IF NOT EXISTS idx_inbox_session ON inbox (sessionId, seq)`,

      // assets：二进制素材的唯一真相（PRD 1.8）—— 文件在 assets/ 下，这一行记的是引用、
      // 大小、类型、内容摘要与像素尺寸。去重是**全局**的：sha256 唯一，同一份字节在整台机器上
      // 只有一行、一份磁盘。所以这张表不记归属：归属在 session_assets 里，一张图贴到两个项目
      // 就是一行素材 + 两行关系。width / height 可空：落定时按文件头解（PNG / JPEG）。
      `CREATE TABLE IF NOT EXISTS assets (
         id        TEXT PRIMARY KEY,
         name      TEXT,
         path      TEXT NOT NULL,
         mime      TEXT NOT NULL,
         bytes     INTEGER NOT NULL,
         sha256    TEXT NOT NULL UNIQUE,
         width     INTEGER,
         height    INTEGER,
         createdAt INTEGER NOT NULL
       )`,

      // session_assets：谁引用了哪份素材（消息 × 素材的关系行）。写入时机是消息落库那一刻
      // （扫 content 里的 `__asset_id`，同一 message+asset 一行）；撤回 / 删会话 / 删消息都由
      // 外键级联删掉关系行。assetId 用 RESTRICT：还有人引用时物理删不掉素材行，「归零才删」
      // 由 `AssetRepository.deleteIfUnreferenced` 的 `NOT EXISTS` 判。
      `CREATE TABLE IF NOT EXISTS session_assets (
         sessionId      TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
         messageId      TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
         assetId        TEXT NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
         createdAt      INTEGER NOT NULL,
         UNIQUE (messageId, assetId)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_session_assets_asset ON session_assets (assetId)`,
      `CREATE INDEX IF NOT EXISTS idx_session_assets_session
         ON session_assets (sessionId)`,

      // asset_vendor_files：厂商侧文件 id 的缓存（端点维度）。它不是真相：删光之后下次发送
      // 重新上传一遍即可，所以这里只记「哪个素材在哪个端点上对应哪个 file_id」。
      `CREATE TABLE IF NOT EXISTS asset_vendor_files (
         assetId      TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
         endpointId   TEXT NOT NULL,
         vendorFileId TEXT NOT NULL,
         createdAt    INTEGER NOT NULL,
         UNIQUE (assetId, endpointId)
       )`,
      // 缓存行的两种查法靠 UNIQUE (assetId, endpointId)：
      // 「这个端点上有没有」与「别的端点上有没有」都走这条（都是 assetId 前缀查询）

      // notices：持久化，durationMs 为 null 表示永久（PRD 4.9）。
      // sessionId 是「这条通知与哪段会话有关」的真值（可空 = 全局通知）：按会话过滤与按会话清
      // 都走这一列，会话没了它跟着级联删除。origin 是「谁让它出现的」（`app` / `log`）：日志
      // 上浮的那批不落库，所以入库的行里它总是 `app` —— 留着这一列是从库里读得出来源，
      // 而不是读出时按 `code` 反推。
      `CREATE TABLE IF NOT EXISTS notices (
         id             TEXT PRIMARY KEY,
         level          TEXT NOT NULL,
         code           TEXT NOT NULL,
         params         TEXT,
         durationMs     INTEGER,
         sessionId      TEXT REFERENCES sessions (id) ON DELETE CASCADE,
         origin         TEXT NOT NULL DEFAULT 'app',
         createdAt      INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_notices_createdAt ON notices (createdAt)`,
      `CREATE INDEX IF NOT EXISTS idx_notices_session ON notices (sessionId)`,

      // 库里没有题表：题是进程内对象（`services/QuestionService.ts`），只做实时（PRD 4.10）。
      // 题的意义是「答完之后触发某件事」，要有活着的消费者来消费它 —— 落进库里的那一行在重启
      // 之后只会变成没人认领的孤儿。必须跨重启的那件事落在 sessions.pendingHandoff 上。

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
      // tokenize='trigram'：默认的 unicode61 把整段中文当成一个 token，中文搜索永远命中不了；
      // trigram 按三字符切分，中文子串才搜得到 —— 代价是查询词至少 3 个字符，更短的查询由
      // `MessageRepository.search` 退化到 LIKE。
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
