import type { DatabaseSync } from "node:sqlite";

import { jsonTable } from "../../infra/json-table.js";
import type { Credential } from "./types.js";

/**
 * 凭证表。校验就是「拿摘要找那一行」，所以 `hash` 既是生成列也是唯一索引：摘要是这把令牌的
 * 身份，先查再插会漏掉两步之间的那一次。
 */
export function credentialTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id      TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      hash    TEXT GENERATED ALWAYS AS (json_extract(payload, '$.hash')) STORED
    );
    CREATE UNIQUE INDEX IF NOT EXISTS credentials_hash ON credentials (hash);
  `);

  const rows = jsonTable<Credential>(db, "credentials");

  return {
    ...rows,

    /** 摘要唯一，所以最多一条 */
    getByHash(hash: string): Credential | undefined {
      return rows.query("WHERE hash = ?", [hash])[0];
    },

    /** 创建顺序：这一域没有排序列，也不为一张只有几行的表多加一列 */
    list(): Credential[] {
      return rows.query("");
    },
  };
}
