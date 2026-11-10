import OpenAI from "openai";
import type { Scope } from "../scope/Scope.js";
import type { AppConfig, ModelParams } from "../types/index.js";

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
 *
 * 本体在 {@link createModelFromConfig}：有的调用方（服务端的辅助小请求，如会话自动标题）
 * **只拿到配置、没有 Scope**，而建一个 Scope 会连带拉起 MCP 连接 —— 为了发一次几十 token
 * 的请求去起一套能力发现，代价与收益完全不成比例。两条路共用同一份「模型 → 端点 → client」
 * 解析，否则「Agent 用的端点」与「辅助请求用的端点」迟早是两份会漂的事实。
 */
export function createModel(scope: Scope, modelId: string, overrides?: ModelParams): AgentModel {
  return createModelFromConfig(scope.config, modelId, overrides);
}

/**
 * 从**配置本身**装配模型（不需要 Scope）。
 *
 * 只在「不经过 Agent 的一次性小请求」里用；Agent 一律走 {@link createModel}（它多一层
 * `scope.config` 的取法，两者最终落到这里）。
 */
export function createModelFromConfig(
  config: AppConfig,
  modelId: string,
  overrides?: ModelParams,
): AgentModel {
  const modelConfig = config.models.find((m) => m.id === modelId);
  if (!modelConfig) throw new Error(`Model "${modelId}" not found`);

  const endpointConfig = config.endpoints.find((e) => e.id === modelConfig.endpointId);
  if (!endpointConfig) throw new Error(`Endpoint "${modelConfig.endpointId}" is not configured`);

  if (!endpointConfig.apiKey) {
    throw new Error(`API key for endpoint "${endpointConfig.name}" is not set`);
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
