import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TaskStatusNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ClientCapabilities, Task } from "@modelcontextprotocol/sdk/types.js";
import type { Agent } from "@ai-zen/agents-core";
import { SILENT_LOG, type LogSink } from "../../../shared/logger.js";
import type {
  McpServerConfig,
  McpServerManifest,
  McpConnectionState,
} from "../../../types/index.js";
import { isTerminalTaskStatus, type McpTaskNoticePort } from "./mcpTaskNotice.js";

// ---------------------------------------------------------------------------
// McpConnectionManager
//
// 基于官方 @modelcontextprotocol/sdk 的 Client + Transport 实现。
// 管理 MCP 服务器的完整连接生命周期：
//   - stdio: 使用 StdioClientTransport（子进程 spawn）
//   - http:  使用 StreamableHTTPClientTransport（Streamable HTTP：POST + 可选 SSE 流）
//   - sse:   使用 SSEClientTransport（旧版 HTTP+SSE：GET 建立 SSE 流 + POST 发送消息）
//   - 空闲超时、建连超时、状态机
//
// 建连失败只做一件事：把原错误抛给调用方。重试策略不在本类里 —— 哪些错误值得重试、
// 隔多久重试，只有调用方知道。
// ---------------------------------------------------------------------------

interface ConnectionEntry {
  state: McpConnectionState;
  client?: Client;
  transport?: Transport;
  manifest?: McpServerManifest;
  pendingPromise?: Promise<void>;
  timeoutMs?: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  cancelled?: boolean;
}

/**
 * 建连超时缺省值（毫秒）。
 *
 * 没有上限时，配置错误的 SSE / HTTP 端点会让 `load_mcp` 永久挂起（SSE 在服务端不发
 * 响应头时尤其如此，fetch 只对建链有兜底，对"连上了但永不回话"没有）。
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

/**
 * 客户端在能力协商里声明的能力。
 *
 * `tasks` 这一格是任务增强的前提：服务器按它判断对面接不接得住任务。里面只声明真的会用的那
 * 一项 —— `cancel` 是因为工具面有取消那一条（`tasks/cancel`）；`list` 不用，就不声明。
 */
const CLIENT_CAPABILITIES: ClientCapabilities = { tasks: { cancel: {} } };

/**
 * 任务 id 在管理器里的键：任务 id 只在它自己那台服务器上唯一，两台服务器各自发的同号任务
 * 是两件事。
 */
function taskKey(server: string, taskId: string): string {
  return `${server}\u0000${taskId}`;
}

/** 先到的终态最多搁这么多条：超过就丢最早的那一条（只影响没有谁来认领的那些） */
const EARLY_STATUS_LIMIT = 64;

export interface McpConnectOptions {
  /** 空闲超时（毫秒），默认 stdio: 30min, http/sse: 5min */
  idleTimeoutMs?: number;
  /** 建连超时（毫秒），默认 60s；超时即断开并抛错，避免工具永久挂起 */
  connectTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT: Record<string, number> = {
  stdio: 30 * 60 * 1000,
  http: 5 * 60 * 1000,
  sse: 5 * 60 * 1000,
};

export class McpConnectionManager {
  private servers = new Map<string, ConnectionEntry>();
  /** 可替换的 transport 工厂，用于测试注入 */
  private _transportFactory?: (config: McpServerConfig) => Transport;
  /** 可替换的 Client 工厂，用于测试注入 */
  private _clientFactory?: () => Client;
  /** 日志口（构造时定下缺省：不注入就什么都不写） */
  private readonly logger: LogSink;
  /** 任务通知的投递口（宿主实现）；不注入就没有人接得住任务状态 */
  private readonly _taskNotice?: McpTaskNoticePort;
  /**
   * 任务 id → 发起它的那段会话。
   *
   * 这份对应关系只活在这里：进程没了就没了 —— 任务本身在服务器那边，谈不上恢复；重启之后
   * 服务器再推来的状态也没有会话可投，丢掉就是。
   */
  private readonly taskSessions = new Map<string, string>();
  /**
   * 比「记下这个任务是谁发起的」更早到的终态。
   *
   * 任务建出来之后服务器就跑，状态可能在我们拿到句柄、把对应关系记下来之前先到（同一个连接上
   * 两条消息的先后不保证）。先搁在这里，记下那一刻立刻补投；搁不下的（没有谁来认领的终态）
   * 直接丢掉。
   */
  private readonly earlyStatuses = new Map<string, Task>();

