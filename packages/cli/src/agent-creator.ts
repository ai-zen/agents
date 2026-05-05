import { Agent, AgentNS, OpenAI, ChatGPT } from "@ai-zen/agents-core";
import chalk from "chalk";
import { ModelParams } from "./types.js";
import { getModel } from "./models.js";
import { getEndpoint } from "./endpoints.js";
import { allTools } from "./tools.js";

// ==================== Agent 创建 ====================

export async function createAgent(
  modelId: string,
  messages?: AgentNS.Message[],
  overrideParams?: ModelParams,
): Promise<Agent> {
  // 获取模型配置
  const modelConfig = getModel(modelId);
  if (!modelConfig) {
    throw new Error(`模型 ${modelId} 不存在`);
  }

  // 获取端点配置
  const endpointConfig = getEndpoint(modelConfig.endpointId);
  if (!endpointConfig) {
    throw new Error(`端点 ${modelConfig.endpointId} 不存在，请先配置端点`);
  }

  // 检查 API Key
  if (!endpointConfig.apiKey) {
    throw new Error(
      `端点 ${endpointConfig.name} 的 API Key 未设置，请使用 "aiz config set-key" 设置`,
    );
  }

  // 创建 OpenAI 端点
  const endpoint = new OpenAI({
    openai_endpoint: endpointConfig.baseUrl,
    api_key: endpointConfig.apiKey,
  });

  // 合并参数
  const mergedParams = {
    ...modelConfig.defaultParams,
    ...overrideParams,
  };

  // 创建模型
  const model = new ChatGPT({
    model_config: mergedParams,
    request_config: await endpoint.chatCompletion(modelConfig.modelName),
  });

  // 创建 Agent
  const agent = new Agent({
    model: model,
    messages: messages || [
      {
        role: AgentNS.Role.System,
        content: "完成任务后立即汇报，不要输出多余的内容，不要解释",
      },
    ],
    tools: [...allTools],
  });

  agent.events.on("run", (messages: AgentNS.Message[]) => {
    const lastMessage = messages[messages.length - 2];
    if (lastMessage?.tool_calls?.length || lastMessage?.function_call) {
      console.log(
        "\n",
        chalk.yellowBright(`🔧 执行工具: `),
        "\n",
        lastMessage,
        "\n",
      );
    }

    const lastToolMessage = messages[messages.length - 1];
    if (lastToolMessage?.role === "tool") {
      console.log(
        "\n",
        chalk.yellowBright(`🔧 工具输出: `),
        "\n",
        lastToolMessage,
        "\n",
      );
    }
  });

  return agent;
}
