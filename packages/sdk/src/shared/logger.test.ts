import { describe, it, expect, beforeEach } from "vitest";
import { getLogger, setLogger, type Logger } from "./logger.js";

describe("logger 全局单例", () => {
  beforeEach(() => {
    // 重置为默认
    setLogger({
      info: console.log,
      warn: console.warn,
      error: console.error,
    });
  });

  it("getLogger 默认返回 console", () => {
    const logger = getLogger();
    expect(logger.info).toBe(console.log);
    expect(logger.warn).toBe(console.warn);
    expect(logger.error).toBe(console.error);
  });

  it("setLogger 替换全局实例", () => {
    const lines: string[] = [];
    const customLogger: Logger = {
      info: (msg) => lines.push(`INFO: ${msg}`),
      warn: (msg) => lines.push(`WARN: ${msg}`),
      error: (msg) => lines.push(`ERROR: ${msg}`),
    };

    setLogger(customLogger);

    const logger = getLogger();
    logger.info("hello");
    logger.warn("careful");
    logger.error("boom");

    expect(lines).toEqual([
      "INFO: hello",
      "WARN: careful",
      "ERROR: boom",
    ]);
  });
});
