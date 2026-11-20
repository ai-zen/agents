/**
 * 通知服务用例的共用脚手架：它要一个 `LogSink`，而绝大多数用例不关心日志写了什么。
 *
 * 与 `net/TestSupport.ts` / `runtime/TestSupport.ts` 同一条规矩：只被 `*.test.ts` 引用，
 * 从生产构建里排除（`tsconfig.json` 的 `**\/*TestSupport.ts`）。
 */

import type { LogLevel, LogSink } from "@ai-zen/agents-logger";

/** 什么都不做的口子（用例只关心通知本身时用它） */
export const QUIET_LOG: LogSink = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 写出去的一条（`recordingLog()` 的记账形状） */
export interface RecordedLog {
  level: LogLevel;
  message: string;
  detail?: unknown;
}

/** 记账的口子：用例要在意「这条为什么被记了一笔」时用它 */
export function recordingLog(): { logger: LogSink; records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const push = (level: LogLevel) => (message: string, detail?: unknown) => {
    records.push({ level, message, detail });
  };
  return { logger: { info: push("info"), warn: push("warn"), error: push("error") }, records };
}
