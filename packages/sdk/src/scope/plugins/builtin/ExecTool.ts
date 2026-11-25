import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT } from "./outputGuard.js";
import { runCommand } from "./commandRun.js";
import { commandOutputContent } from "./commandOutput.js";

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
          description: "Timeout in milliseconds (required). The process is killed on timeout.",
        },
      },
      required: ["command", "timeout"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { command: string; timeout: number }, ctx?: ToolCallContext): Promise<string> {
    const { command, timeout } = input;

    // 运行时双校验：timeout 必填且必须为正数
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(
        `exec: timeout is required and must be a positive number (milliseconds), got: ${JSON.stringify(timeout)}`,
      );
    }

    const run = runCommand({ command, cwd: this.env.cwd, timeoutMs: timeout, signal: ctx?.signal });
    const result = await run.result;

    return commandOutputContent({
      tool: "exec",
      result,
      limit: this.env.config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT,
    });
  }
}
