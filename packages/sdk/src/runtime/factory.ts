import type { AgentDefinition, AppConfig, Model } from "../types";
import { assembleCapabilities } from "../capabilities/pipeline";
import type { AssemblyOutput } from "../capabilities/pipeline";
import type { DisclosureItem } from "../capabilities/disclosure";

export interface CreateAgentInput {
  definition: AgentDefinition;
  config: AppConfig;
  builtinTools?: string[];
  userTools?: string[];
  subagents?: string[];
  skills?: DisclosureItem[];
  mcps?: DisclosureItem[];
  selfFunctionName?: string;
  callerFunctionName?: string;
  isSkillSubAgent?: boolean;
}

export interface ResolvedAgent {
  definition: AgentDefinition;
  model: Model;
  systemPrompt: string;
  capabilities: AssemblyOutput;
}

/**
 * 从 AgentDefinition 和 AppConfig 组装一个可运行的 Agent。
 * 解析模型、装配能力管线、提取 system prompt。
 */
export function createAgent(input: CreateAgentInput): ResolvedAgent {
  const {
    definition,
    config,
    builtinTools = [],
    userTools = [],
    subagents: rawSubagents = [],
    skills = [],
    mcps = [],
    selfFunctionName,
    callerFunctionName,
    isSkillSubAgent = false,
  } = input;

  const modelId = definition.modelId ?? config.defaultModel;
  if (!modelId) {
    throw new Error("未指定模型且无默认模型");
  }

  const model = config.models.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`模型 "${modelId}" 不存在`);
  }

  const systemMessage = definition.messages.find((m) => m.role === "system");
  const systemPrompt = systemMessage?.content ?? "";

  const permissions = definition.permissions ?? {};

  const capabilities = assembleCapabilities({
    permissions,
    builtinTools,
    userTools,
    subagents: rawSubagents,
    skills,
    mcps,
    selfFunctionName,
    callerFunctionName,
    isSkillSubAgent,
  });

  return {
    definition,
    model,
    systemPrompt,
    capabilities,
  };
}
