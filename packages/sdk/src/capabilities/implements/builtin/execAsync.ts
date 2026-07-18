import { CallbackTool } from "@ai-zen/agents-core";
import { spawn } from "child_process";

export const execAsyncTool = new CallbackTool({
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
          description: "工作目录（可选，默认当前目录）",
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
  async callback(input): Promise<string> {
    const command = input.command as string;
    const cwd = (input.cwd as string) ?? undefined;
    const detached = (input.detached as boolean) ?? false;

    // Windows 用 shell 模式，其他平台直接 spawn 避免 shell 安全问题
    const useShell = process.platform === "win32";

    return new Promise<string>((resolve) => {
      let child;

      if (useShell) {
        // Windows: 通过 shell 执行整条命令
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

      // 记录是否已 resolve
      let resolved = false;

      child.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        resolve(
          JSON.stringify({
            success: false,
            pid: null,
            error: `启动失败: ${err.message}`,
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

      // 如果进程很快退出（如命令不存在被 shell 拒绝），捕获退出码
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

      // 给子进程一点时间来触发 spawn/error/exit 事件
      // 若 500ms 后仍未触发，认为启动成功
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

      // 超时后清理
      const cleanup = () => {
        clearTimeout(timeout);
        child.removeAllListeners();
      };

      child.on("spawn", cleanup);
      child.on("error", cleanup);
      child.on("exit", cleanup);

      // 允许子进程独立运行（不阻止父进程退出）
      child.unref();
    });
  },
});
