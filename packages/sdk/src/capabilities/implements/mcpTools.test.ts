import { describe, it, expect, vi } from "vitest";
import { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./mcpTools.js";
import type { McpConnectionManager } from "../../runtime/McpConnectionManager.js";
import type { McpServerConfig } from "../../types/index.js";

function mockManager(overrides?: Partial<McpConnectionManager>): McpConnectionManager {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    getState: vi.fn(),
    getManifest: vi.fn(),
    getClient: vi.fn(),
    touch: vi.fn(),
    ...overrides,
  } as unknown as McpConnectionManager;
}

const mcps: McpServerConfig[] = [
  { id: "github", name: "GitHub", transport: "stdio", command: "gh" },
  { id: "slack", name: "Slack", transport: "http", url: "https://slack.example.com" },
];

describe("createLoadMcpTool", () => {
  it("工具名称和参数正确", () => {
    const manager = mockManager();
    const tool = createLoadMcpTool(manager, mcps);
    expect(tool.function.name).toBe("load_mcp");
    expect(tool.function.parameters.properties.server.enum).toEqual(["github", "slack"]);
    expect(tool.function.parameters.required).toContain("server");
  });

  it("服务器不存在时返回错误", async () => {
    const manager = mockManager();
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "non-existent" });
    expect(result).toContain("不存在");
  });

  it("已连接时直接返回清单", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getManifest: vi.fn(() => ({
        tools: [{ name: "echo", description: "回显" }],
        resources: [],
      })),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github" });
    expect(result).toContain("已连接");
    expect(result).toContain("echo");
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("未连接时调用 connect", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
      getManifest: vi.fn(() => undefined),
      connect: vi.fn().mockResolvedValue({
        tools: [{ name: "list", description: "列出文件" }],
        resources: [],
      }),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github" });
    expect(result).toContain("已连接");
    expect(result).toContain("list");
    expect(manager.connect).toHaveBeenCalledWith("github", mcps[0]);
  });

  it("连接失败时返回错误", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
      getManifest: vi.fn(() => undefined),
      connect: vi.fn().mockRejectedValue(new Error("连接超时")),
    });
    const tool = createLoadMcpTool(manager, mcps);
    const result = await tool.callback({ server: "github" });
    expect(result).toContain("无法连接");
    expect(result).toContain("连接超时");
  });
});

describe("createCallMcpTool", () => {
  it("工具名称和参数正确", () => {
    const manager = mockManager();
    const tool = createCallMcpTool(manager);
    expect(tool.function.name).toBe("call_mcp_tool");
    expect(tool.function.parameters.required).toContain("server");
    expect(tool.function.parameters.required).toContain("tool");
    expect(tool.function.parameters.required).toContain("arguments");
  });

  it("服务器未连接时提示先 load_mcp", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
    });
    const tool = createCallMcpTool(manager);
    const result = await tool.callback({ server: "github", tool: "echo", arguments: {} });
    expect(result).toContain("请先使用 load_mcp");
  });

  it("客户端不可用时返回错误", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => null),
    });
    const tool = createCallMcpTool(manager);
    const result = await tool.callback({ server: "github", tool: "echo", arguments: {} });
    expect(result).toContain("不可用");
  });

  it("成功调用工具返回结果", async () => {
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "hello world" }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createCallMcpTool(manager);
    const result = await tool.callback({ server: "github", tool: "echo", arguments: { message: "hello" } });
    expect(result).toBe("hello world");
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "echo",
      arguments: { message: "hello" },
    });
  });

  it("isError 时返回错误信息", async () => {
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "权限不足" }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createCallMcpTool(manager);
    const result = await tool.callback({ server: "github", tool: "write", arguments: {} });
    expect(result).toContain("工具执行出错");
    expect(result).toContain("权限不足");
  });

  it("调用时返回非 text 内容", async () => {
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "image", data: "base64..." }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createCallMcpTool(manager);
    const result = await tool.callback({ server: "github", tool: "draw", arguments: {} });
    // 无 text 内容时返回 JSON
    expect(typeof result).toBe("string");
    expect(result).not.toContain("失败");
  });

  it("调用失败时返回错误信息", async () => {
    const mockClient = {
      callTool: vi.fn().mockRejectedValue(new Error("网络错误")),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createCallMcpTool(manager);
    const result = await tool.callback({ server: "github", tool: "echo", arguments: {} });
    expect(result).toContain("失败");
    expect(result).toContain("网络错误");
  });
});

describe("createReadMcpResourceTool", () => {
  it("工具名称和参数正确", () => {
    const manager = mockManager();
    const tool = createReadMcpResourceTool(manager);
    expect(tool.function.name).toBe("read_mcp_resource");
    expect(tool.function.parameters.required).toContain("server");
    expect(tool.function.parameters.required).toContain("uri");
  });

  it("服务器未连接时提示先 load_mcp", async () => {
    const manager = mockManager({
      getState: vi.fn(() => "disconnected" as const),
    });
    const tool = createReadMcpResourceTool(manager);
    const result = await tool.callback({ server: "github", uri: "file:///README.md" });
    expect(result).toContain("请先使用 load_mcp");
  });

  it("成功读取资源", async () => {
    const mockClient = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ text: "# 文档内容" }],
      }),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createReadMcpResourceTool(manager);
    const result = await tool.callback({ server: "github", uri: "file:///README.md" });
    expect(result).toBe("# 文档内容");
  });

  it("读取失败时返回错误", async () => {
    const mockClient = {
      readResource: vi.fn().mockRejectedValue(new Error("资源不存在")),
    };
    const manager = mockManager({
      getState: vi.fn(() => "connected" as const),
      getClient: vi.fn(() => mockClient),
    });
    const tool = createReadMcpResourceTool(manager);
    const result = await tool.callback({ server: "github", uri: "file:///missing" });
    expect(result).toContain("失败");
    expect(result).toContain("资源不存在");
  });
});
