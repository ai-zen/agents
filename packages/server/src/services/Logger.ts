/**
 * 日志落文件（PRD F-J2）：`<dataRoot>/logs/server.log` + 按大小轮转 + warn/error 同时上通知。
 *
 * 为什么要有它：界面被一段对话占满时，`process.stdout` 里的话没人看得到。服务端是常驻后台
 * 进程，出事的那一刻只有磁盘上的文件是还在的（PRD F-J2 的原话就是这个理由）。
 *
 * 三件事在这里定死：
 *
 * 1. **按大小轮转**：单份到 `maxBytes`（缺省 5MB）就换下一份，保留 `maxFiles` 份（缺省 5，含
 *    正在写的那份）。命名是 `server.log`（正在写）、`server.log.1`（上一份）……，最老的一份在
 *    轮转时删掉。不引依赖：`node:fs` 的 `rename` / `rm` 就够。
 * 2. **warn / error 上通知**（F-J2）：调注入的 `notifier`（组装处接的是 `NoticeService.log`，
 *    永久通知）。**防回环**靠一个重入标记：发通知这件事本身产生的日志只落文件、不再上通知，
 *    否则通知写库失败会再产生一条通知，一路循环下去。
 * 3. **退出时 flush**（`close()`）：先停止接纳新行，再把已经排队的行写完，最后关流。
 *    进程退出前没写出去的行等于没写，所以 `ServerApp.stop()` 里等它。
 *
 * 行格式：`<ISO 时间> <级别> <来源> <消息> [detail JSON]`。级别定宽（`INFO ` / `WARN ` /
 * `ERROR`），于是 grep 一列就能筛。时间取注入的时钟，缺省 `Date.now`。
 */

import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { join } from "node:path";

import type { HubLogger } from "../net/WsHub.js";

/** 日志级别（三档：信息 / 警告 / 错误；warn 与 error 会同时上通知） */
export type LogLevel = "info" | "warn" | "error";

/** 单份日志文件的上限（5MB；到点换下一份） */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** 保留几份（含正在写的那一份） */
export const DEFAULT_MAX_FILES = 5;

/** 日志文件的缺省名字 */
export const DEFAULT_LOG_FILE_NAME = "server.log";

/**
 * 「这条 warn / error 也让用户在通知栏里看到」（PRD F-J2）。
 *
 * 组装处接的是 `NoticeService.log`（永久通知）。这里刻意不传 `Error` 对象：通知只带一句
 * 给人看的摘要，栈留在文件里。
 */
export type LogNotifier = (level: "warning" | "error", summary: string) => void | Promise<void>;

/** 带来源的日志口子（`withSource` 的返回类型）：比 `HubLogger` 多一档 info */
export interface SourceLogger extends HubLogger {
  info(message: string, detail?: unknown): void;
}

export interface LoggerOptions {
  /** 日志目录（`ServerPaths.logsDir` = `<dataRoot>/logs`）；首次落盘时创建 */
  dir: string;
  /** 文件名，缺省 `server.log` */
  fileName?: string;
  /** 单份上限（字节），缺省 5MB */
  maxBytes?: number;
  /** 保留几份（含正在写的那份），缺省 5 */
  maxFiles?: number;
  /** 缺省来源标签（`withSource` 之外的写法用它），缺省 `server` */
  source?: string;
  /** warn / error 上通知的出口；不给时只落文件 */
  notifier?: LogNotifier;
  /** 时钟，用例注入用；缺省 `Date.now` */
  now?: () => number;
}

export class Logger implements HubLogger, SourceLogger {
  private readonly dir: string;
  private readonly fileName: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly source: string;
  private readonly now: () => number;

  private notifier: LogNotifier | null;
  /** 正在发通知：这期间产生的 warn / error 只落文件（防回环） */
  private notifying = false;

