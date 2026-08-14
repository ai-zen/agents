import { exec, type ChildProcess } from "child_process";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";

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

    return JSON.stringify(result);
  }
}
