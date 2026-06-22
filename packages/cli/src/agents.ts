import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { AgentConfig } from "./types.js";
import { AGENTS_DIR, readConfig, saveConfig } from "./config.js";

// ==================== 文件系统 Agent 管理 ====================

/**
 * 获取单个 Agent 配置（从文件系统读取）
 * 每次调用都重新读取文件，保证最新
 */
export function getAgent(agentId: string): AgentConfig | undefined {
  const filePath = join(AGENTS_DIR, `${agentId}.json`);
  if (!existsSync(filePath)) return undefined;
  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * 获取所有 Agent 列表（从文件系统扫描）
 * 每次调用都重新扫描目录，保证最新
 */
export function getAgents(): AgentConfig[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const agents: AgentConfig[] = [];
  const files = readdirSync(AGENTS_DIR);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = readFileSync(join(AGENTS_DIR, file), "utf-8");
      const agent = JSON.parse(content) as AgentConfig;
      agents.push(agent);
    } catch {
      // 跳过损坏的文件
      continue;
    }
  }

  // 按创建时间排序
  agents.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return agents;
}

/**
 * 获取默认 Agent
 * defaultAgent 字段存的是 ID，指向 agents/ 目录下的文件
 */
export function getDefaultAgent(): AgentConfig | undefined {
  const config = readConfig();
  if (config.defaultAgent) {
    return getAgent(config.defaultAgent);
  }
  const agents = getAgents();
  return agents.length > 0 ? agents[0] : undefined;
}

/**
 * 设置默认 Agent
 */
export function setDefaultAgent(agentId: string): void {
  const config = readConfig();
  if (!getAgent(agentId)) {
    throw new Error(`Agent ${agentId} 不存在`);
  }
  config.defaultAgent = agentId;
  saveConfig(config);
}

/**
 * 新增或更新 Agent（写文件）
 */
export function upsertAgent(agent: AgentConfig): void {
  const filePath = join(AGENTS_DIR, `${agent.id}.json`);
  writeFileSync(filePath, JSON.stringify(agent, null, 2), "utf-8");
}

/**
 * 删除 Agent（删文件）
 */
export function deleteAgent(agentId: string): void {
  const filePath = join(AGENTS_DIR, `${agentId}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
  // 如果删除的是默认 Agent，清除 defaultAgent 引用
  const config = readConfig();
  if (config.defaultAgent === agentId) {
    config.defaultAgent = "";
    saveConfig(config);
  }
}
