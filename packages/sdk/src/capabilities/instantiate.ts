import type { Tool } from "@ai-zen/agents-core";
import { AgentToolLazy } from "@ai-zen/agents-core";
import type { AgentDefinition, McpServerConfig, McpTransport } from "../types";
import type { DisclosureItem, DisclosureParam } from "./disclosure";
import { buildDisclosureParam } from "./disclosure";
import { createLoadSkillTool, createCallSkillSubAgentTool } from "./implements/skill-tools";
import { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./implements/mcp-tools";
import type { McpConnectionManager } from "../runtime/mcp-connection";

const EMPTY_HINT_SKILL = "（当前没有可用的 Skill，请联系用户添加）";
const EMPTY_HINT_MCP = "（当前没有可用的 MCP 服务器，请联系用户添加）";

export interface InstantiateInput {
  /** 权限过滤后的工具名称列表 */
  allowedTools: string[];
  /** 权限过滤后的 SubAgent 名称列表 */
  allowedSubagents: string[];
  /** 权限过滤后可用的 skill 完整信息 */
  allowedSkills: DisclosureItem[];
  /** 权限过滤后可用的 mcp 完整信息 */
  allowedMcps: DisclosureItem[];

  /** 内置工具实例索引 */
  builtinInstances: Tool[];
  /** 用户工具实例索引 */
  userInstances: Tool[];
  /** SubAgent 完整定义索引 */
  subagentDefs: AgentDefinition[];

  /** Skill 目录路径（给动态工具回调查找） */
  skillsPaths: string[];
  /** MCP 管理器 */
  mcpManager?: McpConnectionManager;
  /** MCP server 配置映射 */
  mcpConfigs?: Map<string, { name: string; config: McpServerConfig }>;
  /** MCP transport 工厂 */
  mcpTransportFactory?: (config: McpServerConfig) => McpTransport;
}

/**
 * 将过滤后的名称映射为 Tool 实例。
 * 不涉及权限判断，只做名称 → 实例的映射。
 */
export function instantiateTools(input: InstantiateInput): Tool[] {
  const {
    allowedTools,
    allowedSubagents,
    allowedSkills,
    allowedMcps,
    builtinInstances,
    userInstances,
    subagentDefs,
    skillsPaths,
    mcpManager,
    mcpConfigs,
    mcpTransportFactory,
  } = input;

  const result: Tool[] = [];
  const allowedToolNames = new Set(allowedTools);

  // 1. 内置 + 用户工具
  for (const t of [...builtinInstances, ...userInstances]) {
    if (allowedToolNames.has(t.function.name)) {
      result.push(t);
    }
  }

  // 2. 构建枚举披露参数
  const skillDisclosure = buildDisclosureParam(
    allowedSkills,
    "选择一个 Skill",
    EMPTY_HINT_SKILL,
  );
  const mcpDisclosure = buildDisclosureParam(
    allowedMcps,
    "选择一个 MCP 服务器",
    EMPTY_HINT_MCP,
  );

  // 3. 动态工具（按条件注册）
  if (allowedToolNames.has("load_skill") && allowedSkills.length > 0) {
    result.push(createLoadSkillTool(skillsPaths, skillDisclosure));
  }
  if (allowedToolNames.has("call_skill_sub_agent") && allowedSkills.length > 0) {
    result.push(createCallSkillSubAgentTool(skillsPaths, skillDisclosure));
  }
  if (allowedToolNames.has("load_mcp") && mcpManager && mcpConfigs && mcpTransportFactory && allowedMcps.length > 0) {
    result.push(createLoadMcpTool(mcpManager, mcpConfigs, mcpDisclosure, mcpTransportFactory));
  }
  if (allowedToolNames.has("call_mcp_tool") && mcpManager) {
    result.push(createCallMcpTool(mcpManager));
  }
  if (allowedToolNames.has("read_mcp_resource") && mcpManager) {
    result.push(createReadMcpResourceTool(mcpManager));
  }

  // 4. SubAgent → AgentToolLazy
  const allowedSubagentSet = new Set(allowedSubagents);
  for (const def of subagentDefs) {
    if (!def.function || !allowedSubagentSet.has(def.function.name)) continue;
    const lazy = new AgentToolLazy({
      function: {
        name: def.function.name,
        description: def.function.description || def.description || def.name,
        parameters: def.function.parameters as any,
      },
      messages: def.messages as any,
      buildAgent: async function (this: any, parsedArgs: any) {
        // TODO: 构建完整 Agent 实例（需要 model、config 等）
        throw new Error("AgentToolLazy buildAgent 未实现 — 需在 resolveAgent 中注入回调");
      },
    });
    result.push(lazy as unknown as Tool);
  }

  // 5. 去重（后注册覆盖先注册）
  return dedupTools(result);
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
