import type { DatabaseSync } from "node:sqlite";

import { jsonTable } from "../../infra/json-table.js";
import type { Notice } from "./types.js";

/**
 * 通知表。`sessionId` 与 `createdAt` 是生成列：列给的是过滤与排序，JS 一个字节都不写它们。
 *
 * `sessionId` 上的外键是「删掉那段会话，它的通知跟着没」的实现 —— 会话那一侧只删自己那一行，
 * 不跨域写这张表。SQL 的外键在列值为 NULL 时不成立，所以全局通知不会被这段外键连坐，正是
 * 它要的效果。
 */
export function noticeTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      id        TEXT PRIMARY KEY,
      payload   TEXT NOT NULL,
      sessionId TEXT    GENERATED ALWAYS AS (json_extract(payload, '$.sessionId')) STORED
                        REFERENCES sessions (id) ON DELETE CASCADE,
      createdAt INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.createdAt')) STORED
    );
    CREATE INDEX IF NOT EXISTS notices_order ON notices (createdAt DESC);
    CREATE INDEX IF NOT EXISTS notices_session ON notices (sessionId, createdAt DESC);
  `);

  const rows = jsonTable<Notice>(db, "notices");

  return {
    ...rows,

    list(): Notice[] {
      return rows.query("ORDER BY createdAt DESC");
    },

    /** 那一段的，加上全局的：全局通知不属于任何一段，所以哪一段的界面上都得给 */
    listBySession(sessionId: string): Notice[] {
      return rows.query("WHERE sessionId = ? OR sessionId IS NULL ORDER BY createdAt DESC", [
        sessionId,
      ]);
    },

    clear(): void {
      db.exec("DELETE FROM notices");
    },

    clearBySession(sessionId: string): void {
      db.prepare("DELETE FROM notices WHERE sessionId = ?").run(sessionId);
    },

    /**
     * 清一条：回删掉的那一行，不存在的 id 回 `undefined`。删与读是同一条语句（`RETURNING`）：
     * 两个客户端同时清同一条时，只有真删掉的那一份拿到这一行。
     */
    removeOne(id: string): Notice | undefined {
      const row = db.prepare("DELETE FROM notices WHERE id = ? RETURNING payload").get(id);
      return row === undefined ? undefined : (JSON.parse(String(row.payload)) as Notice);
    },

    deleteExpired(now: number): void {
      db.prepare(
        `DELETE FROM notices
          WHERE json_extract(payload, '$.durationMs') IS NOT NULL
            AND createdAt + json_extract(payload, '$.durationMs') <= ?`,
      ).run(now);
    },
  };
}
