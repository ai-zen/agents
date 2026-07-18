import { describe, it, expect } from "vitest";
import { execTool } from "./exec.js";

describe("execTool", () => {
  it("工具名称和描述正确", () => {
    expect(execTool.function.name).toBe("exec");
    expect(execTool.function.description).toBe("执行命令");
    const params = execTool.function.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty("timeout");
  });

  it("执行简单命令返回 stdout", async () => {
    const result = await execTool.callback({ command: "echo hello" });
    const parsed = JSON.parse(result as string);
    expect(parsed.stdout.trim()).toBe("hello");
  });

  it("执行命令返回 stderr", async () => {
    const result = await execTool.callback({ command: "echo error >&2" });
    const parsed = JSON.parse(result as string);
    expect(parsed.stderr.trim()).toBe("error");
  });

  it("超时后进程被终止", async () => {
    // Windows 没有 sleep 命令，用 ping -n 模拟长时间运行
    const cmd = process.platform === "win32" ? "ping -n 10 127.0.0.1" : "sleep 10";
    const result = await execTool.callback({ command: cmd, timeout: 200 });
    const parsed = JSON.parse(result as string);
    expect(parsed.killed).toBe(true);
  });
});
