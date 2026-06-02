import { Agent, AgentNS, AgentTool, OpenAI, ChatGPT } from "@ai-zen/agents-core";
import { getModel } from "./models.js";
import { getEndpoint } from "./endpoints.js";
import { readConfig } from "./config.js";
import { allTools } from "./tools/index.js";

// ==================== 模型创建 ====================

async function buildModel(modelId: string) {
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

// ==================== Agent 创建 ====================

export async function createAgent(
  modelId: string,
  messages?: AgentNS.Message[],
): Promise<Agent> {
  // 创建主模型
  const model = await buildModel(modelId);

  // 组装工具列表：文件工具 + 子 Agent 工具
  const tools = [...allTools];

  // 加载子 Agent 工具
  const config = readConfig();
  for (const subConfig of config.subAgents || []) {
    try {
      const subModelId = subConfig.modelId || modelId;
      const subModel = subModelId === modelId
        ? model
        : await buildModel(subModelId);

      // 原样透传 model、function、messages，并赋予文件工具
      const subAgent = new AgentTool({
        model: subModel,
        function: subConfig.function,
        messages: subConfig.messages,
        tools: [...allTools],
      });

      tools.push(subAgent);
    } catch (error: any) {
      console.warn(`⚠️  子 Agent "${subConfig.name}" 加载失败: ${error.message}`);
    }
  }

  // 创建 Agent
  const agent = new Agent({
    model: model,
    messages: messages || [
      {
        role: AgentNS.Role.System,
        content: "完成任务后立即汇报，不要输出多余的内容，不要解释",
      },
    ],
    tools,
  });

  return agent;
}
