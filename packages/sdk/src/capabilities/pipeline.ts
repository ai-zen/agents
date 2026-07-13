import type { AgentPermissions } from "../types";
import { filterByPermissions } from "./permissions";
import { prefilterSubAgents, prefilterSkillTools } from "./prefilter";
import { buildDisclosureParam } from "./disclosure";
import type { DisclosureParam, DisclosureItem } from "./disclosure";

const DYNAMIC_TOOLS = [
  "load_skill",
  "call_skill_sub_agent",
  "load_mcp",
  "call_mcp_tool",
  "read_mcp_resource",
];

export interface AssemblyInput {
  permissions: AgentPermissions;
  builtinTools?: string[];
  userTools?: string[];
  subagents?: string[];
  skills?: DisclosureItem[];
  mcps?: DisclosureItem[];
  selfFunctionName?: string;
  callerFunctionName?: string;
  isSkillSubAgent?: boolean;
}

export interface AssemblyOutput {
  tools: string[];
  subagents: string[];
  skillParam: DisclosureParam;
  mcpParam: DisclosureParam;
}

const EMPTY_HINT_SKILL = "（当前没有可用的 Skill，请联系用户添加）";
const EMPTY_HINT_MCP = "（当前没有可用的 MCP 服务器，请联系用户添加）";

/**
 * 能力装配管线：权限过滤 + 安全预过滤 + 枚举披露，一站式输出。
 */
export function assembleCapabilities(input: AssemblyInput): AssemblyOutput {
  const {
    permissions,
    builtinTools = [],
    userTools = [],
    subagents: rawSubagents = [],
    skills: rawSkills = [],
    mcps: rawMcps = [],
    selfFunctionName,
    callerFunctionName,
    isSkillSubAgent = false,
  } = input;

  // 1. 安全预过滤
  const safeSubagents = prefilterSubAgents(rawSubagents, selfFunctionName, callerFunctionName);

  // 2. 组装工具候选：内置 + 用户 + 动态加载工具
  let toolCandidates = [...builtinTools, ...userTools, ...DYNAMIC_TOOLS];
  if (isSkillSubAgent) {
    toolCandidates = prefilterSkillTools(toolCandidates);
  }

  // 3. 四维度权限过滤
  const filtered = filterByPermissions(permissions, {
    tools: toolCandidates,
    skills: rawSkills.map((s) => s.id),
    mcps: rawMcps.map((m) => m.id),
    subagents: safeSubagents,
  });

  // 4. 枚举披露：按已过滤的 skill/mcp id 列表筛选出完整 item
  const allowedSkillIds = new Set(filtered.skills);
  const allowedMcpIds = new Set(filtered.mcps);

  const skillParam = buildDisclosureParam(
    rawSkills.filter((s) => allowedSkillIds.has(s.id)),
    "选择一个 Skill",
    EMPTY_HINT_SKILL,
  );

  const mcpParam = buildDisclosureParam(
    rawMcps.filter((m) => allowedMcpIds.has(m.id)),
    "选择一个 MCP 服务器",
    EMPTY_HINT_MCP,
  );

  return {
    tools: filtered.tools,
    subagents: filtered.subagents,
    skillParam,
    mcpParam,
  };
}
