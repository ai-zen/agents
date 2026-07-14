import type { AgentDefinition, AgentPermissions, AppConfig } from "../types";
import { Tool } from "@ai-zen/agents-core";
import type { SkillInfo } from "../capabilities/discovery/skills";
import type { DisclosureItem } from "../capabilities/disclosure";
import { assembleAgent } from "./factory";
import type { ResolvedAgent } from "./factory";

export interface CreateSkillSubAgentInput {
  skill: SkillInfo;
  task: string;
  config: AppConfig;
  callerPermissions: AgentPermissions;
  builtinTools?: Tool[];
  userTools?: Tool[];
  subagents?: AgentDefinition[];
  skills?: DisclosureItem[];
  mcps?: DisclosureItem[];
}

/**
 * 以 Skill 正文作为 system prompt，创建临时 Agent（Skill 子 Agent）。
 *
 * - 继承调用者的 permissions
 * - isSkillSubAgent=true 预过滤 call_skill_sub_agent / load_skill（防递归）
 * - skill.subAgent 必须为 true，否则抛异常
 */
export function createSkillSubAgent(input: CreateSkillSubAgentInput): ResolvedAgent {
  const {
    skill,
    task,
    config,
    callerPermissions,
    builtinTools = [],
    userTools = [],
    subagents = [],
    skills = [],
    mcps = [],
  } = input;

  if (!skill.subAgent) {
    throw new Error(`Skill "${skill.id}" 不支持子 Agent 模式，请使用 load_skill 加载指导后自行处理`);
  }

  const now = new Date().toISOString();
  const definition: AgentDefinition = {
    id: `skill-sub-${skill.id}`,
    name: `Skill: ${skill.name}`,
    description: skill.description,
    messages: [
      { role: "system", content: skill.content },
      { role: "user", content: task },
    ],
    permissions: callerPermissions,
    createdAt: now,
    updatedAt: now,
  };

  return assembleAgent({
    definition,
    config,
    builtinTools,
    userTools,
    subagents,
    skills,
    mcps,
    isSkillSubAgent: true,
    selfFunctionName: `skill-sub-${skill.id}`,
  });
}
