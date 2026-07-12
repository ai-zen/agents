import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition } from "../types";

function agentPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * 列出目录下所有 Agent。
 * 跳过非 .json 文件和解析失败的文件。
 */
export function listAgents(dir: string): AgentDefinition[] {
  if (!existsSync(dir)) return [];

  const ids = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  const agents: AgentDefinition[] = [];
  for (const id of ids) {
    const agent = readAgent(dir, id);
    if (agent) agents.push(agent);
  }
  return agents;
}

/**
 * 读取单个 Agent，不存在返回 null。
 */
export function readAgent(dir: string, id: string): AgentDefinition | null {
  const path = agentPath(dir, id);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as AgentDefinition;
  } catch {
    return null;
  }
}

/**
 * 写入 Agent（创建或更新）。
 */
export function writeAgent(dir: string, agent: AgentDefinition): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(agentPath(dir, agent.id), JSON.stringify(agent, null, 2), "utf-8");
}

/**
 * 删除 Agent，不存在时不抛异常。
 */
export function deleteAgent(dir: string, id: string): void {
  const path = agentPath(dir, id);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
