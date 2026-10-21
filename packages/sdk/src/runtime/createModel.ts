import OpenAI from "openai";
import type { Scope } from "../scope/Scope.js";
import type { ModelParams } from "../types/index.js";

/**
 * Agent 模型装配结果：openai SDK client + 模型名 + 模型参数。
 * Agent 构造时直接消费此结构。
 */
export interface AgentModel {
  /** openai SDK 客户端 */
  client: OpenAI;
  /** 发送给 API 的模型名 */
  model: string;
  /** 模型参数，透传给 API（可含厂商特有字段，如 DeepSeek thinking） */
  modelConfig?: ModelParams;
}

/**
 * 参数覆盖 —— 浅合并，一行。
 *
 * 这是 SDK 对「模型参数」的唯一处理逻辑：不解释键名、不做档位推导、不知道厂商差异。
 * 需要多层次语义（如「思考档位」）的应用，应该在**写配置时**就把档位展开成具体参数，
 * 存进 `Model.defaultParams` / `AgentDefinition.modelParams`，运行期不再查表。
 *
 * 没有覆盖时返回原对象（保持 `undefined` 语义，避免凭空塞一个空对象）。
 */
function mergeParams(
  base: ModelParams | undefined,
  overrides: ModelParams | undefined,
): ModelParams | undefined {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  return { ...base, ...overrides };
}

/**
 * 模型工厂 — 根据 modelId 和 Scope 装配 openai SDK client。
 *
 * 端点（baseUrl / apiKey）来自 config.endpoints，发送给 API 的模型名 = modelName || id。
 * 任何 OpenAI 兼容端点（OpenAI / 智谱 BigModel / DeepSeek 等）均可通过 baseURL 接入。
 *
 * `overrides` 是 **Agent 级参数覆盖**（`AgentDefinition.modelParams`）：
 * 同一个模型可以给不同 Agent 配不同参数，而模型自身的 `defaultParams` 保持不变。
 */
export function createModel(
  scope: Scope,
  modelId: string,
  overrides?: ModelParams,
): AgentModel {
  const config = scope.config;
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
    modelConfig: mergeParams(modelConfig.defaultParams, overrides),
  };
}
