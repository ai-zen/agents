import { Agent, AgentNS, Tool, CallbackTool } from "@ai-zen/agents-core";

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
  /** 最大上下文字符长度，用于触发任务迁移阈值（达到 2/3 时自动交接） */
  maxContextChars?: number;
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
  description?: string;
  /** 预设消息列表（至少包含 system + 最后一条 user 消息含 {{变量}}） */
  messages: AgentNS.Message[];
  modelId?: string;
  /** 工具定义，原样透传给 AgentTool */
  function: {
    name: string;
    description: string;
    parameters: any;
  };
  /** 按名称引用全局工具（从 allTools 中匹配） */
  tools?: string[];
  /** 按名称引用 MCP 服务器中的工具 */
  mcpServers?: string[];
  /** 内联注册的自定义工具 */
  extraTools?: SubAgentToolDefinition[];
  createdAt: string;
  updatedAt: string;
  version?: number;
}

/** 子 Agent 文件中内联注册的工具定义 */
export interface SubAgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
  /** 工具回调函数（仅在 JS 文件中有效） */
  callback?: (args: any) => Promise<string>;
}

/**
 * 子 Agent 文件定义（JSON 或 JS default export 的格式）
 * 这是用户编写子 Agent 文件时使用的接口
 */
export interface SubAgentFileDefinition {
  id: string;
  name: string;
  description?: string;
  /** 消息列表，或简写为 system 字符串 + 自动添加 {{query}} */
  messages?: AgentNS.Message[];
  /** 简写：仅提供 system 消息内容 */
  system?: string;
  modelId?: string;
  /** 可选：自定义 function 定义，不提供则自动生成默认 query 参数 */
  function?: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
  /** 按名称引用全局工具 */
  tools?: string[];
  /** 按名称引用 MCP 服务器 */
  mcpServers?: string[];
  /** 内联注册的自定义工具 */
  extraTools?: SubAgentToolDefinition[];
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
  /** @deprecated agents 已迁移到 ~/.ai-zen/agents/ 目录下的独立文件 */
  agents?: AgentConfig[];
  /** 子 Agent 工具列表 */
  subAgents?: SubAgentConfig[];
  defaultModel?: string;
  defaultAgent?: string;
  /** 默认迁移模型 ID（用于任务迁移时生成交接文档，不配置则使用 defaultModel） */
  defaultMigrationModel?: string;
  /** 图片生成模型列表 */
  imageModels?: ImageModel[];
  /** 默认图片生成模型 ID */
  defaultImageModel?: string;
  /** MCP 服务器列表 */
  mcpServers?: McpServerConfig[];
}

/** 已加载的子 Agent（包含已解析的工具列表） */
export interface LoadedSubAgent {
  config: SubAgentConfig;
  /** 已解析的工具引用（Tool 实例） */
  tools: Tool[];
  /** 已解析的 MCP 工具（CallbackTool 实例） */
  mcpTools: CallbackTool[];
}

// ==================== 对话命令相关类型 ====================

/** 对话上下文，由 runConversation 创建并传递给各命令处理函数 */
export interface ConversationContext {
  input: string;
  currentName: string;
  modelId: string;
  currentId: string | undefined;
  agentId: string | undefined;
  running: boolean;
  /** 对话开始时系统提示词列表（不含用户消息），用于重建新会话 */
  systemMessages: AgentNS.Message[];
  /**
   * 命令处理后是否需要继续发送消息。
   * 
   * 默认情况下，命令处理后主循环会跳过发送（continue），等待用户下一次输入。
   * 但某些命令（如 /back 撤回后重发）需要主循环继续执行发送逻辑，
   * 此时命令处理函数应设置 ctx.input 并标记 shouldSend = true。
   */
  shouldSend?: boolean;
}

/**
 * 命令处理函数签名
 * 通过修改 ctx.input 或 ctx.running 来控制主循环行为
 */
export type CommandHandler = (
  agent: Agent,
  ctx: ConversationContext,
) => Promise<void>;

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
