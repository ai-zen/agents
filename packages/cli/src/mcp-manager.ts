/**
 * MCP 管理器
 *
 * 职责：
 * - 管理 MCP 服务器连接的生命周期
 * - 连接服务器 → 获取工具列表 → 封装为 CallbackTool
 * - 支持 stdio 和 SSE 两种传输方式
 */

import chalk from "chalk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// SSE 传输暂不引入（需要时再添加）
// import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { CallbackTool } from "@ai-zen/agents-core";
import { McpServerConfig } from "./types.js";
import { readConfig } from "./config.js";

// ==================== 可替换工厂（便于测试） ====================

// ==================== 可替换工厂（便于测试） ====================

/**
 * 创建 StdioClientTransport 实例的工厂函数
 * 测试时可以替换此函数来避免真实的子进程创建
 */
let _createStdioTransport = (config: McpServerConfig) => {
  return new StdioClientTransport({
    command: config.command!,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
  });
};

/** 获取当前 transport 工厂函数 */
export function getCreateStdioTransport(): typeof _createStdioTransport {
  return _createStdioTransport;
}

/** 替换 transport 工厂函数（用于测试） */
export function setCreateStdioTransport(
  fn: typeof _createStdioTransport,
): void {
  _createStdioTransport = fn;
}

// ==================== 类型定义 ====================

/** 已连接的 MCP 服务器实例 */
interface McpConnection {
  config: McpServerConfig;
  client: Client;
  tools: CallbackTool[];
}

// ==================== 状态 ====================

/** 当前活跃的 MCP 连接列表 */
const connections: McpConnection[] = [];

/**
 * 获取按服务器名称索引的 MCP 工具列表
 * 供子 Agent 加载器按名称引用
 */
export function getConnectedMcpTools(): Record<string, CallbackTool[]> {
  const result: Record<string, CallbackTool[]> = {};
  for (const conn of connections) {
    result[conn.config.name] = conn.tools;
    // 也支持按 id 查找
    result[conn.config.id] = conn.tools;
  }
  return result;
}

// ==================== 核心逻辑 ====================

/**
 * 启动所有已配置且启用的 MCP 服务器连接
 * 返回所有 MCP 工具（CallbackTool 数组）
 */
export async function startAllMcpServers(): Promise<CallbackTool[]> {
  const config = readConfig();
  const mcpServers = config.mcpServers || [];

  if (mcpServers.length === 0) {
    return [];
  }

  const allTools: CallbackTool[] = [];

  for (const serverConfig of mcpServers) {
    if (serverConfig.enabled === false) {
      continue; // 跳过已禁用的服务器
    }

    try {
      const result = await connectToServer(serverConfig);
      connections.push(result);
      allTools.push(...result.tools);
      console.log(
        chalk.green(
          `  ✅ MCP 服务器 "${serverConfig.name}" 已连接 (${result.tools.length} 个工具)`,
        ),
      );
    } catch (error: any) {
      console.error(
        chalk.yellow(
          `  ⚠️  MCP 服务器 "${serverConfig.name}" 连接失败: ${error.message}`,
        ),
      );
      // 单个服务器失败不影响其他服务器
    }
  }

  return allTools;
}

/**
 * 连接单个 MCP 服务器
 */
async function connectToServer(
  config: McpServerConfig,
): Promise<McpConnection> {
  let transport;

  switch (config.transport) {
    case "stdio": {
      if (!config.command) {
        throw new Error("stdio 传输方式需要指定 command");
      }
      transport = _createStdioTransport(config);
      break;
    }

    case "sse": {
      if (!config.url) {
        throw new Error("SSE 传输方式需要指定 url");
      }
      // TODO: 后续支持 SSE 传输
      throw new Error("SSE 传输方式暂未实现");
    }

    default:
      throw new Error(`不支持的传输方式: ${config.transport}`);
  }

  // 创建客户端
  const client = new Client(
    {
      name: "ai-zen-mcp-client",
      version: "0.1.0",
    },
    { capabilities: {} },
  );

  // 连接（自动握手）
  await client.connect(transport);

  // 获取工具列表
  const { tools: mcpTools } = await client.listTools();

  // 将 MCP 工具封装为 CallbackTool
  const callbackTools = mcpTools.map((tool) => {
    return new CallbackTool({
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.inputSchema as any,
      },
      async callback(input: Record<string, unknown>): Promise<string> {
        try {
          const result = await client.callTool({
            name: tool.name,
            arguments: input,
          });

          // 提取文本内容
          const content = result.content as Array<{ type: string; text?: string }>;
          const texts = content
            .filter((c) => c.type === "text")
            .map((c) => c.text || "");

          if (texts.length > 0) {
            return texts.join("\n");
          }

          return JSON.stringify(content);
        } catch (error: any) {
          return `工具 "${tool.name}" 调用失败: ${error.message}`;
        }
      },
    });
  });

  return {
    config,
    client,
    tools: callbackTools,
  };
}

/**
 * 断开所有 MCP 服务器连接
 */
export async function stopAllMcpServers(): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.client.close();
    } catch {
      // 忽略关闭时的错误
    }
  }
  connections.length = 0;
}

/**
 * 重新加载所有 MCP 服务器（配置变更后调用）
 */
export async function reloadAllMcpServers(): Promise<CallbackTool[]> {
  await stopAllMcpServers();
  return startAllMcpServers();
}
