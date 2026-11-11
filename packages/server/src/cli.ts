#!/usr/bin/env node
/**
 * `agents-server` 命令行入口 —— **组装根**，只剩四件事：
 * 读 `argv` / `env` → 造一个 `ServerApp` → 跑它 → 把退出码交回去。
 *
 * ## 为什么这里还留着代码
 *
 * 本文件是**唯一**允许读进程级环境的地方（`AI_ZEN_DIR` / `AI_ZEN_ALLOWED_ORIGINS` / `HOME` /
 * `argv` / `cwd`）：所有路径与名单在这里解析成**值**，再以构造参数注入给 `ServerApp`。`src/domain/`、`src/lib/`、
 * `src/daemon/` 与 `ServerApp` 里一律不读全局（可用 README 的 grep 检验）。
 *
 * ## 为什么只剩这么点
 *
 * 状态与方法过去散在这个函数的最后一百行里（谁会话、谁持有、收摊按什么顺序）：组装根
 * 手里有状态却没有名字。现在它们在 `ServerApp`（见那个文件头的三条纪律）—— 本文件不再
 * 知道会话怎么活、通知存在哪，也不再自己拼方法表。留下来的只有**进程才关心的事**：
 * 命令行参数、日志文件、以及在**没有**服务在跑时也要能干的两件小事（`status` / `stop`）。
 *
 * ## 子命令
 *
 *   agents-server [serve] [--port N] [--idle-timeout MS] [--session-idle-timeout MS] [--workspace PATH]
 *                                                         前台启动（默认 8790）
 *   agents-server status                                   打印发现文件与存活状态
 *   agents-server stop                                     让在跑的那个收摊
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ServerApp, type LogLevel } from "./ServerApp.js";
import type { AnyMethod, ResultOf } from "./protocol/api.js";
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from "./domain/session/SessionManager.js";
import { callOnce } from "./wire/call-once.js";
import {
  descriptorPath,
  isProcessAlive,
  readDescriptor,
  removeDescriptor,
} from "./wire/discovery.js";
import { readToken } from "./wire/token.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

interface Args {
  command: "serve" | "status" | "stop";
  aiZenDir: string;
  port: number;
  host: string;
  idleTimeoutMs: number;
  /**
   * 「最后一个看着它的客户端也走了」之后还留多久（`--session-idle-timeout`）。
   *
   * 与上面的 `idleTimeoutMs` 是**两件事**，名字里都有 idle，但对象不同：
   *   · `idleTimeoutMs`     —— 整个守护进程：一个连接都没有了，多久后退出；
   *   · `sessionIdleTimeoutMs` —— 单段会话：没人看着了，多久后回收（存档已在每轮收尾写好）。
   * 断线重连要在后者那个窗口里完成，所以它的缺省值不能低于重连预算（见常量注释）。
   */
  sessionIdleTimeoutMs: number;
  /** 客户端不指定工作目录时用哪个（`--workspace`，缺省为启动本进程时的目录） */
  defaultWorkspace: string;
  /**
   * 额外允许的浏览器 `Origin`（`AI_ZEN_ALLOWED_ORIGINS`，逗号分隔）。
   *
   * 只有环境变量一条路（不给 `--flag`）：它是部署形态的参数（nginx + 域名），不是一次性
   * 开关；当参数传会进 shell 历史，改动一次还要改启动脚本。`Origin` 不是秘密，但也没
   * 必要多一种写它的方式。
   */
  allowedOrigins: string[];
}

