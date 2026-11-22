import type { LogSink } from "../shared/logger.js";

/** 记下来的一条（`recordingLog()` 的记账形状） */
export interface RecordedLog {
  level: "info" | "warn" | "error";
  message: string;
  detail?: unknown;
}

/**
 * 记账的 {@link LogSink}：用例要在意「这一句为什么被记了一笔」时把它注进去。
 *
 * 从前这类用例靠替换模块级的全局日志口来抓输出，本单删掉了那个口（日志由调用方注入），
 * 于是「抓输出」变成「把自己这一份塞进去」——判据还是那一条（报了什么、在哪一档），
 * 但它现在只影响这一个实例，不再是一个进程一份的共享状态。
 *
 * 与宿主 `services/TestSupport.ts` 的 `recordingLog()` 同形（那边吃
 * `@ai-zen/agents-logger` 的 `LogSink`，这边吃 SDK 自己的）：两个包各写各的、靠结构相容对接。
 */
export function recordingLog(): { logger: LogSink; records: RecordedLog[] } {
  const records: RecordedLog[] = [];
  const push = (level: RecordedLog["level"]) => (message: string, detail?: unknown) => {
    records.push({ level, message, detail });
  };
  return {
    logger: { info: push("info"), warn: push("warn"), error: push("error") },
    records,
  };
}

/** 只取某一档的报了什么（`recordingLog()` 的常用投影） */
export function messagesAt(records: readonly RecordedLog[], level: RecordedLog["level"]): string[] {
  return records.filter((record) => record.level === level).map((record) => record.message);
}
