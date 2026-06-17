import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  startAllMcpServers,
  stopAllMcpServers,
  reloadAllMcpServers,
  setCreateStdioTransport,
  getCreateStdioTransport,
} from "./mcp-manager.js";

// ==================== Mock 配置 ====================

const mockServers: any[] = [];

vi.mock("./config.js", () => ({
  readConfig: vi.fn(() => ({
    mcpServers: mockServers,
  })),
}));

// ==================== Mock MCP SDK ====================

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  function MockClient(this: any) {
    this.connect = mockConnect;
    this.listTools = mockListTools;
    this.callTool = mockCallTool;
    this.close = mockClose;
  }
  return { Client: vi.fn().mockImplementation(function(this: any) {
    return new MockClient();
  }) };
});

// ==================== beforeEach ====================

beforeEach(async () => {
  mockServers.length = 0;
  // 清理上轮测试遗留的 MCP 连接
  await stopAllMcpServers();

  // 手动重置 mock 行为（不用 vi.clearAllMocks()，因为会清掉 setCreateStdioTransport 设置的工厂）
  mockConnect.mockReset();
  mockListTools.mockReset();
  mockCallTool.mockReset();
  mockClose.mockReset();

  // 替换 transport 工厂，避免真实的 StdioClientTransport 构造函数
  setCreateStdioTransport(vi.fn(() => ({
    start: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  })));

  // 默认 mock
  mockConnect.mockResolvedValue(undefined);
  mockListTools.mockResolvedValue({
    tools: [
      {
        name: "echo",
        description: "回显输入内容",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ],
  });
  mockCallTool.mockResolvedValue({
    content: [{ type: "text", text: "你说了: hello" }],
  });
  mockClose.mockResolvedValue(undefined);
});

// ==================== 测试用例 ====================

describe("startAllMcpServers", () => {
  it("没有配置 MCP 服务器时返回空数组", async () => {
    const tools = await startAllMcpServers();
    expect(tools).toEqual([]);
  });

  it("跳过已禁用的服务器", async () => {
    mockServers.push(
      { id: "d", name: "禁用", transport: "stdio", command: "node", args: ["bad.js"], enabled: false },
      { id: "e", name: "启用", transport: "stdio", command: "node", args: ["good.js"], enabled: true },
    );

    const tools = await startAllMcpServers();
    expect(tools.length).toBe(1);
    expect(tools[0].function.name).toBe("echo");
  });

  it("连接失败的服务器不影响其他服务器", async () => {
    mockServers.push(
      { id: "b", name: "坏的", transport: "stdio", command: "x", args: [] },
      { id: "g", name: "好的", transport: "stdio", command: "node", args: ["r.js"] },
    );

    mockConnect
      .mockRejectedValueOnce(new Error("连接失败"))
      .mockResolvedValue(undefined);

    const tools = await startAllMcpServers();
    expect(tools.length).toBe(1);
    expect(tools[0].function.name).toBe("echo");
  });

  it("stdio 缺少 command 时被捕获", async () => {
    mockServers.push({ id: "n", name: "无命令", transport: "stdio" } as any);
    const tools = await startAllMcpServers();
    expect(tools).toEqual([]);
  });

  it("SSE 暂未实现", async () => {
    mockServers.push({ id: "s", name: "SSE", transport: "sse", url: "http://localhost:3000/sse" });
    const tools = await startAllMcpServers();
    expect(tools).toEqual([]);
  });

  it("SSE 缺少 url 被捕获", async () => {
    mockServers.push({ id: "su", name: "SSE无URL", transport: "sse" } as any);
    const tools = await startAllMcpServers();
    expect(tools).toEqual([]);
  });

  it("成功连接并返回 CallbackTool", async () => {
    mockServers.push({ id: "srv", name: "服务器", transport: "stdio", command: "node", args: ["s.js"] });

    const tools = await startAllMcpServers();
    expect(tools.length).toBe(1);
    expect(tools[0].function.name).toBe("echo");
    expect(tools[0].function.description).toBe("回显输入内容");
  });

  it("Callback 调用 client.callTool", async () => {
    mockServers.push({ id: "srv", name: "服务器", transport: "stdio", command: "node", args: ["s.js"] });

    const tools = await startAllMcpServers();
    const result = await (tools[0] as any).callback({ message: "hello" });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: "echo",
      arguments: { message: "hello" },
    });
    expect(result).toBe("你说了: hello");
  });

  it("Callback 失败时返回错误信息", async () => {
    mockServers.push({ id: "srv", name: "服务器", transport: "stdio", command: "node", args: ["s.js"] });

    const tools = await startAllMcpServers();
    mockCallTool.mockRejectedValueOnce(new Error("网络错误"));

    const result = await (tools[0] as any).callback({ message: "hello" });
    expect(result).toContain("调用失败");
    expect(result).toContain("网络错误");
  });

  it("非 text 序列化为 JSON", async () => {
    mockServers.push({ id: "srv", name: "服务器", transport: "stdio", command: "node", args: ["s.js"] });

    const tools = await startAllMcpServers();
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: "image", data: "base64...", mimeType: "image/png" }],
    });

    const result = await (tools[0] as any).callback({ message: "hello" });
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].type).toBe("image");
  });

  it("createStdioTransport 被调用时传入正确的参数", async () => {
    mockServers.push({ id: "srv", name: "测试", transport: "stdio", command: "node", args: ["s.js"] });

    await startAllMcpServers();
    const transportFactory = getCreateStdioTransport();
    expect(transportFactory).toHaveBeenCalledWith(
      expect.objectContaining({ id: "srv", command: "node", args: ["s.js"] }),
    );
  });
});

// ==================== stopAllMcpServers ====================

describe("stopAllMcpServers", () => {
  it("断开所有已连接的服务器", async () => {
    mockServers.push({ id: "srv", name: "服务器", transport: "stdio", command: "node", args: ["s.js"] });

    await startAllMcpServers();
    expect(mockClose).not.toHaveBeenCalled();

    await stopAllMcpServers();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("关闭出错不抛出", async () => {
    mockServers.push({ id: "srv", name: "服务器", transport: "stdio", command: "node", args: ["s.js"] });

    await startAllMcpServers();
    mockClose.mockRejectedValueOnce(new Error("关闭失败"));

    await expect(stopAllMcpServers()).resolves.toBeUndefined();
  });

  it("无连接时不报错", async () => {
    await expect(stopAllMcpServers()).resolves.toBeUndefined();
  });
});

// ==================== reloadAllMcpServers ====================

describe("reloadAllMcpServers", () => {
  it("重新加载触发关闭和重新连接", async () => {
    mockServers.push({ id: "srv", name: "服务器", transport: "stdio", command: "node", args: ["s.js"] });

    await startAllMcpServers();
    expect(mockClose).not.toHaveBeenCalled();

    const tools = await reloadAllMcpServers();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(tools.length).toBe(1);
  });
});
