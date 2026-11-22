import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * 一行 = `{ id, payload }`：`payload` 就是那条记录本身的 JSON，写进去什么样读出来什么样。
 *
 * 排序与过滤要用到的字段由建表时声明的生成列提供（库自己从 `payload` 里取，JS 从不写它们），
 * 所以这里只有 upsert / get / delete 三件事，没有逐字段映射。
 */
export function jsonTable<T extends { id: string }>(db: DatabaseSync, table: string) {
  const upsertSql = `INSERT INTO ${table} (id, payload) VALUES (?, ?)
    ON CONFLICT (id) DO UPDATE SET payload = excluded.payload`;
  const selectSql = `SELECT payload FROM ${table}`;

  return {
    put(row: T): void {
      db.prepare(upsertSql).run(row.id, JSON.stringify(row));
    },

    get(id: string): T | undefined {
      const row = db.prepare(`${selectSql} WHERE id = ?`).get(id);
      return row === undefined ? undefined : (JSON.parse(String(row.payload)) as T);
    },

    delete(id: string): void {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    },

    /** `clause` 是这一域自己的 `WHERE` / `ORDER BY`；空串表示全表 */
    query(clause: string, params: SQLInputValue[] = []): T[] {
      return db
        .prepare(`${selectSql} ${clause}`)
        .all(...params)
        .map((row) => JSON.parse(String(row.payload)) as T);
    },
  };
}
