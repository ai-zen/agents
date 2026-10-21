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

/**
 * 端点能力声明 —— 决定「本地文件 → 内容块」时走哪条传输路径。
 *
 * 之前这段判断硬编码在 ViewImageTool 里（`endpoint.id === "deepseek"`），
 * 用户改一下端点 id 就失效；改为显式能力位后，新端点只要声明能力即可享受上传。
 */
export interface EndpointCapabilities {
  /**
   * 是否支持 OpenAI 兼容的 Files API（`POST {baseUrl}/files`，`purpose=user_data`）。
   * 为 true 时本地文件优先上传并以 `file` 块（file_id）发送；否则走 base64 内联。
   */
  filesApi?: boolean;
}

// ---- 模型参数覆盖 ----

/**
 * 模型请求参数（`defaultParams` / `modelParams` 的形状）。
 *
 * 含厂商特有字段（`thinking` / `reasoning_effort` 等），SDK **原样透传**、不解释。
 */
export type ModelParams = Record<string, unknown>;

// ---- 思考预设（reasoning presets）----

/**
 * 单个档位的请求参数补丁。
 *
 * 各家协议差异全部关在补丁里，不硬编码任何键名：
 *   OpenAI   → `{ reasoning_effort: "high" }`（没有 `thinking` 参数）
 *   DeepSeek → `{ thinking: { type: "enabled" }, reasoning_effort: "high" }`
 *   关闭     → `{ reasoning_effort: "none" }` 或 `{ thinking: { type: "disabled" } }`
 */
export type ReasoningPatch = ModelParams;

/**
 * 一个具名思考策略：档位名 → 参数补丁。
 *
 * `levels` 的键集合**就是**该策略的全部可选档位 —— 没有单独的「能否关闭思考」字段：
 * 表里有 `off` 键就能关，没有就不能（如智谱 GLM-5.3 系，官方原文「其余输入将报错」）。
 */
export interface ReasoningPreset {
  /** 用户改过 → SDK 初始化不再覆盖该策略（与 `Model.custom` 同构） */
  custom?: boolean;
  /** 档位名 → 参数补丁 */
  levels: Record<string, ReasoningPatch>;
}

/**
 * 思考策略表 —— `<basePath>/reasoning-presets.json` 的结构，出厂内容见
 * `config/reasoning-presets.ts`。
 *
 * 这份表是 **CLI / 桌面端等客户端共享的资产**：它定义「有哪些档位、每档写什么参数」，
 * 由 `Model.reasoningPreset` 引用。客户端据此限制可选强度、把选中的档位展开成参数
 * 写进 `AgentDefinition.modelParams`。
 *
 * **SDK 自身不消费它生成请求参数**：参数合并只是 `{...defaultParams, ...modelParams}`
 * 一次浅合并（见 `createModel`）。表在这里只负责「定义 + 出厂默认 + 读写」。
 */
export type ReasoningPresets = Record<string, ReasoningPreset>;

/** API 端点 */
export interface Endpoint {
  id: string; // 唯一标识
  name: string; // 展示名称
  baseUrl: string; // API 地址
  apiKey: string; // API 密钥（明文，文件权限 600 由用户保证）
  description?: string; // 描述
  capabilities?: EndpointCapabilities; // 能力声明（可选，缺省视为无特殊能力）
}

/**
 * 上下文用量阈值 —— 与模型的真实窗口无关，只描述「用量到了这条线该怎么办」。
 *
 * 两个阈值语义不同，消费方也不同：
 *   - `handoff`：软线。`AutoMigratePlugin` 在响应返回后拿 `usage.prompt_tokens` 比它，
 *     超过即触发任务交接（交接本身还要再发 1~2 次请求，所以这条线必须留足余量）。
 *   - `guard`：硬线。`ContextGuardPlugin` 在**每次请求前**比它，超过即抛
 *     `ContextOverflowError` 中断本轮——这是最后一道保护，宁可报错也不要发出必然失败的请求。
 *
 * 建议 `guard ≈ handoff × 1.5`，给交接留出缓冲；两者都是绝对值，配置里写多少就是多少，
 * 不做任何倍数换算（阈值就该是能直接读懂的数字）。
 */
export interface TokenThresholds {
  /** 交接阈值（软线）：prompt_tokens 超过它 → 触发任务交接 */
  handoff: number;
  /** 强行阻断阈值（硬线）：请求前用量超过它 → 中断本轮并报错 */
  guard: number;
}

