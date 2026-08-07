import { exec } from "child_process";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class ExecTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
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
      },
      env,
    });
  }

  async call(input: { command: string; timeout: number }): Promise<string> {
    const command = input.command;
    const { timeout } = input;

    // 运行时双校验：timeout 必填且必须为正数
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(
        `exec: 参数 timeout 为必填项，且必须是正数（毫秒），当前值: ${JSON.stringify(timeout)}`,
      );
    }

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      killed: boolean;
      terminated?: "timeout";
    }>(
      (resolve) => {
        const child = exec(
          command,
          {
            cwd: this.env.cwd,
            timeout,
          },
          (error, stdout, stderr) => {
            const killed = error?.killed ?? false;
            resolve({
              stdout,
              stderr,
              exitCode: error?.code ?? (error ? 1 : null),
              killed,
              // 明确告知 agent 命令是因超时被终止（Node 不会自动在 stderr 写入该提示）
              terminated: killed ? "timeout" : undefined,
            });
          },
        );
      },
    );

    return JSON.stringify(result);
  }
}
