import type { DatabaseSync } from "node:sqlite";

import type { AgentNS } from "@ai-zen/agents-core";

/**
 * 还没被取走的那几条话。落库的唯一理由是「关掉再打开，那几句还在等」——它们只活在 core 的
 * 队列里就会随进程消失。
 *
 * 只收会写进 messages 成消息的那一种InboxEntry：core 还有一种「钥匙」（没有正文，只用来唤醒），它没有
 * `messageId`，重启之后也没有可恢复的东西——它说的是「输入已经在 `messages` 里了」，
 * 而那次唤醒本来就是一次性动作。
 *
 * `seq` 是入队顺序（`createdAt` 只到毫秒，同一毫秒进来的两条会撞），也是恢复时放回队列的顺序。
 */
export function inboxTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox (
      id        TEXT PRIMARY KEY,
      payload   TEXT NOT NULL,
      sessionId TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      seq       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_session_seq ON inbox (sessionId, seq);
  `);

  const insertSql = `INSERT INTO inbox (id, payload, sessionId, seq)
    VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM inbox WHERE sessionId = ?))
    ON CONFLICT (id) DO NOTHING`;

  return {
    /**
     * `entry` 必须带 `messageId`：它就是这一行的身份，也是客户端拿去做乐观回显的那个 id。
     *
     * 同一个 id 写两次是正常的，不是错误：投递那一路为了「落库先于入队」会先写一次，入队之后
     * 那条 `inboxAdded` 又会让观察者照事实再写一次。后一次撞的是 `id` 这个主键，`DO NOTHING`
     * 让它什么都不做 —— 不报错、不覆盖先写的那一份载荷、也不再占一个 `seq`（`seq` 是排队顺序，
     * 重写一遍不该把这一条挪到队尾；「先删再插」正是会挪到队尾的那种写法）。
     *
     * 只有 `id` 这一处冲突被咽掉：`sessionId` 指不到会话（外键）、磁盘写不进去这些照旧抛给
     * 调用方，由它报成错误 —— 那些是这一条真的没落进库，不是重复。
     */
    insert(sessionId: string, entry: AgentNS.InboxEntryWithContent & { messageId: string }): void {
      db.prepare(insertSql).run(entry.messageId, JSON.stringify(entry), sessionId, sessionId);
    },

    /** 按入队顺序，就是放回 core 队列时的顺序 */
    listBySession(sessionId: string): AgentNS.InboxEntryWithContent[] {
      return db
        .prepare("SELECT payload FROM inbox WHERE sessionId = ? ORDER BY seq")
        .all(sessionId)
        .map((row) => JSON.parse(String(row.payload)) as AgentNS.InboxEntryWithContent);
    },

    /** 写进 messages 了或被作废的那些：一条一条给 messageId，因为作废的往往是其中几条 */
    deleteMany(messageIds: readonly string[]): void {
      if (messageIds.length === 0) return;
      const placeholders = messageIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM inbox WHERE id IN (${placeholders})`).run(...messageIds);
    },

    clearBySession(sessionId: string): void {
      db.prepare("DELETE FROM inbox WHERE sessionId = ?").run(sessionId);
    },
  };
}
