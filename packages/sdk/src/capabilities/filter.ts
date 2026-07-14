import type { AgentDefinition, AgentPermissions } from "../types";
import { filterByPermissions } from "./permissions";
import type { CandidateSets } from "./permissions";
import { prefilterSubAgents, prefilterSkillTools } from "./prefilter";

/**
 * 工具候选名称按条件拼接，包含安全预过滤。
 * 安全预过滤在权限过滤之前执行，不受权限配置影响。
 */
const DYNAMIC_TOOL_NAMES = [
  "load_skill",
  "call_skill_sub_agent",
  "load_mcp",
  "call_mcp_tool",
  "read_mcp_resource",
];

export interface FilterInput {
  permissions: AgentPermissions;
  builtinNames: string[];
  userNames: string[];
  subagents: AgentDefinition[];
  skillIds: string[];
  mcpIds: string[];
  selfFunctionName?: string;
  callerFunctionName?: string;
  isSkillSubAgent?: boolean;
}

export interface FilterOutput {
  /** 过滤后允许的工具名称 */
  tools: string[];
  /** 过滤后允许的 SubAgent 名称 */
  subagents: string[];
  /** 过滤后允许的 skill id */
  skills: string[];
  /** 过滤后允许的 mcp id */
  mcps: string[];
}

/**
 * 安全预过滤 + 权限过滤，纯名称操作，不涉及 Tool 实例。
 * 输出过滤后的名称列表，供 instantiateTools 消费。
 */
export function filterCapabilities(input: FilterInput): FilterOutput {
  const {
    permissions,
    builtinNames,
    userNames,
    subagents: rawSubagents,
    skillIds,
    mcpIds,
    selfFunctionName,
    callerFunctionName,
    isSkillSubAgent = false,
  } = input;

  // 1. 安全预过滤（SubAgent 递归保护）
  const safeSubagents = prefilterSubAgents(rawSubagents, selfFunctionName, callerFunctionName);

  // 2. 拼装工具候选名称
  let toolNames = [...builtinNames, ...userNames, ...DYNAMIC_TOOL_NAMES];
  if (isSkillSubAgent) {
    toolNames = prefilterSkillTools(toolNames);
  }

  // 3. 权限过滤（纯名称匹配）
  const candidates: CandidateSets = {
    tools: toolNames,
    skills: skillIds,
    mcps: mcpIds,
    subagents: safeSubagents.map((d) => d.function!.name),
  };

  const filtered = filterByPermissions(permissions, candidates);

  return {
    tools: filtered.tools,
    subagents: filtered.subagents,
    skills: filtered.skills,
    mcps: filtered.mcps,
  };
}
