/**
 * `messages` 表仓储：消息读写 + 全文检索。
 *
 * 几处与别处不同的地方：
 *
 * 1. **边流边写**：一次回答的生成过程中同一条助手消息会被反复写。`upsert` 按 id 整条覆盖
 *    `payload` / `problem` / `searchText`，但 `seq` 与 `createdAt` 保留第一次写入时的值 ——
 *    否则消息会在流式过程中不断「往后跳」。
 *
 * 2. **全文检索的分词现实**：FTS5 表用 `tokenize='trigram'`（见 migrations.ts），中文子串才
 *    搜得到；代价是查询词至少要 3 个字符，更短的（典型是两字中文）在 trigram 下必然搜不到，
 *    这里退化到 `LIKE` 子串匹配。
 *
 * 3. **表里只有主线消息**：subagent 的话不入库（`CORE.md` §17），所以「这段会话有多少条
 *    消息」只有一条取法 —— 表上也没有「这条消息挂在哪次工具调用上」那种归属列。
 *
 * 4. **`payload` 就是整条消息**：这一列存 core 的 `AgentNS.Message` 原样一份 JSON，写进去
 *    `JSON.stringify`、读出来 `JSON.parse`，中间没有逐字段映射 —— 写进去什么，读出来还是什么。
 *    `hidden` 不是一列可以由 JS 维护的东西：它是 SQLite 的生成列，由库自己从 `payload` 里取
 *    `$.hidden`（见 migrations.ts）。给用户看的读取路径（`message.list`、侧栏条数、删除代价）
 *    默认把它排除（`hidden IS NOT 1`，消息上没有这个键时生成列是 NULL）；要连它一起取的地方
 *    （模型的历史、排查问题）显式传 `includeHidden`。
 *
 * 5. **`searchText` 是索引产物，不是第二份消息**：它从 `message.content` 的文本段派生，只喂
 *    FTS（触发器只碰这一列）。从正文抽纯文本不改变消息的形状 —— 消息对象本身仍是 `payload`
 *    里那一份，读的时候一个字都不重建。
 *
 * `problem` 是**回显用的失败事实**（`ProblemFact`），宿主附加在消息之外的一条事实：它活得比
 * 进程长（PRD 4.15），所以单独一列存它的 JSON，没有时是 NULL。它不在消息对象里。
 *
 * FTS 索引的同步交给 `messages` 上的触发器（在 migrations.ts 里建），所以本文件写消息时只写
 * `messages` 表。
 */

import type { SQLInputValue } from "node:sqlite";
import type { AgentNS } from "@ai-zen/agents-core";

import type { ProblemFact } from "../wire/states.js";
import type { Database, RunResult, TxClient, TxStatement } from "./Database.js";
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

const COLUMNS = "id, sessionId, seq, createdAt, payload, problem, searchText";

/**
 * 「这条消息给用户看」的条件：`hidden` 生成列不为 1。
 *
 * 生成列从 `payload` 里取 `$.hidden`，消息上没有这个键时它是 NULL —— 所以写 `IS NOT 1`
 * 而不是 `!= 1`（后者对 NULL 恒不成立，会把正常消息全滤掉）。
 */
const VISIBLE_ONLY = `hidden IS NOT 1`;

/** 读消息时的选项 */
export interface MessageListOptions {
  /** 连 `hidden` 的消息一起取（默认不取：`hidden` 表示这条不给人看） */
  includeHidden?: boolean;
}

/**
 * 写语句：`seq` 取同会话当前最大值 + 1；同一 id 再写时只整条覆盖 `payload` / `problem` /
 * `searchText`。
 *
 * `MAX(seq)` 与插入在同一条语句里完成，worker 又是单线程串行执行，所以不会出现两条
 * 消息抢到同一个 seq（`UNIQUE (sessionId, seq)` 是最后一道防线）。
 */
const UPSERT_SQL = `
  INSERT INTO messages (${COLUMNS})
  VALUES (
    ?,
    ?,
    (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE sessionId = ?),
    ?,
    ?,
    ?,
    ?
  )
  ON CONFLICT (id) DO UPDATE SET
    payload    = excluded.payload,
    problem    = excluded.problem,
    searchText = excluded.searchText
`;

