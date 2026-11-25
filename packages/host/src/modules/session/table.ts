import type { DatabaseSync } from "node:sqlite";

import { jsonTable } from "../../infra/json-table.js";
import type { SessionRecord } from "./types.js";

/**
 * 会话表。排序与过滤用到的四列由库从 `payload` 里算出来，JS 一个字节都不写。
 *
 * `pinned` 用 `COALESCE` 兜住缺键：缺这个键时 `json_extract` 给的是 NULL，而 NULL 参与比较
 * 既不是 0 也不是 1，写成 `pinned = 0` 会把缺键的行漏掉。
 *
 * 排序是「置顶优先，再按**最后一次动过的时刻**倒序」（`updatedAt`）：列表要回答的是「哪一段
 * 最近动过」，而 `createdAt` 只是「哪一段先建」—— 一段上周建的会话今天接着聊，它应该排在最上面。
 * `updatedAt` 由 `SessionService.touch()` 在每一批活开始时推一次（老的那一条 `sessions_order`
 * 索引按 `createdAt` 排，已经不用了，这里一并删掉）。
 *
 * `workspaceId` 上的外键是「删项目连带删它名下的会话」（PRD 1.5）的唯一实现：删项目那一侧
 * 只删自己那一行，不跨域写另一张表。`openDatabase` 已打开 `foreign_keys`，级联才会生效。
 */
export function sessionTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      payload     TEXT NOT NULL,
      workspaceId TEXT    GENERATED ALWAYS AS (json_extract(payload, '$.workspaceId')) STORED
                          REFERENCES workspaces (id) ON DELETE CASCADE,
      pinned      INTEGER GENERATED ALWAYS AS (COALESCE(json_extract(payload, '$.pinned'), 0)) STORED,
      createdAt   INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.createdAt')) STORED
    );
    DROP INDEX IF EXISTS sessions_order;
    CREATE INDEX IF NOT EXISTS sessions_activity ON sessions (
      workspaceId, pinned DESC, json_extract(payload, '$.updatedAt') DESC
    );
  `);

  /** 排序就是这一句：置顶优先，再按最后动过的时刻（同一毫秒内按建行时刻兜住顺序） */
  const ORDER = "ORDER BY pinned DESC, json_extract(payload, '$.updatedAt') DESC, createdAt DESC";

  const rows = jsonTable<SessionRecord>(db, "sessions");

  return {
    ...rows,

    listByWorkspace(workspaceId: string): SessionRecord[] {
      return rows.query(`WHERE workspaceId = ? ${ORDER}`, [workspaceId]);
    },

    list(): SessionRecord[] {
      return rows.query(ORDER);
    },
  };
}