  /**
   * @param transportFactory 可选的自定义 transport 工厂（用于测试注入）
   * @param clientFactory 可选的自定义 Client 工厂（用于测试注入）
   * @param logger 日志口（可选）：建连失败、清单没拉到、断线、关不掉从这里报；缺省不记
   * @param taskNotice 任务通知的投递口（可选）：不给就没有地方投，任务状态只当没收到
   */
  constructor(
    transportFactory?: (config: McpServerConfig) => Transport,
    clientFactory?: () => Client,
    logger: LogSink = SILENT_LOG,
    taskNotice?: McpTaskNoticePort,
  ) {
    this._transportFactory = transportFactory;
    this._clientFactory = clientFactory;
    this.logger = logger;
    this._taskNotice = taskNotice;
  }

  // ---- 对外查询 ----

  getState(name: string): McpConnectionState {
    return this.servers.get(name)?.state ?? "disconnected";
  }

  getManifest(name: string): McpServerManifest | undefined {
    return this.servers.get(name)?.manifest;
  }

  getClient(name: string): Client | undefined {
    return this.servers.get(name)?.client;
  }

  /**
   * 这个工具声明的任务档位。
   *
   * 清单里没有它、或者它没写这一格，就是 `forbidden`（规范的缺省）；清单是从 `tools/list`
   * 拿到的，所以问它和问服务器是同一件事，不必再发一次请求。
   */
  taskSupportOf(name: string, tool: string): "forbidden" | "optional" | "required" {
    const tools = this.servers.get(name)?.manifest?.tools ?? [];
    return tools.find((item) => item.name === tool)?.execution?.taskSupport ?? "forbidden";
  }

  /**
   * 记住一个任务是谁发起的：状态通知到了要投进那段会话的 inbox。
   *
   * 会话 id 只有投递口答得出来（发起调用的是执行体，它属于哪一段会话是运行时的事）。答不出来
   * 就什么都不记 —— 那种调用（被派出去的 subagent、一次性执行体）发起的任务没有会话可以回报。
   */
  rememberTask(name: string, taskId: string, agent: Agent): void {
    const sessionId = this._taskNotice?.sessionOf(agent);
    if (sessionId === undefined) {
      this.logger.info(
        `[McpConnectionManager] task "${taskId}" of "${name}" has no session to report to`,
      );
      return;
    }

    const key = taskKey(name, taskId);
    // 再快也快不过它：终态已经先到了的话，记下的这一刻就把它投出去
    const early = this.earlyStatuses.get(key);
    if (early !== undefined) {
      this.earlyStatuses.delete(key);
      this.report(name, early, sessionId);
      return;
    }

    this.taskSessions.set(key, sessionId);
  }

  // ---- 连接 ----

