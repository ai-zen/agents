import { describe, it, expect } from "vitest";
import { cwd } from "./cwd.js";

describe("cwd", () => {
  it("工具名称和描述正确", () => {
    expect(cwd.function.name).toBe("cwd");
    expect(cwd.function.description).toContain("当前工作目录");
  });

  it("返回当前工作目录", async () => {
    const result = await cwd.callback({});
    expect(result).toBe(process.cwd());
  });
});
