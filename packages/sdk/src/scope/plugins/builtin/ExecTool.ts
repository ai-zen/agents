import { spawn, type ChildProcess } from "child_process";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headTailPreview } from "./outputGuard.js";

/**
 * stdout + stderr 的内存上限（字节，两流合计）。
 *
 * `exec` 默认 maxBuffer 只有 1MB：超限时它直接杀掉子进程、只留下前 1MB，还把
 * `error.code` 变成一个字符串错误码。这里显式放大上限，并在真的截断时如实标注
 * `truncated`（尾部内容已丢失）。
 */
const MAX_BUFFER = 16 * 1024 * 1024;

/** 进程组 SIGKILL 之后等待回调的兜底时长：万一管道被孤儿进程占住，也不至于永久挂起 */
const KILL_GRACE_MS = 2000;

/** 子进程已退出、但 stdio 仍被后代占住时，攒完已到达的输出就收尾 */
const STDIO_DRAIN_MS = 200;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
  terminated?: "timeout" | "aborted";
  /** 输出达到 MAX_BUFFER 被截断（尾部丢失，进程因此被终止） */
  truncated?: boolean;
}

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
          description:
            "Timeout in milliseconds (required). The process is killed on timeout. For long-running commands, prefer spawn to run them asynchronously.",
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
    const command = input.command;
    const { timeout } = input;

    // 运行时双校验：timeout 必填且必须为正数
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(
        `exec: timeout is required and must be a positive number (milliseconds), got: ${JSON.stringify(timeout)}`,
      );
    }

    const signal = ctx?.signal;

    const result = await new Promise<ExecResult>((resolve) => {
      // 若 signal 已处于 aborted，直接标记中断结果
      if (signal?.aborted) {
        resolve({
          stdout: "",
          stderr: "Process aborted",
          exitCode: null,
          killed: true,
          terminated: "aborted",
        });
        return;
      }

      let child: ChildProcess | undefined;
      let settled = false;
      let terminated: ExecResult["terminated"];
      let truncated = false;
      let bytes = 0;
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timeoutTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      let drainTimer: NodeJS.Timeout | undefined;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let exited = false;

      const settle = (value: ExecResult) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (graceTimer) clearTimeout(graceTimer);
        if (drainTimer) clearTimeout(drainTimer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };

      /** 用已收集到的输出收尾（子进程已退出或被杀） */
      const settleFromCollected = (forced?: "timeout") => {
        settle({
          stdout: Buffer.concat(out).toString(),
          stderr: Buffer.concat(err).toString(),
          exitCode,
          killed: terminated !== undefined || exitSignal !== null,
          terminated: terminated ?? forced,
          truncated: truncated || undefined,
        });
      };

      /**
       * 杀整个进程组，而不是只杀 shell。
       *
       * `detached: true` 让子进程成为新进程组的组长，`-pid` 即「该组所有进程」；
       * 只 kill shell 会把后代留成孤儿（`cmd | cat`、`sh -c 'sleep 100 &'` 都会漏）。
       * 注意：`child_process.exec()` 会忽略 `detached`（实测 Node 26），故这里用 spawn。
       * Windows 不支持负 pid，回退为只杀子进程。
       */
      const killProcessGroup = () => {
        if (!child?.pid) return;
        if (process.platform === "win32") {
          child.kill("SIGKILL");
          return;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      child = spawn(command, {
        cwd: this.env.cwd,
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        // 与 `SpawnTool` 同一条约定：输出走管道，不需要也不该给用户弹一个终端窗口。
        // 这一条尤其要紧 —— 服务端自己是 detached 起的、没有控制台，不 hide 的话这里
        // **每次工具调用**都会新分配一个控制台窗口。
        windowsHide: true,
      });

      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        if (truncated) return;
        bytes += chunk.length;
        target.push(chunk);
        // 超过内存上限：停手并杀掉进程组，尾部本来也存不下
        if (bytes > MAX_BUFFER) {
          truncated = true;
          killProcessGroup();
        }
      };
      child.stdout?.on("data", collect(out));
      child.stderr?.on("data", collect(err));

      child.on("error", (e) => {
        settle({
          stdout: "",
          stderr: e.message,
          exitCode: null,
          killed: false,
          terminated,
        });
      });

      child.on("exit", (code, sig) => {
        exited = true;
        exitCode = code;
        exitSignal = sig;
        // 已退出但 stdio 可能还被后代占着（如 `cmd &`）：只等一小会儿就收尾
        drainTimer = setTimeout(() => settleFromCollected(), STDIO_DRAIN_MS);
      });

      child.on("close", (code, sig) => {
        if (!exited) {
          exitCode = code;
          exitSignal = sig;
        }
        settleFromCollected();
      });

      // 中断：整组 kill，并立即返回（不等待回调，避免挂起）
      const onAbort = () => {
        terminated = "aborted";
        killProcessGroup();
        settle({
          stdout: "",
          stderr: "Process aborted",
          exitCode: null,
          killed: true,
          terminated: "aborted",
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      // 超时：整组 kill 后优先等回调，好把已收集到的输出带回去
      timeoutTimer = setTimeout(() => {
        terminated = "timeout";
        killProcessGroup();
        graceTimer = setTimeout(() => {
          settle({
            stdout: Buffer.concat(out).toString(),
            stderr: Buffer.concat(err).toString(),
            exitCode: null,
            killed: true,
            terminated: "timeout",
          });
        }, KILL_GRACE_MS);
      }, timeout);
    });

    const truncationNote = result.truncated
      ? `Output reached the ${MAX_BUFFER}-byte in-memory cap: it was truncated there and the tail is lost (the process was killed by maxBuffer).`
      : undefined;

    // 输出保护：stdout + stderr 合计超过 maxToolOutput 时，分文件落盘并返回警告 + 头尾预览
    const limit = this.env.config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT;
    const guarded = await guardOutput({
      tool: "exec",
      content: result,
      isOverLimit: (output) => output.stdout.length + output.stderr.length > limit,
      dump: (_dir, output) => [
        { name: "stdout.log", content: output.stdout },
        { name: "stderr.log", content: output.stderr },
      ],
      buildWarning: (ctx) => {
        const stdout = headTailPreview(result.stdout);
        const stderr = headTailPreview(result.stderr);
        return JSON.stringify({
          outputTooLarge: true,
          warning:
            `Output too large: stdout + stderr total ${result.stdout.length + result.stderr.length} characters, ` +
            `exceeds the limit of ${limit} characters. The output as captured is available in separate files (stdout.log / stderr.log); use read to fetch it in chunks`,
          ...(truncationNote ? { truncated: true, truncationNote } : {}),
          files: ctx.files,
          stdout: { chars: result.stdout.length, lines: countLines(result.stdout), ...stdout },
          stderr: { chars: result.stderr.length, lines: countLines(result.stderr), ...stderr },
          exitCode: result.exitCode,
          killed: result.killed,
          terminated: result.terminated,
        });
      },
    });

    // 未超限：content 为原始结果对象，按原有结构序列化；超限：buildWarning 已生成返回字符串
    if (typeof guarded === "string") return guarded;
    return JSON.stringify(
      result.truncated ? { ...guarded, truncated: true, truncationNote } : guarded,
    );
  }
}

/** 统计文本行数（空文本记 0 行） */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}
