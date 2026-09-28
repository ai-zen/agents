import { exec, type ChildProcess } from "child_process";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headTailPreview } from "./outputGuard.js";

export class ExecTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "exec",
    description: "执行命令",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的命令",
        },
        timeout: {
          type: "number",
          description: "超时时间（毫秒），必填。超时后会终止进程；超过该时长仍未完成即视为超时并终止。建议长时间运行的命令使用 exec_async 异步执行。",
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
        `exec: 参数 timeout 为必填项，且必须是正数（毫秒），当前值: ${JSON.stringify(timeout)}`,
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
          stderr: "进程已中断（aborted）",
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
          stderr: "进程已中断（aborted）",
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
            `输出过大：stdout + stderr 合计 ${result.stdout.length + result.stderr.length} 字符，` +
            `超过上限 ${limit} 字符。完整内容已分文件落盘（stdout.log / stderr.log），可用 readFile 分批读取。`,
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
