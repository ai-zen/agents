export interface LogFunctions {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type Logger = LogFunctions;

let currentLogger: Logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
};

/**
 * 获取全局 Logger 实例。
 */
export function getLogger(): Logger {
  return currentLogger;
}

/**
 * 设置全局 Logger 实例，替换默认的 console 输出。
 */
export function setLogger(log: Logger): void {
  currentLogger = log;
}
