import { AgentNS } from "@ai-zen/agents-core";

// ==================== 类型定义 ====================

export interface Endpoint {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  description?: string;
  version?: number;
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
  version?: number;
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
  version?: number;
}

/** 普通 Agent：用于直接对话 */
export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  /** 预设消息列表（至少包含一条 system 消息） */
  messages: AgentNS.Message[];
  modelId?: string;
  createdAt: string;
  updatedAt: string;
  version?: number;
}

/** 子 Agent 工具：注册到主 Agent，由 LLM 决定何时调用 */
export interface SubAgentConfig {
  id: string;
  name: string;
  /** 预设消息列表（至少包含 system + 最后一条 user 消息含 {{变量}}） */
  messages: AgentNS.Message[];
  modelId?: string;
  /** 工具定义，原样透传给 AgentTool */
  function: {
    name: string;
    description: string;
    parameters: any;
  };
  createdAt: string;
  updatedAt: string;
  version?: number;
}

// ==================== MCP 服务器配置 ====================

/** MCP 服务器传输方式 */
export type McpTransportType = "stdio" | "sse";

/** MCP 服务器配置 */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportType;
  /** stdio 模式：命令 */
  command?: string;
  /** stdio 模式：参数 */
  args?: string[];
  /** stdio 模式：环境变量 */
  env?: Record<string, string>;
  /** stdio 模式：工作目录 */
  cwd?: string;
  /** SSE 模式：URL */
  url?: string;
  /** 是否启用（允许临时禁用而不删除配置） */
  enabled?: boolean;
}

export interface Config {
  endpoints: Endpoint[];
  models: Model[];
  agents: AgentConfig[];
  /** 子 Agent 工具列表 */
  subAgents?: SubAgentConfig[];
  defaultModel?: string;
  defaultAgent?: string;
  /** 图片生成模型列表 */
  imageModels?: ImageModel[];
  /** 默认图片生成模型 ID */
  defaultImageModel?: string;
  /** MCP 服务器列表 */
  mcpServers?: McpServerConfig[];
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
