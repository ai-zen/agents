import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpConnectionManager } from "./McpConnectionManager.js";
import type { McpServerConfig } from "../types/index.js";

// 纯 mock 对象，不涉及 vi.mock
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({
    tools: [{ name: "test-tool", description: "a tool", inputSchema: { type: "object", properties: {} } }],
  }),
  listResources: vi.fn().mockResolvedValue({ resources: [] }),
  listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
  callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
};

const mockTransport = {
  start: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
};

const stdioConfig: McpServerConfig = {
  id: "test-stdio",
  name: "Test Stdio",
  transport: "stdio",
  command: "node",
  args: ["server.js"],
};

const httpConfig: McpServerConfig = {
  id: "test-http",
  name: "Test HTTP",
  transport: "http",
  url: "https://mcp.example.com",
};

describe("McpConnectionManager", () => {
  let manager: McpConnectionManager;

  beforeEach(() => {
    vi.clearAllMocks();

    // 通过自定义 transport 工厂 + 自定义 Client 工厂来注入 mock
    // McpConnectionManager 现在支持可选的 transportFactory 和 clientFactory
    manager = new McpConnectionManager(
      // transportFactory
      () => mockTransport as any,
      // clientFactory
      () => mockClient as any,
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.close.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({
      tools: [{ name: "test-tool", description: "a tool", inputSchema: { type: "object", properties: {} } }],
    });
    mockClient.listResources.mockResolvedValue({ resources: [] });
    mockClient.listPrompts.mockResolvedValue({ prompts: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- 状态机 ----

  it("初始状态 disconnected", () => {
    expect(manager.getState("github")).toBe("disconnected");
  });

  it("connect → connected", async () => {
    const promise = manager.connect("github", stdioConfig);

    expect(manager.getState("github")).toBe("connecting");

    const manifest = await promise;
    expect(manager.getState("github")).toBe("connected");
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0].name).toBe("test-tool");
  });

  it("connect 失败 → error", async () => {
    mockClient.connect.mockRejectedValueOnce(new Error("connection refused"));

    await expect(manager.connect("github", stdioConfig)).rejects.toThrow("connection refused");
    expect(manager.getState("github")).toBe("error");
  });

  it("disconnect → disconnected", async () => {
    await manager.connect("github", stdioConfig);

    await manager.disconnect("github");
    expect(manager.getState("github")).toBe("disconnected");
  });

  it("重复 connect 已连接的 server 直接返回清单", async () => {
    await manager.connect("github", stdioConfig);

    const manifest = await manager.connect("github", stdioConfig);
    expect(manifest.tools).toHaveLength(1);
  });

  it("重复 connect 正在连接中的 server 复用同一 promise", async () => {
    const [r1, r2] = await Promise.all([
      manager.connect("github", stdioConfig),
      manager.connect("github", stdioConfig),
    ]);
    expect(r1).toBe(r2);
  });

  it("stdio 缺少 command 时抛出错误", async () => {
    // 使用默认构造（无 factory）来测试校验逻辑，因为 mock 工厂会绕过校验
    const rawManager = new McpConnectionManager();
    const badConfig: McpServerConfig = { id: "bad", name: "Bad", transport: "stdio" };
    await expect(rawManager.connect("bad", badConfig)).rejects.toThrow("缺少 command");
  });

  it("http 缺少 url 时抛出错误", async () => {
    const rawManager = new McpConnectionManager();
    const badConfig: McpServerConfig = { id: "bad", name: "Bad", transport: "http" };
    await expect(rawManager.connect("bad", badConfig)).rejects.toThrow("缺少 url");
  });

  it("sse 缺少 url 时抛出错误", async () => {
    const rawManager = new McpConnectionManager();
    const badConfig: McpServerConfig = { id: "bad", transport: "sse" };
    await expect(rawManager.connect("bad", badConfig)).rejects.toThrow("缺少 url");
  });

  it("不支持的 transport 类型时抛出错误", async () => {
    const rawManager = new McpConnectionManager();
    const badConfig = { transport: "websocket" } as any;
    await expect(rawManager.connect("bad", badConfig)).rejects.toThrow("不支持");
  });

  // ---- 获取 Client ----

  it("getClient 返回已连接的 Client", async () => {
    await manager.connect("github", stdioConfig);
    const client = manager.getClient("github");
    expect(client).toBeDefined();
  });

  it("getClient 返回未连接 server 的 undefined", () => {
    expect(manager.getClient("nonexistent")).toBeUndefined();
  });

  // ---- 空闲超时 ----

  it("空闲超时后自动断开", async () => {
    await manager.connect("github", stdioConfig, { idleTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(manager.getState("github")).toBe("disconnected");
  });

  it("活跃操作重置超时计时器", async () => {
    await manager.connect("github", stdioConfig, { idleTimeoutMs: 1000 });

    await vi.advanceTimersByTimeAsync(500);
    manager.touch("github");

    await vi.advanceTimersByTimeAsync(800);
    expect(manager.getState("github")).toBe("connected");

    await vi.advanceTimersByTimeAsync(400);
    expect(manager.getState("github")).toBe("disconnected");
  });

  // ---- 错误状态恢复 ----

  it("connect 错误状态后可以重试 connect", async () => {
    mockClient.connect.mockRejectedValueOnce(new Error("fail"));

    await expect(manager.connect("github", stdioConfig)).rejects.toThrow();
    expect(manager.getState("github")).toBe("error");

    mockClient.connect.mockResolvedValueOnce(undefined);
    await manager.connect("github", stdioConfig);
    expect(manager.getState("github")).toBe("connected");
  });

  // ---- 断开未连接的 server ----

  it("disconnect 未连接的 server 无操作", async () => {
    await expect(manager.disconnect("nonexistent")).resolves.toBeUndefined();
  });

  // ---- disconnectAll ----

  it("disconnectAll 断开所有连接", async () => {
    await manager.connect("github", stdioConfig);
    await manager.connect("slack", httpConfig);

    await manager.disconnectAll();
    expect(manager.getState("github")).toBe("disconnected");
    expect(manager.getState("slack")).toBe("disconnected");
  });

  // ---- 多 server 独立管理 ----

  it("多个 server 状态独立", async () => {
    await manager.connect("github", stdioConfig);
    expect(manager.getState("github")).toBe("connected");
    expect(manager.getState("slack")).toBe("disconnected");

    await manager.connect("slack", { id: "slack", name: "Slack", transport: "http", url: "https://slack.example.com" });
    expect(manager.getState("github")).toBe("connected");
    expect(manager.getState("slack")).toBe("connected");

    await manager.disconnect("github");
    expect(manager.getState("github")).toBe("disconnected");
    expect(manager.getState("slack")).toBe("connected");
  });

  // ---- 自动重连 ----

  it("connect 失败后自动重试（指数退避）", async () => {
    mockClient.connect
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);

    const promise = manager.connect("github", stdioConfig, {
      autoReconnect: true,
      maxRetries: 5,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const manifest = await promise;
    expect(manifest).toBeDefined();
    expect(manager.getState("github")).toBe("connected");
  });

  it("超过最大重试次数后进入 error", async () => {
    mockClient.connect
      .mockRejectedValueOnce(new Error("always fail"))
      .mockRejectedValueOnce(new Error("always fail"))
      .mockRejectedValueOnce(new Error("always fail"));

    const promise = manager.connect("github", stdioConfig, {
      autoReconnect: true,
      maxRetries: 2,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).rejects.toThrow("always fail");
    expect(manager.getState("github")).toBe("error");
  });

  it("配置错误不重试", async () => {
    const configError = Object.assign(new Error("invalid transport"), { code: "CONFIG_ERROR" });
    mockClient.connect.mockRejectedValue(configError);

    const promise = manager.connect("github", stdioConfig, {
      autoReconnect: true,
      isConfigError: (err: any) => err.code === "CONFIG_ERROR",
    });

    await expect(promise).rejects.toThrow("invalid transport");
    expect(manager.getState("github")).toBe("error");
  });

  it("手动 disconnect 取消进行中的重连", async () => {
    mockClient.connect.mockRejectedValueOnce(new Error("fail"));

    const promise = manager.connect("github", stdioConfig, {
      autoReconnect: true,
      maxRetries: 5,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(500);
    await manager.disconnect("github");

    await expect(promise).rejects.toThrow();
    expect(manager.getState("github")).toBe("disconnected");
  });
});
