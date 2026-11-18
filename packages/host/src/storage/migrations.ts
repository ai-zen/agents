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
 * 迁移列表。v1 是建表语句本身：这套表结构当时还没随版本发出去，PM 在 W1 之后的裁定（cwd 唯一、
 * 身份列非空）直接落了进去。再往后改结构时追加新条目（v2 压缩两列、v3 消息来源、v4 会话行上
 * 那四列、v5 题不落库 + 待交接 + 删掉第二套取法）—— 已经装上升过级的库不会重跑旧条目，改旧条目
 * 会让两台机器的表结构悄悄分叉。
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
      // 大小、类型、内容摘要与像素尺寸。
      // 去重是**全局**的：sha256 唯一，同一份字节在整台机器上只有一行、一份磁盘。所以这张表
      // 不再记「属于哪段对话 / 哪条消息」：归属在 conversation_assets 里，一张图贴到两个项目
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

      // conversation_assets：谁引用了哪份素材（消息 × 素材的关系行）。
      // 写入时机是消息落库那一刻（扫 content 里的 `__asset_id`，同一 message+asset 一行）；
      // 撤回 / 删对话 / 删消息都由外键级联删掉关系行，不需要谁去减计数。
      // assetId 用 RESTRICT：还有人引用时物理删不掉素材行（护栏），真正的删除条件由
      // 「COUNT(*) = 0」判定（见 AssetRepository.deleteIfUnreferenced）。
      // 「几张会话引用了它」= COUNT(DISTINCT conversationId)，走 idx_conversation_assets_asset。
      `CREATE TABLE IF NOT EXISTS conversation_assets (
         conversationId TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
         messageId      TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
         assetId        TEXT NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
         createdAt      INTEGER NOT NULL,
         UNIQUE (messageId, assetId)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_conversation_assets_asset ON conversation_assets (assetId)`,
      `CREATE INDEX IF NOT EXISTS idx_conversation_assets_conversation
         ON conversation_assets (conversationId)`,

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

      // questions：v1 时代那张题表（有状态、可持久化、多端共享）。v5 已经把它 DROP 掉 ——
      // 题改成进程内对象（PRD 4.10 的「只做实时」）。这条建表语句留着不改：已经装上升过 v1
      // 的库不会重跑旧条目，而改它只会让两台机器的表结构悄悄分叉（见本文件开头）。
      `CREATE TABLE IF NOT EXISTS questions (
         id             TEXT PRIMARY KEY,
         conversationId TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
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
  {
    /**
     * v2：会话上的压缩标记。
     *
     * 压缩从前只留两处痕迹：消息上的 `omit` 位与一条交接断点消息 —— 那是「压过」的结果，
     * 说不出「什么时候压的、自动还是手动」。两列补上这个事实：`compactedAt` 是时刻（可空），
     * `compactionMode` 是 `"auto"`（派生会话自动压）/ `"manual"`（用户答完交接问题后压）。
     *
     * 为什么是 `ALTER TABLE ADD COLUMN` 而不是改 v1 的建表语句：已经装上升过 v1 的库不会重跑
     * 旧条目，改旧条目会让两台机器的表结构悄悄分叉（见本文件开头的注释）。加法两列对所有旧库
     * 都成立，且新列默认 NULL（= 从来没压过）刚好就是旧数据的真相。
     */
    version: 2,
    statements: [
      `ALTER TABLE conversations ADD COLUMN compactedAt INTEGER`,
      `ALTER TABLE conversations ADD COLUMN compactionMode TEXT`,
    ],
  },
  {
    /**
     * v3：消息的来源。
     *
     * core 的 `AgentNS.MessageSource` 从「自由字符串」变成了**判别结构**
     * （`{kind:"user"}` / `{kind:"agent", label}` / `{kind:"system", label}`）：用字符串就得
     * 把 `"user"` 当保留字，一个恰好叫 `user` 的 agent 就把它顶翻了（`CORE.md` §3）。
     *
     * 存的是那段 JSON（`TEXT`），读回来反序列化成同一个形状。旧行这一列是 NULL —— 那不是
     * 「用户说的」，而是「不知道」：这一列出现之前的行没有记过来源。`MessageRepository` 的
     * `toSource` 还兼容「这一列里存的是字符串」的旧形态（早先把来源当自由字符串那种写法）。
     */
    version: 3,
    statements: [`ALTER TABLE messages ADD COLUMN source TEXT`],
  },
  {
    /**
     * v4：会话行补上 PRD 说的另外三格（两条阈值 / 自动交接开关 / 血缘，`PRD.md` 1.4 的 11 格）。
     *
     * 这四样从前压根不在会话行上：两条阈值挂在**模型**上（`tokenThresholds.handoff/guard`），
     * 会话没有覆盖列；自动交接开关与血缘只活在 `PeerSessionService` 的进程内记录里（重启即失，
     * 与 PRD 4.5 / 4.6 直接冲突）。四列都是 `ADD COLUMN`，v1 建表语句一个字不改（理由同 v2）。
     *
     * 两条阈值可空：NULL = 跟模型走（这一段会话没自己定过）。自动交接开关非空、缺省 **0**：SQLite
     * 的 `ADD COLUMN ... NOT NULL` 必须给缺省值，而这个缺省值就是「用户建的那一侧」—— **问**
     * （撞线停下来问一句，PRD 4.10）。写入方（创建处）一定显式写（用户建 0 / 兄弟 1），所以缺省值
     * 只在两种情况说话：旧库里的行，以及将来有人漏写。
     *
     * 缺省从 1 改成 0 的口径（用户拍板：旧库不迁移 —— 「旧户直接删了都没关系」）：从前那个「1」
     * 是拿「兄弟会话」当缺省，于是升级上来的老会话撞线时**不问、自己交班**；现在的口径反过来
     * —— 不问是**例外**（兄弟会话，创建那一刻写死 1），常态是问。「缺省值猜错了」这件事的代价
     * 不对称：猜成「问」最多多问一句（用户答「不交接」就再也不问，PRD 4.10 的「答案的后果要落」），
     * 猜成「不问」则是用户从头到尾不知道发生过什么。
     *
     * 血缘可空：NULL = 用户建的；非空 = 开这段会话的那段会话的 id。它只是**身份**（历史展示
     * 「由会话 X 创建」），不是通行证 —— 投递不看关系（PRD 1.2 / 4.6）。
     */
    version: 4,
    statements: [
      // 两条阈值：会话行上的覆盖值；NULL = 跟模型走（`models[].tokenThresholds` 那份）
      `ALTER TABLE conversations ADD COLUMN handoffThreshold INTEGER`,
      `ALTER TABLE conversations ADD COLUMN guardThreshold INTEGER`,
      // 自动交接开关：0 = 关（常态，撞线问一句）/ 1 = 开（兄弟会话，撞线自己交班）
      `ALTER TABLE conversations ADD COLUMN autoHandoff INTEGER NOT NULL DEFAULT 0`,
      // 血缘：谁开的这段会话（父会话 id）；NULL = 用户建的
      `ALTER TABLE conversations ADD COLUMN lineage TEXT`,
    ],
  },
  {
    /**
     * v5：题不落库（PRD 4.10 的「只做实时」），会话行上补一格待交接，消息表删掉第二套取法。
     *
     * 三件事一起做，因为它们说的是同一件事的三面：**题的生命 = 这段对话活着的这段时间**。
     *
     *   1. `DROP TABLE IF EXISTS questions` —— 题改成进程内对象（`services/QuestionService.ts`）：
     *      它没有消费者就没有意义（答完之后该办的事由宿主办掉，`PRD 4.10`），所以库里那一行
     *      只会在重启之后变成一个没人认领的孤儿。那条 `idx_questions_conversation` 索引随表
     *      消失，不必单独 drop。
     *   2. `conversations.pendingHandoff` —— 答完题之后「这段当时不闲、等它闲下来再交接」那一格
     *      （`PLAN §5.2`）。它必须落库：「等下一次变闲」可能跨重启，而 restart 之后题已经没了，
     *      这是**唯一**能带着走的那份事实。`NULL` = 没有待办。
     *   3. 删 `messages.parentToolCallId` 列与它的索引 —— 子 Agent 的话从来不入库（`CORE.md` §17），
     *      这一列于是永远 NULL，而它带来的 `listByParentToolCallId`／`listByConversation` 里那句
     *      `AND parentToolCallId IS NULL` 是「这段对话有多少条消息」的第二种取法。库里只能有一个
     *      来源，那条取法与它的读取口一起删。
     *
     * 为什么用 `DROP COLUMN` 而不是「建新表 + 搬数据 + 换名」：本机 `node:sqlite` 的 SQLite 支持
     * `ALTER TABLE ... DROP COLUMN`（3.35+，实测 3.53），而这条语句在外部内容表（`messages_fts`
     * 挂在 `messages` 上、两个触发器也挂在它上面）面前也是安全的：被删的列不在触发器、不在索引、
     * 不在 `UNIQUE (conversationId, seq)` 里。索引先删是硬要求 —— 列还挂在索引上时 SQLite 会拒绝
     * `DROP COLUMN`。
     *
     * 旧库不迁移（用户：旧户删掉重来都没关系）：这里**没有**任何数据搬迁语句。
     */
    version: 5,
    statements: [
      // 题改成进程内对象：那张表与它的索引一起消失（索引随表走）
      `DROP TABLE IF EXISTS questions`,
      // 答完题留下、等下一次变闲再兑现的那一格：`"self"` / `"summary"`，NULL = 没有待办
      `ALTER TABLE conversations ADD COLUMN pendingHandoff TEXT`,
      // 第二种取法先拆索引（列还挂在索引上时 DROP COLUMN 会被拒），再删列
      `DROP INDEX IF EXISTS idx_messages_parent_tool_call`,
      `ALTER TABLE messages DROP COLUMN parentToolCallId`,
    ],
  },
  {
    /**
     * v6：`inbox` 表 —— 队列里**还没被取走**的那些条目落库（PRD 1.2 / 4.12）。
     *
     * 这是本仓唯一一个「关掉就丢东西」的洞：条目只活在 core 的队列里，进程一没就没了，
     * 而 PRD 要的是「打开就是上次的样子，包括没被处理的那几句话 —— 它们还在等」。
     *
     * 建表而不是改旧表：此前库里根本没有这一格（那是缺的东西，不是错的列），所以这条是
     * 纯加法，旧库跑一遍就多一张空表，行为不变（见本文件开头）。
     *
     * **列按「条目上有什么就存什么」**（`CORE.md` §3 的 `InboxEntryWithContent`），
     * 内容一个字都不清理、不派生、不转换：
     *
     * - `messageId`：主键。它同时是恢复时的去重键（「这条已经落地过了就扔掉」），而同一个
     *   id 也不会入队两次 —— 它是客户端乐观回显用的那个 id（PRD D5），投递方定死；
     * - `conversationId`：这一条排在哪段对话的队列里。删对话 / 删工作区时条目跟着没 ——
     *   它是那段对话的待办，对话没了它就没有去处（与 `notices` / `messages` 同一个口径）；
     * - `source`：core 的 `MessageSource` 判别结构的 **JSON 原文**（不是字符串，见 v3 的口径）；
     * - `content`：正文的 **JSON 原文**，字符串与多模态段数组都原样进去、原样读回来
     *   （落库时清理会让两次请求的前缀对不上，prompt caching 全 miss）；
     * - `createdAt`：条目的 ISO 串**原样**。这里是 TEXT 而不是全库惯用的 INTEGER 毫秒 ——
     *   条目上那一格就是 ISO 串，存下来要读回同一个值（「一个字段都不重算」）；
     * - `seq`：入队顺序。**必须要它**：`createdAt` 只到毫秒，同一毫秒进来的两条（一次批量
     *   投递、重启后紧接着投）会撞在一起，光按 `createdAt` 排就还原不回它们本来的先后。
     *   它在**一段对话内**递增（入队就是队尾，于是「顺序 = 取件顺序」这条在库里也成立）。
     *
     * 索引 `(conversationId, seq)`：装配时按对话一次取干、且按入队顺序 —— 这是唯一的读取路径，
     * 两者一个复合索引就够，不再为 `seq` 单建一条。
     */
    version: 6,
    statements: [
      `CREATE TABLE IF NOT EXISTS inbox (
         messageId      TEXT PRIMARY KEY,
         conversationId TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
         source         TEXT NOT NULL,
         content        TEXT NOT NULL,
         createdAt      TEXT NOT NULL,
         seq            INTEGER NOT NULL
       )`,
      // 按对话取，且顺序即入队顺序（恢复时要按它原样放回）
      `CREATE INDEX IF NOT EXISTS idx_inbox_conversation ON inbox (conversationId, seq)`,
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
