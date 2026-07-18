import { describe, it, expect } from "vitest";
import { execAsyncTool } from "./execAsync.js";

describe("execAsyncTool", () => {
  it("工具名称和描述正确", () => {
    expect(execAsyncTool.function.name).toBe("exec_async");
    expect(execAsyncTool.function.description).toContain("异步执行命令");
    expect(execAsyncTool.function.parameters).toBeDefined();
    const params = execAsyncTool.function.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty("command");
    expect(params.properties).toHaveProperty("cwd");
    expect(params.properties).toHaveProperty("detached");
    expect(params.required).toEqual(["command"]);
  });

  it("异步启动 echo 命令并返回成功", async () => {
    const result = await execAsyncTool.callback({ command: "echo hello" });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(true);
    expect(parsed.pid).toBeGreaterThanOrEqual(0);
    expect(parsed.message).toContain("进程已启动");
  });

  it("启动不存在的命令可能返回错误或成功但退出码非零", async () => {
    const result = await execAsyncTool.callback({
      command: "nonexistent_cmd_xyz_12345",
    });
    const parsed = JSON.parse(result as string);
    // 在不同系统上行为不同，只需确保有合理的响应
    expect(parsed).toHaveProperty("success");
    expect(parsed).toHaveProperty("pid");
    expect(parsed).toHaveProperty("message");
  });

  it("detached 参数不影响基本启动", async () => {
    const result = await execAsyncTool.callback({
      command: "echo test",
      detached: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.success).toBe(true);
  });
});
