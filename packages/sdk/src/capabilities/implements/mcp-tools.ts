import { CallbackTool } from "@ai-zen/agents-core";
import type { DisclosureParam } from "../disclosure";
import type { McpConnectionManager } from "../../runtime/mcp-connection";
import type { McpServerConfig, McpTransport } from "../../types";

// ---------------------------------------------------------------------------
// TODO: SDK 应内置 stdio / HTTP transport 实现。
// McpConnectionManager 已完整管理连接生命周期（重连、退避、超时、状态机），
// 三个工具的回调直接使用 McpConnectionManager 的 API。
// 当前 transport 由 resolveAgent 内部创建并注入，不暴露给上层。
// ---------------------------------------------------------------------------

/**
 * 创建 load_mcp 工具。
 * server 枚举来自 mcpDisclosure（已在装配时按 permissions.mcps 裁剪）。
 */
export function createLoadMcpTool(
  mcpManager: McpConnectionManager,
  mcpConfigs: Map<string, { name: string; config: McpServerConfig }>,
  mcpDisclosure: DisclosureParam,
  transportFactory: (config: McpServerConfig) => McpTransport,
): CallbackTool {
  return new CallbackTool({
    function: {
      name: "load_mcp",
      description: "连接到指定 MCP 服务器，获取其可用工具和资源列表。",
      parameters: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: mcpDisclosure.description,
            ...(mcpDisclosure.enum ? { enum: mcpDisclosure.enum } : {}),
          },
        },
        required: ["server"],
        additionalProperties: false,
      },
    },
    callback: async (input): Promise<string> => {
      const serverName = input.server as string;
      const serverConfig = mcpConfigs.get(serverName);
      if (!serverConfig) {
        return `❌ MCP 服务器 "${serverName}" 不存在`;
      }

      // 已连接则直接返回清单
      const existingManifest = mcpManager.getManifest(serverName);
      if (existingManifest && mcpManager.getState(serverName) === "connected") {
        mcpManager.touch(serverName);
        const toolList = existingManifest.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
        return `✅ MCP 服务器 "${serverName}" 已连接 (${existingManifest.tools.length} 个工具):\n${toolList}`;
      }

      try {
        const transport = transportFactory(serverConfig.config);
        const manifest = await mcpManager.connect(serverName, serverConfig.config, transport);
        const toolList = manifest.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
        return `✅ MCP 服务器 "${serverName}" 已连接 (${manifest.tools.length} 个工具):\n${toolList}`;
      } catch (error: any) {
        return `无法连接到 "${serverName}": ${error?.message ?? error}`;
      }
    },
  });
}

/**
 * 创建 call_mcp_tool 工具。
 */
export function createCallMcpTool(mcpManager: McpConnectionManager): CallbackTool {
  return new CallbackTool({
    function: {
      name: "call_mcp_tool",
      description: "调用已连接 MCP 服务器上的指定工具。需先通过 load_mcp 连接服务器。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP 服务器名称" },
          tool: { type: "string", description: "工具名称" },
          arguments: { type: "object", description: "工具参数" },
        },
        required: ["server", "tool", "arguments"],
        additionalProperties: false,
      },
    },
    callback: async (input): Promise<string> => {
      const serverName = input.server as string;
      const state = mcpManager.getState(serverName);
      if (state !== "connected") {
        return `请先使用 load_mcp 连接 "${serverName}"`;
      }

      // TODO: 通过 McpConnectionManager 持有的 transport 调用工具
      // const transport = mcpManager.getTransport(serverName);
      // return transport.callTool(input.tool as string, input.arguments as Record<string, unknown>);
      return `❌ TODO: call_mcp_tool — 需在 McpTransport 接口补充 callTool 方法`;
    },
  });
}

/**
 * 创建 read_mcp_resource 工具。
 */
export function createReadMcpResourceTool(mcpManager: McpConnectionManager): CallbackTool {
  return new CallbackTool({
    function: {
      name: "read_mcp_resource",
      description: "读取已连接 MCP 服务器上的指定资源（文档、数据等）。",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP 服务器名称" },
          uri: { type: "string", description: "资源 URI" },
        },
        required: ["server", "uri"],
        additionalProperties: false,
      },
    },
    callback: async (input): Promise<string> => {
      const serverName = input.server as string;
      const state = mcpManager.getState(serverName);
      if (state !== "connected") {
        return `请先使用 load_mcp 连接 "${serverName}"`;
      }

      // TODO: 通过 McpConnectionManager 持有的 transport 读取资源
      // const transport = mcpManager.getTransport(serverName);
      // return transport.readResource(input.uri as string);
      return `❌ TODO: read_mcp_resource — 需在 McpTransport 接口补充 readResource 方法`;
    },
  });
}
