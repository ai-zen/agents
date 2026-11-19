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

/** 事务里一条语句的执行方式：整表读、单行读、写 */
export type TxKind = "all" | "get" | "run";

/** 送进 worker 的一条语句（`kind` 决定它在 worker 里按哪条路径执行） */
interface TxBatchStatement {
  kind: TxKind;
  sql: string;
  params: SQLInputValue[];
}

/**
 * 在 `tx` 回调里登记一条语句后拿到的凭据：批次跑完后靠它把结果从 `tx` 的返回值里取出来。
 *
 * `index` 是这条语句在批次里的位置。`output` 只在类型上标记「这条语句会产出什么形状」，
 * 运行时是 `undefined`，不参与跨线程传输。
 */
export interface TxStatement<T> {
  readonly index: number;
  readonly output?: T;
}

/**
 * `tx` 回调拿到的客户端：`all` / `get` / `run` 都只是**登记**语句，按登记顺序排进同一批。
 *
 * 批次在回调返回后一次性送进 worker，在同一个事务里串行执行；读到的值由回调返回哪几条
 * 凭据决定（返回凭据数组 → 拿到等长的结果，返回单条凭据 → 拿到单条结果，什么都不返回 →
 * 只是一批写）。回调自己抛错时批次还没发出去，库里不会有任何改动。
 */
export interface TxClient {
  all<T>(sql: string, params?: SQLInputValue[]): TxStatement<T[]>;
  get<T>(sql: string, params?: SQLInputValue[]): TxStatement<T | undefined>;
  run(sql: string, params?: SQLInputValue[]): TxStatement<RunResult>;
}

/** 回调能返回的东西：不关心结果、一条语句的凭据、或一组凭据 */
export type TxPlan = TxStatement<unknown> | readonly TxStatement<unknown>[] | void;

/** 单条凭据对应结果的类型 */
export type TxValue<S> = S extends TxStatement<infer R> ? R : never;

/**
 * `tx` 的返回值：回调返回一组凭据时是等长的结果元组，返回单条凭据时是那条的结果，
 * 什么都不返回时是 `void`。
 */
export type TxOutcome<S extends TxPlan> = S extends readonly TxStatement<unknown>[]
  ? { [K in keyof S]: TxValue<S[K]> }
  : S extends TxStatement<unknown>
    ? TxValue<S>
    : void;

type RequestPayload =
  | { kind: "all"; sql: string; params: SQLInputValue[] }
  | { kind: "get"; sql: string; params: SQLInputValue[] }
  | { kind: "run"; sql: string; params: SQLInputValue[] }
  | { kind: "batch"; statements: TxBatchStatement[] };

type WorkerResponse =
  { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: string };

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

function isStatementList(
  value: TxStatement<unknown> | readonly TxStatement<unknown>[],
): value is readonly TxStatement<unknown>[] {
  return Array.isArray(value);
}

/** 按凭据里的下标把结果对回调用方；下标越界说明凭据不是这一批登记的，直接报错 */
function pickResult<T>(statement: TxStatement<T>, results: readonly unknown[]): T {
  if (statement.index >= results.length) {
    throw new Error(`tx 结果缺少第 ${statement.index} 条语句（本批共 ${results.length} 条）`);
  }
  return results[statement.index] as T;
}

function pickOutcome(plan: TxPlan, results: readonly unknown[]): unknown {
  if (plan === undefined) return undefined;
  if (isStatementList(plan)) return plan.map((statement) => pickResult(statement, results));
  return pickResult(plan, results);
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
   * 事务：回调里用 `client.all` / `get` / `run` 登记语句，回调返回后整批在 worker 里
   * `BEGIN IMMEDIATE` → 按登记顺序逐条执行 → `COMMIT`，任一条失败就整体 ROLLBACK。
   *
   * 回调返回的凭据决定拿回哪些结果，所以「先读后写」是一次往返、一个事务：
   *
   * ```ts
   * const [found, written] = await db.tx((q) => [
   *   q.get<{ n: number }>("SELECT n FROM t WHERE id = ?", [id]),
   *   q.run("UPDATE t SET n = n + 1 WHERE id = ?", [id]),
   * ]);
   * ```
   *
   * 回调抛错时还什么都没发出去，等于什么都没写，直接向上抛。
   */
  async tx<const S extends TxPlan>(
    fn: (client: TxClient) => S | Promise<S>,
  ): Promise<TxOutcome<S>> {
    this.assertOpen();
    const batch: TxBatchStatement[] = [];
    const register = <T>(kind: TxKind, sql: string, params: SQLInputValue[]): TxStatement<T> => {
      const index = batch.length;
      batch.push({ kind, sql, params });
      return { index };
    };
    const client: TxClient = {
      all: <T>(sql: string, params: SQLInputValue[] = []) => register<T[]>("all", sql, params),
      get: <T>(sql: string, params: SQLInputValue[] = []) =>
        register<T | undefined>("get", sql, params),
      run: (sql: string, params: SQLInputValue[] = []) => register<RunResult>("run", sql, params),
    };

    const plan = await fn(client);
    const results =
      batch.length === 0
        ? []
        : ((await this.dispatch({ kind: "batch", statements: batch })) as readonly unknown[]);
    return pickOutcome(plan, results) as TxOutcome<S>;
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
    worker.on("message", (response: WorkerResponse) => this.resolveResponse(response));
    // worker 崩溃 / 退出：把所有挂起请求 reject 掉，否则调用方会一直等下去
    worker.on("error", (error) => this.failAll(toError(error)));
    worker.on("exit", () => this.failAll(new Error("SQLite worker 已退出")));
    this.worker = worker;
    return worker;
  }

  /** 一条 worker 回执 → 它对应的那个等待者 */
  private resolveResponse(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return; // 关闭流程里的回执：没有对应的等待者
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
