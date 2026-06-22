/**
 * 子 Agent 加载器
 *
 * 从文件系统发现并加载子 Agent，支持 JSON 和 JS 两种格式。
 *
 * 发现路径（优先级从低到高）：
 *   1. ~/.ai-zen/sub-agents/               ← 全局
 *   2. ./.ai-zen/sub-agents/               ← 项目级（CWD）
 *
 * 工具解析规则：
 *   - tools[]:       按名称从 allTools 中匹配
 *   - extraTools[]:  内联注册，直接创建 CallbackTool
 *   - mcpServers[]:  按名称从已连接的 MCP 服务器中匹配工具
 */

import chalk from "chalk";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { AgentNS, CallbackTool } from "@ai-zen/agents-core";
import { SUB_AGENTS_DIR } from "./config.js";
import { allTools } from "./tools/index.js";
import { SubAgentConfig, SubAgentFileDefinition, SubAgentToolDefinition } from "./types.js";
import { getConnectedMcpTools } from "./mcp-manager.js";

// ==================== 常量 ====================

/** 项目级子 Agent 目录 */
const PROJECT_SUB_AGENTS_DIR = join(process.cwd(), ".ai-zen", "sub-agents");

// ==================== 工具引用解析 ====================

/**
 * 按名称从全局工具列表中查找工具
 */
function resolveToolByName(name: string): CallbackTool | undefined {
  return allTools.find((t) => t.function.name === name);
}

/**
 * 解析子 Agent 的工具引用
 * @param toolNames 按名称引用的工具列表
 * @param extraTools 内联注册的工具定义
 * @param mcpServerNames 按名称引用的 MCP 服务器列表
 * @returns 解析后的工具实例列表
 */
function resolveTools(
  toolNames?: string[],
  extraTools?: SubAgentToolDefinition[],
  mcpServerNames?: string[],
): { tools: CallbackTool[]; mcpTools: CallbackTool[] } {
  const tools: CallbackTool[] = [];
  const mcpTools: CallbackTool[] = [];

  // 1. 按名称引用全局工具
  if (toolNames && toolNames.length > 0) {
    for (const name of toolNames) {
      const tool = resolveToolByName(name);
      if (tool) {
        tools.push(tool);
      } else {
        console.warn(chalk.yellow(`  ⚠️  工具 "${name}" 未找到，已跳过`));
      }
    }
  }

  // 2. 内联注册的自定义工具
  if (extraTools && extraTools.length > 0) {
    for (const def of extraTools) {
      const tool = new CallbackTool({
        function: {
          name: def.name,
          description: def.description,
          parameters: def.parameters as any,
        },
        callback: def.callback || (async () => "此工具无回调函数（仅用于 JSON 声明）"),
      });
      tools.push(tool);
    }
  }

  // 3. 按名称引用 MCP 服务器中的工具
  if (mcpServerNames && mcpServerNames.length > 0) {
    const connectedMcpTools = getConnectedMcpTools();
    for (const serverName of mcpServerNames) {
      const serverTools = connectedMcpTools[serverName];
      if (serverTools && serverTools.length > 0) {
        mcpTools.push(...serverTools);
      } else {
        console.warn(chalk.yellow(`  ⚠️  MCP 服务器 "${serverName}" 未连接或无工具，已跳过`));
      }
    }
  }

  return { tools, mcpTools };
}

// ==================== 自动生成 function 定义 ====================

/**
 * 为子 Agent 自动生成默认的 function 定义
 * 当用户未提供自定义 function 时，使用此默认定义
 */
