import { describe, it, expect } from "vitest";
import { cwdTool } from "./cwd.js";

describe("cwdTool", () => {
  it("工具名称和描述正确", () => {
    expect(cwdTool.function.name).toBe("cwd");
    expect(cwdTool.function.description).toContain("当前工作目录");
  });

  it("返回当前工作目录", async () => {
    const result = await cwdTool.callback({});
    expect(result).toBe(process.cwd());
  });
});
