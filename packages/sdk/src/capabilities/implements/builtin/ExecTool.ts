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
              description: "超时时间（毫秒），超时后会终止进程。默认无超时。建议长时间运行的命令使用 exec_async 异步执行。",
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
      env,
    });
  }

  async call(input: { command: string; timeout?: number }): Promise<string> {
    const command = input.command;
    const timeout = input.timeout;

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; killed?: boolean }>(
      (resolve) => {
        const child = exec(
          command,
          {
            cwd: this.env.cwd,
            timeout: timeout && timeout > 0 ? timeout : undefined,
          },
          (error, stdout, stderr) => {
            resolve({
              stdout,
              stderr,
              exitCode: error?.code ?? (error ? 1 : null),
              killed: error?.killed ?? false,
            });
          },
        );
      },
    );

    return JSON.stringify(result);
  }
}
