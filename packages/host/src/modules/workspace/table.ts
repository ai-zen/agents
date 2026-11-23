import type { DatabaseSync } from "node:sqlite";

import { jsonTable } from "../../infra/json-table.js";
import type { WorkspaceRecord } from "./types.js";

/**
 * 项目表。`cwd` 由库从 `payload` 里算出来，唯一性也由库上的索引把关 ——
 * 先查再写会漏掉两步之间的那一次，而同一个目录只能是同一个项目。
 *
 * `createdAt` 同样只是生成列：列给的是列表排序，JS 一个字节都不写它。
 */
export function workspaceTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id        TEXT PRIMARY KEY,
      payload   TEXT NOT NULL,
      cwd       TEXT    GENERATED ALWAYS AS (json_extract(payload, '$.cwd')) STORED,
      createdAt INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.createdAt')) STORED
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workspaces_cwd ON workspaces (cwd);
    CREATE INDEX IF NOT EXISTS workspaces_order ON workspaces (createdAt DESC);
  `);

  const rows = jsonTable<WorkspaceRecord>(db, "workspaces");

  return {
    ...rows,

    /** 后加的项目排在前面；同一毫秒建的两个用 `id` 定序，否则每次读回来的顺序都可能不同 */
    list(): WorkspaceRecord[] {
      return rows.query("ORDER BY createdAt DESC, id");
    },
  };
}
