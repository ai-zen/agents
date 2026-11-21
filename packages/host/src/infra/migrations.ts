import type { DatabaseSync } from "node:sqlite";

/**
 * 版本 0 → 1：给已经存在的 `messages` 补上 `searchText` 与 `hidden`，并把全文索引重建一遍。
 *
 * 这两列是建表语句之后才加的，而建表走的是 `CREATE TABLE IF NOT EXISTS` —— 对已经存在的表是
 * 空操作，于是旧库里的 `messages` 永远停在没有这两列的形状上，索引的触发器与搜索却都按新形状
 * 写。新库建表时这两列本来就在；表不存在时这一步什么都不做。
 */
export function addMessageSearchColumns(db: DatabaseSync): void {
  // 生成列不出现在 `PRAGMA table_info` 的结果里，带 `hidden` 那一格的只有 `table_xinfo`。
  // 拿前者判断 `hidden`，新形状的表会被判成缺列，再 ALTER 一次就撞上 duplicate column name。
  const columns = new Set(
    db
      .prepare("PRAGMA table_xinfo(messages)")
      .all()
      .map((row) => String(row.name)),
  );
  if (columns.size === 0) return;

  if (!columns.has("searchText")) {
    db.exec("ALTER TABLE messages ADD COLUMN searchText TEXT NOT NULL DEFAULT ''");
  }
  // 生成列只能以 `VIRTUAL` 后加：`ALTER TABLE ADD COLUMN` 加 `STORED` 生成列会被拒绝
  // （cannot add a STORED column）。新库里这一列是 `STORED`，旧库里补出来的是 `VIRTUAL`；
  // 表达式一样，读到的值也一样，两者对查询等价。
  if (!columns.has("hidden")) {
    db.exec(
      `ALTER TABLE messages ADD COLUMN hidden INTEGER
         GENERATED ALWAYS AS (COALESCE(json_extract(payload, '$.hidden'), 0)) VIRTUAL`,
    );
  }

  // `messages_fts` 是 external content 表：索引只收它建好之后写进去的行，此前的行一条都没有，
  // 只能靠 rebuild 按 `messages` 重扫一遍。那张虚拟表归 `searchTable` 建，旧库里可能还没有它，
  // 那种库上没有可重建的索引，也就不动。
  const hasIndex =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
      .get() !== undefined;
  if (hasIndex) db.exec("INSERT INTO messages_fts (messages_fts) VALUES ('rebuild')");
}
