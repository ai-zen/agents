import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 开库：`file` 为 `:memory:` 时不落盘（用例用它）。
 *
 * 不起 worker 线程：一条本地查询是微秒级，单用户宿主的开销远小于一次跨线程往返
 * （旧实现为此写了一整套批量事务协议）。
 *
 * **没有迁移。** 这个项目没有旧版本，也没有要迁的库：表由各域的 `*Table(db)` 就地建出来，
 * 出现形状对不上的库时，唯一正确的处理是把那个文件删掉重建。为「可能有人手上有旧库」写的
 * 版本递进，保护的是一个不存在的处境，而它自己的分支（补列、重建索引、判断列存不存在）
 * 每一处都是新的出错面。
 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
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
