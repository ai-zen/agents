import { spawn, type ChildProcess } from "node:child_process";

/**
 * stdout + stderr 的内存上限（字节，两流合计）。
 *
 * 超限就杀掉整个进程组并把已到的输出截在那里，结果里带 `truncated`（尾部内容已丢失）。
 */
export const MAX_BUFFER = 16 * 1024 * 1024;

/** 进程组 SIGKILL 之后等待回调的兜底时长：万一管道被孤儿进程占住，也不至于永久挂起 */
const KILL_GRACE_MS = 2000;

/** 子进程已退出、但 stdio 仍被后代占住时，攒完已到达的输出就收尾 */
const STDIO_DRAIN_MS = 200;

/** 一条命令的收场：输出、退出状态、因何终止 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
  terminated?: "timeout" | "aborted";
  /** 输出达到 MAX_BUFFER 被截断（尾部丢失，进程因此被终止） */
  truncated?: boolean;
}

/** 起好的一条命令：结果另走一句 promise，回收自己拿 `kill()` */
export interface CommandRun {
  /** 子进程；`signal` 传入时已经 aborted 的话不起进程，这里为 `undefined` */
  readonly child: ChildProcess | undefined;
  /** 按进程组回收这条命令 */
  kill(): void;
  /** 结果，不会 reject */
  readonly result: Promise<CommandResult>;
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
  /** 超时（毫秒）；不给就一直跑到进程自己结束 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 起一条命令，收回它的输出与退出状态。
 *
 * 三处写法与 `spawn` 的裸调用不同，各有原因：
 *
 * - `detached: true` 让子进程成为新进程组的组长，于是 `-pid` 就是「该组所有进程」。只杀 shell
 *   会把后代留成孤儿（`cmd | cat`、`sh -c 'sleep 100 &'` 都会漏）。Windows 不支持负 pid，
 *   那边回退为只杀子进程。
 * - 输出攒在两个缓冲区里并合计计数，到 {@link MAX_BUFFER} 就停手并杀掉进程组 —— 再攒也存不下。
 * - 收尾不只听 `close`：子进程已退出而 stdio 仍被后代占着时，攒完已到达的输出就收尾，
 *   否则要等那些后代自己退出。
 *
 * `child_process.exec()` 会忽略 `detached`（实测 Node 26），所以这里用 `spawn`。
 */
export function runCommand(options: RunCommandOptions): CommandRun {
  const { command, cwd, timeoutMs, signal } = options;

  let child: ChildProcess | undefined;
  let settled = false;
  let terminated: CommandResult["terminated"];
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

  let resolveResult: (value: CommandResult) => void = () => undefined;
  const result = new Promise<CommandResult>((resolve) => {
    resolveResult = resolve;
  });

  const settle = (value: CommandResult) => {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (drainTimer) clearTimeout(drainTimer);
    signal?.removeEventListener("abort", onAbort);
    resolveResult(value);
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

  /** 杀整个进程组（不是只杀 shell，理由见 {@link runCommand}） */
  function killProcessGroup(): void {
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
  }

  // 声明成函数而不是常量：`settle` 要摘掉它，而最前面那条「已经 aborted」的收场也走 `settle`
  function onAbort(): void {
    terminated = "aborted";
    killProcessGroup();
    settle({
      stdout: "",
      stderr: "Process aborted",
      exitCode: null,
      killed: true,
      terminated: "aborted",
    });
  }

  if (signal?.aborted) {
    settle({
      stdout: "",
      stderr: "Process aborted",
      exitCode: null,
      killed: true,
      terminated: "aborted",
    });
    return { child: undefined, kill: killProcessGroup, result };
  }

  child = spawn(command, {
    cwd,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    // 输出走管道，不需要也不该给用户弹一个终端窗口。这一条尤其要紧 —— 服务端自己是
    // detached 起的、没有控制台，不 hide 的话每次调用都会新分配一个控制台窗口。
    windowsHide: true,
  });

  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    if (truncated) return;
    bytes += chunk.length;
    target.push(chunk);
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

  // 中断：整组回收，并立即返回（不等回调，避免挂起）
  signal?.addEventListener("abort", onAbort, { once: true });

  // 超时：整组回收后优先等回调，好把已收集到的输出带回去
  if (timeoutMs !== undefined) {
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
    }, timeoutMs);
  }

  return { child, kill: killProcessGroup, result };
}
