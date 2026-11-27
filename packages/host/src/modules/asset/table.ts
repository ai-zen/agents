import type { DatabaseSync } from "node:sqlite";

import { jsonTable } from "../../infra/json-table.js";
import type { AssetRecord } from "./types.js";

/**
 * Asset 表。`sha256` 是生成列，唯一索引放在它上面：同一份字节全库只留一行，判据就是这条索引
 * —— 先查再插会漏掉两步之间的那一次。
 *
 * 磁盘上那份文件的路径不进行里：它由 `sha256` 算出来，存一份路径就多一个会和摘要对不上的值。
 */
export function assetTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id        TEXT PRIMARY KEY,
      payload   TEXT NOT NULL,
      sha256    TEXT    GENERATED ALWAYS AS (json_extract(payload, '$.sha256')) STORED,
      createdAt INTEGER GENERATED ALWAYS AS (json_extract(payload, '$.createdAt')) STORED
    );
    CREATE UNIQUE INDEX IF NOT EXISTS assets_sha256 ON assets (sha256);
  `);

  const rows = jsonTable<AssetRecord>(db, "assets");

  return {
    ...rows,

    getBySha256(sha256: string): AssetRecord | undefined {
      return rows.query("WHERE sha256 = ?", [sha256]).at(0);
    },

    /**
     * 一段会话引用了哪些 Asset。引用行挂在消息上，所以这里穿过 `messages` 取这一段会话名下的
     * 那些：让引用行自己也记一份 `sessionId`，就是让「这条消息属于哪段会话」在两处各有一份。
     */
    listBySession(sessionId: string): AssetRecord[] {
      return rows.query(
        `WHERE id IN (
           SELECT assetId FROM session_assets
            WHERE messageId IN (SELECT id FROM messages WHERE sessionId = ?)
         )
         ORDER BY createdAt, id`,
        [sessionId],
      );
    },
  };
}

/**
 * 「哪条消息引用了哪份 Asset」。行里只有这两个 id —— 引用关系没有别的可记的东西。
 *
 * 两个外键都是级联：删消息（以及删会话时被连带删掉的消息）带走引用行，删 Asset 行也带走它。
 * Asset 行只由 `AssetService.sweepUnreferenced` 在引用归零之后删，所以级联不会抢先删掉还有引用的行。
 */
export function sessionAssetTable(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_assets (
      id        TEXT PRIMARY KEY,
      payload   TEXT NOT NULL,
      messageId TEXT GENERATED ALWAYS AS (json_extract(payload, '$.messageId')) STORED
                       REFERENCES messages (id) ON DELETE CASCADE,
      assetId   TEXT GENERATED ALWAYS AS (json_extract(payload, '$.assetId')) STORED
                       REFERENCES assets (id) ON DELETE CASCADE,
      UNIQUE (messageId, assetId)
    );
    CREATE INDEX IF NOT EXISTS session_assets_asset ON session_assets (assetId);
  `);

  const insert = db.prepare(
    "INSERT INTO session_assets (id, payload) VALUES (?, ?) ON CONFLICT DO NOTHING",
  );

  return {
    /**
     * 登记「这条消息引用了这几份 Asset」。同一对 `(messageId, assetId)` 反复 link 只留一行。
     *
     * 幂等是这张表的硬要求，理由在时间轴那一侧：观察者每收到一次消息事实就来登记一次
     *（新增 / 变了 / 定稿都算），而流式期间一条消息会被写很多次 —— 一百片的回答就是一百次。
     * 不幂等的话引用行会成倍长出来，`countByAsset` 也就再也归不了零，Asset 永远删不掉。
     *
     * 判据交给上面那条 `UNIQUE (messageId, assetId)` 加插入时的 `ON CONFLICT DO NOTHING`，
     * 不在这层「先查一次、没有再插」：那样的两步之间，另一段会话的一次写入就能把同一对插进去，
     * 先查的那一次于是成了摆设。让库自己判，冲突只有它一个答案。
     */
    link(messageId: string, assetIds: readonly string[]): void {
      for (const assetId of assetIds) {
        insert.run(crypto.randomUUID(), JSON.stringify({ messageId, assetId }));
      }
    },

    /** 这份 Asset 还剩几条引用：它归零才轮到删字节与行 */
    countByAsset(assetId: string): number {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM session_assets WHERE assetId = ?")
        .get(assetId);
      return Number(row?.count ?? 0);
    },
  };
}