  async connect(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions = {},
  ): Promise<McpServerManifest> {
    const existing = this.servers.get(name);

    if (existing?.state === "connected" && existing.manifest) {
      this.touch(name);
      return existing.manifest;
    }

    if (existing?.state === "connecting" && existing.pendingPromise) {
      await existing.pendingPromise;
      return this.servers.get(name)?.manifest ?? this.throwNotConnected(name);
    }

    const timeoutMs =
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT[config.transport] ?? 5 * 60 * 1000;
    const pendingPromise = this.doConnect(name, config);

    this.servers.set(name, {
      state: "connecting",
      pendingPromise,
      timeoutMs,
      cancelled: false,
    });

    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    try {
      await this.withConnectTimeout(name, pendingPromise, connectTimeoutMs);
      const entry = this.servers.get(name)!;
      // 建连期间被 disconnect()/dispose()：不要复活连接
      if (entry.cancelled || entry.state === "disconnected") {
        throw new Error(`Connection to "${name}" was cancelled`);
      }
      this.servers.set(name, {
        ...entry,
        state: "connected",
        timeoutTimer: this.scheduleTimeout(name, timeoutMs),
      });
      return entry.manifest!;
    } catch (err) {
      const entry = this.servers.get(name);
      if (entry?.cancelled || entry?.state === "disconnected") {
        this.servers.set(name, { state: "disconnected" });
      } else {
        this.servers.set(name, { state: "error" });
      }
      throw err;
    }
  }

  /** 给建连套上超时：超时即取消连接并清掉半成品状态 */
  private async withConnectTimeout(
    name: string,
    promise: Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `MCP server "${name}" connection timed out after ${timeoutMs}ms (check the transport config: command/url/headers)`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      await Promise.race([promise, timeout]);
    } catch (err) {
      if (String((err as Error)?.message ?? "").includes("timed out")) {
        // 取消挂着的建连，并清掉它可能建好的资源。清理自己再失败也要留一行：
        // 主错误下面照抛，但「建到一半的东西没清掉」是另一件事
        await this.disconnect(name).catch((cleanupError: unknown) => {
          this.logger.warn(
            `[McpConnectionManager] 连接超时后清理 "${name}" 失败：${String(cleanupError)}`,
          );
        });
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async doConnect(name: string, config: McpServerConfig): Promise<void> {
    const transport = this.createTransport(config);
    const client = this._clientFactory
      ? this._clientFactory()
      : new Client(
          { name: "ai-zen-agents", version: "0.1.0" },
          {
            capabilities: CLIENT_CAPABILITIES,
          },
        );

    await client.connect(transport);

    // 任务状态是服务器推来的（`notifications/tasks/status`）：建好连就把这一条接上，之后由
    // `onTaskStatus` 决定投不投。一个 client 一条，重复建连时旧 client 已经关了，不会叠。
    client.setNotificationHandler(TaskStatusNotificationSchema, (notification) => {
      this.onTaskStatus(name, notification.params);
    });

    // 根据 Server 声明的 capabilities 按需调用，避免调用未声明的方法
    const serverCaps = client.getServerCapabilities();

    const manifest: McpServerManifest = {
      tools: [],
      resources: [],
      prompts: [],
    };

    if (serverCaps?.tools) {
      try {
        const toolsResult = await client.listTools();
        manifest.tools = (toolsResult.tools ?? []).map((t: any) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema as Record<string, unknown>,
          // 任务档位带着走：`call_mcp_tool` 要不要带任务参数，判据就是这一格
          ...(t.execution ? { execution: { taskSupport: t.execution.taskSupport } } : {}),
        }));
      } catch (err: unknown) {
        this.logger.error(
          `[McpConnectionManager] Failed to list tools for "${name}": ${(err as Error)?.message ?? err}`,
        );
      }
    }

    if (serverCaps?.resources) {
      try {
        const resourcesResult = await client.listResources();
        manifest.resources = (resourcesResult.resources ?? []).map((r: any) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }));
      } catch (err: unknown) {
        this.logger.error(
          `[McpConnectionManager] Failed to list resources for "${name}": ${(err as Error)?.message ?? err}`,
        );
      }
    }

    if (serverCaps?.prompts) {
      try {
        const promptsResult = await client.listPrompts();
        manifest.prompts = (promptsResult.prompts ?? []).map((p: any) => ({
          name: p.name,
          description: p.description,
        }));
      } catch (err: unknown) {
        this.logger.error(
          `[McpConnectionManager] Failed to list prompts for "${name}": ${(err as Error)?.message ?? err}`,
        );
      }
    }

