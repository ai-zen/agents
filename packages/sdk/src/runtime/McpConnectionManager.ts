import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig, McpServerManifest, McpConnectionState } from "../types/index.js";

// ---------------------------------------------------------------------------
// McpConnectionManager
//
// 基于官方 @modelcontextprotocol/sdk 的 Client + Transport 实现。
// 管理 MCP 服务器的完整连接生命周期：
//   - stdio: 使用 StdioClientTransport（子进程 spawn）
//   - http:  使用 StreamableHTTPClientTransport（HTTP POST + SSE）
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

export interface McpConnectOptions {
  /** 空闲超时（毫秒），默认 stdio: 30min, http: 5min */
  idleTimeoutMs?: number;
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

    const timeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT[config.transport] ?? 5 * 60 * 1000;
    const pendingPromise = this.connectWithRetry(name, config, options, 0);

    this.servers.set(name, {
      state: "connecting",
      pendingPromise,
      timeoutMs,
      cancelled: false,
    });

    try {
      await pendingPromise;
      const entry = this.servers.get(name)!;
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
      : new Client(
          { name: "ai-zen-agents", version: "0.1.0" },
          { capabilities: {} },
        );

    await client.connect(transport);

    // 根据 Server 声明的 capabilities 按需调用，避免调用未声明的方法
    const serverCaps = client.getServerCapabilities();

    const manifest: McpServerManifest = {
      tools: [],
      resources: [],
      prompts: [],
    };

    if (serverCaps?.tools) {
      const toolsResult = await client.listTools();
      manifest.tools = (toolsResult.tools ?? []).map((t: any) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    }

    if (serverCaps?.resources) {
      const resourcesResult = await client.listResources();
      manifest.resources = (resourcesResult.resources ?? []).map((r: any) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    }

    if (serverCaps?.prompts) {
      const promptsResult = await client.listPrompts();
      manifest.prompts = (promptsResult.prompts ?? []).map((p: any) => ({
        name: p.name,
        description: p.description,
      }));
    }

    const entry = this.servers.get(name) ?? { state: "connecting" as const };
    this.servers.set(name, {
      ...entry,
      state: "connected",
      client,
      transport,
      manifest,
      cancelled: false,
    });
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
        throw new Error(`MCP stdio server 缺少 command`);
      }
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });
    }

    // http 和 sse 都使用 StreamableHTTPClientTransport
    if (config.transport === "http" || config.transport === "sse") {
      if (!config.url) {
        throw new Error(`MCP ${config.transport} server 缺少 url`);
      }
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    }

    throw new Error(`不支持的 MCP transport 类型: ${(config as any).transport}`);
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

    try {
      await entry.client?.close();
      await entry.transport?.close();
    } catch {
      // 断开失败也清理状态
    }

    this.servers.set(name, { state: "disconnected" });
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

  private scheduleTimeout(name: string, timeoutMs: number): ReturnType<typeof setTimeout> | undefined {
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
