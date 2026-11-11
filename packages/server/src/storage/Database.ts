/**
 * 数据库门面：对外只有 `all` / `get` / `run` / `tx` / `close` 五个异步方法，内部把每条
 * 请求变成一条 worker 消息，交给 `dbWorker.ts` 在独立线程里用同步的 `DatabaseSync` 执行。
 *
 * 主线程因此完全不碰 SQL 执行：不会阻塞事件循环，也不会有「一个慢查询卡住所有 WebSocket
 * 连接」这种事。
 *
 * 实例由创建者持有并注入给各 Repository（依赖从单根出发），本模块不导出任何模块级单例。
 */

import { Worker } from "node:worker_threads";
import type { SQLInputValue } from "node:sqlite";

/** 写语句的返回（worker 侧已把 bigint 转成 number，可安全跨线程传输） */
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** `tx` 回调里登记的一条语句 */
export interface TxStatement {
  sql: string;
  params: SQLInputValue[];
}

/**
 * `tx` 回调拿到的客户端：只能**登记**语句，语句在回调返回后一次性送进 worker，
 * 在同一个事务里按顺序执行。
 *
 * 事务内拿不到中间结果 —— 需要「读一下再决定写什么」的场合，把判断折进一条带子查询的
 * SQL 里，或者把读放在事务外（本层不做业务判断，跨表原子性由调用方用 `tx` 圈定范围）。
 */
export interface TxClient {
  run(sql: string, params?: SQLInputValue[]): void;
}

type RequestPayload =
  | { kind: "all"; sql: string; params: SQLInputValue[] }
  | { kind: "get"; sql: string; params: SQLInputValue[] }
  | { kind: "run"; sql: string; params: SQLInputValue[] }
  | { kind: "batch"; statements: TxStatement[] };

type WorkerResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * worker 入口的文件名：源码直接跑（vitest / 类型剥离）时同目录是 `.ts`，产物里是 `.js`。
 * 按当前模块自身的扩展名推导，两种运行方式都能找到同一个 worker。
 */
function resolveWorkerUrl(): URL {
  const self = new URL(import.meta.url);
  const extension = self.pathname.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./dbWorker${extension}`, self);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class Database {
  private readonly dbPath: string;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private closing: Promise<void> | null = null;

  /** @param dbPath SQLite 数据库文件路径 */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** 多行查询 */
  all<T>(sql: string, params: SQLInputValue[] = []): Promise<T[]> {
    return this.dispatch({ kind: "all", sql, params }) as Promise<T[]>;
  }

  /** 单行查询；没有命中的行时返回 `undefined` */
  get<T>(sql: string, params: SQLInputValue[] = []): Promise<T | undefined> {
    return this.dispatch({ kind: "get", sql, params }) as Promise<T | undefined>;
  }

  /** 写语句（INSERT / UPDATE / DELETE） */
  run(sql: string, params: SQLInputValue[] = []): Promise<RunResult> {
    return this.dispatch({ kind: "run", sql, params }) as Promise<RunResult>;
  }

  /**
   * 事务：回调里用 `tx.run` 登记语句，回调返回后整批在 worker 里
   * `BEGIN IMMEDIATE` → 逐条执行 → `COMMIT`，任一条失败就整体 ROLLBACK。
   *
   * 回调抛错时还什么都没发出去，等于什么都没写，直接向上抛。
   */
  async tx<T>(fn: (tx: TxClient) => Promise<T> | T): Promise<T> {
    this.assertOpen();
    const statements: TxStatement[] = [];
    const client: TxClient = {
      run(sql, params = []) {
        statements.push({ sql, params });
      },
    };
    const result = await fn(client);
    if (statements.length > 0) {
      await this.dispatch({ kind: "batch", statements });
    }
    return result;
  }

  /**
   * 关闭：先拒绝所有挂起的请求、把实例标记为已关闭（之后任何调用都直接 reject），
   * 再请 worker 关库退出；worker 没在超时内退出就强制终止，避免 `close()` 自己悬挂。
   */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    // 关库时仍在排队的请求一律以「已关闭」失败，不让调用方拿到永远不 resolve 的 Promise
    this.failAll(new Error("Database 已关闭，不再接受调用"));
    if (!worker) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void worker.terminate().then(
          () => resolve(),
          () => resolve(),
        );
      }, 2000);
      worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        worker.postMessage({ id: this.nextId++, kind: "close" });
      } catch {
        void worker.terminate().then(
          () => resolve(),
          () => resolve(),
        );
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Database 已关闭，不再接受调用");
  }

  /** 统一执行通道：分配请求 id、挂起 Promise、把消息交给 worker */
  private dispatch(payload: RequestPayload): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Database 已关闭，不再接受调用"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.workerHandle().postMessage({ ...payload, id });
      } catch (error) {
        // 消息本身没发出去（worker 已终止等），立刻失败，不留悬挂项
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  /** 懒启动：第一次真正要碰数据库时才起 worker */
  private workerHandle(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(resolveWorkerUrl(), {
      workerData: { dbPath: this.dbPath },
    });
    worker.on("message", (response: WorkerResponse) => this.settle(response));
    // worker 崩溃 / 退出：把所有挂起请求 reject 掉，否则调用方会一直等下去
    worker.on("error", (error) => this.failAll(toError(error)));
    worker.on("exit", () => this.failAll(new Error("SQLite worker 已退出")));
    this.worker = worker;
    return worker;
  }

  private settle(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return; // 关闭流程里的回执等，没有对应的等待者
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker = null;
  }
}
