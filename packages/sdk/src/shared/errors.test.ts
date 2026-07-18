import { describe, it, expect } from "vitest";
import { SdkError } from "./errors.js";

describe("SdkError", () => {
  it("包含 code 和 message", () => {
    const err = new SdkError("CONFIG_READ_FAILED", "无法读取配置文件");
    expect(err.code).toBe("CONFIG_READ_FAILED");
    expect(err.message).toBe("无法读取配置文件");
    expect(err).toBeInstanceOf(Error);
  });

  it("支持 cause", () => {
    const cause = new Error("ENOENT");
    const err = new SdkError("FILE_NOT_FOUND", "文件不存在", cause);
    expect(err.cause).toBe(cause);
  });
});
