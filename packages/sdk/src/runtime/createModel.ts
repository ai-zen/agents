import OpenAI from "openai";
import type { Provider } from "./Provider.js";

/**
 * Agent 模型装配结果：openai SDK client + 模型名 + 模型参数。
 * Agent 构造时直接消费此结构。
 */
export interface AgentModel {
  /** openai 官方 SDK 客户端 */
  client: OpenAI;
  /** 发送给 API 的模型名 */
  model: string;
  /** 模型参数（defaultParams），透传给 API（可含厂商特有字段，如 DeepSeek thinking） */
  modelConfig?: Record<string, unknown>;
}

/**
 * 模型工厂 — 根据 modelId 和 Provider 装配 openai SDK client。
 *
 * 端点（baseUrl / apiKey）来自 config.endpoints，发送给 API 的模型名 = modelName || id。
 * 任何 OpenAI 兼容端点（OpenAI / 智谱 BigModel / DeepSeek 等）均可通过 baseURL 接入。
 */
export function createModel(provider: Provider, modelId: string): AgentModel {
  const config = provider.config;
  const modelConfig = config.models.find((m) => m.id === modelId);
  if (!modelConfig) throw new Error(`模型 "${modelId}" 不存在`);

  const endpointConfig = config.endpoints.find(
    (e) => e.id === modelConfig.endpointId,
  );
  if (!endpointConfig)
    throw new Error(`端点 "${modelConfig.endpointId}" 未配置`);

  if (!endpointConfig.apiKey) {
    throw new Error(`端点 "${endpointConfig.name}" 的 API Key 未设置`);
  }

  const client = new OpenAI({
    apiKey: endpointConfig.apiKey,
    baseURL: endpointConfig.baseUrl,
  });

  // 发送给 API 的模型名：modelName > id
  const apiModelName = modelConfig.modelName || modelConfig.id;

  return {
    client,
    model: apiModelName,
    modelConfig: modelConfig.defaultParams,
  };
}
