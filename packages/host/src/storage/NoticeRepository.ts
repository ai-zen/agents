/**
 * `notices` 表仓储：通知持久化（PRD L3：手动清 + 持久化）。
 *
 * 库里存的是**码 + 参数**而不是渲染好的句子：多语言在读出时按连接的语言渲染
 * （`PLAN.md` §8 的多语言渲染点），否则一条通知存死一种语言，换个语言连回来就错了。
 *
 * `durationMs` 为 null 表示永久存在；有值时到点消失，靠 `deleteExpired` 清掉。
 *
 * `sessionId` 是「这条通知与哪段会话有关」的真值列（可空 = 全域通知），
 * 按会话过滤与按会话清除都走它。
 */

import type { Database } from "./Database.js";
import type { Notice, NoticeCreateInput, NoticeRow } from "./types.js";

const COLUMNS = "id, level, code, params, durationMs, sessionId, origin, createdAt";

/** `params` 列只有 `create()` 写：`JSON.stringify(参数对象)` 或 `NULL`。这里照着那两种形状读回来 */
function parseParams(value: string | null): Record<string, unknown> | null {
  return value === null ? null : (JSON.parse(value) as Record<string, unknown>);
}

function toNotice(row: NoticeRow): Notice {
  return {
    id: row.id,
    level: row.level,
    code: row.code,
    params: parseParams(row.params),
    durationMs: row.durationMs,
    sessionId: row.sessionId,
    origin: row.origin,
    createdAt: row.createdAt,
  };
}

export class NoticeRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(input: NoticeCreateInput): Promise<void> {
    await this.db.run(`INSERT INTO notices (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      input.id,
      input.level,
      input.code,
      input.params === undefined || input.params === null ? null : JSON.stringify(input.params),
      input.durationMs ?? null,
      input.sessionId ?? null,
      input.origin ?? "app",
      input.createdAt,
    ]);
  }

  async get(id: string): Promise<Notice | undefined> {
    const row = await this.db.get<NoticeRow>(`SELECT ${COLUMNS} FROM notices WHERE id = ?`, [id]);
    return row ? toNotice(row) : undefined;
  }

  /**
   * 仍然该显示的通知：永久的（`durationMs IS NULL`）加上还没到点的。
   * 已到点但还没被 `deleteExpired` 扫掉的，这里也不返回，免得读到已过期的通知。
   */
  async listActive(now: number): Promise<Notice[]> {
    const rows = await this.db.all<NoticeRow>(
      `SELECT ${COLUMNS} FROM notices
       WHERE durationMs IS NULL OR createdAt + durationMs > ?
       ORDER BY createdAt ASC, id ASC`,
      [now],
    );
    return rows.map(toNotice);
  }

  /** 手动清除一条（PRD L3：永久通知只能这样消失） */
  async clear(id: string): Promise<number> {
    const result = await this.db.run("DELETE FROM notices WHERE id = ?", [id]);
    return result.changes;
  }

  async clearAll(): Promise<number> {
    const result = await this.db.run("DELETE FROM notices");
    return result.changes;
  }

  /** 清掉挂在一段会话上的通知（`notice.clear({ sessionId })` 的读写路径） */
  async clearBySession(sessionId: string): Promise<number> {
    const result = await this.db.run("DELETE FROM notices WHERE sessionId = ?", [sessionId]);
    return result.changes;
  }

  /** 清掉已经到点的通知，返回清掉的条数 */
  async deleteExpired(now: number): Promise<number> {
    const result = await this.db.run(
      "DELETE FROM notices WHERE durationMs IS NOT NULL AND createdAt + durationMs <= ?",
      [now],
    );
    return result.changes;
  }
}
