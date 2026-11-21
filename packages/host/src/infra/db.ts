import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { addMessageSearchColumns } from "./migrations.js";

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
  migrate(db);
  return db;
}

/**
 * 一批写：`work` 抛错就整批退回。
 *
 * 只接受同步的 `work`。`node:sqlite` 的接口是同步的，事务边界与这批写必须落在同一段栈上：
 * 传一个 async 函数进来，`COMMIT` 会在它第一个 `await` 之前就执行，之后抛的错已经出了事务。
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 把库的结构递进到当前版本，返回时库的形状与 `PRAGMA user_version` 一致。
 *
 * 每一级只补已经存在的表缺的东西，不建表：建表归各域的 `*Table(db)`，它们在本函数之后才被
 * 调用 —— 新库走到这里一张表都没有，所以每一级都得能对着空库跑。
 */
function migrate(db: DatabaseSync): void {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);

  if (version < 1) {
    transaction(db, () => {
      addMessageSearchColumns(db);
      db.exec("PRAGMA user_version = 1");
    });
  }
}
