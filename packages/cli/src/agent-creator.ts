import chalk from "chalk";
import { Agent, AgentNS, AgentTool, OpenAI, ChatGPT, CallbackTool, Tool } from "@ai-zen/agents-core";
import { getModel } from "./models.js";
import { getEndpoint } from "./endpoints.js";
import { readConfig } from "./config.js";
import { allTools } from "./tools/index.js";
import { startAllMcpServers } from "./mcp-manager.js";
import { discoverSubAgents, resolveSubAgentTools } from "./sub-agent-loader.js";
import { SubAgentConfig } from "./types.js";
import { buildLoadSkillFunction, loadSkillContent } from "./skill-loader.js";
import { discoverUserTools } from "./tool-loader.js";

// ==================== 模型创建 ====================

export async function buildModel(modelId: string) {
  const modelConfig = getModel(modelId);
  if (!modelConfig) {
    throw new Error(`模型 ${modelId} 不存在`);
  }

  const endpointConfig = getEndpoint(modelConfig.endpointId);
  if (!endpointConfig) {
    throw new Error(`端点 ${modelConfig.endpointId} 不存在，请先配置端点`);
  }

  if (!endpointConfig.apiKey) {
    throw new Error(
      `端点 ${endpointConfig.name} 的 API Key 未设置，请使用 "aiz config set-key" 设置`,
    );
  }

  const endpoint = new OpenAI({
    openai_endpoint: endpointConfig.baseUrl,
    api_key: endpointConfig.apiKey,
  });

  const model = new ChatGPT({
    model_config: modelConfig.defaultParams,
    request_config: await endpoint.chatCompletion(modelConfig.modelName),
  });

  return model;
}

// ==================== 工具去重合并 ====================

/**
 * 将新工具合并到 Agent 的工具列表中，按 function.name 去重。
 * 同名工具以新为准（覆盖），新工具追加。
 */
function mergeTools(agentTools: Tool[], newTools: Tool[]): void {
  for (const newTool of newTools) {
    const index = agentTools.findIndex(
      (t) => t.function.name === newTool.function.name,
    );
    if (index >= 0) {
      agentTools[index] = newTool;
    } else {
      agentTools.push(newTool);
    }
  }
}

// ==================== 构建子 Agent 工具 ====================

/**
 * 根据子 Agent 配置构建 AgentTool 实例
 */
async function buildSubAgentTool(
  subConfig: SubAgentConfig,
  defaultModelId: string,
  defaultModel: any,
): Promise<AgentTool | null> {
  try {
    const subModelId = subConfig.modelId || defaultModelId;
    const subModel = subModelId === defaultModelId
      ? defaultModel
      : await buildModel(subModelId);

    const { tools: subTools, mcpTools: subMcpTools } = resolveSubAgentTools(subConfig);

    const allSubTools: CallbackTool[] = [];
    if (subConfig.tools && subConfig.tools.length > 0) {
      allSubTools.push(...subTools);
    } else if (!subConfig.tools && !subConfig.extraTools && !subConfig.mcpServers) {
      allSubTools.push(...allTools);
    } else {
      allSubTools.push(...subTools);
    }
    allSubTools.push(...subMcpTools);

    return new AgentTool({
      model: subModel,
      function: subConfig.function,
      messages: subConfig.messages,
      tools: allSubTools,
    });
  } catch (error: any) {
    console.warn(`⚠️  子 Agent "${subConfig.name}" 加载失败: ${error.message}`);
    return null;
  }
}

/**
 * 获取所有子 Agent 配置（文件系统 + config.json 向后兼容）
 */
async function getAllSubAgentConfigs(): Promise<SubAgentConfig[]> {
  const configs: SubAgentConfig[] = [];

  const discovered = await discoverSubAgents();
  configs.push(...discovered);

  const config = readConfig();
  for (const subConfig of config.subAgents || []) {
    if (!configs.find((a) => a.id === subConfig.id)) {
      configs.push(subConfig);
    }
  }

  return configs;
}

// ==================== 构建 load_skill 工具 ====================

/**
 * 创建 load_skill 工具实例
 * function 定义（含 enum）每次重新生成，确保 Skill 列表最新
 */
function createLoadSkillTool(): CallbackTool {
  return new CallbackTool({
    function: buildLoadSkillFunction(),
    callback(this, args: { skill_id: string }) {
      const content = loadSkillContent(args.skill_id);
      if (!content) {
        return `❌ Skill "${args.skill_id}" 不存在，请确认文件名是否正确`;
      }
      this.agent.messages.push({
        role: AgentNS.Role.System,
        content: `以下是 Skill "${args.skill_id}" 的内容，请按照其中的指导完成任务：\n\n${content}`,
      });
      return `✅ Skill "${args.skill_id}" 已加载，内容已附加到当前对话中`;
    },
  });
}

// ==================== 构建完整工具列表 ====================

/**
 * 构建 Agent 的完整工具列表
 * 包含：内置工具 + 用户自定义工具 + 子 Agent + MCP 工具 + load_skill
 */
async function buildToolList(
  defaultModel: any,
  defaultModelId: string,
): Promise<Tool[]> {
  const tools: Tool[] = [...allTools];

  // 1. 用户自定义工具
  const userTools = await discoverUserTools();
  tools.push(...userTools);

  // 2. 子 Agent
  const subAgentConfigs = await getAllSubAgentConfigs();
  for (const subConfig of subAgentConfigs) {
    const subAgent = await buildSubAgentTool(subConfig, defaultModelId, defaultModel);
    if (subAgent) tools.push(subAgent);
  }

  // 3. MCP 工具（长连接，启动时连接一次，后续复用）
  const mcpTools = await startAllMcpServers();
  if (mcpTools.length > 0) {
    console.log(chalk.green(`  ✅ MCP 工具已加载: ${mcpTools.length} 个`));
  }
  tools.push(...mcpTools);

  // 4. load_skill
  tools.push(createLoadSkillTool());

  return tools;
}

// ==================== Agent 创建 ====================

export async function createAgent(
  modelId: string,
  messages?: AgentNS.Message[],
): Promise<Agent> {
  // 创建主模型
  const model = await buildModel(modelId);

  // 构建初始工具列表
  const tools = await buildToolList(model, modelId);

  // 创建 Agent，并设置 onBeforeSend 钩子
  // 每次请求前刷新文件系统中的资源（用户工具、子 Agent、Skill 列表），
  // 确保工具定义始终是最新的。
  // MCP 工具是长连接，只在启动时连接一次，不在此刷新。
  const agent = new Agent({
    model: model,
    messages: messages || [
      {
        role: AgentNS.Role.System,
        content: "你是一个AI助手，专门帮助用户回答问题和执行任务。请用中文回复。",
      },
    ],
    tools,
    onBeforeSend: async () => {
      // 1. 刷新用户自定义工具（文件系统，轻量操作）
      const freshUserTools = await discoverUserTools();
      mergeTools(agent.tools, freshUserTools);

      // 2. 刷新子 Agent（文件系统，轻量操作）
      const freshSubConfigs = await getAllSubAgentConfigs();
      for (const subConfig of freshSubConfigs) {
        const subAgent = await buildSubAgentTool(subConfig, modelId, model);
        if (subAgent) mergeTools(agent.tools, [subAgent]);
      }

      // 3. 刷新 load_skill 工具定义，更新可用 Skill 枚举列表
      mergeTools(agent.tools, [createLoadSkillTool()]);

      // 注意：MCP 工具是长连接，不在每次请求前刷新。
      // 如需重连，调用 mcp-manager 的 reloadAllMcpServers()
    },
  });

  return agent;
}
