import { spawn } from "child_process";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class ExecAsyncTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "exec_async",
    description:
      "异步执行命令，启动程序后立即返回，不等待执行结果。适用于启动长期运行的进程（如服务器、监听程序、GUI应用等）或不需要等待结果的命令。注意：该工具本身不捕获命令的输出；若需获取/留存输出，可在命令中使用 shell 重定向写入文件（如 `> /path/file`，支持 `>>` 追加、`|` 管道）。命令经 shell 解析执行。",
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
