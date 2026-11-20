import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 开库：`file` 为 `:memory:` 时不落盘（用例用它）。
 *
 * 不起 worker 线程：一条本地查询是微秒级，单用户宿主的开销远小于一次跨线程往返
 * （旧实现为此写了一整套批量事务协议）。
 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
