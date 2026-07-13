export interface LogFunctions {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type Logger = LogFunctions;

/**
 * 创建可注入的 Logger，默认使用 console。
 */
export function createLogger(log?: Partial<LogFunctions>): Logger {
  return {
    info: log?.info ?? console.log,
    warn: log?.warn ?? console.warn,
    error: log?.error ?? console.error,
  };
}
