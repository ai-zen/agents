import { describe, it, expect } from "vitest";
import { UnknownToolHintPlugin } from "./UnknownToolHintPlugin.js";
import type { UnknownToolContext } from "@ai-zen/agents-core";
import type { Provider } from "../runtime/Provider.js";

function mockProvider(opts?: { mcpPaths?: string[] }): Provider {
  return {
    mcpPaths: opts?.mcpPaths ?? [],
  } as Provider;
}

function ctx(toolName: string, availableTools: string[]): UnknownToolContext {
  return {
    toolCall: { function: { name: toolName } },
    availableTools: availableTools.map((name) => ({
      type: "function" as const,
      function: { name, description: "", parameters: { type: "object" as const, properties: {} } },
    })),
  };
}

describe("UnknownToolHintPlugin", () => {
  it("无 MCP 配置时提示工具不存在", () => {
    const plugin = new UnknownToolHintPlugin({ provider: mockProvider() });
    const result = plugin.onUnknownTool(ctx("foo", []));
    expect(result).toBe('工具 "foo" 不存在。');
  });

  it("有 MCP 配置但 call_mcp_tool 不可用时提示权限问题", () => {
    const plugin = new UnknownToolHintPlugin({
      provider: mockProvider({ mcpPaths: ["/tmp/mcp.json"] }),
    });
    const result = plugin.onUnknownTool(ctx("foo", ["readFile"]));
    expect(result).toContain("call_mcp_tool 权限已被禁用");
  });

  it("有 MCP 配置且 call_mcp_tool 可用时提示使用 call_mcp_tool", () => {
    const plugin = new UnknownToolHintPlugin({
      provider: mockProvider({ mcpPaths: ["/tmp/mcp.json"] }),
    });
    const result = plugin.onUnknownTool(ctx("foo", ["call_mcp_tool"]));
    expect(result).toContain("请使用 call_mcp_tool");
  });

  it("无 MCP 配置时不提示 MCP 相关内容", () => {
    const plugin = new UnknownToolHintPlugin({ provider: mockProvider() });
    const result = plugin.onUnknownTool(ctx("unknownFn", ["call_mcp_tool"]));
    expect(result).toContain("unknownFn");
    expect(result).not.toContain("MCP");
    expect(result).not.toContain("call_mcp_tool");
  });

  it("通过 onUnknownTool 钩子接入 Agent（注册后可短路默认提示）", async () => {
    // 验证插件实现了 AgentPlugin 的 onUnknownTool 钩子，可被 dispatchHook 调用
    const plugin = new UnknownToolHintPlugin({
      provider: mockProvider({ mcpPaths: ["/tmp/mcp.json"] }),
    });
    const result = await plugin.onUnknownTool!(ctx("foo", []));
    expect(result).toContain("foo");
  });
});
