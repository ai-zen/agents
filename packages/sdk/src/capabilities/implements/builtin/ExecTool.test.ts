import { describe, it, expect } from "vitest";
import { ExecTool } from "./ExecTool.js";
import { makeEnv } from "./test-helpers.js";
import type { ToolCallContext } from "@ai-zen/agents-core";

describe("ExecTool", () => {
  it("工具名称和描述正确", () => {
    const tool = new ExecTool(makeEnv());
    expect(tool.function.name).toBe("exec");
    expect(tool.function.description).toBe("执行命令");
    const params = tool.function.parameters as Record<string, unknown>;
    expect(params.properties).toHaveProperty("timeout");
    // timeout 必须声明为必填
    const required = (params.required as string[]) ?? [];
    expect(required).toContain("timeout");
  });

  it("执行简单命令返回 stdout", async () => {
    const tool = new ExecTool(makeEnv());
    const result = await tool.call({ command: "echo hello", timeout: 5000 });
    const parsed = JSON.parse(result as string);
    expect(parsed.stdout.trim()).toBe("hello");
    // 正常结束不标志为超时终止
    expect(parsed.killed).toBe(false);
    expect(parsed.terminated).toBeUndefined();
  });

  it("执行命令返回 stderr", async () => {
    const tool = new ExecTool(makeEnv());
    const result = await tool.call({ command: "echo error >&2", timeout: 5000 });
    const parsed = JSON.parse(result as string);
    expect(parsed.stderr.trim()).toBe("error");
  });

  it("缺失 timeout 时抛出异常", async () => {
    const tool = new ExecTool(makeEnv());
    await expect(tool.call({ command: "echo hello" } as never)).rejects.toThrow(/timeout/);
  });

  it("timeout 为非正数时抛出异常", async () => {
    const tool = new ExecTool(makeEnv());
    await expect(tool.call({ command: "echo hello", timeout: 0 })).rejects.toThrow(/timeout/);
    await expect(tool.call({ command: "echo hello", timeout: -100 })).rejects.toThrow(/timeout/);
  });

  it("超时后进程被终止并明确标记原因", async () => {
    const tool = new ExecTool(makeEnv());
    // Windows 没有 sleep 命令，用 ping -n 模拟长时间运行
    const cmd = process.platform === "win32" ? "ping -n 10 127.0.0.1" : "sleep 10";
    const result = await tool.call({ command: cmd, timeout: 200 });
    const parsed = JSON.parse(result as string);
    expect(parsed.killed).toBe(true);
    // 明确告知 agent：命令因超时被终止
    expect(parsed.terminated).toBe("timeout");
  });

  it("中断（abort）时 kill 子进程并标记 aborted", async () => {
    const tool = new ExecTool(makeEnv());
    const cmd = process.platform === "win32" ? "ping -n 10 127.0.0.1" : "sleep 10";
    const controller = new AbortController();

    const start = Date.now();
    const promise = tool.call(
      { command: cmd, timeout: 30_000 },
      { signal: controller.signal } as unknown as ToolCallContext,
    );
    await new Promise((r) => setTimeout(r, 200)); // 让进程先启动
    controller.abort(); // 中断

    const result = await promise;
    const elapsed = Date.now() - start;
    const parsed = JSON.parse(result as string);

    expect(parsed.killed).toBe(true);
    expect(parsed.terminated).toBe("aborted");
    // 明显早于 30s 超时
    expect(elapsed).toBeLessThan(5000);
  });

  it("signal 已 aborted 时立即返回中断结果，不启动子进程", async () => {
    const tool = new ExecTool(makeEnv());
    const controller = new AbortController();
    controller.abort();

    const result = await tool.call(
      { command: "echo should_not_run", timeout: 5000 },
      { signal: controller.signal } as unknown as ToolCallContext,
    );
    const parsed = JSON.parse(result as string);
    expect(parsed.killed).toBe(true);
    expect(parsed.terminated).toBe("aborted");
    expect(parsed.stdout).not.toContain("should_not_run");
  });
});
