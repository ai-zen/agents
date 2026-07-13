import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpConnectionManager } from "./mcp-connection";
import type { McpServerConfig, McpTransport, McpServerManifest } from "../types";

function mockTransport(): McpTransport {
  return {
    connect: vi.fn().mockResolvedValue({
      tools: [{ name: "test-tool", description: "a tool", inputSchema: { type: "object" } }],
      resources: [],
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

const stdioConfig: McpServerConfig = {
  transport: "stdio",
  command: "node",
  args: ["server.js"],
};

describe("McpConnectionManager", () => {
  let manager: McpConnectionManager;

  beforeEach(() => {
    manager = new McpConnectionManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- 状态机 ----

  it("初始状态 disconnected", () => {
    expect(manager.getState("github")).toBe("disconnected");
  });

  it("connect → connecting → connected", async () => {
    const transport = mockTransport();
    const promise = manager.connect("github", stdioConfig, transport);

    expect(manager.getState("github")).toBe("connecting");

    await promise;
    expect(manager.getState("github")).toBe("connected");
  });

  it("connect 失败 → error", async () => {
    const transport = mockTransport();
    (transport.connect as any).mockRejectedValue(new Error("connection refused"));

    await expect(manager.connect("github", stdioConfig, transport)).rejects.toThrow("connection refused");
    expect(manager.getState("github")).toBe("error");
  });

  it("disconnect → disconnected", async () => {
    const transport = mockTransport();
    await manager.connect("github", stdioConfig, transport);

    await manager.disconnect("github");
    expect(manager.getState("github")).toBe("disconnected");
  });

  it("重复 connect 已连接的 server 直接返回清单", async () => {
    const transport = mockTransport();
    await manager.connect("github", stdioConfig, transport);

    // 第二次 connect 不应该调用 transport.connect
    const manifest = await manager.connect("github", stdioConfig, transport);
    expect(manifest.tools).toHaveLength(1);
    expect(transport.connect).toHaveBeenCalledTimes(1);
  });

  it("重复 connect 正在连接中的 server 复用同一 promise", async () => {
    const transport = mockTransport();
    // 同时发起两次连接
    const [r1, r2] = await Promise.all([
      manager.connect("github", stdioConfig, transport),
      manager.connect("github", stdioConfig, transport),
    ]);
    expect(r1).toBe(r2);
    expect(transport.connect).toHaveBeenCalledTimes(1);
  });

  // ---- 空闲超时 ----

  it("空闲超时后自动断开", async () => {
    const transport = mockTransport();
    await manager.connect("github", stdioConfig, transport, { idleTimeoutMs: 1000 });

    // 推进时间超过超时
    await vi.advanceTimersByTimeAsync(1500);

    expect(manager.getState("github")).toBe("disconnected");
    expect(transport.disconnect).toHaveBeenCalled();
  });

  it("活跃操作重置超时计时器", async () => {
    const transport = mockTransport();
    await manager.connect("github", stdioConfig, transport, { idleTimeoutMs: 1000 });

    // 500ms 时触发活跃
    await vi.advanceTimersByTimeAsync(500);
    manager.touch("github");

    // 再过 800ms（总计 1300ms，但距上次 touch 仅 800ms）
    await vi.advanceTimersByTimeAsync(800);
    expect(manager.getState("github")).toBe("connected");

    // 再过 400ms（距上次 touch 1200ms > 1000ms）
    await vi.advanceTimersByTimeAsync(400);
    expect(manager.getState("github")).toBe("disconnected");
  });

  // ---- 重连 ----

  it("connect 错误状态后可以重试 connect", async () => {
    const transport = mockTransport();
    (transport.connect as any).mockRejectedValueOnce(new Error("fail"));

    await expect(manager.connect("github", stdioConfig, transport)).rejects.toThrow();
    expect(manager.getState("github")).toBe("error");

    // 重试成功
    (transport.connect as any).mockResolvedValueOnce({
      tools: [],
      resources: [],
    });
    await manager.connect("github", stdioConfig, transport);
    expect(manager.getState("github")).toBe("connected");
  });

  // ---- 断开未连接的 server ----

  it("disconnect 未连接的 server 无操作", async () => {
    await expect(manager.disconnect("nonexistent")).resolves.toBeUndefined();
  });

  // ---- 多 server 独立管理 ----

  it("多个 server 状态独立", async () => {
    const t1 = mockTransport();
    const t2 = mockTransport();

    await manager.connect("github", stdioConfig, t1);
    expect(manager.getState("github")).toBe("connected");
    expect(manager.getState("slack")).toBe("disconnected");

    await manager.connect("slack", { transport: "http", url: "https://slack.example.com" }, t2);
    expect(manager.getState("github")).toBe("connected");
    expect(manager.getState("slack")).toBe("connected");

    await manager.disconnect("github");
    expect(manager.getState("github")).toBe("disconnected");
    expect(manager.getState("slack")).toBe("connected");
  });

  // ---- 自动重连（指数退避）----

  it("connect 失败后自动重试（指数退避）", async () => {
    const transport = mockTransport();
    (transport.connect as any)
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ tools: [], resources: [] });

    const promise = manager.connect("github", stdioConfig, transport, {
      autoReconnect: true,
      maxRetries: 5,
    });

    // 第 1 次重试：1s 后
    await vi.advanceTimersByTimeAsync(1000);
    // 第 2 次重试：2s 后
    await vi.advanceTimersByTimeAsync(2000);

    const manifest = await promise;
    expect(manifest).toBeDefined();
    expect(manager.getState("github")).toBe("connected");
    expect(transport.connect).toHaveBeenCalledTimes(3);
  });

  it("超过最大重试次数后进入 error", async () => {
    const transport = mockTransport();
    // initial + 2 retries = 3 次失败
    (transport.connect as any)
      .mockRejectedValueOnce(new Error("always fail"))
      .mockRejectedValueOnce(new Error("always fail"))
      .mockRejectedValueOnce(new Error("always fail"));

    const promise = manager.connect("github", stdioConfig, transport, {
      autoReconnect: true,
      maxRetries: 2,
    });

    // 预装 catch 避免 unhandled rejection 警告
    promise.catch(() => {});

    // 第 1 次重试：1s
    await vi.advanceTimersByTimeAsync(1000);
    // 第 2 次重试：2s
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).rejects.toThrow("always fail");
    expect(manager.getState("github")).toBe("error");
    expect(transport.connect).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("配置错误不重试", async () => {
    const transport = mockTransport();
    const configError = Object.assign(new Error("invalid transport"), { code: "CONFIG_ERROR" });
    (transport.connect as any).mockRejectedValue(configError);

    const promise = manager.connect("github", stdioConfig, transport, {
      autoReconnect: true,
      isConfigError: (err) => (err as any).code === "CONFIG_ERROR",
    });

    await expect(promise).rejects.toThrow("invalid transport");
    expect(transport.connect).toHaveBeenCalledTimes(1); // 不重试
    expect(manager.getState("github")).toBe("error");
  });

  it("手动 disconnect 取消进行中的重连", async () => {
    const transport = mockTransport();
    (transport.connect as any).mockRejectedValueOnce(new Error("fail"));

    const promise = manager.connect("github", stdioConfig, transport, {
      autoReconnect: true,
      maxRetries: 5,
    });
    promise.catch(() => {});

    // 推进 500ms 后手动断开
    await vi.advanceTimersByTimeAsync(500);
    await manager.disconnect("github");

    // 重连应被取消，promise 应 reject
    await expect(promise).rejects.toThrow();
    expect(manager.getState("github")).toBe("disconnected");
  });
});
