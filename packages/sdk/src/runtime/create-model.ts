import { OpenAI, ChatGPT } from "@ai-zen/agents-core";
import type { ChatCompletionModel } from "@ai-zen/agents-core";
import type { AppConfig } from "../types";

/**
 * 模型工厂 — 根据 modelId 和 config 构建 Core ChatCompletionModel。
 *
 * 属于独立的 runtime 子层，不依赖 capabilities/ 或其他模块。
 * 通过 Provider 实例获取 AppConfig 后调用。
 *
 * 改为同步版本，使用 endp​oint.chatCompletionSync() 避免不必要的 async。
 */
export function createModel(
  config: AppConfig,
  modelId: string,
): ChatCompletionModel {
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

  const model = new ChatGPT({
    model_config: modelConfig.defaultParams,
    request_config: endpoint.chatCompletionSync(modelConfig.name),
  });

  return model;
}
