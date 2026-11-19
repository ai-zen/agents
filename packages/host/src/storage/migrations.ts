/**
 * 建表与迁移。
 *
 * `meta.schemaVersion` 是唯一的版本真相：`migrate` 从当前版本往上逐级执行，
 * 每一级的所有语句 + 版本号推进都在**同一个事务**里 —— 结构改了一半而版本号没动，
 * 或者版本号动了而结构没改，都会让下次启动跑在错误的假设上。
 *
 * 不识别任何旧数据、不做数据搬迁（PRD 1.9「明确不做」：迁移或识别旧数据）。
 *
 * **一条迁移都没跑过，就是当前形状**：`MIGRATIONS` 只有一条 v1，它是这套表结构的完整建表语句 ——
 * 所有表、所有列、所有索引一次建齐。「先建个缺几列的、再 ADD COLUMN 补齐」「先建一张表、
 * 再 DROP 掉」这类写法，只在模拟一段不存在的演进史时才有意义；这里没有旧库，所以不写。
 *
 * 将来改结构时**追加**新条目（v2、v3 ……）：一个库的版本号只往前走一次，跑过的条目不会重跑，
 * 所以往后的结构变化只能靠新增条目；回头改旧条目会让两台机器的表结构悄悄分叉。
 *
 * **库里没有旧版本**：这套表结构还没随任何版本发出去，表名 / 列名 / 索引名就是现在这一版
 * （`sessions` / `session_assets` / `sessionId`）。改名时**没有**写 `RENAME`、也没有新增条目：
 * 建表语句就地改，版本号序列不变。本地开发库不迁移 —— 删掉重来即可。
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
 * 迁移列表：只有一条 v1，内容就是整套建表语句。
 *
 * 「版本号 + 逐级执行 + 一级一个事务」这套机制留着，因为将来加列 / 加表还要用它：
 * 老库靠新追加的那一条补上，新库从 0 直接跑到最新。现在它只会经历 `0 → 1`。
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
      // nameIsAuto 记住「这个名字是不是自动起的」（R35）：创建时的原名算自动，用户改名置 0，
      // 自动命名写入新名并置 1。
      // thinkingLevel 存档位名（可空）：空 = 跟随助手定义上的那份参数；非空 = 这一段会话选的档位，
      // 装配 agent 时按该模型的思考策略表展开成参数补丁。
      //
      // compactedAt / compactionMode 是「压过」这件事的另外两格事实：光有消息上的 `omit` 位与
      // 一条交接断点消息，说不出「什么时候压的、自动还是手动」。compactedAt 是时刻（可空 =
      // 从来没压过），compactionMode 是 `"auto"`（派生会话自动压）/ `"manual"`（用户答完
      // 交接问题后压）。
      //
      // handoffThreshold / guardThreshold 是两条阈值的会话级覆盖值（PRD 1.4 的 11 格）：
      // 可空 = 跟模型走（`models[].tokenThresholds` 那份），非空 = 这段会话自己定过。
      //
      // autoHandoff 是自动交接开关：0 = 关（常态，撞线停下来问一句，PRD 4.10）/ 1 = 开
      // （平级会话，撞线自己交班）。非空、缺省 **0**：缺省值只在有人漏写时说话，而猜错的代价
      // 不对称 —— 猜成「问」最多多问一句（用户答「不交接」就不再问，PRD 4.10 的「答案的后果
      // 要落」），猜成「不问」则是用户从头到尾不知道发生过什么。写入方（创建处）一定显式写：
      // 用户建 0 / 平级会话 1。
      //
      // lineage 是血缘（可空）：NULL = 用户建的；非空 = 开这段会话的那段会话的 id。它只是**身份**
      // （历史展示「由会话 X 创建」），不是通行证 —— 投递不看关系（PRD 1.2 / 4.6）。
      //
      // pendingHandoff 是「答完题之后当时不闲、等它闲下来再交接」的那一格（`PLAN §5.2`）：
      // `"self"` / `"summary"`，NULL = 没有待交接。它必须落库：「等下一次变闲」可能跨重启，
      // 而重启之后题已经没了（题不落库，见下面「库里没有题表」那段），这是**唯一**能带着走的
      // 那份事实。
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
      // source 存「这条是谁说的」，是 core 的 `AgentNS.MessageSource` 判别结构的 **JSON**
      // （`{kind:"user"}` / `{kind:"agent", label}` / `{kind:"system", label}`）——
      // 用自由字符串就得把 `"user"` 当保留字，一个恰好叫 `user` 的 agent 就把它顶翻了
      // （`CORE.md` §3）。可空 = 那一行**没记过**来源，读出来是 `source: null`
      // （「不知道」，不是「用户说的」）：新建会话的第一条 cwd 消息就是这样。
      //
      // 消息只有一套取法，会话里的每一条都在这张表里：subagent 的话从来不入库
      // （`CORE.md` §17），所以没有 `parentToolCallId` 那种「挂在哪次工具调用上」的列 ——
      // 它会永远 NULL，还顺手给出第二套「这段会话有多少条消息」的算法。
      `CREATE TABLE IF NOT EXISTS messages (
         id          TEXT PRIMARY KEY,
         sessionId   TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
         seq         INTEGER NOT NULL,
         role        TEXT NOT NULL,
         status      TEXT NOT NULL,
         omit        INTEGER NOT NULL DEFAULT 0,
         content     TEXT NOT NULL DEFAULT '',
         data        TEXT,
         searchText  TEXT NOT NULL DEFAULT '',
         createdAt   INTEGER NOT NULL,
         updatedAt   INTEGER NOT NULL,
         source      TEXT,
         UNIQUE (sessionId, seq)
       )`,
      // 按会话顺序读取，以及 `after=<消息 id>` 定位
      `CREATE INDEX IF NOT EXISTS idx_messages_session_seq
         ON messages (sessionId, seq)`,

      // inbox：队列里**还没被取走**的那些条目落库（PRD 1.2 / 4.12）—— 条目只活在 core 的
      // 队列里就会「关掉就丢东西」，而 PRD 要的是「打开就是上次的样子，包括没被处理的
      // 那几句话 —— 它们还在等」。
      //
      // **列按「条目上有什么就存什么」**（`CORE.md` §3 的 `InboxEntryWithContent`），
      // 内容一个字都不清理、不派生、不转换：
      //
      // - `messageId`：主键。它同时是恢复时的去重键（「这条已经落地过了就扔掉」），而同一个
      //   id 也不会入队两次 —— 它是客户端乐观回显用的那个 id（PRD D5），投递方定死；
      // - `sessionId`：这一条排在哪段会话的队列里。删会话 / 删工作区时条目跟着没 ——
      //   它是那段会话 inbox 里的条目，会话没了它就没有去处（与 `notices` / `messages` 同一个口径）；
      // - `source`：core 的 `MessageSource` 判别结构的 **JSON 原文**（不是字符串，口径同
      //   `messages.source`）；
      // - `content`：正文的 **JSON 原文**，字符串与多模态段数组都原样进去、原样读回来
      //   （落库时清理会让两次请求的前缀对不上，prompt caching 全 miss）；
      // - `createdAt`：条目的 ISO 串**原样**。这里是 TEXT 而不是全库惯用的 INTEGER 毫秒 ——
      //   条目上那一格就是 ISO 串，存下来要读回同一个值（「一个字段都不重算」）；
      // - `seq`：入队顺序。**必须要它**：`createdAt` 只到毫秒，同一毫秒进来的两条（一次批量
      //   投递、重启后紧接着投）会撞在一起，光按 `createdAt` 排就还原不回它们本来的先后。
      //   它在**一段会话内**递增（入队就是队尾，于是「顺序 = 取件顺序」这条在库里也成立）。
      `CREATE TABLE IF NOT EXISTS inbox (
         messageId      TEXT PRIMARY KEY,
         sessionId      TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
         source         TEXT NOT NULL,
         content        TEXT NOT NULL,
         createdAt      TEXT NOT NULL,
         seq            INTEGER NOT NULL
       )`,
      // 按会话取，且顺序即入队顺序（装配时按会话一次取干是唯一的读取路径，
      // 两者一个复合索引就够，不再为 `seq` 单建一条）
      `CREATE INDEX IF NOT EXISTS idx_inbox_session ON inbox (sessionId, seq)`,

      // assets：二进制素材的唯一真相（PRD L2 / F-H8）—— 文件在 assets/ 下，这一行记的是引用、
      // 大小、类型、内容摘要与像素尺寸。
      // 去重是**全局**的：sha256 唯一，同一份字节在整台机器上只有一行、一份磁盘。所以这张表
      // 不再记「属于哪段会话 / 哪条消息」：归属在 session_assets 里，一张图贴到两个项目
      // 就是一行素材 + 两行关系。
      // width / height 可空：落定时按文件头解（PNG / JPEG），解不出来就是 NULL。
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

      // session_assets：谁引用了哪份素材（消息 × 素材的关系行）。
      // 写入时机是消息落库那一刻（扫 content 里的 `__asset_id`，同一 message+asset 一行）；
      // 撤回 / 删会话 / 删消息都由外键级联删掉关系行，不需要谁去减计数。
      // assetId 用 RESTRICT：还有人引用时物理删不掉素材行（护栏），真正的删除条件由
      // 「COUNT(*) = 0」判定（见 AssetRepository.deleteIfUnreferenced）。
      // 「几张会话引用了它」= COUNT(DISTINCT sessionId)，走 idx_session_assets_asset。
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

      // asset_vendor_files：厂商侧文件 id 的缓存（端点维度）。
      // 它**不是**真相：删光之后从 assets 重建即可（下次发送时重新上传一遍），所以这里只记
      // 「哪个素材在哪个端点上对应哪个 file_id」；素材没了就跟着走。
      `CREATE TABLE IF NOT EXISTS asset_vendor_files (
         assetId      TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
         endpointId   TEXT NOT NULL,
         vendorFileId TEXT NOT NULL,
         createdAt    INTEGER NOT NULL,
         UNIQUE (assetId, endpointId)
       )`,
      // 缓存行的两种查法靠 UNIQUE (assetId, endpointId)：
      // 「这个端点上有没有」与「别的端点上有没有」都走这条（都是 assetId 前缀查询）

      // notices：持久化，durationMs 为 null 表示永久（PRD L3）。
      // sessionId 是「这条通知与哪段会话有关」的真值（可空 = 全局通知）：按会话过滤、
      // 按会话清都走这一列；会话没了它也就没有意义，所以跟着级联删除。
      `CREATE TABLE IF NOT EXISTS notices (
         id             TEXT PRIMARY KEY,
         level          TEXT NOT NULL,
         code           TEXT NOT NULL,
         params         TEXT,
         durationMs     INTEGER,
         sessionId      TEXT REFERENCES sessions (id) ON DELETE CASCADE,
         createdAt      INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_notices_createdAt ON notices (createdAt)`,
      `CREATE INDEX IF NOT EXISTS idx_notices_session ON notices (sessionId)`,

      // 库里没有题表：题改成进程内对象（`services/QuestionService.ts`），只做实时（PRD 4.10）。
      // 题存在的意义是「答完之后触发某件事」，所以要有活着的消费者来消费它 —— 落进库里的那一行
      // 在重启之后只会变成一个没人认领的孤儿。题的生命 = 这段会话活着的这段时间；
      // 「等它闲下来再交接」这个必须跨重启的事实落在 sessions.pendingHandoff 上，不落在题上。

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
