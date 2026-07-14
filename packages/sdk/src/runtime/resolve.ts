import type { Tool } from "@ai-zen/agents-core";
import type { AppConfig, McpServerConfig, McpTransport } from "../types";
import { readAgent } from "../crud/agents";
import { discoverSubAgents } from "../capabilities/discovery/subagents";
import { discoverSkills } from "../capabilities/discovery/skills";
import { discoverMcpServers } from "../capabilities/discovery/mcp";
import { discoverUserTools } from "../capabilities/discovery/usertools";
import { discoverBuiltinTools } from "../capabilities/discovery/builtin";
import { filterCapabilities } from "../capabilities/filter";
import { instantiateTools } from "../capabilities/instantiate";
import type { McpConnectionManager } from "./mcp-connection";
import { createGenerateImageTool } from "../capabilities/implements/builtin/generateImage";
import type { ResolvedAgent } from "./types";

export interface ResolveAgentInput {
  agentId: string;
  config: AppConfig;
  agentsDir: string;
  subAgentsPaths?: string[];
  skillsPaths?: string[];
  toolsPaths?: string[];
  mcpPaths?: string[];
  /** MCP 连接管理器 */
  mcpManager?: McpConnectionManager;
  /** MCP server 配置映射 */
  mcpConfigs?: Map<string, { name: string; config: McpServerConfig }>;
  /** MCP transport 工厂 */
  mcpTransportFactory?: (config: McpServerConfig) => McpTransport;
}

/**
 * 从磁盘完整装配 Agent：加载定义 → 发现候选 → 权限过滤 → 实例化。
 * 产出 ResolvedAgent（纯数据），消费方直接 new Agent({ model, messages, tools })。
 */
export function resolveAgent(input: ResolveAgentInput): ResolvedAgent {
  const {
    agentId, config, agentsDir,
    subAgentsPaths = [], skillsPaths = [], toolsPaths = [], mcpPaths = [],
    mcpManager, mcpConfigs, mcpTransportFactory,
  } = input;

  function resolve(): ResolvedAgent {
    const definition = readAgent(agentsDir, agentId);
    if (!definition) throw new Error(`Agent "${agentId}" 不存在`);

    // 解析 model
    const modelId = definition.modelId ?? config.defaultModel;
    if (!modelId) throw new Error("未指定模型且无默认模型");
    const model = config.models.find((m) => m.id === modelId);
    if (!model) throw new Error(`模型 "${modelId}" 不存在`);

    // 阶段 1：发现（产出实例 + 名称）
    let builtinInstances = discoverBuiltinTools();
    const userInstances = discoverUserTools(toolsPaths);
    const subagentDefs = discoverSubAgents(subAgentsPaths);
    const skills = discoverSkills(skillsPaths);
    const mcps = discoverMcpServers(mcpPaths);

    // 注入条件工具（generateImage）
    builtinInstances = injectGenerateImageTool(builtinInstances, userInstances, config);

    // 阶段 2：安全预过滤 + 权限过滤（纯名称操作）
    const filtered = filterCapabilities({
      permissions: definition.permissions ?? {},
      builtinNames: builtinInstances.map((t) => t.function.name),
      userNames: userInstances.map((t) => t.function.name),
      subagents: subagentDefs,
      skillIds: skills.map((s) => s.id),
      mcpIds: mcps.map((m) => m.id),
      selfFunctionName: definition.function?.name,
    });

    // 阶段 3：实例化（名称 → Tool 实例）
    const allowedSkillIds = new Set(filtered.skills);
    const allowedMcpIds = new Set(filtered.mcps);

    const tools = instantiateTools({
      allowedTools: filtered.tools,
      allowedSubagents: filtered.subagents,
      allowedSkills: skills.filter((s) => allowedSkillIds.has(s.id)),
      allowedMcps: mcps.filter((m) => allowedMcpIds.has(m.id)),
      builtinInstances,
      userInstances,
      subagentDefs,
      skillsPaths,
      mcpManager,
      mcpConfigs,
      mcpTransportFactory,
    });

    return {
      definition,
      model,
      messages: definition.messages,
      tools,
      refresh: () => resolve(),
    };
  }

  return resolve();
}

/**
 * 如果配置了图片模型，自动注入 generateImage 工具。
 * 跳过条件：用户工具或内置工具中已存在同名工具（用户可覆盖）。
 */
function injectGenerateImageTool(
  builtinInstances: Tool[],
  userInstances: Tool[],
  config: AppConfig,
): Tool[] {
  const imageModels = (config as any).imageModels as any[] | undefined;
  if (!imageModels || imageModels.length === 0) return builtinInstances;

  const existingNames = new Set([
    ...userInstances.map((t) => t.function.name),
    ...builtinInstances.map((t) => t.function.name),
  ]);
  if (existingNames.has("generateImage")) return builtinInstances;

  return [...builtinInstances, createGenerateImageTool(config)];
}
