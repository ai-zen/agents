import { describe, it, expect } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpawnTool } from "./SpawnTool.js";
import { makeEnv } from "./test-helpers.js";

describe("SpawnTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new SpawnTool(makeEnv());
    expect(tool.function.name).toBe("spawn");
    expect(tool.function.description).toContain("Spawn a command asynchronously");
    expect(tool.function.parameters).toBeDefined();
    const params = tool.function.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty("command");
    expect(params.properties).toHaveProperty("cwd");
    expect(params.properties).toHaveProperty("detached");
    expect(params.required).toEqual(["command"]);
  });

  it("异步启动 echo 命令，只报告已启动", async () => {
    const tool = new SpawnTool(makeEnv());
    const result = await tool.call({ command: "echo hello" });
    const parsed = JSON.parse(result as string);
    expect(parsed.started).toBe(true);
    expect(parsed.pid).toBeGreaterThanOrEqual(0);
    expect(parsed.message).toContain("Process started");
    // 不再声称 success：本工具不跟踪退出状态
    expect(parsed.success).toBeUndefined();
    expect(parsed.note).toContain("does not track the exit status");
  });

  it("快速失败的进程不会被报成 success（只报 started）", async () => {
    const tool = new SpawnTool(makeEnv());
    // exit 3 / 命令不存在 / 语法错误：都在工具返回后才发生，工具看不到
    for (const command of ["exit 3", "nonexistent_cmd_xyz_12345", "if then fi"]) {
      const parsed = JSON.parse((await tool.call({ command })) as string);
      expect(parsed.started).toBe(true);
      expect(parsed.success).toBeUndefined();
      expect(parsed.exitCode).toBeUndefined();
    }
  });

  it("未指定 cwd 时使用 env.cwd", async () => {
    const cwd = process.cwd();
    const tool = new SpawnTool(makeEnv(cwd));
    const result = await tool.call({ command: process.platform === "win32" ? "cd" : "pwd" });
    const parsed = JSON.parse(result as string);
    expect(parsed.started).toBe(true);
  });

  it("启动不存在的命令可能返回错误或已启动", async () => {
    const tool = new SpawnTool(makeEnv());
    const result = await tool.call({
      command: "nonexistent_cmd_xyz_12345",
    });
    const parsed = JSON.parse(result as string);
    expect(parsed).toHaveProperty("started");
    expect(parsed).toHaveProperty("pid");
    expect(parsed).toHaveProperty("message");
  });

  it("detached 参数不影响基本启动", async () => {
    const tool = new SpawnTool(makeEnv());
    const result = await tool.call({
      command: "echo test",
      detached: true,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed.started).toBe(true);
  });

  it("命令经 shell 解析，支持重定向到文件", async () => {
    const tool = new SpawnTool(makeEnv());
    const outputFile = join(tmpdir(), `exec-async-redirect-${Date.now()}.txt`);
    try {
      const cmd =
        process.platform === "win32"
          ? `echo redirected > ${outputFile}`
          : `echo redirected > ${outputFile}`;
      const result = await tool.call({ command: cmd });
      const parsed = JSON.parse(result as string);
      expect(parsed.started).toBe(true);

      // 重定向由 shell 立即完成，等待进程落盘后断言文件生成
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(outputFile)).toBe(true);
    } finally {
      if (existsSync(outputFile)) unlinkSync(outputFile);
    }
  });
});
