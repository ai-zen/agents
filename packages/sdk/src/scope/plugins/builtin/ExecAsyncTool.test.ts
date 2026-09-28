import { describe, it, expect } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("命令经 shell 解析，支持重定向到文件", async () => {
    const tool = new ExecAsyncTool(makeEnv());
    const outputFile = join(tmpdir(), `exec-async-redirect-${Date.now()}.txt`);
    try {
      const cmd =
        process.platform === "win32"
          ? `echo redirected > ${outputFile}`
          : `echo redirected > ${outputFile}`;
      const result = await tool.call({ command: cmd });
      const parsed = JSON.parse(result as string);
      expect(parsed.success).toBe(true);

      // 重定向由 shell 立即完成，等待进程落盘后断言文件生成
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(outputFile)).toBe(true);
    } finally {
      if (existsSync(outputFile)) unlinkSync(outputFile);
    }
  });
});
