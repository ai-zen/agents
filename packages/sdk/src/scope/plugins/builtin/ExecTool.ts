import { exec, type ChildProcess } from "child_process";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headTailPreview } from "./outputGuard.js";

export class ExecTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "exec",
    description: "Execute a shell command",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to execute",
        },
        timeout: {
          type: "number",
          description:
            "Timeout in milliseconds (required). The process is killed on timeout. For long-running commands, prefer spawn to run them asynchronously.",
        },
      },
      required: ["command", "timeout"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(
    input: { command: string; timeout: number },
    ctx?: ToolCallContext,
  ): Promise<string> {
    const command = input.command;
    const { timeout } = input;

    // 运行时双校验：timeout 必填且必须为正数
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(
        `exec: timeout is required and must be a positive number (milliseconds), got: ${JSON.stringify(timeout)}`,
      );
    }

    const signal = ctx?.signal;

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      killed: boolean;
      terminated?: "timeout" | "aborted";
    }>((resolve) => {
      // 若 signal 已处于 aborted，直接标记中断结果
      if (signal?.aborted) {
        resolve({
          stdout: "",
          stderr: "Process aborted",
          exitCode: null,
          killed: true,
          terminated: "aborted",
        });
        return;
      }

      let child: ChildProcess | undefined;
      let settled = false;
      const settle = (value: {
        stdout: string;
        stderr: string;
        exitCode: number | null;
        killed: boolean;
        terminated?: "timeout" | "aborted";
      }) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };

      child = exec(
        command,
        { cwd: this.env.cwd, timeout },
        (error, stdout, stderr) => {
          const killed = error?.killed ?? false;
          const terminated = killed
            ? (signal?.aborted ? "aborted" : "timeout")
            : undefined;
          settle({
            stdout,
            stderr,
            exitCode: error?.code ?? (error ? 1 : null),
            killed,
            terminated,
          });
        },
      );

      // 中断：kill 子进程，令其尽快结束
      const onAbort = () => {
        child?.kill("SIGKILL");
        // 即便 exec 回调因信号处理而未能及时触发，也立即返回中断结果，避免挂起
        settle({
          stdout: "",
          stderr: "Process aborted",
          exitCode: null,
          killed: true,
          terminated: "aborted",
        });
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    // 输出保护：stdout + stderr 合计超过 maxToolOutput 时，分文件落盘并返回警告 + 头尾预览
    const limit = this.env.config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT;
    const guarded = await guardOutput({
      tool: "exec",
      content: result,
      isOverLimit: (output) => output.stdout.length + output.stderr.length > limit,
      dump: (_dir, output) => [
        { name: "stdout.log", content: output.stdout },
        { name: "stderr.log", content: output.stderr },
      ],
      buildWarning: (ctx) => {
        const stdout = headTailPreview(result.stdout);
        const stderr = headTailPreview(result.stderr);
        return JSON.stringify({
          outputTooLarge: true,
          warning:
            `Output too large: stdout + stderr total ${result.stdout.length + result.stderr.length} characters, ` +
            `exceeds the limit of ${limit} characters. Full content was written to separate files (stdout.log / stderr.log); use read to fetch it in chunks`,
          files: ctx.files,
          stdout: { chars: result.stdout.length, lines: countLines(result.stdout), ...stdout },
          stderr: { chars: result.stderr.length, lines: countLines(result.stderr), ...stderr },
          exitCode: result.exitCode,
          killed: result.killed,
          terminated: result.terminated,
        });
      },
    });

    // 未超限：content 为原始结果对象，按原有结构序列化；超限：buildWarning 已生成返回字符串
    return typeof guarded === "string" ? guarded : JSON.stringify(guarded);
  }
}

/** 统计文本行数（空文本记 0 行） */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}
