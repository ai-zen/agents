#!/usr/bin/env node
/**
 * `agents-server` 命令行入口 —— 组装根。
 *
 * 本文件是**唯一**允许读进程级环境的地方（`AI_ZEN_DIR` / `HOME` / `argv`），因为它是
 * composition root：所有路径在这里解析成值，再以参数注入给下面的对象。`src/service/`
 * 与 `src/daemon/` 里一律不读全局（可用 README 的 grep 检验）。
 *
 * 子命令：
 *   agents-server [serve] [--port N] [--idle-timeout MS] [--workspace PATH]  前台启动（默认 8790）
 *   agents-server status                                   打印发现文件与存活状态
 *   agents-server stop                                     让在跑的那个收摊
 */

import { promises as fs } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Daemon } from "./daemon/Daemon.js";
import { createAgentHandlers } from "./daemon/agentHandlers.js";
import { createConfigHandlers } from "./daemon/configHandlers.js";
import { createSessionHandlers } from "./daemon/sessionHandlers.js";
import {
  descriptorPath,
  isProcessAlive,
  readDescriptor,
  removeDescriptor,
} from "./daemon/discovery.js";
import { encodeFrame, FrameDecoder } from "./protocol/frames.js";
import { PROTOCOL_VERSION } from "./protocol/messages.js";
import { SessionAgentFactory } from "./service/agent/SessionAgentFactory.js";
import { ConfigService } from "./service/config/ConfigService.js";
import { EventHub } from "./service/events/EventHub.js";
import { SessionManager } from "./service/session/SessionManager.js";
import { FileSessionStore } from "./service/store/FileSessionStore.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

