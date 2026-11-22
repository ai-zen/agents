import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT } from "./outputGuard.js";
import { runCommand, type CommandResult } from "./commandRun.js";
import { commandOutputContent } from "./commandOutput.js";
import { ASYNC_EXEC_TOOL, deliverAsyncResult, nextTaskId, trackCommand } from "./asyncTasks.js";

export class AsyncExecTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: ASYNC_EXEC_TOOL,
    description:
      "Run a shell command in the background and return immediately. Do not wait for it: this call is " +
      "over the moment it returns. The system will notify you when the command ends (it exits, its " +
      "timeout fires, or it fails to start) by pushing that command's output and exit status back into " +
      "this session as a new message; that notification is the only way the result arrives. So do not " +
      "wait and do not poll: nothing comes back while the command is still running, and there is no " +
      "tool that checks a background task. Use exec when the result must be in hand before the next " +
      "step; use async_exec for long commands (builds, test suites, scripts) whose result is worth " +
      "coming back to.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to execute (parsed and run by the shell, same as exec)",
        },
        cwd: {
          type: "string",
          description: "Working directory (optional, defaults to the current working directory)",
        },
        timeout: {
          type: "number",
          description:
            "Timeout in milliseconds (optional). When it fires the whole process group is killed, and " +
            "the pushed result says the command was killed by the timeout.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(
    input: { command: string; cwd?: string; timeout?: number },
    ctx?: ToolCallContext,
  ): Promise<string> {
    const agent = ctx?.agent;
    if (!agent) throw new Error(`${ASYNC_EXEC_TOOL} must be called by an agent`);

    const command = input.command;
    const timeout = input.timeout;

    if (
      timeout !== undefined &&
      (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
    ) {
      throw new Error(
        `${ASYNC_EXEC_TOOL}: timeout must be a positive number (milliseconds) when given, got: ${JSON.stringify(timeout)}`,
      );
    }

    const cwd = input.cwd ? this.resolve(input.cwd) : this.env.cwd;
    const log = this.env.log;
    const taskId = nextTaskId(agent, ASYNC_EXEC_TOOL);

    const run = runCommand({ command, cwd, timeoutMs: timeout });
    const untrack = trackCommand(agent, run, log);

    // 结果一路走投递回来：这里不 await 它，工具当场返回
    void run.result
      .then(async (result) => {
        const content = await commandOutputContent({
          tool: ASYNC_EXEC_TOOL,
          fields: {
            task: ASYNC_EXEC_TOOL,
            taskId,
            command,
            ...(timeout !== undefined ? { timeout } : {}),
            message: outcomeMessage(result, command, timeout),
          },
          result,
          limit: this.env.config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT,
        });
        deliverAsyncResult({ agent, label: ASYNC_EXEC_TOOL, content, log });
      })
      .catch((error: unknown) => {
        log?.error(`[${ASYNC_EXEC_TOOL}] task "${taskId}" ended but its result was not delivered`, {
          error,
        });
      })
      .finally(untrack);

    return JSON.stringify({
      started: true,
      taskId,
      command,
      ...(timeout !== undefined ? { timeout } : {}),
      note: `The command runs in the background as task "${taskId}". Do not wait for it: the system will notify you by pushing its result into this session when the command ends. Nothing checks a background task, so do not poll.`,
    });
  }
}

/** 这一次的收场：正文里要能看出是正常结束、超时被杀还是输出被截断 */
function outcomeMessage(
  result: CommandResult,
  command: string,
  timeoutMs: number | undefined,
): string {
  if (result.terminated === "timeout") {
    return `Command "${command}" was killed by its ${timeoutMs}ms timeout, together with every process it started; the output below is what it produced before that.`;
  }
  if (result.terminated === "aborted") {
    return `Command "${command}" was stopped before it finished; the output below is what it produced before that.`;
  }
  if (result.truncated) {
    return `Command "${command}" wrote more than the in-memory cap, so it was killed there and the tail of its output is lost.`;
  }
  if (result.exitCode === null) {
    return `Command "${command}" ended without an exit code; what came back is below.`;
  }
  return `Command "${command}" finished with exit code ${result.exitCode}.`;
}