function generateDefaultFunction(
  id: string,
  name: string,
  description?: string,
): {
  name: string;
  description: string;
  parameters: Record<string, any>;
} {
  // 将 id 中的中文字符/特殊字符转为下划线，生成合法的 function name
  const funcName = id
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, "_")
    .replace(/^_+|_+$/g, "");

  return {
    name: funcName || "sub_agent",
    description: description || `调用子 Agent: ${name}`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: `请详细描述要交给"${name}"处理的任务`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

// ==================== 文件解析 ====================

/**
 * 将 SubAgentFileDefinition 转换为 SubAgentConfig
 */
function convertToSubAgentConfig(def: SubAgentFileDefinition): SubAgentConfig {
  // 构建消息列表
  let messages: AgentNS.Message[];

  if (def.messages && def.messages.length > 0) {
    // 使用用户提供的完整消息列表
    messages = def.messages;
  } else if (def.system) {
    // 简写模式：从 system 字段自动构建
    messages = [
      { role: AgentNS.Role.System, content: def.system },
      { role: AgentNS.Role.User, content: "{{query}}" },
    ];
  } else {
    // 兜底：使用通用默认提示
    messages = [
      {
        role: AgentNS.Role.System,
        content:
          "你是一个AI助手，请根据给定的任务描述，认真分析并完成任务。完成任务后直接返回结果。请用中文回复。",
      },
      { role: AgentNS.Role.User, content: "{{query}}" },
    ];
  }

  // function 定义：用户自定义或自动生成
  const funcDef = def.function || generateDefaultFunction(def.id, def.name, def.description);

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    messages,
    modelId: def.modelId,
    function: funcDef,
    tools: def.tools,
    mcpServers: def.mcpServers,
    extraTools: def.extraTools,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 解析 JSON 格式的子 Agent 文件
 */
async function loadJsonAgent(filePath: string): Promise<SubAgentConfig | null> {
  try {
    const content = readFileSync(filePath, "utf-8");
    const def: SubAgentFileDefinition = JSON.parse(content);
    return convertToSubAgentConfig(def);
  } catch (error: any) {
    console.warn(chalk.yellow(`  ⚠️  加载子 Agent 文件失败: ${filePath} - ${error.message}`));
    return null;
  }
}

/**
 * 解析 JS 格式的子 Agent 文件
 */
async function loadJsAgent(filePath: string): Promise<SubAgentConfig | null> {
  try {
    // 使用动态 import
    const module = await import(filePath);
    const def: SubAgentFileDefinition = module.default || module;
    return convertToSubAgentConfig(def);
  } catch (error: any) {
    console.warn(chalk.yellow(`  ⚠️  加载子 Agent 文件失败: ${filePath} - ${error.message}`));
    return null;
  }
}

/**
 * 从单个文件中解析子 Agent 配置
 */
async function loadAgentFile(filePath: string): Promise<SubAgentConfig | null> {
  if (filePath.endsWith(".json")) {
    return loadJsonAgent(filePath);
  }
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) {
    return loadJsAgent(filePath);
  }
  return null;
}

// ==================== 目录扫描 ====================

/**
 * 扫描单个目录，发现所有子 Agent 文件
 */
async function scanDirectory(dir: string): Promise<SubAgentConfig[]> {
  if (!existsSync(dir)) return [];

  const agents: SubAgentConfig[] = [];
  const files = readdirSync(dir);

  for (const file of files) {
    const filePath = join(dir, file);
    // 跳过目录和隐藏文件
    if (file.startsWith(".")) continue;

    const agent = await loadAgentFile(filePath);
    if (agent) {
      agents.push(agent);
    }
  }

  return agents;
}

// ==================== 主入口 ====================

/**
 * 发现所有子 Agent（全局 + 项目级）
 * 项目级同名 Agent 会覆盖全局的
 */
export async function discoverSubAgents(): Promise<SubAgentConfig[]> {
  const agentMap = new Map<string, SubAgentConfig>();

  // 1. 加载全局子 Agent（优先级低）
  const globalAgents = await scanDirectory(SUB_AGENTS_DIR);
  for (const agent of globalAgents) {
    agentMap.set(agent.id, agent);
  }

  // 2. 加载项目级子 Agent（优先级高，覆盖全局同名）
  const projectAgents = await scanDirectory(PROJECT_SUB_AGENTS_DIR);
  for (const agent of projectAgents) {
    agentMap.set(agent.id, agent);
  }

  return Array.from(agentMap.values());
}

/**
 * 根据子 Agent 配置，解析其引用的工具和 MCP 工具
 */
export function resolveSubAgentTools(config: SubAgentConfig): {
  tools: CallbackTool[];
  mcpTools: CallbackTool[];
} {
  return resolveTools(config.tools, config.extraTools, config.mcpServers);
}
