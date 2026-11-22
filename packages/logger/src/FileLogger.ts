/**
 * 一份日志文件：三档级别 + 来源标签 + 按大小轮转 + 排队的写盘。
 *
 * 这个包只管「把一行字写出去」。它**不读环境变量、不持全局单例、不写 stdout / stderr、
 * 不认识「通知」这个概念** —— 谁想知道刚刚写出去了一条什么，订阅 `onRecord` 自己处理。
 *
 * 三件事在这里定死：
 *
 * 1. **按大小轮转**：单份到 `maxBytes`（缺省 5MB）就换下一份，保留 `maxFiles` 份（缺省 5，
 *    含正在写的那份）。命名是 `<file>`（正在写）、`<file>.1`（上一份）……，最老的一份在
 *    轮转时删掉。不引依赖：`node:fs` 的 `rename` / `rm` 就够。
 * 2. **写盘按到达顺序串行排队**：一行日志的代价不该被写盘拖住，所以调用方不必等；`close()`
 *    把队排空再关流（进程退出前没写出去的行等于没写）。
 * 3. **流是懒开的**：第一次真的要写才 open —— 一行都没写的进程不必在磁盘上留一个空文件。
 *
 * 没有级别阈值：`info` / `warn` / `error` 一视同仁地写出去。挡掉哪一档不是这个包的判断。
 *
 * 行格式：`<ISO 时间> <级别> <来源> <消息> [detail JSON]`。级别定宽（`INFO ` / `WARN ` /
 * `ERROR`），于是 grep 一列就能筛。
 */

import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { dirname } from "node:path";

/** 三档级别（信息 / 警告 / 错误） */
export type LogLevel = "info" | "warn" | "error";

/**
 * 三方法的结构类型：`FileLogger` 与 `withSource()` 的产物都是它。
 */
export interface LogSink {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/** 写出去的一条记录（`onRecord` 的载荷） */
export interface LogRecord {
  level: LogLevel;
  /** 谁写的（`withSource` 换的就是这一格） */
  source: string;
  message: string;
  detail?: unknown;
  /** ISO 8601，取自注入的时钟 */
  at: string;
}

export interface FileLoggerOptions {
  /** 写到哪个文件；目录不存在就建 */
  file: string;
  /** 单份上限（字节），缺省 5MB */
  maxBytes?: number;
  /** 保留几份（含正在写的那份），缺省 5 */
  maxFiles?: number;
  /** 行里的来源标签，缺省 `app` */
  source?: string;
  /** 注入时钟（用例要可复现），缺省 `Date.now` */
  now?: () => number;
  /** 每写一条就回调一次。同步、fire-and-forget；它抛错只报给 `onWriteError`，不影响写盘 */
  onRecord?: (record: LogRecord) => void;
  /** 落盘失败（开流 / 写 / 轮转）的唯一出口；它自己抛错会被吞掉 */
  onWriteError?: (error: unknown) => void;
}

/** 单份日志文件的上限（5MB；到点换下一份） */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** 保留几份（含正在写的那一份） */
export const DEFAULT_MAX_FILES = 5;

export class FileLogger implements LogSink {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly defaultSource: string;
  private readonly now: () => number;
  private readonly onRecord?: (record: LogRecord) => void;
  private readonly onWriteError?: (error: unknown) => void;

  private stream: WriteStream | null = null;
  /** 正在写的那份已经写了多少字节（轮转判据） */
  private bytes = 0;
  /** 写盘按到达顺序串行（轮转要等当前流关掉，不能被打断） */
  private queue: Promise<void> = Promise.resolve();
  /** 收尾已经开始 / 结束：之后的行不再接纳（否则 `close()` 之后还会长出新内容） */
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(options: FileLoggerOptions) {
    this.file = options.file;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.defaultSource = options.source ?? "app";
    this.now = options.now ?? Date.now;
    this.onRecord = options.onRecord;
    this.onWriteError = options.onWriteError;
  }

  // -------------------------------------------------------------------------
  // 对外：三档写法
  // -------------------------------------------------------------------------

  info(message: string, detail?: unknown): void {
    this.log("info", this.defaultSource, message, detail);
  }

  warn(message: string, detail?: unknown): void {
    this.log("warn", this.defaultSource, message, detail);
  }

  error(message: string, detail?: unknown): void {
    this.log("error", this.defaultSource, message, detail);
  }

  // -------------------------------------------------------------------------
  // 对外：其余四件
  // -------------------------------------------------------------------------

  /** 现在这份日志写到哪（完整路径），供启动提示与用例读 */
  get filePath(): string {
    return this.file;
  }

  /** 换一个来源标签的视图：**同一个实例、同一份流**，换的只是行里的那一格 */
  withSource(source: string): LogSink {
    return {
      info: (message, detail) => this.log("info", source, message, detail),
      warn: (message, detail) => this.log("warn", source, message, detail),
      error: (message, detail) => this.log("error", source, message, detail),
    };
  }

