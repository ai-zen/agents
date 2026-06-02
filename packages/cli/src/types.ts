import { AgentNS } from "@ai-zen/agents-core";

// ==================== 类型定义 ====================

export interface Endpoint {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  description?: string;
}

export interface ModelParams {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  [key: string]: any;
}

export interface Model {
  id: string;
  name: string;
  endpointId: string;
  modelName: string;
  description?: string;
  defaultParams?: ModelParams;
}

/** 图片生成模型配置 */
export interface ImageModel {
  id: string;
  name: string;
  endpointId: string;
  modelName: string;
  description?: string;
  defaultSize?: string;
  defaultQuality?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  modelId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Config {
  endpoints: Endpoint[];
  models: Model[];
  agents: AgentConfig[];
  defaultModel?: string;
  defaultAgent?: string;
  /** 图片生成模型列表 */
  imageModels?: ImageModel[];
  /** 默认图片生成模型 ID */
  defaultImageModel?: string;
}

export interface ConversationData {
  id: string;
  name: string;
  modelId: string;
  agentId?: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentNS.Message[];
  messageCount: number;
}
