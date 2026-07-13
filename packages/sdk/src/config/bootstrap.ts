import type { AgentDefinition } from "../types";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_AGENT_ID = "default";

export const DEFAULT_AGENT_DEFINITION: Omit<AgentDefinition, "createdAt" | "updatedAt"> = {
  id: DEFAULT_AGENT_ID,
  name: "默认助手",
  description: "通用 AI 助手，所有权限已开放",
  messages: [
    {
      role: "system",
      content: "你是一个有用的 AI 助手。",
    },
  ],
  permissions: {
    tools: { allow: ["*"] },
    skills: { allow: ["*"] },
    mcps: { allow: ["*"] },
    subagents: { allow: ["*"] },
  },
};

/**
 * 确保 basePath/agents/ 下至少有一个 Agent。
 *
 * - 如果已有任意 .json 文件（不论是不是 default），不覆盖，返回 null
 * - 如果 agents/ 为空或不存在，写入默认 Agent，返回 AgentDefinition
 * - 如果 default.json 已存在，返回已存在的定义（不覆盖）
 *
 * 返回 null 表示已有其他 agent，无需初始化默认。
 */
export function ensureDefaultAgent(basePath: string): AgentDefinition | null {
  const agentsDir = join(basePath, "agents");
  const defaultPath = join(agentsDir, `${DEFAULT_AGENT_ID}.json`);

  // default.json 已存在 → 返回已有定义，不覆盖
  if (existsSync(defaultPath)) {
    return JSON.parse(readFileSync(defaultPath, "utf-8")) as AgentDefinition;
  }

  // 确保 agents 目录存在
  mkdirSync(agentsDir, { recursive: true });

  // 检查是否有其他 agent
  const existing = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
  if (existing.length > 0) {
    // 已有其他 agent，不写入默认
    return null;
  }

  // 写入默认 Agent
  const now = new Date().toISOString();
  const definition: AgentDefinition = {
    ...DEFAULT_AGENT_DEFINITION,
    createdAt: now,
    updatedAt: now,
  };

  writeFileSync(defaultPath, JSON.stringify(definition, null, 2), "utf-8");

  return definition;
}
