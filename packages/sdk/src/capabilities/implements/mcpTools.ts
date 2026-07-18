import { CallbackTool } from "@ai-zen/agents-core";
import { createDisclosureParam } from "../disclosure.js";
import type { McpConnectionManager } from "../../runtime/McpConnectionManager.js";
import type { McpServerConfig } from "../../types/index.js";

const EMPTY_HINT = "（当前没有可用的 MCP 服务器，请联系用户添加）";

/**
 * 创建 load_mcp 工具。
 * server 枚举由 filteredMcps （完整 McpServerConfig[]）自动推导。
 */
export function createLoadMcpTool(
  mcpManager: McpConnectionManager,
  mcpConfigs: Map<string, { name: string; config: McpServerConfig }>,
  filteredMcps: McpServerConfig[],
): CallbackTool {
  const ids = filteredMcps.map((s) => s.id);
  const param = createDisclosureParam(ids, "选择一个 MCP 服务器", EMPTY_HINT);

  return new CallbackTool({
    function: {
      name: "load_mcp",
      description: "连接到指定 MCP 服务器，获取其可用工具和资源列表。",
      parameters: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: param.description,
            ...(param.enum ? { enum: param.enum } : {}),
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

      const existingManifest = mcpManager.getManifest(serverName);
      if (existingManifest && mcpManager.getState(serverName) === "connected") {
        mcpManager.touch(serverName);
        const toolList = existingManifest.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
        return `✅ MCP 服务器 "${serverName}" 已连接 (${existingManifest.tools.length} 个工具):\n${toolList}`;
      }

      try {
        const manifest = await mcpManager.connect(serverName, serverConfig.config);
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
 * 通过官方 Client.callTool() API 调用 MCP 服务器上的工具。
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

      const client = mcpManager.getClient(serverName);
      if (!client) {
        return `MCP 服务器 "${serverName}" 的客户端不可用`;
      }

      try {
        mcpManager.touch(serverName);
        const result = await client.callTool({
          name: input.tool as string,
          arguments: input.arguments as Record<string, unknown>,
        });

        const contents = (result as any).content ?? [];
        const textParts = contents
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text);
        const text = textParts.join("\n");

        if ((result as any).isError) {
          return `❌ 工具执行出错:\n${text || JSON.stringify(result)}`;
        }

        return text || JSON.stringify(result);
      } catch (error: any) {
        return `❌ 调用 "${input.tool}" 失败: ${error?.message ?? error}`;
      }
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

      const client = mcpManager.getClient(serverName);
      if (!client) {
        return `MCP 服务器 "${serverName}" 的客户端不可用`;
      }

      try {
        mcpManager.touch(serverName);
        const result = await (client as any).readResource({
          uri: input.uri as string,
        });

        const contents = result?.contents ?? [];
        const textParts = contents
          .filter((c: any) => c.text)
          .map((c: any) => c.text);
        return textParts.join("\n") || JSON.stringify(result);
      } catch (error: any) {
        return `❌ 读取资源 "${input.uri}" 失败: ${error?.message ?? error}`;
      }
    },
  });
}