  /**
   * 收尾：停止接纳新行 → 把排队的行写完 → 关流。
   *
   * 幂等（多个触发源可能先后叫到）。一行都没写过时是 no-op：不建目录、不留空文件。
   */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------

  /**
   * 一条记录的唯一入口：记时间 → 排队写盘 → 通知订阅者。
   *
   * `onRecord` 在**排队之后**才叫：它抛错不能把这条记录从盘上抹掉。
   */
  private log(level: LogLevel, source: string, message: string, detail?: unknown): void {
    if (this.closed) return;
    const at = new Date(this.now()).toISOString();
    const line = formatLine(at, level, source, message, detail);
    this.queue = this.queue
      .then(() => this.writeLine(line))
      .catch((error) => this.reportWriteError(error));
    this.notifyRecord({ level, source, message, detail, at });
  }

  private async writeLine(line: string): Promise<void> {
    const size = Buffer.byteLength(line);
    // 这一行自己就超上限时照写：写不进去比多占一份文件更糟
    if (this.bytes > 0 && this.bytes + size > this.maxBytes) {
      try {
        await this.rotate();
      } catch (error) {
        // 轮转不成也要把这一行写下去（下一行会重新开流）
        this.reportWriteError(error);
      }
    }
    const stream = this.ensureStream();
    if (stream === null) return;
    this.bytes += size;
    stream.write(line);
  }

  /** 拿当前要写的流（懒开：没写过日志的进程不必在磁盘上留一个空文件） */
  private ensureStream(): WriteStream | null {
    if (this.stream !== null) return this.stream;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.bytes = sizeOf(this.file);
      const stream = createWriteStream(this.file, { flags: "a" });
      // 写本身失败时没有更好的去处（日志不能再抱怨日志）：报出去，下一行重新开流
      stream.on("error", (error: unknown) => {
        this.stream = null;
        this.reportWriteError(error);
      });
      this.stream = stream;
      return stream;
    } catch (error) {
      this.reportWriteError(error);
      return null;
    }
  }

  /**
   * 轮转：关掉当前流 → `<file>` 改名为 `.1`，其余依次后移 → 最老的一份删掉。
   *
   * 下一行由调用方重新开流（`ensureStream` 会按新文件从 0 开始计数）。
   */
  private async rotate(): Promise<void> {
    await this.endStream();
    const oldest = this.pathOf(this.maxFiles - 1);
    if (this.maxFiles > 1) rmSync(oldest, { force: true });
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      const from = this.pathOf(index);
      if (!exists(from)) continue;
      renameSync(from, this.pathOf(index + 1));
    }
    if (exists(this.file)) renameSync(this.file, this.pathOf(1));
  }

  /** 关闭当前流并把它写完（这一步就是 flush） */
  private async endStream(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    this.bytes = 0;
    if (stream === null) return;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
      // 已经坏掉的流不会再触发 finish：不让收尾挂在这里
      stream.once("error", () => resolve());
    });
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    await this.queue;
    await this.endStream();
  }

  /** 第 index 份文件的路径；`0` 是正在写的那份 */
  private pathOf(index: number): string {
    return index === 0 ? this.file : `${this.file}.${index}`;
  }

  /** 把一条记录交给订阅者：它抛错只报一次，不影响写盘、也不抛回调用方 */
  private notifyRecord(record: LogRecord): void {
    if (this.onRecord === undefined) return;
    try {
      this.onRecord(record);
    } catch (error) {
      this.reportWriteError(error);
    }
  }

  /** 落盘失败的唯一出口：它自己抛错也吞掉（再抛就没有地方说了） */
  private reportWriteError(error: unknown): void {
    if (this.onWriteError === undefined) return;
    try {
      this.onWriteError(error);
    } catch {
      // 报错的口子自己坏掉时不再往上抛：日志是旁路能力，不该把主流程带走
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 造一行日志。
 *
 * 级别定宽（5 列），`detail` 压成一行 JSON —— 一行一条记录，`tail -f` 与 grep 都直接可用。
 */
export function formatLine(
  at: string,
  level: LogLevel,
  source: string,
  message: string,
  detail?: unknown,
): string {
  const head = `${at} ${level.toUpperCase().padEnd(5)} ${source} ${message}`;
  const tail = detail === undefined ? "" : ` ${stringify(detail)}`;
  return `${head}${tail}\n`;
}

function stringify(detail: unknown): string {
  if (detail instanceof Error) {
    return JSON.stringify({ message: detail.message, stack: detail.stack });
  }
  try {
    const text = JSON.stringify(detail);
    return text === undefined ? String(detail) : text;
  } catch {
    // 循环引用之类结构：给一个能看出「有这么个东西」的占位，不让整行丢掉
    return "[unserializable]";
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
