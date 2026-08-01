import { describe, it, expect } from "vitest";
import { ExecTool } from "./ExecTool.js";
import { makeEnv } from "./test-helpers.js";

describe("ExecTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new ExecTool(makeEnv());
    expect(tool.function.name).toBe("exec");
    expect(tool.function.description).toBe("执行命令");
    const params = tool.function.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty("timeout");
  });

  it("执行简单命令返回 stdout", async () => {
    const tool = new ExecTool(makeEnv());
    const result = await tool.call({ command: "echo hello" });
    const parsed = JSON.parse(result as string);
    expect(parsed.stdout.trim()).toBe("hello");
  });

  it("执行命令返回 stderr", async () => {
    const tool = new ExecTool(makeEnv());
    const result = await tool.call({ command: "echo error >&2" });
    const parsed = JSON.parse(result as string);
    expect(parsed.stderr.trim()).toBe("error");
  });

  it("超时后进程被终止", async () => {
    const tool = new ExecTool(makeEnv());
    // Windows 没有 sleep 命令，用 ping -n 模拟长时间运行
    const cmd = process.platform === "win32" ? "ping -n 10 127.0.0.1" : "sleep 10";
    const result = await tool.call({ command: cmd, timeout: 200 });
    const parsed = JSON.parse(result as string);
    expect(parsed.killed).toBe(true);
  });
});
