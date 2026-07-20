// ============================================================
// 以下类型均为暂时约定，以后续实际设计为准。
// 来源：docs/sdk-design.md §1-§3
// ============================================================

import type { AgentNS } from "@ai-zen/agents-core";

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
  description?: string; // 描述
}

/** 模型配置，绑定一个 Endpoint */
export interface Model {
  id: string; // 唯一标识
  name: string; // 展示名称
  endpointId: string; // 关联 Endpoint.id
  modelName?: string; // 发送给 API 的模型名称（不填则用 id）
  maxContextTokens: number; // 上下文窗口 token 上限
  maxContextChars?: number; // 旧版字符数阈值（兼容迁移）
  defaultParams?: Record<string, unknown>; // 模型默认参数（temperature 等）
  description?: string; // 描述
  version?: number;
}

/** Agent 定义，有 function 字段时为 SubAgent */
export interface AgentDefinition {
  id: string; // 唯一标识，文件名 = id.json
  name: string; // 展示名称
  description?: string; // 简短描述（列表展示用）
  messages: AgentNS.Message[]; // 预设对话（至少一条 system）
  modelId?: string; // 指定模型，不填用默认
  permissions?: AgentPermissions;

  // 以下有则视为 SubAgent
  function?: AgentNS.FunctionDefine;

  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  version?: number;
}

/** 对话记录 */
export interface Conversation {
  id: string; // 唯一标识
  agentId: string; // 关联 Agent.id
  modelId: string; // 对话使用的模型
  messages: AgentNS.Message[]; // 完整消息历史
  lastPromptTokens?: number; // 最近一轮 API 返回的 usage.prompt_tokens
  cwd?: string; // 对话开始时的当前工作目录
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** 当前会话草稿 */
export interface Draft {
  conversationId?: string; // 已命名对话的 id，未命名为 undefined
  agentId: string;
  modelId: string;
  messages: AgentNS.Message[];
  cwd?: string; // 对话开始时的当前工作目录
  updatedAt: string; // ISO 8601
}

// ---- 配置文件（暂时约定）----

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

/** config.json 结构 */
export interface AppConfig {
  defaultModel?: string; // 默认模型 id
  endpoints: Endpoint[];
  models: Model[];
  /** 图片生成模型列表 */
  imageModels?: ImageModel[];
  /** 默认图片生成模型 ID */
  defaultImageModel?: string;
  /** 默认 Agent ID（CLI/Desktop 使用） */
  defaultAgent?: string;
  /** 默认迁移模型 ID */
  defaultMigrationModel?: string;
}

// ---- MCP（已定稿，来自 docs/sdk-design.md §7）----

/** MCP 连接状态 */
export type McpConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** MCP 服务器配置 */
export interface McpServerConfig {
  id: string;
  /** transport 类型，内部统一使用 "stdio" | "http" | "sse" */
  transport: "stdio" | "http" | "sse";
  /** 是否禁用，默认为 false */
  disabled?: boolean;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse
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

/**
 * MCP 底层传输适配器（已废弃）。
 *
 * 现在由 @modelcontextprotocol/sdk 内置的 StdioClientTransport 和
 * StreamableHTTPClientTransport 实现，不再需要外部注入。
 *
 * McpConnectionManager 内部使用官方 SDK 的 Transport 接口，
 * 上层无需关心 transport 实现细节。
 *
 * @deprecated 改用 @modelcontextprotocol/sdk 的 Transport
 */

// ---- MCP 共享子类型 ----

/** 图标（MCP 规范 §Icons） */
export interface McpIcon {
  src: string;             // HTTP/HTTPS URL 或 data: URI
  mimeType?: string;       // 如 "image/png"
  sizes?: string[];        // 如 ["48x48"]、["any"]
  theme?: "light" | "dark";
}

/** 注解（MCP 规范 §Annotations） */
export interface McpAnnotations {
  audience?: ("user" | "assistant")[];
  priority?: number;       // 0.0-1.0
  lastModified?: string;   // ISO 8601
}

// ---- MCP Server Manifest ----

/** load_mcp 成功后返回的工具/资源/提示清单 */
export interface McpServerManifest {
  tools: McpToolDef[];
  resources: McpResourceDef[];
  prompts?: McpPromptDef[];
}

/** 工具定义（MCP 规范 §Tools） */
export interface McpToolDef {
  name: string;                      // 唯一标识
  title?: string;                    // 展示名称
  description: string;               // 功能描述
  icons?: McpIcon[];                 // UI 图标
  inputSchema: Record<string, unknown>;  // 参数 JSON Schema（原 parameters）
  outputSchema?: Record<string, unknown>; // 输出 JSON Schema
  annotations?: McpAnnotations;      // 行为元数据
  execution?: {                      // 任务增强执行
    taskSupport?: "forbidden" | "optional" | "required";
  };
}

/** 资源定义（MCP 规范 §Resources） */
export interface McpResourceDef {
  uri: string;                       // 资源 URI
  name: string;                      // 展示名称
  description?: string;              // 描述
  mimeType?: string;                 // MIME 类型
  size?: number;                     // 字节大小
  icons?: McpIcon[];
  annotations?: McpAnnotations;
}

/** 提示模板定义（MCP 规范 §Prompts） */
export interface McpPromptDef {
  name: string;                      // 唯一标识
  title?: string;                    // 展示名称
  description?: string;              // 描述
  arguments?: {                      // 参数列表
    name: string;
    description?: string;
    required?: boolean;
  }[];
}
