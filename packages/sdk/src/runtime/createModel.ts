import { OpenAI, ChatGPT } from "@ai-zen/agents-core";
import type { ChatCompletionModel } from "@ai-zen/agents-core";
import type { Provider } from "./Provider.js";

/**
 * 模型工厂 — 根据 modelId 和 Provider 构建 Core ChatCompletionModel。
 *
 * 同步版本，使用 endp​oint.chatCompletionSync() 避免不必要的 async。
 */
export function createModel(
  provider: Provider,
  modelId: string,
): ChatCompletionModel {
  const config = provider.config;
  const modelConfig = config.models.find((m) => m.id === modelId);
  if (!modelConfig) throw new Error(`模型 "${modelId}" 不存在`);

  const endpointConfig = config.endpoints.find(
    (e) => e.id === modelConfig.endpointId,
  );
  if (!endpointConfig)
    throw new Error(`端点 "${modelConfig.endpointId}" 未配置`);

  const endpoint = new OpenAI({
    openai_endpoint: endpointConfig.baseUrl,
    api_key: endpointConfig.apiKey,
  });

  // 发送给 API 的模型名：modelName > id
  const apiModelName = modelConfig.modelName || modelConfig.id;

  const model = new ChatGPT({
    model_config: modelConfig.defaultParams,
    request_config: endpoint.chatCompletionSync(apiModelName),
  });

  return model;
}