function parseArgs(argv: string[]): Args {
  const rest = [...argv];
  // 第一个非 `--` 参数是子命令；缺省 serve
  let command: Args["command"] = "serve";
  if (rest[0] && !rest[0].startsWith("-")) {
    const first = rest.shift() as string;
    if (first !== "serve" && first !== "status" && first !== "stop") {
      throw new Error(`unknown command: ${first} (expected serve | status | stop)`);
    }
    command = first;
  }

  const aiZenDir =
    readFlag(rest, "--ai-zen-dir") ??
    process.env.AI_ZEN_DIR ??
    join(process.env.HOME || process.env.USERPROFILE || homedir(), ".ai-zen");
  const port = Number(readFlag(rest, "--port") ?? 8790);
  const host = readFlag(rest, "--host") ?? "127.0.0.1";
  const idleTimeoutMs = Number(readFlag(rest, "--idle-timeout") ?? 0);
  const sessionIdleTimeoutMs = Number(
    readFlag(rest, "--session-idle-timeout") ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  );
  // cwd 归属服务端：客户端不发工作目录时用它。缺省取本进程的 cwd —— 这是「谁把服务端
  // 拉起来的、当时他在哪个目录」的答案，所以启动日志里会把它打出来（否则用户报
  // 「`@` 补全列出来的全是不认识的目录」时，无从判断是谁决定的目录）。
  const defaultWorkspace = readFlag(rest, "--workspace") ?? process.cwd();
  // 浏览器来源白名单：只从环境变量读（见 `Args.allowedOrigins` 的注释）
  const allowedOrigins = parseOrigins(process.env.AI_ZEN_ALLOWED_ORIGINS);

  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad --port: ${port}`);
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
    throw new Error(`bad --idle-timeout: ${idleTimeoutMs}`);
  }
  if (!Number.isFinite(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 0) {
    throw new Error(`bad --session-idle-timeout: ${sessionIdleTimeoutMs}`);
  }
  return {
    command,
    aiZenDir,
    port,
    host,
    idleTimeoutMs,
    sessionIdleTimeoutMs,
    defaultWorkspace,
    allowedOrigins,
  };
}

/**
 * `AI_ZEN_ALLOWED_ORIGINS` → `Origin` 列表（逗号分隔、trim、丢空项）。
 *
 * 丢空项是必须的：`A,,B` / 结尾多一个逗号 / 只写了一堆空白，都不该在名单里留下一个空串
 * （它永远匹配不上，但会让读日志的人以为配了两条）。
 */
function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** 取 `--flag value` 的值（同时支持 `--flag=value`） */
function readFlag(argv: string[], flag: string): string | undefined {
  const eq = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** 日志出口：`log` 写一行，`flush` 等这一次收摊的写入全部落盘（收摊的最后一步用它） */
interface ServerLog {
  log: (level: LogLevel, message: string) => void;
  flush: () => Promise<void>;
}

/**
 * 追加写日志：守护进程是 detach 出来的，绝不能往客户端终端写。
 *
 * 为什么要跟踪在飞的写入：收摊的最后一步是「flush 日志 → 退出」，而 `appendFile` 是异步的。
 * 不跟踪就只能靠「退出前睡 10ms」赌它写完了 —— 那正是「最后一条日志偶尔不见了」的来源。
 */
async function openLog(aiZenDir: string): Promise<ServerLog> {
  const file = join(aiZenDir, "logs", "server.log");
  await fs.mkdir(dirname(file), { recursive: true });
  const inFlight = new Set<Promise<void>>();
  return {
    log: (level, message) => {
      const line = `${new Date().toISOString()} [${level}] ${message}\n`;
      // 日志写不进去不该拖垮服务
      const write = fs.appendFile(file, line, "utf-8").catch(() => {});
      inFlight.add(write);
      void write.finally(() => inFlight.delete(write));
    },
    flush: async () => {
      await Promise.all(inFlight);
    },
  };
}

/**
 * 连上在跑的服务端问一句（`stop` / 单实例检查用）。
 *
 * 与客户端 `status.ts`、`ensure-server.ts` 里的探活是**同一件事**，实现只有
 * `wire/call-once.ts` 的一份（`callOnce`），三处都调它。凭证从 `aiZenDir` 下那一个文件读 ——
 * 正在跑的那个守护进程就是把它写在那里的（`wire/token.ts`）。
 */
async function callRunning<M extends AnyMethod>(
  address: { host: string; port: number; aiZenDir: string },
  method: M,
  timeoutMs = 2000,
): Promise<ResultOf<M>> {
  return await callOnce({ host: address.host, port: address.port }, method, undefined, {
    timeoutMs,
    client: { name: "agents-server-cli", version: SERVER_VERSION },
    token: (await readToken(address.aiZenDir)) ?? undefined,
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "status") {
    const descriptor = await readDescriptor(args.aiZenDir);
    if (!descriptor) {
      console.log(`no server running (no descriptor at ${descriptorPath(args.aiZenDir)})`);
      return 1;
    }
    const running = isProcessAlive(descriptor.pid);
    // 字段名与 `ai --server-status` 对齐：同一个问题（服务端在不在）只用一个名字
    console.log(JSON.stringify({ ...descriptor, running }, null, 2));
    return running ? 0 : 1;
  }

  if (args.command === "stop") {
    const descriptor = await readDescriptor(args.aiZenDir);
    if (!descriptor) {
      console.log("no server running");
      return 0;
    }
    if (!isProcessAlive(descriptor.pid)) {
      // 残留文件：进程已经没了，直接收掉，避免下次连到死端口
      await removeDescriptor(args.aiZenDir);
      console.log("stale descriptor cleaned (process was gone)");
      return 0;
    }
    const address = { ...descriptor, aiZenDir: args.aiZenDir };
    await callRunning(address, "shutdown");
    console.log(`stopped server on ${descriptor.host}:${descriptor.port} (pid ${descriptor.pid})`);
    return 0;
  }

  // ---- serve ----
  const log = await openLog(args.aiZenDir);
  // 组装根的全部工作：把「路径 + 进程环境」解析成值，交给 `ServerApp`。会话装配、方法表、
  // 通知槽位、收摊顺序都在那边 —— 这里不再出现任何一个业务对象。
  const app = new ServerApp({
    aiZenDir: args.aiZenDir,
    homeDir: process.env.HOME || process.env.USERPROFILE || homedir(),
    defaultWorkspacePath: args.defaultWorkspace,
    host: args.host,
    port: args.port,
    idleTimeoutMs: args.idleTimeoutMs,
    sessionIdleTimeoutMs: args.sessionIdleTimeoutMs,
    // 浏览器来源白名单：`AI_ZEN_ALLOWED_ORIGINS`（空 = 只允许 loopback）
    allowedOrigins: args.allowedOrigins,
    log: log.log,
    flushLog: log.flush,
  });
  const descriptor = await app.start();
  app.installSignalHandlers();
  // 前台启动时把端口打到 stdout：客户端/脚本靠它拿到系统分配的端口
  console.log(JSON.stringify({ name: SERVER_NAME, ...descriptor }));
  return 0;
}

main()
  .then((code) => {
    // serve 分支不会到这里就退出（daemon 还在跑）；status/stop 直接返回
    if (code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    console.error(`agents-server: ${error?.message ?? error}`);
    process.exit(1);
  });
