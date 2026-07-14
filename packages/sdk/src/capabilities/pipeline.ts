import type { Tool } from "@ai-zen/agents-core";
import { AgentToolLazy } from "@ai-zen/agents-core";
import type { AgentDefinition, AgentPermissions, McpServerConfig, McpTransport } from "../types";
import { filterByPermissions } from "./permissions";
import type { CandidateSets } from "./permissions";
import { prefilterSubAgents, prefilterSkillTools } from "./prefilter";
import { buildDisclosureParam } from "./disclosure";
import type { DisclosureItem } from "./disclosure";
import { createLoadSkillTool } from "./implements/skill-tools";
import { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./implements/mcp-tools";
import type { McpConnectionManager } from "../runtime/mcp-connection";

export interface AssemblyInput {
  permissions: AgentPermissions;
  builtinTools?: Tool[];
  userTools?: Tool[];
  subagents?: AgentDefinition[];
  skills?: DisclosureItem[];
  mcps?: DisclosureItem[];
  /** Skill 目录路径列表（供 load_skill / call_skill_sub_agent 回调查找） */
  skillsPaths?: string[];
  /** MCP 连接管理器（供 MCP 动态工具使用） */
  mcpManager?: McpConnectionManager;
  /** MCP server 配置映射 */
  mcpConfigs?: Map<string, { name: string; config: McpServerConfig }>;
  /** MCP transport 工厂 */
  mcpTransportFactory?: (config: McpServerConfig) => McpTransport;
  selfFunctionName?: string;
  callerFunctionName?: string;
  isSkillSubAgent?: boolean;
}

export interface AssemblyOutput {
  /** 最终工具列表：内置 + 用户 + 动态工具 + subagents（已转为 AgentToolLazy），已去重 */
  tools: Tool[];
}

const EMPTY_HINT_SKILL = "（当前没有可用的 Skill，请联系用户添加）";
const EMPTY_HINT_MCP = "（当前没有可用的 MCP 服务器，请联系用户添加）";

const DYNAMIC_TOOL_NAMES = [
  "load_skill",
  "call_skill_sub_agent",
  "load_mcp",
  "call_mcp_tool",
  "read_mcp_resource",
];

/**
 * 能力装配管线：权限过滤 + 安全预过滤 + 实例化，一站式输出 Tool[]。
 * 所有维度最终合并为 tools: Tool[]，上层直接使用，无需再理解内部维度。
 */
export function assembleCapabilities(input: AssemblyInput): AssemblyOutput {
  const {
    permissions,
    builtinTools = [],
    userTools = [],
    subagents: rawSubagents = [],
    skills: rawSkills = [],
    mcps: rawMcps = [],
    skillsPaths = [],
    mcpManager,
    mcpConfigs,
    mcpTransportFactory,
    selfFunctionName,
    callerFunctionName,
    isSkillSubAgent = false,
  } = input;

  // ========================================
  // 1. 安全预过滤
  // ========================================
  const safeSubagents = prefilterSubAgents(rawSubagents, selfFunctionName, callerFunctionName);

  // ========================================
  // 2. 权限过滤
  // ========================================

  // 工具候选名称 = 内置 + 用户 + 动态工具名
  const builtinNames = builtinTools.map((t: Tool) => t.function.name);
  const userNames = userTools.map((t: Tool) => t.function.name);
  let toolCandidateNames = [...builtinNames, ...userNames, ...DYNAMIC_TOOL_NAMES];
  if (isSkillSubAgent) {
    toolCandidateNames = prefilterSkillTools(toolCandidateNames);
  }

  const subagentNames = safeSubagents.map((d) => d.function!.name);

  const candidates: CandidateSets = {
    tools: toolCandidateNames,
    skills: rawSkills.map((s) => s.id),
    mcps: rawMcps.map((m) => m.id),
    subagents: subagentNames,
  };

  const filtered = filterByPermissions(permissions, candidates);

  // ========================================
  // 3. 构建枚举披露参数
  // ========================================
  const allowedSkillIds = new Set(filtered.skills);
  const allowedMcpIds = new Set(filtered.mcps);

  const filteredSkills = rawSkills.filter((s) => allowedSkillIds.has(s.id));
  const filteredMcps = rawMcps.filter((m) => allowedMcpIds.has(m.id));

  const skillDisclosure = buildDisclosureParam(
    filteredSkills,
    "选择一个 Skill",
    EMPTY_HINT_SKILL,
  );

  const mcpDisclosure = buildDisclosureParam(
    filteredMcps,
    "选择一个 MCP 服务器",
    EMPTY_HINT_MCP,
  );

  // ========================================
  // 4. 实例化：名称 → Tool 实例
  // ========================================
  const result: Tool[] = [];
  const allowedToolNames = new Set(filtered.tools);

  // 4a. 内置 + 用户工具
  for (const t of [...builtinTools, ...userTools]) {
    if (allowedToolNames.has(t.function.name)) {
      result.push(t);
    }
  }

  // 4b. 动态工具（按条件注册）
  if (allowedToolNames.has("load_skill") && filteredSkills.length > 0) {
    result.push(createLoadSkillTool(skillsPaths, skillDisclosure));
  }
  if (allowedToolNames.has("call_skill_sub_agent") && filteredSkills.length > 0) {
    // TODO: call_skill_sub_agent 需要更多参数（config、permissions、skillsPaths 等），暂时跳过
  }
  if (allowedToolNames.has("load_mcp") && mcpManager && mcpConfigs && mcpTransportFactory && filteredMcps.length > 0) {
    result.push(createLoadMcpTool(mcpManager, mcpConfigs, mcpDisclosure, mcpTransportFactory));
  }
  if (allowedToolNames.has("call_mcp_tool") && mcpManager) {
    result.push(createCallMcpTool(mcpManager));
  }
  if (allowedToolNames.has("read_mcp_resource") && mcpManager) {
    result.push(createReadMcpResourceTool(mcpManager));
  }

  // 4c. SubAgent → AgentToolLazy
  const allowedSubagentNames = new Set(filtered.subagents);
  for (const def of safeSubagents) {
    if (!allowedSubagentNames.has(def.function!.name)) continue;
    const lazy = new AgentToolLazy({
      function: {
        name: def.function!.name,
        description: def.function!.description || def.description || def.name,
        parameters: def.function!.parameters as any,
      },
      messages: def.messages as any,
      buildAgent: async function (this: any, parsedArgs: any) {
        // TODO: 构建完整 Agent 实例（需要 model、config 等）
        throw new Error("AgentToolLazy buildAgent 未实现 — 需在 resolveAgent 中注入回调");
      },
    });
    result.push(lazy as unknown as Tool);
  }

  // ========================================
  // 5. 去重
  // ========================================
  return { tools: dedupTools(result) };
}

function dedupTools(tools: Tool[]): Tool[] {
  const seen = new Set<string>();
  const result: Tool[] = [];
  for (let i = tools.length - 1; i >= 0; i--) {
    const name = tools[i].function.name;
    if (!seen.has(name)) {
      seen.add(name);
      result.unshift(tools[i]);
    }
  }
  return result;
}
