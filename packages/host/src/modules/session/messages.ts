import type { DatabaseSync } from "node:sqlite";

import type { AgentNS } from "@ai-zen/agents-core";

/**
 * 消息表。`payload` 就是 core 的一条 `AgentNS.Message`，写进去什么样读出来什么样。
 *
 * 同一个 id 会被反复写：流式响应边生成边落库，每次整条覆盖。第二次写入只换 `payload`，
 * `seq` 停在第一次的值 —— 让 `seq` 跟着改会把「按 `seq` 升序」的顺序在流式追加过程中一直重排。
 *
 * `createdAt` 是生成列，值来自 `payload` 里那一格，而那一格是 core 在构造消息那刻填的。
 * 流式写入改的是同一个对象的正文，所以它自然停在第一次那一刻；反过来，拿一个新对象再写一遍
 * 同一个 id，时刻就会跟着变 —— 那是调用方该知道的事，不是这张表该拦的。
 *
 * `seq` 与 `searchText` 是 JS 写进去的两个真列：同一会话内的顺序是并发写入的单调量，从
 * `payload` 里取不出来；`searchText` 是全文索引的产物，见下。`createdAt` 由 core 在构造消息
 * 时填，所以它是生成列，JS 不写它。
 *
 * `searchText` 不是消息的第二份：消息本体始终是 `payload` 里那一整条，读的时候不从这一列
 * 重建任何字段，它只喂 `messages_fts`（索引由触发器同步）。它只收 `content` 里的文本段：
 * 把整条 `payload` 的 JSON 键名也索引进去，搜 `id` 会捞出所有工具调用。
 */
export function messageTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      payload    TEXT NOT NULL,
      sessionId  TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      seq        INTEGER NOT NULL,
      searchText TEXT    NOT NULL DEFAULT '',
      hidden     INTEGER GENERATED ALWAYS AS (COALESCE(json_extract(payload, '$.hidden'), 0)) STORED,
      createdAt  INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.createdAt')) STORED,
      UNIQUE (sessionId, seq)
    );
    CREATE INDEX IF NOT EXISTS messages_session_seq ON messages (sessionId, seq);
  `);

  const upsertSql = `INSERT INTO messages (id, payload, sessionId, seq, searchText)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE sessionId = ?), ?)
    ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, searchText = excluded.searchText`;

  function upsert(sessionId: string, message: AgentNS.Message): void {
    db.prepare(upsertSql).run(
      message.id,
      JSON.stringify(message),
      sessionId,
      sessionId,
      searchTextOf(message),
    );
  }

  return {
    upsert,

    upsertMany(sessionId: string, list: AgentNS.Message[]): void {
      for (const message of list) upsert(sessionId, message);
    },

    get(id: string): AgentNS.Message | undefined {
      const row = db.prepare("SELECT payload FROM messages WHERE id = ?").get(id);
      return row === undefined ? undefined : (JSON.parse(String(row.payload)) as AgentNS.Message);
    },

    /**
     * `after` 那条在库里找不到时 `COALESCE` 给 0，退回整段历史；没给 `after` 走的是同一条路，
     * 所以这里不分两支。
     */
    listBySession(sessionId: string, options: { after?: string } = {}): AgentNS.Message[] {
      return db
        .prepare(
          `SELECT payload FROM messages
            WHERE sessionId = ?
              AND seq >= COALESCE((SELECT seq FROM messages WHERE id = ? AND sessionId = ?), 0)
            ORDER BY seq`,
        )
        .all(sessionId, options.after ?? "", sessionId)
        .map((row) => JSON.parse(String(row.payload)) as AgentNS.Message);
    },

    /** 侧栏要的「最后一条什么时候说的」：一个聚合，不读任何 `payload` */
    lastAt(sessionId: string): number | null {
      const row = db
        .prepare("SELECT MAX(createdAt) AS at FROM messages WHERE sessionId = ?")
        .get(sessionId);
      return row?.at === null || row?.at === undefined ? null : Number(row.at);
    },

    /**
     * 这一段有几条。删会话要报「这一次删掉了什么」，那个数在删之前数，而数条数不必把每一条的
     * `payload` 读出来再解析一遍。
     */
    countBySession(sessionId: string): number {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE sessionId = ?")
        .get(sessionId);
      return Number(row?.count ?? 0);
    },

    delete(id: string): void {
      db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    },

    /** `messageId` 在库里找不到时子查询给 NULL，比较不成立，一行都不删 */
    deleteAfter(sessionId: string, messageId: string): void {
      db.prepare(
        `DELETE FROM messages
          WHERE sessionId = ?
            AND seq > (SELECT seq FROM messages WHERE id = ? AND sessionId = ?)`,
      ).run(sessionId, messageId, sessionId);
    },
  };
}

/**
 * 喂给全文索引的纯文本：只取 `content` 里的文本段，拼起来、空白归一。
 *
 * 图片段与文件段没有可搜的字；整条 `payload` 序列化进来则会把 JSON 键名一起索引，
 * 于是搜 `id` 命中所有工具调用。`content` 是裸字符串时它自己就是那一段文本。
 */
function searchTextOf(message: AgentNS.Message): string {
  const content = message.content;
  const parts =
    content === undefined
      ? []
      : typeof content === "string"
        ? [content]
        : content.filter((section) => section.type === "text").map((section) => section.text);

  return parts.join(" ").replace(/\s+/g, " ").trim();
}
