import { describe, it, expect } from "vitest";
import { CwdTool } from "./CwdTool.js";
import { makeEnv } from "./test-helpers.js";

describe("CwdTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new CwdTool(makeEnv());
    expect(tool.function.name).toBe("cwd");
    expect(tool.function.description).toContain("当前工作目录");
  });

  it("返回 env.cwd（而非 process.cwd）", async () => {
    const cwd = "/tmp/workspace-a";
    const tool = new CwdTool(makeEnv(cwd));
    expect(await tool.call({})).toBe(cwd);
  });
});
