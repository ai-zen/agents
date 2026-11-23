import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SILENT_LOG, type LogSink } from "../../../shared/logger.js";
import type {
  McpServerDefinition,
  McpServerManifest,
  McpConnectionState,
} from "../../../types/index.js";
import { McpTaskBridge } from "./mcpTaskBridge.js";
import type { McpTaskNoticePort } from "./mcpTaskNotice.js";

// ---------------------------------------------------------------------------
// McpConnectionManager
//
// 基于官方 @modelcontextprotocol/client 的 Client + Transport 实现。
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
  /** 一台服务器一个：任务的分岔与之后的结果、取消都走它 */
  taskBridge?: McpTaskBridge;
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
  private _transportFactory?: (config: McpServerDefinition) => Transport;
  /** 可替换的 Client 工厂，用于测试注入 */
  private _clientFactory?: () => Client;
  /** 日志口（构造时定下缺省：不注入就什么都不写） */
  private readonly logger: LogSink;
  /** 任务通知的投递口（宿主实现）；不注入就没有人接得住任务终态 */
  private readonly _taskNotice?: McpTaskNoticePort;

  /**
   * @param transportFactory 可选的自定义 transport 工厂（用于测试注入）
   * @param clientFactory 可选的自定义 Client 工厂（用于测试注入）
   * @param logger 日志口（可选）：建连失败、清单没拉到、断线、关不掉从这里报；缺省不记
   * @param taskNotice 任务通知的投递口（可选）：不给就没有地方投，任务终态只当没收到
   */
  constructor(
    transportFactory?: (config: McpServerDefinition) => Transport,
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

  /** 这台服务器上的任务会话；没连上就没有 */
  getTaskBridge(name: string): McpTaskBridge | undefined {
    return this.servers.get(name)?.taskBridge;
  }

  // ---- 连接 ----

  async connect(
    name: string,
    config: McpServerDefinition,
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

  private async doConnect(name: string, config: McpServerDefinition): Promise<void> {
    const transport = this.createTransport(config);
    const client = this._clientFactory
      ? this._clientFactory()
      : new Client({ name: "ai-zen-agents", version: "0.1.0" });

    await client.connect(transport);

    // 任务的分岔口：之后 `call_mcp_tool` 每一次调用都走它（当场结果与任务句柄都从它那里出去）
    const taskBridge = new McpTaskBridge(client, name, this._taskNotice, this.logger);

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
          // 这一格决定这次调用要不要提议成任务（见 `McpTaskBridge`）
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
      await taskBridge.close().catch(() => undefined);
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
      taskBridge,
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
    this.servers.set(name, { state: "disconnected" });
  }

  /**
   * 根据配置创建对应的 Transport 实例。
   * 如果设置了自定义工厂（测试用），则使用自定义工厂。
   */
  private createTransport(config: McpServerDefinition): Transport {
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

    // 断开失败也清理状态。注意保留 `cancelled`：建连中的 await 回来后要据此放弃写入。
    // 任务会话先关：它持着这台 client 的回调槽，client 关了再关会报错。
    await entry.taskBridge?.close().catch((error: unknown) => {
      this.logger.warn(`[McpConnectionManager] 关闭 "${name}" 的任务会话失败：${String(error)}`);
    });
    await this.closeQuietly(entry.client, entry.transport);

    this.servers.set(name, {
      ...entry,
      state: "disconnected",
      client: undefined,
      transport: undefined,
      taskBridge: undefined,
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
