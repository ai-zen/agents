import type { AppConfig, McpServerConfig } from "../types/index.js";
import type { McpConnectionManager } from "./McpConnectionManager.js";

/**
 * Provider — 全局上下文实例。
 *
 * SDK 不是一个模块工具箱（到处 import 散装函数），而是一个实例，
 * 持有所有全局状态（配置、路径、MCP 管理器等），各层通过它获取所需。
 *
 * 设计原则：
 *   - Provider 实例一旦创建不可变（路径、配置等不变），refresh 时创建新实例
 *   - 各层不直接 import 散装函数，而是通过 Provider 实例获取
 *   - Provider 不关心能力的发现/过滤/实例化，那是 Capabilities 的事
 */
export class Provider {
  /** 应用配置（端点、模型等） */
  readonly config: AppConfig;

  // ---- 路径 ----
  readonly agentsDir: string;
  readonly subAgentsPaths: string[];
  readonly skillsPaths: string[];
  readonly toolsPaths: string[];
  readonly mcpPaths: string[];
  readonly conversationsDir: string;
  readonly draftsDir: string;

  // ---- MCP ----
  readonly mcpManager?: McpConnectionManager;
  readonly mcpConfigs?: Map<string, { name: string; config: McpServerConfig }>;

  constructor(options: {
    config: AppConfig;
    agentsDir: string;
    subAgentsPaths?: string[];
    skillsPaths?: string[];
    toolsPaths?: string[];
    mcpPaths?: string[];
    conversationsDir: string;
    draftsDir: string;
    mcpManager?: McpConnectionManager;
    mcpConfigs?: Map<string, { name: string; config: McpServerConfig }>;
  }) {
    this.config = options.config;
    this.agentsDir = options.agentsDir;
    this.subAgentsPaths = options.subAgentsPaths ?? [];
    this.skillsPaths = options.skillsPaths ?? [];
    this.toolsPaths = options.toolsPaths ?? [];
    this.mcpPaths = options.mcpPaths ?? [];
    this.conversationsDir = options.conversationsDir;
    this.draftsDir = options.draftsDir;
    this.mcpManager = options.mcpManager;
    this.mcpConfigs = options.mcpConfigs;
  }
}