/** 模型配置，绑定一个 Endpoint */
export interface Model {
  id: string; // 唯一标识
  name: string; // 展示名称
  endpointId: string; // 关联 Endpoint.id
  modelName?: string; // 发送给 API 的模型名称（不填则用 id）
  /**
   * 上下文用量阈值（交接软线 + 阻断硬线）。**不是**模型的真实上下文窗口。
   *
   * 历史字段 `maxContextTokens` / `maxContextChars` 已由 `config/migrate.ts`
   * 迁移成这个结构体并删除。
   */
  tokenThresholds: TokenThresholds;
  defaultParams?: Record<string, unknown>; // 模型默认参数（temperature 等）
  /**
   * 思考策略名，引用 `reasoning-presets.json` 里的键。
   *
   * 它是**跨客户端共享的元数据**：CLI / 桌面端据此判断这个模型能选哪几档。
   * SDK 不拿它去生成请求参数（那条路只有 `defaultParams` + `modelParams` 浅合并），
   * 只保证该字段能随模型配置一起读写与出厂同步。
   */
  reasoningPreset?: string;
  /** 是否支持图片输入（视觉模型）。看图工具（view_image）仅对视觉模型启用；generate_image 是否返回图片内容块也据此判断 */
  vision?: boolean;
  description?: string; // 描述
  version?: number;
  /**
   * 是否用户自定义。
   *
   * 为 true 时 SDK 初始化不会用出厂定义替换该模型；缺省（或 false）视为出厂托管，
   * 初始化时会与 DEFAULT_APP_CONFIG.models 同步（出厂清单为准）。
   */
  custom?: boolean;
}

/** Agent 定义，有 function 字段时为 SubAgent */
export interface AgentDefinition {
  id: string; // 唯一标识，文件名 = id.json
  name: string; // 展示名称
  description?: string; // 简短描述（列表展示用）
  messages: AgentNS.Message[]; // 预设对话（至少一条 system）
  /**
   * 绑定模型 id —— **运行期唯一真相源**。
   *
   * 缺省即「无模型可用」，`createAgent` 会直接报错；不存在配置层的 `defaultModel`
   * 兜底，也不存在会话级的模型记录。要换模型就改这里（`/model` 写的就是它）。
   */
  modelId?: string;
  /**
   * Agent 级模型参数覆盖，浅合并进模型的 `defaultParams`。
   *
   * SDK 只做 `{ ...model.defaultParams, ...modelParams }`，不解释任何键名、不做
   * 档位推导、不知道厂商差异。於是「配置即事实」：应用（如 CLI）在**写入配置时**就把
   * 档位展开成具体参数存在这里，运行时不再查表。
   *
   * 于是同一个模型可以给不同 Agent 配不同强度（编程 Agent `reasoning_effort: "max"`、
   * 闲聊 Agent `{ thinking: { type: "disabled" } }`），而模型自身的 `defaultParams` 不动。
   */
  modelParams?: ModelParams;
  permissions?: AgentPermissions;

  // 以下有则视为 SubAgent
  function?: AgentNS.FunctionDefine;

  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  version?: number;
  /**
   * 是否用户自定义。
   *
   * 为 true 时 SDK 初始化不会同步/替换该 Agent 的内置内容（如默认提示词）；
   * 缺省（或为 false）时，初始化会以出厂定义同步其提示词，其余字段保留。
   */
  custom?: boolean;
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
  /**
   * 是否用户自定义。
   *
   * 为 true 时 SDK 初始化不会用出厂定义替换该模型；缺省（或 false）视为出厂托管，
   * 初始化时会与 DEFAULT_APP_CONFIG.imageModels 同步（出厂清单为准）。
   */
  custom?: boolean;
}

/** config.json 结构 */
export interface AppConfig {
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
  /**
   * 工具输出上限（字符数），缺省取 32768。
   *
   * 工具本次输出超过该值时，由工具自身的保护策略处置（落盘或仅警告），
   * 避免超长输出撑爆上下文。仅作用于"输出"，与工具的读取阈值无关
   * （如 read/find_text 对 300KB 文件的读取上限）。
   */
  maxToolOutput?: number;
}

// ---- 工具环境 ----

/**
 * 工具环境 — Scope 的能力插件在实例化内置工具时注入的环境信息。
 *
 * cwd 是相对路径解析的基准（每个 Scope 对应一个工作目录）；
 * config 供需要模型/端点配置的工具（如 generate_image）使用。
 */
export interface ToolEnv {
  /** 当前工作目录 */
  cwd: string;
  /** 应用配置 */
  config: AppConfig;
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
  /** 服务器描述（供 load_mcp 呈现给 LLM，非连接必需） */
  description?: string;
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
 * 现在由 @modelcontextprotocol/sdk 内置的 StdioClientTransport、
 * StreamableHTTPClientTransport（http）和 SSEClientTransport（sse）实现，
 * 不再需要外部注入。
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
