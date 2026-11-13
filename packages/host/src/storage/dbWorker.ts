/**
 * SQLite worker 线程：`node:sqlite` 只提供同步 API（`DatabaseSync`），在主线程上执行会
 * 直接卡住事件循环（宿主要和多个 WebSocket 连接同时打交道，卡一次就是全体卡住），
 * 所以数据库句柄整个住在 worker 里，主线程只发消息、按 id 收结果。
 *
 * 这里刻意只 import Node 内置模块、不 import 任何同目录文件：
 * worker 是以自己的模块图独立启动的，依赖越少启动越快、也不会踩到「源码是 .ts / 产物是
 * .js」这种路径差异。
 */

import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** worker 启动参数：数据库文件路径（由 Database 在主线程传入） */
interface WorkerInit {
  dbPath: string;
}

/** 主线程 → worker 的请求（与 Database.ts 里的 WorkerRequest 一一对应） */
type WorkerRequest =
  | { id: number; kind: "all"; sql: string; params: SQLInputValue[] }
  | { id: number; kind: "get"; sql: string; params: SQLInputValue[] }
  | { id: number; kind: "run"; sql: string; params: SQLInputValue[] }
  | { id: number; kind: "batch"; statements: Statement[] }
  | { id: number; kind: "close" };

/** 事务里的一条语句：`kind` 决定按整表读、单行读还是写执行 */
interface Statement {
  kind: "all" | "get" | "run";
  sql: string;
  params: SQLInputValue[];
}

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

const port = parentPort;
if (!port) throw new Error("dbWorker 只能由 worker_threads 启动");

const { dbPath } = workerData as WorkerInit;

// 数据库文件所在目录可能还不存在（首次启动、测试用临时目录），开库前先补上
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new DatabaseSync(dbPath);

// WAL：读不被写阻塞、写不被读阻塞，崩溃后也更容易恢复。
// 读回来的模式必须真的是 "wal" —— 文件系统不支持时（网络盘、只读目录等）会静默留在
// delete 模式，那种情况下并发读写会互相卡住，与其带病运行不如让启动直接失败。
const journal = sqlite.prepare("PRAGMA journal_mode = WAL").get() as
  | { journal_mode?: string }
  | undefined;
if (journal?.journal_mode !== "wal") {
  throw new Error(
    `无法切换到 WAL 日志模式（当前为 ${String(journal?.journal_mode)}），数据库路径：${dbPath}`,
  );
}

// 外键约束在 SQLite 里默认是关的，必须显式打开，级联删除才会生效
sqlite.exec("PRAGMA foreign_keys = ON");
const foreignKeys = sqlite.prepare("PRAGMA foreign_keys").get() as
  | { foreign_keys?: number }
  | undefined;
if (foreignKeys?.foreign_keys !== 1) {
  throw new Error("无法开启 foreign_keys，级联删除不会生效");
}

/**
 * 语句缓存：SQL 全部来自仓储里的固定语句，种类有限，缓存下来省掉热路径上重复编译。
 * 若某次迁移改动了表结构，SQLite 会在下次执行时自动重新编译，不需要手动失效。
 */
const statementCache = new Map<string, StatementSync>();

function prepare(sql: string): StatementSync {
  const cached = statementCache.get(sql);
  if (cached) return cached;
  const compiled = sqlite.prepare(sql);
  statementCache.set(sql, compiled);
  return compiled;
}

/** 执行一条写语句；`changes` / `lastInsertRowid` 统一转成 number，保证能结构化克隆 */
function runStatement(sql: string, params: SQLInputValue[]): RunResult {
  const result = prepare(sql).run(...params);
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

/** 按语句自己声明的种类执行：读的回行，写的回 `changes` / `lastInsertRowid` */
function executeStatement(statement: Statement): unknown {
  switch (statement.kind) {
    case "all":
      return prepare(statement.sql).all(...statement.params);
    case "get":
      return prepare(statement.sql).get(...statement.params);
    case "run":
      return runStatement(statement.sql, statement.params);
  }
}

/**
 * 一次消息内串行执行一批语句：`BEGIN IMMEDIATE` 先拿写锁，中途任何一条失败就整批
 * ROLLBACK。主线程的 `Database.tx` 就是靠这个保证「要么全成、要么全不成」，也是它能让
 * 回调里「先读再写」而不拆成两次往返的原因（读与写在同一个事务、同一条消息里跑完）。
 */
function runBatch(statements: Statement[]): unknown[] {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const results = statements.map((statement) => executeStatement(statement));
    sqlite.exec("COMMIT");
    return results;
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // 部分错误（如死锁/中断）下 SQLite 已经自己回滚了，这里的再次回滚失败可以忽略
    }
    throw error;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

port.on("message", (request: WorkerRequest) => {
  try {
    switch (request.kind) {
      case "all": {
        const rows = prepare(request.sql).all(...request.params);
        port.postMessage({ id: request.id, ok: true, result: rows });
        break;
      }
      case "get": {
        const row = prepare(request.sql).get(...request.params);
        port.postMessage({ id: request.id, ok: true, result: row });
        break;
      }
      case "run": {
        port.postMessage({
          id: request.id,
          ok: true,
          result: runStatement(request.sql, request.params),
        });
        break;
      }
      case "batch": {
        port.postMessage({ id: request.id, ok: true, result: runBatch(request.statements) });
        break;
      }
      case "close": {
        // 先回执再收尾：主线程拿到回执就知道挂起表可以释放了
        port.postMessage({ id: request.id, ok: true });
        statementCache.clear();
        sqlite.close();
        port.close();
        break;
      }
    }
  } catch (error) {
    port.postMessage({ id: request.id, ok: false, error: describeError(error) });
  }
});
