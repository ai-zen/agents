/**
 * 包出口：一个类、三个类型、两个缺省值、一个纯函数。
 *
 * 这里只做再导出，不新增语义，也不导出任何单例 —— 日志实例由用它的那个进程自己持有。
 */

export { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, FileLogger, formatLine } from "./FileLogger.js";
export type { FileLoggerOptions, LogLevel, LogRecord, LogSink } from "./FileLogger.js";