interface Args {
  command: "serve" | "status" | "stop";
  aiZenDir: string;
  port: number;
  host: string;
  idleTimeoutMs: number;
  /** 客户端不指定工作目录时用哪个（`--workspace`，缺省为启动本进程时的目录） */
  defaultWorkspace: string;
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
  // cwd 归属服务端：客户端不发工作目录时用它。缺省取本进程的 cwd —— 这是「谁把服务端
  // 拉起来的、当时他在哪个目录」的答案，所以下面启动日志里会把它打出来（否则用户报
  // 「`@` 补全列出来的全是不认识的目录」时，无从判断是谁决定的目录）。
  const defaultWorkspace = readFlag(rest, "--workspace") ?? process.cwd();

  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad --port: ${port}`);
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
    throw new Error(`bad --idle-timeout: ${idleTimeoutMs}`);
  }
  return { command, aiZenDir, port, host, idleTimeoutMs, defaultWorkspace };
}

/** 取 `--flag value` 的值（同时支持 `--flag=value`） */
function readFlag(argv: string[], flag: string): string | undefined {
  const eq = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** 追加写日志：守护进程是 detach 出来的，绝不能往客户端终端写 */
async function openLog(aiZenDir: string): Promise<(level: string, message: string) => void> {
  const file = join(aiZenDir, "logs", "server.log");
  await fs.mkdir(dirname(file), { recursive: true });
  return (level, message) => {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    void fs.appendFile(file, line, "utf-8").catch(() => {
      /* 日志写不进去不该拖垮服务 */
    });
  };
}

/** 连上在跑的服务端，做一次握手 + 一次方法调用（stop / status 用） */
async function callRunning(
  host: string,
  port: number,
  method: string,
  timeoutMs = 2000,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ host, port });
    const decoder = new FrameDecoder();
    let handled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout after ${timeoutMs}ms calling ${method}`));
    }, timeoutMs);

    const done = (fn: () => void) => {
      if (handled) return;
      handled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.write(
        encodeFrame({
          kind: "hello",
          protocol: PROTOCOL_VERSION,
          client: { name: "agents-server-cli", version: SERVER_VERSION },
        }),
      );
    });
    socket.on("data", (chunk: string) => {
      for (const frame of decoder.push(chunk)) {
        const value = frame as any;
        if (value?.kind === "hello") {
          if (!value.ok) {
            done(() => reject(new Error(`handshake failed: ${value.error?.code} ${value.error?.message ?? ""}`)));
            return;
          }
          socket.write(encodeFrame({ id: 1, method }));
          continue;
        }
        if (typeof value?.id === "number") {
          if (value.ok) done(() => resolve(value.result));
          else done(() => reject(new Error(`${value.error?.code}: ${value.error?.message}`)));
        }
      }
    });
    socket.on("error", (error) => done(() => reject(error)));
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
    const alive = isProcessAlive(descriptor.pid);
    console.log(JSON.stringify({ ...descriptor, alive }, null, 2));
    return alive ? 0 : 1;
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
    await callRunning(descriptor.host, descriptor.port, "shutdown");
    console.log(`stopped server on ${descriptor.host}:${descriptor.port} (pid ${descriptor.pid})`);
    return 0;
  }

  // ---- serve ----
  // 单实例：已有一个活着的就别起第二个（否则两份 MCP 连接、两份工具发现）
  const existing = await readDescriptor(args.aiZenDir);
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      try {
        await callRunning(existing.host, existing.port, "ping", 800);
        console.error(
          `already running on ${existing.host}:${existing.port} (pid ${existing.pid}, v${existing.version})`,
        );
        return 1;
      } catch (error: any) {
        // 进程在但连不上：可能是别人的端口被占，或它正处在启动/收尾；两种都不该默默双开
        console.error(`a live pid ${existing.pid} holds the descriptor but is not answering: ${error?.message ?? error}`);
        return 1;
      }
    }
    // 进程已死：残留文件，清掉继续
    await removeDescriptor(args.aiZenDir);
  }

  const log = await openLog(args.aiZenDir);

  // 组装根：这里把「路径 + 进程环境」解析成值，再注入给下面的对象。
  // 会话装配（配置 / Scope / 工具发现）全在 agents-server 内部，本进程只负责接线。
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  const agentFactory = new SessionAgentFactory({ aiZenDir: args.aiZenDir, homeDir });
  const workspacesRoot = join(args.aiZenDir, "workspaces");
  // 配置与 Agent 定义的管理面（客户端配置中心用）：路径在这里解析成值再注入，
  // `service/` 里一律不读全局（配置根、Agent 目录、MCP 文件、工作区根都是）
  const configService = new ConfigService({
    configFile: join(args.aiZenDir, "config.json"),
    agentsDir: join(args.aiZenDir, "agents"),
    subAgentsDir: join(args.aiZenDir, "sub-agents"),
    globalMcpFile: join(args.aiZenDir, "mcp.json"),
    workspacesRoot,
  });
  log("info", `default workspace: ${args.defaultWorkspace}`);
  // 一条事件出口：会话事件与全局通知共用（客户端只需一次订阅）
  const hub = new EventHub();
  const sessions = new SessionManager({
    hub,
    createAgent: (input) => agentFactory.create(input),
    // 每个工作区一份存档：续接与 session.save 都走它
    storeFor: (workspaceId) => new FileSessionStore({ rootDir: join(workspacesRoot, workspaceId) }),
    // 配置/定义变了要连带丢掉 Scope（它持有配置快照）
    invalidateScope: (workspacePath) => agentFactory.invalidate(workspacePath),
    // 交接要读磁盘上的 `handoff` Skill、写 `<工作区>/.ai-zen/handoffs`：路径根由这里给
    handoff: { aiZenDir: args.aiZenDir, homeDir },
  });

  const daemon = new Daemon({
    aiZenDir: args.aiZenDir,
    host: args.host,
    port: args.port,
    version: SERVER_VERSION,
    idleTimeoutMs: args.idleTimeoutMs,
    log,
    handlers: {
      ...createSessionHandlers({
        manager: sessions,
        workspacesRoot,
        defaultWorkspacePath: args.defaultWorkspace,
      }),
      ...createAgentHandlers({ factory: agentFactory, config: configService }),
      ...createConfigHandlers({ config: configService }),
    },
    onStopped: (reason) => {
      log("info", `exit (${reason})`);
      // 留一点时间让 stdout 刷出去，然后退出（进程是被 detach 的，不会有人替我们退出）
      setTimeout(() => process.exit(0), 10);
    },
  });

  const descriptor = await daemon.start();
  // 前台启动时把端口打到 stdout：客户端/脚本靠它拿到系统分配的端口
  console.log(JSON.stringify({ name: SERVER_NAME, ...descriptor }));

  const shutdown = async (signal: string) => {
    // 先收会话（断掉 MCP 连接），再停守护进程 —— 反过来会把还没收完的连接晾在 socket 上
    sessions.dispose();
    await agentFactory.dispose();
    await daemon.stop(`signal ${signal}`);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
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
