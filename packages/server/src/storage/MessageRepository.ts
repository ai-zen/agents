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
  "id, conversationId, seq, role, status, omit, content, data, searchText, parentToolCallId, createdAt, updatedAt";

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
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?
  )
  ON CONFLICT (id) DO UPDATE SET
    role             = excluded.role,
    status           = excluded.status,
    omit             = excluded.omit,
    content          = excluded.content,
    data             = excluded.data,
    searchText       = excluded.searchText,
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

  async get(id: string): Promise<StoredMessage | undefined> {
    const row = await this.db.get<MessageRow>(
      `SELECT ${COLUMNS} FROM messages WHERE id = ?`,
      [id],
    );
    return row ? toStoredMessage(row) : undefined;
  }

  /**
   * 按对话取消息（architecture.md A12 的 `message.list` 口径）。
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
   * {@link countByConversation} 数的是表里的全部行（不筛这一列），所以一段跑过子 Agent 的对话，
   * `listByConversation().length` 会小于 `countByConversation()`。
   */
  async listByConversation(conversationId: string, after?: string): Promise<StoredMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT ${COLUMNS} FROM messages
       WHERE conversationId = ?
         AND parentToolCallId IS NULL
         AND (? IS NULL
              OR seq >= COALESCE(
                   (SELECT seq FROM messages WHERE id = ? AND conversationId = ?),
                   -1))
       ORDER BY seq ASC`,
      [conversationId, after ?? null, after ?? null, conversationId],
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
  ): Promise<StoredMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT ${COLUMNS} FROM messages
       WHERE conversationId = ? AND parentToolCallId = ?
       ORDER BY seq ASC`,
      [conversationId, parentToolCallId],
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
   */
  async countByConversation(conversationId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM messages WHERE conversationId = ?",
      [conversationId],
    );
    return row?.n ?? 0;
  }
}
