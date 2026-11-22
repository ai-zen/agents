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

    /**
     * 本工具只回答「进程是否已启动」，**不跟踪退出状态**。
     *
     * 它 spawn 后立刻返回，输出也走 `stdio: "ignore"` 丢弃；因此命令不存在、语法错误、
     * 脚本起来就崩这类「早退失败」在这里一律看不见 —— 所以结果字段叫 `started` 而不是
     * `success`，并在 note 里说清。需要成败/输出/退出码请用 exec。
     */
    return new Promise<string>((resolve) => {
      const child = spawn(command, [], {
        cwd,
        detached,
        stdio: "ignore",
        shell: true,
        windowsHide: true,
      });

      let resolved = false;
      let timer: NodeJS.Timeout | undefined;
      const done = (payload: Record<string, unknown>) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        resolve(JSON.stringify(payload));
      };

      const startedPayload = () => ({
        started: true,
        pid: child.pid ?? null,
        message: `Process started (PID: ${child.pid ?? "unknown"})`,
        note: "This tool only reports that the process was started; it does not track the exit status. Use exec if you need the exit code or the output.",
      });

      child.on("error", (err) => {
        done({ started: false, pid: null, message: `Failed to start: ${err.message}` });
      });

      child.on("spawn", () => {
        child.unref();
        done(startedPayload());
      });

      // 兜底：`spawn` 事件理论上必然触发，这里保证工具不会挂住
      timer = setTimeout(() => {
        child.unref();
        done(startedPayload());
      }, 500);
      timer.unref?.();
    });
  }
}
