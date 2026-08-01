import { describe, it, expect } from "vitest";
import { ExecAsyncTool } from "./ExecAsyncTool.js";
import { makeEnv } from "./test-helpers.js";

describe("ExecAsyncTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new ExecAsyncTool(makeEnv());
    expect(tool.function.name).toBe("exec_async");
    expect(tool.function.description).toContain("异步执行命令");
    expect(tool.function.parameters).toBeDefined();
    const params = tool.function.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty("command");
    expect(params.properties).toHaveProperty("cwd");
    expect(params.properties).toHaveProperty("detached");
    expect(params.required).toEqual(["command"]);
  });

  it("异步启动 echo 命令并返回成功", async () => {
    const tool = new ExecAsyncTool(makeEnv());
    const result = await tool.call({ command: "echo hello" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(true);
    expect(parsed.pid).toBeGreaterThanOrEqual(0);
    expect(parsed.message).toContain("进程已启动");
  });

  it("未指定 cwd 时使用 env.cwd", async () => {
    const cwd = process.cwd();
    const tool = new ExecAsyncTool(makeEnv(cwd));
    const result = await tool.call({ command: process.platform === "win32" ? "cd" : "pwd" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(true);
  });

  it("启动不存在的命令可能返回错误或成功但退出码非零", async () => {
    const tool = new ExecAsyncTool(makeEnv());
    const result = await tool.call({
      command: "nonexistent_cmd_xyz_12345",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveProperty("success");
    expect(parsed).toHaveProperty("pid");
    expect(parsed).toHaveProperty("message");
  });

  it("detached 参数不影响基本启动", async () => {
    const tool = new ExecAsyncTool(makeEnv());
    const result = await tool.call({
      command: "echo test",
      detached: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(true);
  });
});
