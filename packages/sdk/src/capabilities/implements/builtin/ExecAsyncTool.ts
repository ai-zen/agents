import { spawn } from "child_process";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class ExecAsyncTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
        name: "exec_async",
        description:
          "异步执行命令，启动程序后立即返回，不等待执行结果。适用于启动长期运行的进程（如服务器、监听程序、GUI应用等）或不需要等待结果的命令。注意：该工具不会捕获命令的输出，如果需要获取输出请使用 exec。",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "要执行的命令（含参数）",
            },
            cwd: {
              type: "string",
              description: "工作目录（可选，默认当前工作目录）",
            },
            detached: {
              type: "boolean",
              description:
                "是否完全脱离当前进程组（可选，默认 false）。设为 true 时，即使当前 Agent 进程退出，启动的程序仍会继续运行。适用于需要独立运行的守护进程或 GUI 程序。",
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
      env,
    });
  }

  async call(input: { command: string; cwd?: string; detached?: boolean }): Promise<string> {
    const command = input.command;
    const cwd = input.cwd ? this.resolve(input.cwd) : this.env.cwd;
    const detached = input.detached ?? false;

    // Windows 用 shell 模式，其他平台直接 spawn 避免 shell 安全问题
    const useShell = process.platform === "win32";

    return new Promise<string>((resolve) => {
      let child: ReturnType<typeof spawn>;

      if (useShell) {
        child = spawn(command, [], {
          cwd,
          detached,
          stdio: "ignore",
          shell: true,
          windowsHide: true,
        });
      } else {
        // Unix: 解析命令和参数，直接 spawn
        const args: string[] = [];
        let current = "";
        let inQuote: string | null = null;

        for (const ch of command) {
          if (inQuote) {
            if (ch === "\\") {
              current += command[command.indexOf(ch) + 1] ?? "";
              continue;
            }
            if (ch === inQuote) {
              inQuote = null;
              if (current) args.push(current);
              current = "";
              continue;
            }
            current += ch;
          } else {
            if (ch === '"' || ch === "'") {
              inQuote = ch;
            } else if (ch === " ") {
              if (current) {
                args.push(current);
                current = "";
              }
            } else {
              current += ch;
            }
          }
        }
        if (current) args.push(current);

        child = spawn(args[0]!, args.slice(1), {
          cwd,
          detached,
          stdio: "ignore",
        });
      }

      let resolved = false;

      child.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        resolve(
          JSON.stringify({
            success: false,
            pid: null,
            message: `启动失败: ${err.message}`,
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
            message: `进程已启动 (PID: ${child.pid ?? "unknown"})`,
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
                ? `进程已退出 (PID: ${child.pid ?? "unknown"})`
                : `进程已退出 (PID: ${child.pid ?? "unknown"}, 退出码: ${code})`,
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
            message: `进程已启动 (PID: ${child.pid ?? "unknown"})`,
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
