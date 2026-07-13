import type { AgentDefinition, AppConfig } from "../types";
import { readAgent } from "../crud/agents";
import { discoverSubAgents } from "../capabilities/discovery/subagents";
import { discoverSkills } from "../capabilities/discovery/skills";
import { discoverMcpServers } from "../capabilities/discovery/mcp";
import { BUILTIN_TOOLS } from "../capabilities/discovery/builtin";
import { createAgent } from "./factory";
import type { CreateAgentInput, ResolvedAgent } from "./factory";

export interface ResolveAgentInput {
  agentId: string;
  config: AppConfig;
  agentsDir: string;
  subAgentsDir?: string;
  skillsDir?: string;
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
    subAgentsDir,
    skillsDir,
    mcpPaths = [],
  } = input;

  const definition = readAgent(agentsDir, agentId);
  if (!definition) {
    throw new Error(`Agent "${agentId}" 不存在`);
  }

  const subagents = subAgentsDir ? discoverSubAgents(subAgentsDir) : [];
  const skills = skillsDir ? discoverSkills(skillsDir) : [];
  const mcps = discoverMcpServers(mcpPaths);

  const createInput: CreateAgentInput = {
    definition,
    config,
    builtinTools: [...BUILTIN_TOOLS],
    subagents: subagents.map((s) => s.id),
    skills,
    mcps,
  };

  return createAgent(createInput);
}