  private stream: WriteStream | null = null;
  /** 正在写的那份已经写了多少字节（轮转判据） */
  private bytes = 0;
  /** 写盘按到达顺序串行（轮转要等当前流关掉，不能被打断） */
  private queue: Promise<void> = Promise.resolve();
  /** 收尾已经开始 / 结束：之后的行不再落盘（否则 `close()` 之后还会长出新内容） */
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(options: LoggerOptions) {
    this.dir = options.dir;
    this.fileName = options.fileName ?? DEFAULT_LOG_FILE_NAME;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.source = options.source ?? "server";
    this.notifier = options.notifier ?? null;
    this.now = options.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // 对外：三档写法
  // -------------------------------------------------------------------------

  info(message: string, detail?: unknown): void {
    this.log("info", this.source, message, detail);
  }

  warn(message: string, detail?: unknown): void {
    this.log("warn", this.source, message, detail);
  }

  error(message: string, detail?: unknown): void {
    this.log("error", this.source, message, detail);
  }

  /**
   * 写一行（级别 + 来源 + 消息 + 可选的 detail），warn / error 顺带上通知。
   *
   * 落盘是排队的（`queue`），所以调用方不必等：一行日志的代价不该被写盘拖住。
   */
  log(level: LogLevel, source: string, message: string, detail?: unknown): void {
    if (this.closed) return;
    const line = formatLine(this.now(), level, source, message, detail);
    this.queue = this.queue.then(() => this.writeLine(line)).catch(() => undefined);
    if (level !== "info") this.raiseNotice(level, message);
  }

  /** 换一个来源标签的视图：接线层写 `ws`、单根写 `server`、素材层写 `assets`，落盘时带来源 */
  withSource(source: string): SourceLogger {
    return {
      info: (message, detail) => this.log("info", source, message, detail),
      warn: (message, detail) => this.log("warn", source, message, detail),
      error: (message, detail) => this.log("error", source, message, detail),
    };
  }

  /**
   * 接上（或换掉）通知出口。
   *
   * 单根里日志口子比通知服务先造出来（早造的那些服务也要能记日志），所以这里允许后接一次。
   */
  setNotifier(notifier: LogNotifier | null): void {
    this.notifier = notifier;
  }

  /** 现在这份日志写到哪（`server.log` 的完整路径），供启动提示与用例读 */
  get filePath(): string {
    return join(this.dir, this.fileName);
  }

  /** 收尾是否已经做完（用例断言「退出后流关闭」用它） */
  get isClosed(): boolean {
    return this.closed;
  }

  // -------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------

  /**
   * 收尾：停止接纳新行 → 把排队的行写完 → 关流。
   *
   * 幂等：`ServerApp.stop()` 可能被多个触发源先后叫到。
   */
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    await this.queue;
    await this.endStream();
  }

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------

  private async writeLine(line: string): Promise<void> {
    const size = Buffer.byteLength(line);
    // 这一行自己就超上限时照写：写不进去比多占一份文件更糟
    if (this.bytes > 0 && this.bytes + size > this.maxBytes) await this.rotate();
    const stream = this.ensureStream();
    if (stream === null) return;
    this.bytes += size;
    stream.write(line);
  }

  /** 拿当前要写的流（懒开：没写过日志的进程不必在数据根下留一个空文件） */
  private ensureStream(): WriteStream | null {
    if (this.stream !== null) return this.stream;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.bytes = sizeOf(this.filePath);
      const stream = createWriteStream(this.filePath, { flags: "a" });
      // 写盘本身失败时没有更好的去处（日志不能再抱怨日志），关掉它、后续行直接丢
      stream.on("error", () => {
        this.stream = null;
      });
      this.stream = stream;
      return stream;
    } catch {
      return null;
    }
  }

  /**
   * 轮转：关掉当前流 → `server.log` 改名为 `.1`，其余依次后移 → 最老的一份删掉。
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
    if (exists(this.filePath)) renameSync(this.filePath, this.pathOf(1));
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

  /** 第 index 份文件的路径；`0` 是正在写的那份 */
  private pathOf(index: number): string {
    return index === 0 ? this.filePath : `${this.filePath}.${index}`;
  }

  // -------------------------------------------------------------------------
  // 通知（F-J2）
  // -------------------------------------------------------------------------

  /**
   * warn / error 也上通知栏。
   *
   * 重入标记是防回环的那一处：发通知会写库、会推事件，那些动作里万一又冒出日志，
   * 这条判断把它们挡在「只落文件」这一侧。通知本身失败只吞掉——再记一条日志就是回环。
   */
  private raiseNotice(level: LogLevel, summary: string): void {
    const notifier = this.notifier;
    if (notifier === null || this.notifying) return;
    const noticeLevel = level === "error" ? "error" : "warning";
    this.notifying = true;
    void Promise.resolve()
      .then(() => notifier(noticeLevel, summary))
      .catch(() => undefined)
      .finally(() => {
        this.notifying = false;
      });
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
  timestamp: number,
  level: LogLevel,
  source: string,
  message: string,
  detail?: unknown,
): string {
  const head = `${new Date(timestamp).toISOString()} ${level.toUpperCase().padEnd(5)} ${source} ${message}`;
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
