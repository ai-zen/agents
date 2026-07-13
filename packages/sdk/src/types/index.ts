// ============================================================
// 以下类型均为暂时约定，以后续实际设计为准。
// 来源：docs/sdk-design.md §1-§3
// ============================================================

// ---- 权限（已定稿）----

/** 单维度权限策略：allow 或 deny 互斥 */
export type PermissionPolicy =
  | { allow: string[] }
  | { deny: string[] };

/** Agent 四维度权限 */
export interface AgentPermissions {
  tools?: PermissionPolicy;
  skills?: PermissionPolicy;
  mcps?: PermissionPolicy;
  subagents?: PermissionPolicy;
}

// ---- 核心实体（暂时约定）----

/** API 端点 */
export interface Endpoint {
  id: string; // 唯一标识
  name: string; // 展示名称
  baseUrl: string; // API 地址
  apiKey: string; // API 密钥（明文，文件权限 600 由用户保证）
}

/** 模型配置，绑定一个 Endpoint */
export interface Model {
  id: string; // 唯一标识
  name: string; // 展示名称
  endpointId: string; // 关联 Endpoint.id
  maxContextChars: number; // 上下文窗口上限（字符数近似）
  defaultParams?: Record<string, unknown>; // 模型默认参数（temperature 等）
}

/** Agent 定义，有 function 字段时为 SubAgent */
export interface AgentDefinition {
  id: string; // 唯一标识，文件名 = id.json
  name: string; // 展示名称
  description?: string; // 简短描述（列表展示用）
  messages: AgentMessage[]; // 预设对话（至少一条 system）
  modelId?: string; // 指定模型，不填用默认
  permissions?: AgentPermissions;

  // 以下有则视为 SubAgent
  function?: {
    name: string; // 工具注册名（英文标识）
    description: string; // 工具描述（LLM 据此决定是否调用）
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };

  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  version?: number;
}

/** 预设消息 */
export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string; // SubAgent 的 user content 可用 {{task}} 占位符
}

/** 对话记录 */
export interface Conversation {
  id: string; // 唯一标识
  agentId: string; // 关联 Agent.id
  modelId: string; // 对话使用的模型
  messages: AgentMessage[]; // 完整消息历史
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** 当前会话草稿 */
export interface Draft {
  conversationId?: string; // 已命名对话的 id，未命名为 undefined
  agentId: string;
  modelId: string;
  messages: AgentMessage[];
  updatedAt: string; // ISO 8601
}

// ---- 配置文件（暂时约定）----

/** config.json 结构 */
export interface AppConfig {
  defaultModel?: string; // 默认模型 id
  endpoints: Endpoint[];
  models: Model[];
}

// ---- MCP（已定稿，来自 docs/sdk-design.md §7）----

/** MCP 连接状态 */
export type McpConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** mcp.json 中的单个 server 配置 */
export interface McpServerConfig {
  transport: "stdio" | "http";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http
  url?: string;
  headers?: Record<string, string>;
  // oauth (http only)
  oauth?: {
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scope?: string;
  };
}

/** MCP 连接句柄：上层实现的具体传输 */
export interface McpTransport {
  /** 建立连接，成功返回工具/资源清单 */
  connect(config: McpServerConfig): Promise<McpServerManifest>;
  /** 断开连接 */
  disconnect(): Promise<void>;
  /** 注册 list_changed 回调 */
  onListChanged?: (callback: () => void) => void;
}

/** load_mcp 成功后返回的工具/资源清单 */
export interface McpServerManifest {
  tools: McpToolDef[];
  resources: McpResourceDef[];
}

export interface McpToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface McpResourceDef {
  uri: string;
  description?: string;
}
