import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { ExecTool } from "./ExecTool.js";
import { makeEnv } from "./test-helpers.js";
import type { ToolCallContext } from "@ai-zen/agents-core";
import type { AppConfig } from "../../../types/index.js";

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

  it("输出超过 maxToolOutput 时落盘 stdout/stderr，并返回警告与各流头尾预览", async () => {
    const tool = new ExecTool(makeEnv(process.cwd(), { maxToolOutput: 1000 } as AppConfig));
    const result = await tool.call({
      command: `node -e "process.stdout.write('a'.repeat(3000))"`,
      timeout: 10_000,
    });
    const parsed = JSON.parse(result as string);

    expect(parsed.outputTooLarge).toBe(true);
    expect(parsed.warning).toContain("超过上限 1000 字符");

    // 完整内容分文件落盘
    const stdoutPath = parsed.files["stdout.log"];
    const stderrPath = parsed.files["stderr.log"];
    expect(readFileSync(stdoutPath, "utf-8").length).toBe(3000);
    expect(readFileSync(stderrPath, "utf-8")).toBe("");

    // 各流独立额度：头 1000 + 尾 1000
    expect(parsed.stdout.chars).toBe(3000);
    expect(parsed.stdout.head).toBe("a".repeat(1000));
    expect(parsed.stdout.tail).toBe("a".repeat(1000));
    expect(parsed.stdout.omitted).toBe(1000);

    // 原有字段保留（成功场景下 exitCode 沿用既有语义为 null）
    expect(parsed.exitCode).toBeNull();
    expect(parsed.killed).toBe(false);
  });

  it("输出未超过 maxToolOutput 时按原结构返回，不落盘", async () => {
    const tool = new ExecTool(makeEnv(process.cwd(), { maxToolOutput: 100_000 } as AppConfig));
    const result = await tool.call({ command: "echo hello", timeout: 5000 });
    const parsed = JSON.parse(result as string);

    expect(parsed.stdout.trim()).toBe("hello");
    expect(parsed.files).toBeUndefined();
    expect(parsed.outputTooLarge).toBeUndefined();
  });
});
