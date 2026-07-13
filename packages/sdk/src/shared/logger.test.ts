import { describe, it, expect } from "vitest";
import { createLogger, type Logger } from "./logger";

describe("createLogger", () => {
  it("使用注入的 log 函数", () => {
    const lines: string[] = [];
    const logger = createLogger({
      info: (msg) => lines.push(`INFO: ${msg}`),
      warn: (msg) => lines.push(`WARN: ${msg}`),
      error: (msg) => lines.push(`ERROR: ${msg}`),
    });

    logger.info("hello");
    logger.warn("careful");
    logger.error("boom");

    expect(lines).toEqual([
      "INFO: hello",
      "WARN: careful",
      "ERROR: boom",
    ]);
  });

  it("默认使用 console", () => {
    const logger = createLogger();
    // 不抛异常即通过
    logger.info("test");
    logger.warn("test");
    logger.error("test");
  });
});
