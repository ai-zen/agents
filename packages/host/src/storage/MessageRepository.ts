/**
 * `messages` 表仓储：消息读写 + 全文检索。
 *
 * 三处与别处不同的地方：
 *
 * 1. **边流边写**：一轮生成过程中同一条助手消息会被反复写（PRD D15）。`upsert` 按 id
 *    覆盖正文 / 状态 / omit，但 `seq` 与 `createdAt` 保留第一次写入时的值 —— 否则消息
 *    会在流式过程中不断「往后跳」。
 *
 * 2. **全文检索的分词现实**：FTS5 表用 `tokenize='trigram'`（见 migrations.ts），
 *    中文子串才搜得到；代价是查询词至少要 3 个字符，少于 3 个字符（典型是两字中文）
 *    在 trigram 下必然搜不到，这里退化到 `LIKE` 子串匹配。
 *
 * 3. **子 Agent 的归属**：`parentToolCallId` 记下这条消息是被哪次工具调用派出去产生的
 *    （R37）。怎么写入由上层决定，本文件提供按它取回的一段读取路径。
 *
 * 4. **`hidden` 的两条读数**：`hidden` 是 core 的 `Message.hidden`，落在 `data` 列的 JSON 里
 *    （没有单独的列）。给用户看的读取路径（`message.list`、侧栏条数、删除代价）默认把它
 *    排除；要连它一起取的地方（模型的历史、排查问题）显式传 `includeHidden`。
 *
 * 5. **`source` 是判别结构**：core 的 `AgentNS.MessageSource`（`{kind:"user"}` /
 *    `{kind:"agent",label}` / `{kind:"system",label}`）在本表是一列 `TEXT`，存它的 JSON。
 *    写入时序列化、读回来反序列化，两个方向同一个形状；旧行这一列是 NULL（= 没记过），
 *    兼容与升级策略在 {@link toSource}。
 *
 * FTS 索引的同步交给 `messages` 上的触发器（同样在 migrations.ts 里建），所以本文件
 * 写消息时只写 `messages` 表，不需要额外维护索引。
 */

import type { SQLInputValue } from "node:sqlite";
import type { AgentNS } from "@ai-zen/agents-core";

import type { Database } from "./Database.js";
import type {
  MessageRow,
  MessageSearchHit,
  MessageSearchScope,
  MessageUpsertInput,
  StoredMessage,
} from "./types.js";

/** trigram 分词器能匹配的最小查询长度（按字符算，不是字节） */
const TRIGRAM_MIN_LENGTH = 3;

/** 搜索结果的片段长度上限 */
const SNIPPET_LENGTH = 160;

const COLUMNS =
  "id, conversationId, seq, role, status, omit, content, data, searchText, source, parentToolCallId, createdAt, updatedAt";

/**
 * 「这条消息给用户看」的条件：`data.hidden` 不为真。
 *
 * `hidden` 在 `data` 这列 JSON 里，所以判断要读一次 JSON。`data` 为空或不是合法 JSON 时
 * 按「不是隐藏」算 —— 一条坏数据不该让整条消息在界面上凭空消失。
 */
const VISIBLE_ONLY = `(CASE WHEN json_valid(data) THEN json_extract(data, '$.hidden') ELSE 0 END) IS NOT 1`;

/** 读消息时的选项 */
export interface MessageListOptions {
  /** 连 `hidden` 的消息一起取（默认不取：`hidden` 表示这条不给人看） */
  includeHidden?: boolean;
}

/**
 * 写入语句：`seq` 取同对话当前最大值 + 1；同一 id 再写时只覆盖内容类字段。
 *
 * `MAX(seq)` 与插入在同一条语句里完成，worker 又是单线程串行执行，所以不会出现两条
 * 消息抢到同一个 seq（`UNIQUE (conversationId, seq)` 是最后一道防线）。
 *
 * `parentToolCallId` 在冲突分支里用 `COALESCE`：流式过程里同一条消息会被反复写，
 * 不带上这一列的那些写不会把已经记下的归属抹掉。
 */
const UPSERT_SQL = `
  INSERT INTO messages (${COLUMNS})
  VALUES (
    ?,
    ?,
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversationId = ?),
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?
  )
  ON CONFLICT (id) DO UPDATE SET
    role             = excluded.role,
    status           = excluded.status,
    omit             = excluded.omit,
    content          = excluded.content,
    data             = excluded.data,
    searchText       = excluded.searchText,
    -- 来源是**投递那一刻**的事实，之后的每一遍写（流式、收尾）都带着同一份；
    -- 没带的那几遍（例如只改状态的写）不许把它抹成 NULL。
    source           = COALESCE(excluded.source, messages.source),
    parentToolCallId = COALESCE(excluded.parentToolCallId, messages.parentToolCallId),
    updatedAt        = excluded.updatedAt
`;