/**
 * 把「写一条消息」登记进一个已有的批次（`tx` 客户端），拿到那条语句的凭据。
 *
 * 导出的理由：交接换记忆那一批要把「插存档会话行」「把消息搬走」「写 cwd 与断点两条消息」
 * 放进**同一个**事务（`SessionRepository.replaceMemory`）。就地复制一份 `UPSERT_SQL` 会让
 * `seq` 的口径多出第二份实现，那正是「同一段会话里两条消息抢到同一个 seq」的来源。
 */
export function registerMessageUpsert(
  tx: TxClient,
  input: MessageUpsertInput,
): TxStatement<RunResult> {
  return tx.run(UPSERT_SQL, upsertParams(input));
}

/**
 * 从消息正文里抽出可检索的纯文本。
 *
 * 只取文本段：JSON 结构（工具调用的参数、用量等）不进索引，否则搜 "id"、"type"
 * 这类词会把所有工具调用消息都捞出来，反而搜不准。
 *
 * 这是 FTS 的索引产物，不是消息形状的转换：抽出来的这一份只喂 `messages_fts`，消息对象
 * 仍然是 `payload` 里那一份，读的时候不从它重建任何字段。
 */
function extractSearchText(content: AgentNS.MessageContent | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const section of content) {
    if (section.type === "text" && typeof section.text === "string") parts.push(section.text);
  }
  return parts.join("\n");
}

function toSearchText(content: AgentNS.MessageContent | undefined): string {
  return extractSearchText(content).replace(/\s+/g, " ").trim();
}

/**
 * 一行库 → 一条消息。
 *
 * `payload` 是我们自己写进去的那一份，`JSON.parse` 之后就是 core 的 `AgentNS.Message`：
 * 不补空值、不收紧取值、不认「坏值」。读不出来就让它抛 —— 那说明库里那行不是本仓库写的，
 * 悄悄吞掉只会让一条坏数据变成界面上一条看着正常的消息。
 */
function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    createdAt: row.createdAt,
    message: JSON.parse(row.payload) as AgentNS.Message,
    problem: row.problem === null ? null : (JSON.parse(row.problem) as ProblemFact),
  };
}

