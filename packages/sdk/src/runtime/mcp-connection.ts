import type { McpServerConfig, McpTransport, McpServerManifest, McpConnectionState } from "../types";

interface ConnectionEntry {
  state: McpConnectionState;
  manifest?: McpServerManifest;
  transport?: McpTransport;
  pendingPromise?: Promise<McpServerManifest>;
  timeoutMs?: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  cancelled?: boolean;
  /** 拒绝当前重试等待 promise */
  cancelRetryWait?: (err: Error) => void;
}

export interface McpConnectOptions {
  /** 空闲超时（毫秒），默认 stdio: 30min, http: 5min */
  idleTimeoutMs?: number;
  /** 失败时自动重连 */
  autoReconnect?: boolean;
  /** 最大重试次数，默认 5 */
  maxRetries?: number;
  /** 判断是否为配置错误（不重试），默认全部重试 */
  isConfigError?: (err: unknown) => boolean;
}

const DEFAULT_IDLE_TIMEOUT: Record<string, number> = {
  stdio: 30 * 60 * 1000,
  http: 5 * 60 * 1000,
};

/** 指数退避: 1s → 2s → 4s → 8s → 16s → 30s（封顶） */
function backoff(attempt: number): number {
  const ms = Math.min(1000 * Math.pow(2, attempt), 30_000);
  return ms;
}

export class McpConnectionManager {
  private servers = new Map<string, ConnectionEntry>();

  // ---- 查询 ----

  getState(name: string): McpConnectionState {
    return this.servers.get(name)?.state ?? "disconnected";
  }

  getManifest(name: string): McpServerManifest | undefined {
    return this.servers.get(name)?.manifest;
  }

  // ---- 连接 ----

  async connect(
    name: string,
    config: McpServerConfig,
    transport: McpTransport,
    options: McpConnectOptions = {},
  ): Promise<McpServerManifest> {
    const existing = this.servers.get(name);

    // 已连接 → 直接返回
    if (existing?.state === "connected" && existing.manifest) {
      this.touch(name);
      return existing.manifest;
    }

    // 正在连接 → 复用 pending promise
    if (existing?.state === "connecting" && existing.pendingPromise) {
      return existing.pendingPromise;
    }

    // 开始连接
    const timeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT[config.transport] ?? 5 * 60 * 1000;
    const pendingPromise = this.connectWithRetry(name, config, transport, options, 0);

    this.servers.set(name, {
      state: "connecting",
      transport,
      pendingPromise,
      timeoutMs,
      cancelled: false,
    });

    try {
      const manifest = await pendingPromise;
      this.servers.set(name, {
        state: "connected",
        manifest,
        transport,
        timeoutMs,
        timeoutTimer: this.scheduleTimeout(name, timeoutMs),
      });
      return manifest;
    } catch (err) {
      const entry = this.servers.get(name);
      // 已被 disconnect 清理过 → 保持 disconnected
      if (entry?.cancelled || entry?.state === "disconnected") {
        this.servers.set(name, { state: "disconnected" });
      } else {
        this.servers.set(name, {
          state: "error",
          transport,
          timeoutMs,
        });
      }
      throw err;
    }
  }

  private async connectWithRetry(
    name: string,
    config: McpServerConfig,
    transport: McpTransport,
    options: McpConnectOptions,
    attempt: number,
  ): Promise<McpServerManifest> {
    try {
      return await transport.connect(config);
    } catch (err) {
      const entry = this.servers.get(name);

      // 已取消 → 直接抛
      if (entry?.cancelled) {
        throw err;
      }

      // 配置错误不重试
      if (options.isConfigError?.(err)) {
        throw err;
      }

      // 不启用自动重连 → 直接抛
      if (!options.autoReconnect) {
        throw err;
      }

      const maxRetries = options.maxRetries ?? 5;
      if (attempt >= maxRetries) {
        throw err;
      }

      // 等待退避时间后重试
      const delay = backoff(attempt);
      await new Promise<void>((resolve, reject) => {
        const current = this.servers.get(name);
        if (current) {
          current.cancelRetryWait = reject;
        }

        const timer = setTimeout(() => {
          const current2 = this.servers.get(name);
          if (current2) {
            current2.cancelRetryWait = undefined;
          }
          if (current2?.cancelled) {
            reject(new Error(`Connection to "${name}" was cancelled`));
          } else {
            resolve();
          }
        }, delay);

        const current3 = this.servers.get(name);
        if (current3) {
          current3.retryTimer = timer;
        }
      });

      // 再次检查取消
      const recheck = this.servers.get(name);
      if (recheck?.cancelled) {
        throw new Error(`Connection to "${name}" was cancelled`);
      }

      return this.connectWithRetry(name, config, transport, options, attempt + 1);
    }
  }

  // ---- 断开 ----

  async disconnect(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry || entry.state === "disconnected") return;

    // 标记取消，中断进行中的重连
    entry.cancelled = true;

    // 拒绝正在等待重试的 promise
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
      await entry.transport?.disconnect();
    } catch {
      // 断开失败也清理状态
    }

    this.servers.set(name, { state: "disconnected" });
  }

  // ---- 活跃心跳 ----

  /** 标记 server 为活跃，重置空闲计时器 */
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
}
