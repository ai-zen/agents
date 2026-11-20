import type { DatabaseSync } from "node:sqlite";

import { jsonTable } from "../../infra/json-table.js";
import type { Session } from "./types.js";

/**
 * 会话表。排序与过滤用到的三列由库从 `payload` 里算出来，JS 一个字节都不写。
 *
 * `pinned` 用 `COALESCE` 兜住缺键：缺这个键时 `json_extract` 给的是 NULL，而 NULL 参与比较
 * 既不是 0 也不是 1，写成 `pinned = 0` 会把缺键的行漏掉。
 */
export function sessionTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      payload     TEXT NOT NULL,
      workspaceId TEXT    GENERATED ALWAYS AS (json_extract(payload, '$.workspaceId')) STORED,
      pinned      INTEGER GENERATED ALWAYS AS (COALESCE(json_extract(payload, '$.pinned'), 0)) STORED,
      createdAt   INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.createdAt')) STORED
    );
    CREATE INDEX IF NOT EXISTS sessions_order ON sessions (workspaceId, pinned DESC, createdAt DESC);
  `);

  const rows = jsonTable<Session>(db, "sessions");

  return {
    ...rows,

    listByWorkspace(workspaceId: string): Session[] {
      return rows.query("WHERE workspaceId = ? ORDER BY pinned DESC, createdAt DESC", [
        workspaceId,
      ]);
    },

    list(): Session[] {
      return rows.query("ORDER BY pinned DESC, createdAt DESC");
    },
  };
}