/** 建 upsert 的绑定参数数组（顺序与 UPSERT_SQL 的占位符一一对应） */
function upsertParams(input: MessageUpsertInput): SQLInputValue[] {
  return [
    input.id,
    input.sessionId,
    input.sessionId,
    input.createdAt,
    JSON.stringify(input.message),
    input.problem === undefined || input.problem === null ? null : JSON.stringify(input.problem),
    toSearchText(input.message.content),
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
   * 同一条消息（同 id）重复调用即「整条覆盖最新内容」，`seq` / `createdAt` 不变。
   */
  async upsert(input: MessageUpsertInput): Promise<void> {
    await this.db.run(UPSERT_SQL, upsertParams(input));
  }

  /**
   * 批量写入（一次回答结束时的「写一次」）：整批放在一个事务里，避免中途断开留下半截历史。
   */
  async upsertMany(inputs: MessageUpsertInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.db.tx((tx) => {
      for (const input of inputs) registerMessageUpsert(tx, input);
    });
  }

  /**
   * 物理删掉一条消息（core 的「丢」= 真删，`CORE.md` §6）。
   *
   * 运行时的 `messageRemoved` 事件走它：core 在一次请求开头修历史时删掉的残局，库里也得消失 ——
   * 否则用户会看见一条模型那边已经不存在的消息。关系行（`session_assets`）跟着外键级联走。
   */
  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM messages WHERE id = ?`, [id]);
  }

  async get(id: string): Promise<StoredMessage | undefined> {
    const row = await this.db.get<MessageRow>(`SELECT ${COLUMNS} FROM messages WHERE id = ?`, [id]);
    return row ? toStoredMessage(row) : undefined;
  }

  /**
   * 按会话取消息（`PLAN.md` A12 的 `message.list` 口径）。
   *
   * - 不给 `after`：整段历史，按 `seq` 升序。
   * - 给了 `after` 且这个 id 存在：**从它本身开始**（含它，内容是最新的）+ 之后全部。
   *   故意不从它的下一条开始 —— 重连的客户端上次拿到的最后一条可能正是流式中那条，
   *   它的内容已经变了，得重新拿最新的。
   * - 给了 `after` 但库里没有这个 id（已删除、或换了库）：退回整段历史。
   *
   * 读到的是这段会话的全部行：subagent 的话不入库，表上也没有归属列，所以不需要再筛一次。
   * 三种情况收敛成一条 SQL：找不到时 `COALESCE` 把下界降成 -1，条件恒真。
   *
   * 它与 {@link countBySession} 数的是同一批行（两边都只看 `hidden`），口径见 PLAN §7。
   * `hidden` 的消息默认不在结果里；要看的那一侧（模型的历史、排查）传 `includeHidden`。
   */
  async listBySession(
    sessionId: string,
    after?: string,
    options: MessageListOptions = {},
  ): Promise<StoredMessage[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT ${COLUMNS} FROM messages
       WHERE sessionId = ?
         AND (? = 1 OR ${VISIBLE_ONLY})
         AND (? IS NULL
              OR seq >= COALESCE(
                   (SELECT seq FROM messages WHERE id = ? AND sessionId = ?),
                   -1))
       ORDER BY seq ASC`,
      [sessionId, options.includeHidden === true ? 1 : 0, after ?? null, after ?? null, sessionId],
    );
    return rows.map(toStoredMessage);
  }

  /**
   * 全文搜索（按聊天内容，可只搜一个 Workspace）。
   *
   * 查的是 `id` / `createdAt` / `payload` 与命中片段：**不在 SQL 里 `json_extract` 消息字段**，
   * 角色由调用方解析 `payload` 之后从消息对象上取。
   *
   * @param scope 一段会话内 / 一个 Workspace 下 / `undefined`（不限；由调用方显式传入）
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

    if (scope && "sessionId" in scope) {
      conditions.push("m.sessionId = ?");
      params.push(scope.sessionId);
    } else if (scope && "workspaceId" in scope) {
      conditions.push("c.workspaceId = ?");
      params.push(scope.workspaceId);
    }

    const sql = useFts
      ? `SELECT m.id, m.sessionId, c.name AS sessionName, c.workspaceId AS workspaceId,
                m.createdAt, m.payload, ${snippet}
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN sessions c ON c.id = m.sessionId
         WHERE ${conditions.join(" AND ")}
         ORDER BY m.createdAt DESC, m.seq DESC
         LIMIT ?`
      : `SELECT m.id, m.sessionId, c.name AS sessionName, c.workspaceId AS workspaceId,
                m.createdAt, m.payload, ${snippet}
         FROM messages m
         JOIN sessions c ON c.id = m.sessionId
         WHERE ${conditions.join(" AND ")}
         ORDER BY m.createdAt DESC, m.seq DESC
         LIMIT ?`;

    return this.db.all<MessageSearchHit>(sql, [trimmed, trimmed, ...params, limit]);
  }

  /**
   * 硬删一段会话里排在指定消息之后的消息（PRD D24 的撤回）。
   * `includeSelf` 为真时连那条消息一起删。
   *
   * 锚点不在该会话里时 `seq` 子查询为 NULL，条件不成立，一条也不会删。
   */
  async deleteAfter(
    sessionId: string,
    messageId: string,
    options: { includeSelf?: boolean } = {},
  ): Promise<number> {
    const comparison = options.includeSelf ? ">=" : ">";
    const result = await this.db.run(
      `DELETE FROM messages
       WHERE sessionId = ?
         AND seq ${comparison} (
           SELECT seq FROM messages WHERE id = ? AND sessionId = ?
         )`,
      [sessionId, messageId, sessionId],
    );
    return result.changes;
  }

  /**
   * 数一段会话在 `messages` 表里的行数（删除代价那一侧用它）。
   *
   * 与 {@link listBySession} 数的是同一批行：`hidden` 两边都不算 —— 它在界面上从来没出现过，
   * 数进代价里会让用户看到一个对不上的数字。
   */
  async countBySession(sessionId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM messages WHERE sessionId = ? AND ${VISIBLE_ONLY}`,
      [sessionId],
    );
    return row?.n ?? 0;
  }
}