/**
 * 从消息正文里抽出可检索的纯文本。
 *
 * 只取文本段：JSON 结构（工具调用的参数、用量等）不进索引，否则搜 "id"、"type"
 * 这类词会把所有工具调用消息都捞出来，反而搜不准。
 */
function extractSearchText(content: AgentNS.MessageContent | null): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const section of content) {
    // 库里的内容是外部写入的 JSON，形状不保证合 core 的类型：非文本段不参与索引
    if (section.type === "text" && typeof section.text === "string") parts.push(section.text);
  }
  return parts.join("\n");
}

function toSearchText(content: AgentNS.MessageContent | null): string {
  return extractSearchText(content).replace(/\s+/g, " ").trim();
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // 库里出现坏 JSON 时不让整条记录读不出来，原样当字符串返回
    return value;
  }
}

/**
 * `content` 列的反序列化：core 的 `MessageContent` 就是「字符串，或内容段数组」。
 *
 * 两种形状原样返回（R30：不在仓储层重建内容段）；其它情况（空列、坏数据）归为「没有正文」。
 */
function toContent(value: unknown): AgentNS.MessageContent | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value as AgentNS.MessageContentSection[];
  return null;
}

/**
 * `source` 列的反序列化：core 的 `AgentNS.MessageSource` 是**判别结构**，库里存的是它的 JSON。
 *
 * 三种输入都要接住：
 *   1. 合法的判别结构（`{kind:"user"}` / `{kind:"agent",label}` / `{kind:"system",label}`）
 *      —— 原样返回；`label` 不是字符串的按空串算（宁可少一句话，不要让整行读不出来）；
 *   2. **旧形态：一个字符串**（这一列出现之前把来源当自由字符串的写法，或手写的 `'user'`）。
 *      读回来升成结构：`"user"` → `{kind:"user"}`，其余 → `{kind:"system", label: 那个串}`；
 *   3. NULL / 坏数据 → `null`，意思是「没有记过来源」，**不默认成用户**（`CORE.md` §3：
 *      不做「没有 source 就是用户」那种缺省）。
 */
