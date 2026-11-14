/**
 * `Database` 门面与 worker 的协作测试：建库、四条执行通道、事务里的读与写、关闭语义。
 * 库开在一次性临时目录里，不碰仓库目录、也不碰用户的 `~/.ai-zen`。
 *
 * 库整个文件只建一次，每个用例只把用例自己建的 `t` 删掉；验证 `close()` 语义的那两条
 * 天生要销毁库，它们自己在同一个临时目录里另开一个（见下面的 `ownDatabase`）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "./Database.js";

let dir: string;
let db: Database;

/**
 * 要销毁库的用例在这里另开一个（同一个临时目录、另一个文件名，由 `afterAll` 统一关掉）。
 *
 * 这些用例里用 `const db = ownDatabase(...)` 遮蔽外层那个共享库，所以用例正文（包括断言）
 * 一行不用改，读到的就是自己的那个。
 */
const ownDbs: Database[] = [];

function ownDatabase(fileName: string): Database {
  const own = new Database(join(dir, fileName));
  ownDbs.push(own);
  return own;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-storage-db-"));
  db = new Database(join(dir, "ai-zen.db"));
});

beforeEach(async () => {
  // 这组用例不跑迁移，只拿 `t` 当沙盘：上一条用例建的那张表先拆掉
  await db.run("DROP TABLE IF EXISTS t");
});

afterAll(async () => {
  for (const own of ownDbs) await own.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("Database", () => {
  it("建库后能跑 all / get / run，并按 WAL 模式打开", async () => {
    // 「建库」这条要的是一个还不存在的库文件（共享库已被 beforeEach 开过了），所以自己开一个
    const db = ownDatabase("fresh-create.db");
    const journal = await db.get<{ journal_mode: string }>("PRAGMA journal_mode");
    expect(journal?.journal_mode).toBe("wal");

    await db.run("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    const inserted = await db.run("INSERT INTO t (id, n) VALUES (?, ?)", ["a", 1]);
    expect(inserted.changes).toBe(1);

    await db.run("INSERT INTO t (id, n) VALUES (?, ?)", ["b", 2]);
    const rows = await db.all<{ id: string; n: number }>("SELECT id, n FROM t ORDER BY n");
    expect(rows).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ]);

    const single = await db.get<{ n: number }>("SELECT n FROM t WHERE id = ?", ["b"]);
    expect(single?.n).toBe(2);

    const missing = await db.get<{ n: number }>("SELECT n FROM t WHERE id = ?", ["zzz"]);
    expect(missing).toBeUndefined();
  });

  it("外键约束是打开的（worker 初始化里显式 PRAGMA）", async () => {
    const pragma = await db.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(pragma?.foreign_keys).toBe(1);
  });

  it("tx 成功时整批提交，语句按登记顺序执行", async () => {
    await db.run("CREATE TABLE t (id TEXT PRIMARY KEY)");
    await db.tx((q) => {
      q.run("INSERT INTO t (id) VALUES (?)", ["x"]);
      q.run("INSERT INTO t (id) VALUES (?)", ["y"]);
    });
    const rows = await db.all<{ id: string }>("SELECT id FROM t ORDER BY id");
    expect(rows.map((row) => row.id)).toEqual(["x", "y"]);
  });

  it("tx 里能读：读到的是同一事务里写之后的状态（R19）", async () => {
    await db.run("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    await db.run("INSERT INTO t (id, n) VALUES ('a', 1)");

    const [before, updated, after, listed] = await db.tx((q) => [
      q.get<{ n: number }>("SELECT n FROM t WHERE id = ?", ["a"]),
      q.run("UPDATE t SET n = n + 1 WHERE id = ?", ["a"]),
      q.get<{ n: number }>("SELECT n FROM t WHERE id = ?", ["a"]),
      q.all<{ n: number }>("SELECT n FROM t ORDER BY n"),
    ]);

    expect(before?.n).toBe(1);
    expect(updated.changes).toBe(1);
    expect(after?.n).toBe(2);
    expect(listed).toEqual([{ n: 2 }]);
  });

  it("tx 里只读也可以：结果按登记顺序对回来", async () => {
    await db.run("CREATE TABLE t (id TEXT PRIMARY KEY)");
    await db.run("INSERT INTO t (id) VALUES ('x')");

    const single = await db.tx((q) => q.get<{ id: string }>("SELECT id FROM t"));
    expect(single?.id).toBe("x");

    const missing = await db.tx((q) =>
      q.get<{ id: string }>("SELECT id FROM t WHERE id = ?", ["nope"]),
    );
    expect(missing).toBeUndefined();
  });

  it("tx 里的读语句出错时整批回滚，前面的写也不留", async () => {
    await db.run("CREATE TABLE t (id TEXT PRIMARY KEY)");
    await expect(
      db.tx((q) => [
        q.run("INSERT INTO t (id) VALUES (?)", ["written"]),
        q.get("SELECT * FROM 不存在的表"),
      ]),
    ).rejects.toThrow();

    expect(await db.all("SELECT id FROM t")).toEqual([]);
  });

  it("tx 中途失败时整批回滚，前面成功的语句也不留下", async () => {
    await db.run("CREATE TABLE t (id TEXT PRIMARY KEY)");
    await expect(
      db.tx((q) => {
        q.run("INSERT INTO t (id) VALUES (?)", ["kept?"]);
        q.run("INSERT INTO t (id) VALUES (?)", ["kept?"]); // 主键冲突
      }),
    ).rejects.toThrow(/UNIQUE|constraint/i);

    const rows = await db.all<{ id: string }>("SELECT id FROM t");
    expect(rows).toEqual([]);
  });

  it("tx 回调自己抛错时不会写任何东西", async () => {
    await db.run("CREATE TABLE t (id TEXT PRIMARY KEY)");
    await expect(
      db.tx((q) => {
        q.run("INSERT INTO t (id) VALUES (?)", ["never"]);
        throw new Error("业务侧放弃");
      }),
    ).rejects.toThrow("业务侧放弃");

    const rows = await db.all<{ id: string }>("SELECT id FROM t");
    expect(rows).toEqual([]);
  });

  it("SQL 出错时只 reject 那一条，数据库仍然可用", async () => {
    await expect(db.all("SELECT * FROM 不存在的表")).rejects.toThrow();
    const ok = await db.get<{ one: number }>("SELECT 1 AS one");
    expect(ok?.one).toBe(1);
  });

  it("close 之后所有调用都直接 reject，close 本身可重复调用", async () => {
    // 这条要把库销毁掉（后面的用例还要用共享库），所以自己开一个
    const db = ownDatabase("close-repeat.db");
    await db.get("SELECT 1");
    await db.close();
    await db.close();

    await expect(db.all("SELECT 1")).rejects.toThrow("已关闭");
    await expect(db.get("SELECT 1")).rejects.toThrow("已关闭");
    await expect(db.run("SELECT 1")).rejects.toThrow("已关闭");
    await expect(db.tx(() => undefined)).rejects.toThrow("已关闭");
  });

  it("close 会把仍在排队的请求 reject 掉，不留悬挂 Promise", async () => {
    // 同上：这条要连 worker 一起关掉，用自己那个库
    const db = ownDatabase("close-pending.db");
    // 塞一条慢语句（递归 CTE 制造延迟），趁它还没跑完就关闭；
    // 先挂上 catch 处理器，避免 close 里的同步 reject 变成未处理的 rejection
    const slow = db
      .get(
        "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 200000) SELECT count(*) AS n FROM c",
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    await db.close();
    const error = await slow;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("已关闭");
  });
});