    const entry = this.servers.get(name) ?? { state: "connecting" as const };

    // 建连期间被 disconnect()/dispose()（启动即退出是正常序列）：关掉刚建好的资源，
    // 绝不写回 connected，否则连接会"复活"、stdio 子进程也再没人关。
    if (entry.cancelled) {
      await this.closeQuietly(client, transport);
      throw new Error(`Connection to "${name}" was cancelled`);
    }

    // 断线检测：运行期 transport 关掉时把状态标回 disconnected，避免 `load_mcp`
    // 一直展示过期清单（不做自动重连：重连策略属于上层）。
    const prevOnClose = transport.onclose;
    transport.onclose = () => {
      prevOnClose?.();
      this.markDisconnected(name);
    };
    const prevOnError = transport.onerror;
    transport.onerror = (error: Error) => {
      prevOnError?.(error);
      this.logger.error(
        `[McpConnectionManager] Transport error for "${name}": ${error?.message ?? error}`,
      );
    };

    this.servers.set(name, {
      ...entry,
      state: "connected",
      client,
      transport,
      manifest,
      cancelled: false,
    });
  }

  /** 关闭连接资源（断开/取消路径共用）：关不掉要留一行，不能装成关掉了 */
  private async closeQuietly(client?: Client, transport?: Transport): Promise<void> {
    try {
      await client?.close();
    } catch (error) {
      this.logger.warn(`[McpConnectionManager] 关闭 MCP client 失败：${String(error)}`);
    }
    try {
      await transport?.close();
    } catch (error) {
      this.logger.warn(`[McpConnectionManager] 关闭 MCP transport 失败：${String(error)}`);
    }
  }

  /** 运行期断线：标记 disconnected 并记日志（已在连接状态才处理，避免重复日志） */
  private markDisconnected(name: string): void {
    const entry = this.servers.get(name);
    if (!entry || entry.state !== "connected") return;
    this.logger.error(`[McpConnectionManager] MCP server "${name}" disconnected`);
    this.clearTimeout(name);
    // 连不上了就再也收不到这台服务器的状态通知：那些对应关系没有用处了，一并丢掉
    this.forgetTasks(name);
    this.servers.set(name, { state: "disconnected" });
  }

  /**
   * 一条任务状态通知该干什么。
   *
   * 只有终态才投：`working` / `input_required` 不是「有事要人动手」，每一条都投就是刷屏；
   * 终态那一条是要人（执行体）去拉结果的信号，投进发起这次调用的那段会话。
   *
   * 对应关系用过就删：这里记的是「哪个任务还欠谁一条回报」，终态之后就没了。
   */
  private onTaskStatus(name: string, task: Task): void {
    if (!isTerminalTaskStatus(task.status)) return;

    const key = taskKey(name, task.taskId);
    const sessionId = this.taskSessions.get(key);
    if (sessionId === undefined) {
      this.rememberEarlyStatus(key, task);
      return;
    }

    this.taskSessions.delete(key);
    this.report(name, task, sessionId);
  }

  /** 把先到的终态搁一下（上限只防未认领的那些无限长） */
  private rememberEarlyStatus(key: string, task: Task): void {
    if (this.earlyStatuses.size >= EARLY_STATUS_LIMIT) {
      const oldest = this.earlyStatuses.keys().next().value;
      if (oldest !== undefined) this.earlyStatuses.delete(oldest);
    }
    this.earlyStatuses.set(key, task);
  }

  /** 把一条终态投进那段会话 */
  private report(name: string, task: Task, sessionId: string): void {
    const port = this._taskNotice;
    if (port === undefined || !isTerminalTaskStatus(task.status)) return;

    // 通知处理是服务器那一侧推过来的，没有人接得住异常：投不出去（那段已经不在）由端口自己
    // 记一句并返回 false，真报错也只落到日志里
    void port
      .deliver(sessionId, {
        server: name,
        taskId: task.taskId,
        status: task.status,
        ...(task.statusMessage === undefined ? {} : { statusMessage: task.statusMessage }),
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `[McpConnectionManager] 投递任务通知失败 "${name}/${task.taskId}"：${String(error)}`,
        );
      });
  }

  /** 丢掉一台服务器上所有任务的对应关系（断开与断线共用） */
  private forgetTasks(name: string): void {
    const prefix = `${name}\u0000`;
    for (const key of [...this.taskSessions.keys()]) {
      if (key.startsWith(prefix)) this.taskSessions.delete(key);
    }
    for (const key of [...this.earlyStatuses.keys()]) {
      if (key.startsWith(prefix)) this.earlyStatuses.delete(key);
    }
  }

  /**
   * 根据配置创建对应的 Transport 实例。
   * 如果设置了自定义工厂（测试用），则使用自定义工厂。
   */
  private createTransport(config: McpServerConfig): Transport {
    if (this._transportFactory) {
      return this._transportFactory(config);
    }

    if (config.transport === "stdio") {
      if (!config.command) {
        throw new Error(`MCP stdio server is missing command`);
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });
    }

    // http 使用 Streamable HTTP 传输（POST + 可选 SSE 流）
    if (config.transport === "http") {
      if (!config.url) {
        throw new Error(`MCP http server is missing url`);
      }
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }

    // sse 使用旧版 HTTP+SSE 传输（GET 建立 SSE 流，POST 发送消息）
    if (config.transport === "sse") {
      if (!config.url) {
        throw new Error(`MCP sse server is missing url`);
      }
      return new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }

    throw new Error(`Unsupported MCP transport type: ${(config as any).transport}`);
  }

  // ---- 断开 ----

  /**
   * 断开**单个** server（不影响别的 server）。
   *
   * 状态与清单一起失效：断开之后 `getState()` 回到 `disconnected`、`getManifest()` 为空，
   * 下一次 `connect()` 会按新的定义重新建链（懒连）。
   */
  async disconnect(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry || entry.state === "disconnected") return;

    entry.cancelled = true;

    this.clearTimeout(name);
    // 连接没了就收不到状态通知了：这台服务器上还没到终态的任务不再欠谁一条回报
    this.forgetTasks(name);

    // 断开失败也清理状态。注意保留 `cancelled`：建连中的 await 回来后要据此放弃写入。
    await this.closeQuietly(entry.client, entry.transport);

    this.servers.set(name, {
      ...entry,
      state: "disconnected",
      client: undefined,
      transport: undefined,
      manifest: undefined,
      pendingPromise: undefined,
      timeoutTimer: undefined,
    });
  }

  async disconnectAll(): Promise<void> {
    const names = Array.from(this.servers.keys());
    await Promise.all(names.map((n) => this.disconnect(n)));
  }

  // ---- 活跃心跳 ----

  touch(name: string): void {
    const entry = this.servers.get(name);
    if (!entry || entry.state !== "connected" || !entry.timeoutMs) return;
    this.clearTimeout(name);
    entry.timeoutTimer = this.scheduleTimeout(name, entry.timeoutMs);
  }

  // ---- 内部 ----

  private scheduleTimeout(
    name: string,
    timeoutMs: number,
  ): ReturnType<typeof setTimeout> | undefined {
    if (timeoutMs <= 0) return undefined;
    const timer = setTimeout(() => {
      this.disconnect(name);
    }, timeoutMs);
    timer.unref();
    return timer;
  }

  private clearTimeout(name: string): void {
    const entry = this.servers.get(name);
    if (entry?.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = undefined;
    }
  }

  private throwNotConnected(name: string): never {
    throw new Error(`MCP server "${name}" is not connected`);
  }
}