function toSource(value: unknown): AgentNS.MessageSource | null {
  if (typeof value === "string") {
    if (value === "user") return { kind: "user" };
    return { kind: "system", label: value };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as { kind?: unknown; label?: unknown };
  if (record.kind === "user") return { kind: "user" };
  if (record.kind === "agent" || record.kind === "system") {
    return { kind: record.kind, label: typeof record.label === "string" ? record.label : "" };
  }
  return null;
}

function toStoredMessage(row: MessageRow): StoredMessage {
  const data = parseJson(row.data);
  return {
    id: row.id,
    conversationId: row.conversationId,
    parentToolCallId: row.parentToolCallId,
    seq: row.seq,
    role: row.role,
    status: row.status,
    omit: row.omit !== 0,
    content: toContent(parseJson(row.content)),
    source: toSource(parseJson(row.source)),
    data: typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 建 upsert 的绑定参数数组（顺序与 UPSERT_SQL 的占位符一一对应） */
function upsertParams(input: MessageUpsertInput): SQLInputValue[] {
  const searchText = toSearchText(input.content ?? null);
  const contentJson = JSON.stringify(input.content ?? null);
  const dataJson = input.data === undefined || input.data === null ? null : JSON.stringify(input.data);
  return [
    input.id,
    input.conversationId,
    input.conversationId,
    input.role,
    input.status,
    input.omit ? 1 : 0,
    contentJson,
    dataJson,
    searchText,
    input.source === undefined || input.source === null ? null : JSON.stringify(input.source),
    input.parentToolCallId ?? null,
    input.createdAt,
    input.createdAt,
  ];
}

/** FTS5 的查询串：整体加引号当作短语，用户输入里的特殊符号就不会被当成查询语法 */
function toMatchPhrase(keyword: string): string {
  return `"${keyword.replace(/"/g, '""')}"`;
}

/** LIKE 的通配符转义 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class MessageRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 写入或覆盖一条消息。
   *
   * 同一条消息（同 id）重复调用即「覆盖最新内容 + 状态」，`seq` / `createdAt` 不变。
   */
  async upsert(input: MessageUpsertInput): Promise<void> {
    await this.db.run(UPSERT_SQL, upsertParams(input));
  }

  /**
   * 批量写入（一轮结束时的「写一次」）：整批放在一个事务里，避免中途断开留下半轮历史。
   */
  async upsertMany(inputs: MessageUpsertInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.db.tx((tx) => {
      for (const input of inputs) tx.run(UPSERT_SQL, upsertParams(input));
    });
  }

  /**
   * 物理删掉一条消息（core 的「丢」= 真删，`CORE.md` §6）。
   *
   * 运行时的 `messageRemoved` 事件走它：core 在一圈开头修历史时删掉的残局，库里也必须消失 ——
   * 否则用户会看见一条模型那边已经不存在的消息。关系行（`conversation_assets`）跟着外键级联走。
   */
  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM messages WHERE id = ?`, [id]);
  }

  async get(id: string): Promise<StoredMessage | undefined> {
    const row = await this.db.get<MessageRow>(
      `SELECT ${COLUMNS} FROM messages WHERE id = ?`,
      [id],
    );
    return row ? toStoredMessage(row) : undefined;
  }

  /**
   * 按对话取消息（`PLAN.md` A12 的 `message.list` 口径）。
   *
   * - 不给 `after`：整段历史，按 `seq` 升序。
   * - 给了 `after` 且这个 id 存在：**从它本身开始**（含它，内容是最新的）+ 之后全部。
   *   故意不从它的下一条开始 —— 重连的客户端上次拿到的最后一条可能正是流式中那条，
   *   它的内容已经变了，得重新拿最新的。
   * - 给了 `after` 但库里没有这个 id（已删除、或换了库）：退回整段历史。
   *
   * 三条都只覆盖**主线**消息：子 Agent 的消息虽然落在同一张表，但它们属于另一次对话
   * 与另一步执行（`parentToolCallId` 非空），回看走 {@link listByParentToolCallId}，
   * 不能混进主线历史（否则模型下一轮会把别人的对话当成自己的上下文）。
   *
   * 三种情况收敛成一条 SQL：找不到时 `COALESCE` 把下界降成 -1，条件恒真。
   *
   * 这里数出来的是**主线**的条数（`parentToolCallId IS NULL` 那一半）：子 Agent 的消息落在同一张
   * 表、但有非空的 `parentToolCallId`，不在本方法的结果里。同样是「这段对话有多少条消息」，
   * {@link countByConversation} 数的是表里的全部行（不筛那一列，只筛 `hidden`），所以一段跑过
   * 子 Agent 的对话，`listByConversation().length` 会小于 `countByConversation()`。
   *
   * `hidden` 的消息默认不在结果里（侧栏条数、`message.list` 都用这条默认）。要看的那一侧
   * （模型的历史、排查）传 `includeHidden`。
   */
  async listByConversation(
    conversationId: string,
    after?: string,
    options: MessageListOptions = {},
  ): Promise<StoredMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT ${COLUMNS} FROM messages
       WHERE conversationId = ?
         AND parentToolCallId IS NULL
         AND (? = 1 OR ${VISIBLE_ONLY})
         AND (? IS NULL
              OR seq >= COALESCE(
                   (SELECT seq FROM messages WHERE id = ? AND conversationId = ?),
                   -1))
       ORDER BY seq ASC`,
      [
        conversationId,
        options.includeHidden === true ? 1 : 0,
        after ?? null,
        after ?? null,
        conversationId,
      ],
    );
    return rows.map(toStoredMessage);
  }

  /**
   * 按父工具调用取子 Agent 的消息（R37 提供的存储能力）。
   *
   * 按对话限定范围：工具调用 id 只在它所属的那段对话里有意义。
   */
  async listByParentToolCallId(
    conversationId: string,
    parentToolCallId: string,
    options: MessageListOptions = {},
  ): Promise<StoredMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT ${COLUMNS} FROM messages
       WHERE conversationId = ? AND parentToolCallId = ?
         AND (? = 1 OR ${VISIBLE_ONLY})
       ORDER BY seq ASC`,
      [conversationId, parentToolCallId, options.includeHidden === true ? 1 : 0],
    );
    return rows.map(toStoredMessage);
  }

  /**
   * 按对话取「子 Agent 说过的话」那一半（F-I7 的空闲回看与重开后的子 Agent 页签）。
   *
   * 与 {@link listByConversation} 正好互补：那边只要主线（`parentToolCallId IS NULL`），这里只要
   * 子 Agent 的另一半。一次取回整段对话的全部委派产物，`parentToolCallId` 就是「这段话属于
   * 哪一次委派」的唯一痕迹 —— 上层据此把历次委派重新拼成子 Agent 快照，不必先知道有哪些
   * 工具调用 id（那些 id 只活在主线消息的 `tool_calls` 里，而一次委派是否**真的**派出去过，
   * 唯一确凿的证据是这张表里有它的子消息）。
   *
   * 顺序照 `seq` 升序：同一次委派的消息连在一起，跨委派的先后也保持原样。
   */
  async listDelegated(
    conversationId: string,
    options: MessageListOptions = {},
  ): Promise<StoredMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT ${COLUMNS} FROM messages
       WHERE conversationId = ?
         AND parentToolCallId IS NOT NULL
         AND (? = 1 OR ${VISIBLE_ONLY})
       ORDER BY seq ASC`,
      [conversationId, options.includeHidden === true ? 1 : 0],
    );
    return rows.map(toStoredMessage);
  }

  /**
   * 全文搜索（PRD D16：按聊天内容、可只搜一个 Workspace）。
   *
   * @param scope 一段对话内 / 一个 Workspace 下 / 不限（`undefined` 由调用方显式传入
   *              表示不限；本层不替调用方决定「不给条件就搜全库」是不是合理）
   * @param keyword 查询词：长度 >= 3 走 FTS5 trigram，< 3 走 LIKE 子串
   * @param limit 上限
   */
  async search(
    scope: MessageSearchScope,
    keyword: string,
    limit: number,
  ): Promise<MessageSearchHit[]> {
    const trimmed = keyword.trim();
    if (trimmed.length === 0) return [];
    // 片段取命中位置前面 40 个字符开始的一小段；没命中（FTS 命中但整词不在、或极端长词）
    // 就退回头部一小段。两处都写成 `m.searchText`：FTS 分支里两张表都有 searchText 列，
    // 不限定会直接报 ambiguous column（歧义列）
    const snippet = `CASE
        WHEN instr(m.searchText, ?) > 0
          THEN substr(m.searchText, max(1, instr(m.searchText, ?) - 40), ${SNIPPET_LENGTH})
        ELSE substr(m.searchText, 1, ${SNIPPET_LENGTH})
      END AS snippet`;

    // trigram 至少要 3 个字符，短查询用它只会得到空结果，直接换 LIKE
    const useFts = [...trimmed].length >= TRIGRAM_MIN_LENGTH;
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];

    if (useFts) {
      conditions.push("messages_fts MATCH ?");
      params.push(toMatchPhrase(trimmed));
    } else {
      conditions.push("m.searchText LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(trimmed)}%`);
    }

    if (scope && "conversationId" in scope) {
      conditions.push("m.conversationId = ?");
      params.push(scope.conversationId);
    } else if (scope && "workspaceId" in scope) {
      conditions.push("c.workspaceId = ?");
      params.push(scope.workspaceId);
    }

    const sql = useFts
      ? `SELECT m.id, m.conversationId, c.name AS conversationName, c.workspaceId AS workspaceId,
                m.role, m.createdAt, ${snippet}
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversationId
         WHERE ${conditions.join(" AND ")}
         ORDER BY m.createdAt DESC, m.seq DESC
         LIMIT ?`
      : `SELECT m.id, m.conversationId, c.name AS conversationName, c.workspaceId AS workspaceId,
                m.role, m.createdAt, ${snippet}
         FROM messages m
         JOIN conversations c ON c.id = m.conversationId
         WHERE ${conditions.join(" AND ")}
         ORDER BY m.createdAt DESC, m.seq DESC
         LIMIT ?`;

    return this.db.all<MessageSearchHit>(sql, [trimmed, trimmed, ...params, limit]);
  }

  /**
   * 硬删一段对话里排在指定消息之后的消息（PRD D24 的撤回）。
   * `includeSelf` 为真时连那条消息一起删。
   *
   * 锚点不在该对话里时 `seq` 子查询为 NULL，条件不成立，一条也不会删。
   */
  async deleteAfter(
    conversationId: string,
    messageId: string,
    options: { includeSelf?: boolean } = {},
  ): Promise<number> {
    const comparison = options.includeSelf ? ">=" : ">";
    const result = await this.db.run(
      `DELETE FROM messages
       WHERE conversationId = ?
         AND seq ${comparison} (
           SELECT seq FROM messages WHERE id = ? AND conversationId = ?
         )`,
      [conversationId, messageId, conversationId],
    );
    return result.changes;
  }

  /**
   * 数一段对话在 `messages` 表里的全部行数（PRD D17 / F-F9 的代价一侧用它）。
   *
   * 与 {@link listByConversation} 的差别就在 `parentToolCallId` 这一列：本方法不筛它，所以子 Agent
   * 的消息也算在内。同一个问题（「这段对话有多少条消息」）于是有两个不同的数，两处的用途不同：
   * 这里要的是「删掉会让库里少多少行」，那边要的是「主线里能回看多少条」。
   *
   * `hidden` 的消息两边都不算：它在界面上从来没出现过，删掉它数进代价里会让用户看到
   * 一个对不上的数字。
   */
  async countByConversation(conversationId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM messages WHERE conversationId = ? AND ${VISIBLE_ONLY}`,
      [conversationId],
    );
    return row?.n ?? 0;
  }
}
