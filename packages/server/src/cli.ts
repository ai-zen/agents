#!/usr/bin/env node
/**
 * `agents-server` 命令行入口 —— 组装根。
 *
 * 本文件是**唯一**允许读进程级环境的地方（`AI_ZEN_DIR` / `HOME` / `argv`），因为它是
 * composition root：所有路径在这里解析成值，再以参数注入给下面的对象。`src/service/`
 * 与 `src/daemon/` 里一律不读全局（可用 README 的 grep 检验）。
 *
 * 子命令：
 *   agents-server [serve] [--port N] [--idle-timeout MS] [--session-idle-timeout MS] [--workspace PATH]
 *                                                         前台启动（默认 8790）
 *   agents-server status                                   打印发现文件与存活状态
 *   agents-server stop                                     让在跑的那个收摊
 */

import { promises as fs } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Daemon } from "./daemon/Daemon.js";
import { createAgentHandlers } from "./daemon/agentHandlers.js";
import { createAssetHandlers } from "./daemon/assetHandlers.js";
import { createConfigHandlers } from "./daemon/configHandlers.js";
import { createSessionHandlers } from "./daemon/sessionHandlers.js";
import {
  descriptorPath,
  isProcessAlive,
  readDescriptor,
  removeDescriptor,
} from "./protocol/discovery.js";
import { encodeFrame, FrameDecoder } from "./protocol/frames.js";
import { DAEMON_METHODS } from "./protocol/daemon.js";
import { PROTOCOL_VERSION } from "./protocol/messages.js";
import { SessionAgentFactory } from "./service/agent/SessionAgentFactory.js";
import { AssetService } from "./service/asset/AssetService.js";
import { globalAgentPaths } from "./service/agent/agentPaths.js";
import { ConfigService } from "./service/config/ConfigService.js";
import { createAutoTitle } from "./service/session/AutoTitle.js";
import { EventHub } from "./service/events/EventHub.js";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { resolveModel } from "@ai-zen/agents-sdk";
import {
  SessionManager,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
} from "./service/session/SessionManager.js";
import { FileSessionStore } from "./service/store/FileSessionStore.js";
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
  // 拉起来的、当时他在哪个目录」的答案，所以下面启动日志里会把它打出来（否则用户报
  // 「`@` 补全列出来的全是不认识的目录」时，无从判断是谁决定的目录）。
  const defaultWorkspace = readFlag(rest, "--workspace") ?? process.cwd();

  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad --port: ${port}`);
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
    throw new Error(`bad --idle-timeout: ${idleTimeoutMs}`);
  }
  if (!Number.isFinite(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 0) {
    throw new Error(`bad --session-idle-timeout: ${sessionIdleTimeoutMs}`);
  }
  return { command, aiZenDir, port, host, idleTimeoutMs, sessionIdleTimeoutMs, defaultWorkspace };
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
            done(() =>
              reject(
                new Error(`handshake failed: ${value.error?.code} ${value.error?.message ?? ""}`),
              ),
            );
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
    await callRunning(descriptor.host, descriptor.port, DAEMON_METHODS.shutdown);
    console.log(`stopped server on ${descriptor.host}:${descriptor.port} (pid ${descriptor.pid})`);
    return 0;
  }

  // ---- serve ----
  // 单实例：已有一个活着的就别起第二个（否则两份 MCP 连接、两份工具发现）
  const existing = await readDescriptor(args.aiZenDir);
  if (existing) {
    if (isProcessAlive(existing.pid)) {
      try {
        await callRunning(existing.host, existing.port, DAEMON_METHODS.ping, 800);
        console.error(
          `already running on ${existing.host}:${existing.port} (pid ${existing.pid}, v${existing.version})`,
        );
        return 1;
      } catch (error: any) {
        // 进程在但连不上：可能是别人的端口被占，或它正处在启动/收尾；两种都不该默默双开
        console.error(
          `a live pid ${existing.pid} holds the descriptor but is not answering: ${error?.message ?? error}`,
        );
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
  // 配置与管理面共用的两个全局路径（`config.json` / `agents`）：只在这里算一次，
  // 下面的 ConfigService 与会话层的自动标题拿的是同一个值
  const { configFile, agentsDir } = globalAgentPaths({ aiZenDir: args.aiZenDir, homeDir });
  // 配置与 Agent 定义的管理面（客户端配置中心用）：路径在这里解析成值再注入，
  // `service/` 里一律不读全局（配置根、Agent 目录、MCP 文件、工作区根都是）
  const configService = new ConfigService({
    configFile,
    agentsDir,
    subAgentsDir: join(args.aiZenDir, "sub-agents"),
    globalMcpFile: join(args.aiZenDir, "mcp.json"),
    workspacesRoot,
    // 配置一写盘就把所有工作区缓存的 Scope 丢掉：它们各持一份配置快照，不丢就是
    // 「改完配置、别的会话还在用旧的」（详见 `ConfigServiceOptions.onConfigChanged`）
    onConfigChanged: () => agentFactory.invalidate(),
  });
  // 配置根初始化：默认 Agent / 子 Agent / 出厂模型与策略表都由**服务端**释放。
  // 客户端不再碰本机配置目录，所以“首次启动就有默认 Agent”只能在这里保证 ——
  // 否则新机器上第一个 `agent.list` 拿到空列表，TUI 连启动都过不去（`app.noAgents`）。
  await configService.bootstrap();
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
    // 没人看着的会话多久后回收（断线重连的窗口就在这个值里）
    sessionIdleTimeoutMs: args.sessionIdleTimeoutMs,
    // 自动标题：第一轮之后异步让模型起个名。开关（`autoTitle`）与用哪个模型
    // （`defaultMigrationModel`）都要读配置，所以注入的是「函数」而不是一个布尔值 ——
    // 会话层不读配置，而这里只给它一个 `config.json` 路径
    autoTitle: createAutoTitle({ configFile }),
    // 存档条目的生效模型：会话层只认记录（`agentId` + 会话级覆盖），要算出生效模型必须
    // 有「那个 agentId 的定义」与「全局兜底」，这两样都只有组装根手里有。解析本身交给
    // SDK 的 `resolveModel`（三级顺序的唯一实现）—— 这里只负责把三档的**原始值**递给它，
    // 绝不自己写 `a ?? b ?? c`（那就是第二份会漂的优先级）。
    resolveSessionModel: async ({ agentId, sessionModelId }) => {
      // 协议层把定义与配置当**不透明载荷**（客户端不该解释它们），而组装根手里这份就是
      // SDK 的 `AgentDefinition` / `AppConfig` —— 整个仓库里唯一该做这个断言的地方
      const definition = (await configService.getAgent({ id: agentId }))
        .agent as AgentDefinition | null;
      // 定义已经删了：与 `createAgent` 同一口径（它也认为这段会话根本装不起来）。
      // 抛出去而不是退到全局兜底 —— 一条指着已删定义的存档没有「生效模型」可言，
      // 会话层会把这一条的字段省掉，清单其余部分照常
      if (!definition) throw new Error(`Agent "${agentId}" not found`);
      const { config } = await configService.get();
      const resolved = resolveModel({
        sessionModelId,
        agentModelId: definition.modelId,
        defaultModel: (config as AppConfig).defaultModel,
      });
      // 三级都空 = 真的没有模型（`createAgent` 对它是报错），所以同样按「解析失败」处理
      if (!resolved) throw new Error(`Agent "${agentId}" has no model bound`);
      return resolved;
    },
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
      // 资产清单（只读）：全局层与项目层的目录都在组装根这里解析成值再注入
      ...createAssetHandlers({
        service: new AssetService({ aiZenDir: args.aiZenDir, homeDir, workspacesRoot }),
      }),
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
