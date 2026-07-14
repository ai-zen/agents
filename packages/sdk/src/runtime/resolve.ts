import type { AgentDefinition, AppConfig } from "../types";
import { readAgent } from "../crud/agents";
import { discoverSubAgents } from "../capabilities/discovery/subagents";
import { discoverSkills } from "../capabilities/discovery/skills";
import { discoverMcpServers } from "../capabilities/discovery/mcp";
import { discoverUserTools } from "../capabilities/discovery/usertools";
import { discoverBuiltinTools } from "../capabilities/discovery/builtin";
import { createAgent } from "./factory";
import type { CreateAgentInput, ResolvedAgent } from "./factory";

export interface ResolveAgentInput {
  agentId: string;
  config: AppConfig;
  agentsDir: string;
  subAgentsPaths?: string[];
  skillsPaths?: string[];
  toolsPaths?: string[];
  mcpPaths?: string[];
}

/**
 * 从磁盘完整装配 Agent：加载定义 → 发现候选 → 组装。
 */
export function resolveAgent(input: ResolveAgentInput): ResolvedAgent {
  const {
    agentId,
    config,
    agentsDir,
    subAgentsPaths = [],
    skillsPaths = [],
    toolsPaths = [],
    mcpPaths = [],
  } = input;

  const definition = readAgent(agentsDir, agentId);
  if (!definition) {
    throw new Error(`Agent "${agentId}" 不存在`);
  }

  const createInput: CreateAgentInput = {
    definition,
    config,
    builtinTools: discoverBuiltinTools(),
    userTools: discoverUserTools(toolsPaths),
    subagents: discoverSubAgents(subAgentsPaths),
    skills: discoverSkills(skillsPaths),
    mcps: discoverMcpServers(mcpPaths),
  };

  return createAgent(createInput);
}
