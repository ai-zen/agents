import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getLogger } from "../../../shared/logger.js";
import type {
  McpServerConfig,
  McpServerManifest,
  McpConnectionState,
} from "../../../types/index.js";

// ---------------------------------------------------------------------------
// McpConnectionManager
//
// 基于官方 @modelcontextprotocol/sdk 的 Client + Transport 实现。
// 管理 MCP 服务器的完整连接生命周期：
//   - stdio: 使用 StdioClientTransport（子进程 spawn）
//   - http:  使用 StreamableHTTPClientTransport（Streamable HTTP：POST + 可选 SSE 流）
//   - sse:   使用 SSEClientTransport（旧版 HTTP+SSE：GET 建立 SSE 流 + POST 发送消息）
//   - 重连、退避、空闲超时、状态机
// ---------------------------------------------------------------------------

interface ConnectionEntry {
  state: McpConnectionState;
  client?: Client;
  transport?: Transport;
  manifest?: McpServerManifest;
  pendingPromise?: Promise<void>;
  timeoutMs?: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  cancelled?: boolean;
  cancelRetryWait?: (err: Error) => void;
}

/**
 * 建连超时缺省值（毫秒）。
 *
 * 没有上限时，配置错误的 SSE / HTTP 端点会让 `load_mcp` 永久挂起（SSE 在服务端不发
 * 响应头时尤其如此，fetch 只对建链有兜底，对"连上了但永不回话"没有）。与请求超时同口径。
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

export interface McpConnectOptions {
  /** 空闲超时（毫秒），默认 stdio: 30min, http/sse: 5min */
  idleTimeoutMs?: number;
  /** 建连超时（毫秒），默认 60s；超时即断开并抛错，避免工具永久挂起 */
  connectTimeoutMs?: number;
  /** 失败时自动重连 */
  autoReconnect?: boolean;
  /** 最大重试次数，默认 3 */
  maxRetries?: number;
  /** 判断是否为配置错误（不重试），默认全部重试 */
  isConfigError?: (err: unknown) => boolean;
}

const DEFAULT_IDLE_TIMEOUT: Record<string, number> = {
  stdio: 30 * 60 * 1000,
  http: 5 * 60 * 1000,
  sse: 5 * 60 * 1000,
};

/** 指数退避: 1s → 2s → 4s → 8s → 16s → 30s（封顶） */
function backoff(attempt: number): number {
  const ms = Math.min(1000 * Math.pow(2, attempt), 30_000);
  return ms;
}

export class McpConnectionManager {
  private servers = new Map<string, ConnectionEntry>();
  /** 可替换的 transport 工厂，用于测试注入 */
  private _transportFactory?: (config: McpServerConfig) => Transport;
  /** 可替换的 Client 工厂，用于测试注入 */
  private _clientFactory?: () => Client;

  /**
   * @param transportFactory 可选的自定义 transport 工厂（用于测试注入）
   * @param clientFactory 可选的自定义 Client 工厂（用于测试注入）
   */
  constructor(
    transportFactory?: (config: McpServerConfig) => Transport,
    clientFactory?: () => Client,
  ) {
    this._transportFactory = transportFactory;
    this._clientFactory = clientFactory;
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
    const pendingPromise = this.connectWithRetry(name, config, options, 0);

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
        // 取消挂着的建连，并清掉它可能建好的资源
        await this.disconnect(name).catch(() => {});
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async connectWithRetry(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions,
    attempt: number,
  ): Promise<void> {
    try {
      await this.doConnect(name, config);
    } catch (err) {
      const entry = this.servers.get(name);
      if (entry?.cancelled) throw err;
      if (options.isConfigError?.(err)) throw err;
      if (!options.autoReconnect) throw err;

      const maxRetries = options.maxRetries ?? 3;
      if (attempt >= maxRetries) throw err;

      const delay = backoff(attempt);
      await new Promise<void>((resolve, reject) => {
        const current = this.servers.get(name);
        if (current) current.cancelRetryWait = reject;

        const timer = setTimeout(() => {
          const current2 = this.servers.get(name);
          if (current2) current2.cancelRetryWait = undefined;
          if (current2?.cancelled) {
            reject(new Error(`Connection to "${name}" was cancelled`));
          } else {
            resolve();
          }
        }, delay);

        const current3 = this.servers.get(name);
        if (current3) current3.retryTimer = timer;
      });

      const recheck = this.servers.get(name);
      if (recheck?.cancelled) throw new Error(`Connection to "${name}" was cancelled`);
      return this.connectWithRetry(name, config, options, attempt + 1);
    }
  }

  private async doConnect(name: string, config: McpServerConfig): Promise<void> {
    const transport = this.createTransport(config);
    const client = this._clientFactory
      ? this._clientFactory()
      : new Client({ name: "ai-zen-agents", version: "0.1.0" }, { capabilities: {} });

    await client.connect(transport);

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
        }));
      } catch (err: unknown) {
        getLogger().error(
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
        getLogger().error(
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
        getLogger().error(
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

    // 断线检测：运行期 transport 关掉时把状态标回 disconnected，避免 load_mcp / 状态栏
    // 一直展示过期清单（不做自动重连：重连策略属于上层）。
    const prevOnClose = transport.onclose;
    transport.onclose = () => {
      prevOnClose?.();
      this.markDisconnected(name);
    };
    const prevOnError = transport.onerror;
    transport.onerror = (error: Error) => {
      prevOnError?.(error);
      getLogger().error(
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

  /** 静默关闭连接资源（断开/取消路径共用） */
  private async closeQuietly(client?: Client, transport?: Transport): Promise<void> {
    try {
      await client?.close();
    } catch {}
    try {
      await transport?.close();
    } catch {}
  }

  /** 运行期断线：标记 disconnected 并记日志（已在连接状态才处理，避免重复日志） */
  private markDisconnected(name: string): void {
    const entry = this.servers.get(name);
    if (!entry || entry.state !== "connected") return;
    getLogger().error(`[McpConnectionManager] MCP server "${name}" disconnected`);
    this.clearTimeout(name);
    this.servers.set(name, { state: "disconnected" });
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

  async disconnect(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry || entry.state === "disconnected") return;

    entry.cancelled = true;

    if (entry.cancelRetryWait) {
      entry.cancelRetryWait(new Error(`Connection to "${name}" was cancelled`));
      entry.cancelRetryWait = undefined;
    }

    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
    }

    this.clearTimeout(name);

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
      retryTimer: undefined,
      cancelRetryWait: undefined,
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
