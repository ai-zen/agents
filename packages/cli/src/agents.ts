import { AgentConfig } from "./types.js";
import { readConfig, saveConfig } from "./config.js";

// ==================== Agent 管理 ====================

export function getAgent(agentId: string): AgentConfig | undefined {
  const config = readConfig();
  return config.agents.find((a) => a.id === agentId);
}

export function getAgents(): AgentConfig[] {
  const config = readConfig();
  return config.agents;
}

export function getDefaultAgent(): AgentConfig | undefined {
  const config = readConfig();
  if (config.defaultAgent) {
    return getAgent(config.defaultAgent);
  }
  return config.agents.length > 0 ? config.agents[0] : undefined;
}

export function setDefaultAgent(agentId: string): void {
  const config = readConfig();
  if (!config.agents.find((a) => a.id === agentId)) {
    throw new Error(`Agent ${agentId} 不存在`);
  }
  config.defaultAgent = agentId;
  saveConfig(config);
}

export function upsertAgent(agent: AgentConfig): void {
  const config = readConfig();
  const index = config.agents.findIndex((a) => a.id === agent.id);
  if (index >= 0) {
    config.agents[index] = agent;
  } else {
    config.agents.push(agent);
  }
  saveConfig(config);
}

export function deleteAgent(agentId: string): void {
  const config = readConfig();
  config.agents = config.agents.filter((a) => a.id !== agentId);
  saveConfig(config);
}
