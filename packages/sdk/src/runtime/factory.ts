import type { Tool } from "@ai-zen/agents-core";
import type { AgentDefinition, AppConfig, Model, McpServerConfig, McpTransport } from "../types";
import { assembleCapabilities } from "../capabilities/pipeline";
import type { AssemblyOutput } from "../capabilities/pipeline";
import type { DisclosureItem } from "../capabilities/disclosure";
import type { McpConnectionManager } from "../runtime/mcp-connection";
import { createGenerateImageTool } from "../capabilities/implements/builtin/generateImage";

export interface CreateAgentInput {
  definition: AgentDefinition;
  config: AppConfig;
  builtinTools?: Tool[];
  userTools?: Tool[];
  subagents?: AgentDefinition[];
  skills?: DisclosureItem[];
  mcps?: DisclosureItem[];
  /** Skill 目录路径列表 */
  skillsPaths?: string[];
  /** MCP 连接管理器 */
  mcpManager?: McpConnectionManager;
  /** MCP server 配置映射 */
  mcpConfigs?: Map<string, { name: string; config: McpServerConfig }>;
  /** MCP transport 工厂 */
  mcpTransportFactory?: (config: McpServerConfig) => McpTransport;
  selfFunctionName?: string;
  callerFunctionName?: string;
  isSkillSubAgent?: boolean;
}

export interface ResolvedAgent {
  definition: AgentDefinition;
  model: Model;
  capabilities: AssemblyOutput;
}

/**
 * 从 AgentDefinition 和 AppConfig 组装一个可运行的 Agent。
 * 解析模型、装配能力管线。
 */
export function createAgent(input: CreateAgentInput): ResolvedAgent {
  const modelId = input.definition.modelId ?? input.config.defaultModel;
  if (!modelId) {
    throw new Error("未指定模型且无默认模型");
  }

  const model = input.config.models.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`模型 "${modelId}" 不存在`);
  }

  // 如果配置了图片模型，自动注入 generateImage 工具
  let builtinTools = input.builtinTools ?? [];
  const imageModels = (input.config as any).imageModels as any[] | undefined;
  if (imageModels && imageModels.length > 0) {
    // 先检查是否已被用户工具覆盖
    const userToolNames = new Set(
      (input.userTools ?? []).map((t: Tool) => t.function.name),
    );
    const builtinNames = new Set(
      builtinTools.map((t: Tool) => t.function.name),
    );
    if (
      !userToolNames.has("generateImage") &&
      !builtinNames.has("generateImage")
    ) {
      builtinTools = [
        ...builtinTools,
        createGenerateImageTool(input.config),
      ];
    }
  }

  const capabilities = assembleCapabilities({
    permissions: input.definition.permissions ?? {},
    builtinTools,
    userTools: input.userTools ?? [],
    subagents: input.subagents ?? [],
    skills: input.skills ?? [],
    mcps: input.mcps ?? [],
    skillsPaths: input.skillsPaths ?? [],
    mcpManager: input.mcpManager,
    mcpConfigs: input.mcpConfigs,
    mcpTransportFactory: input.mcpTransportFactory,
    selfFunctionName: input.selfFunctionName,
    callerFunctionName: input.callerFunctionName,
    isSkillSubAgent: input.isSkillSubAgent ?? false,
  });

  return {
    definition: input.definition,
    model,
    capabilities,
  };
}
