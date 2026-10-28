import { spawn } from "child_process";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class SpawnTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "spawn",
    description:
      "Spawn a command asynchronously and return immediately without waiting for the result. Use it for long-running processes (servers, watchers, GUI apps, etc.) or commands whose result you do not need to wait for. Note: this tool does not capture the command's output itself; to retain or inspect output, use shell redirection to a file inside the command (e.g. `> /path/file`; `>>` append and `|` pipes are supported). The command is parsed and executed by the shell.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to execute (including arguments)",
        },
        cwd: {
          type: "string",
          description: "Working directory (optional, defaults to the current working directory)",
        },
        detached: {
          type: "boolean",
          description:
            "Whether to fully detach from the current process group (optional, defaults to false). When true, the spawned program keeps running even after the current Agent process exits. Use it for daemons or GUI programs that must run independently.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { command: string; cwd?: string; detached?: boolean }): Promise<string> {
    const command = input.command;
    const cwd = input.cwd ? this.resolve(input.cwd) : this.env.cwd;
    const detached = input.detached ?? false;

    // 统一走 shell：允许 shell 语法（重定向 > / >>、管道 | 等）
    return new Promise<string>((resolve) => {
      const child = spawn(command, [], {
        cwd,
        detached,
        stdio: "ignore",
        shell: true,
        windowsHide: true,
      });

      let resolved = false;

      child.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        resolve(
          JSON.stringify({
            success: false,
            pid: null,
            message: `Failed to start: ${err.message}`,
          }),
        );
      });

      child.on("spawn", () => {
        if (resolved) return;
        resolved = true;
        resolve(
          JSON.stringify({
            success: true,
            pid: child.pid ?? null,
            message: `Process started (PID: ${child.pid ?? "unknown"})`,
          }),
        );
      });

      child.on("exit", (code) => {
        if (resolved) return;
        resolved = true;
        resolve(
          JSON.stringify({
            success: code === 0,
            pid: child.pid ?? null,
            exitCode: code,
            message:
              code === null
                ? `Process exited (PID: ${child.pid ?? "unknown"})`
                : `Process exited (PID: ${child.pid ?? "unknown"}, exit code: ${code})`,
          }),
        );
      });

      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        resolve(
          JSON.stringify({
            success: true,
            pid: child.pid ?? null,
            message: `Process started (PID: ${child.pid ?? "unknown"})`,
          }),
        );
      }, 500);

      const cleanup = () => {
        clearTimeout(timeout);
        child.removeAllListeners();
      };

      child.on("spawn", cleanup);
      child.on("error", cleanup);
      child.on("exit", cleanup);

      child.unref();
    });
  }
}
