import type { Tool } from "@ai-zen/agents-core";
import type { AgentDefinition, AgentMessage, AppConfig, Model, McpServerConfig, McpTransport } from "../types";
import type { DisclosureItem } from "../capabilities/disclosure";
import type { McpConnectionManager } from "./mcp-connection";

export interface AssembleAgentInput {
  definition: AgentDefinition;
  config: AppConfig;
  builtinTools?: Tool[];
  userTools?: Tool[];
  subagents?: AgentDefinition[];
  skills?: DisclosureItem[];
  mcps?: DisclosureItem[];
  /** Skill 目录路径列表（供 load_skill / call_skill_sub_agent 回调查找） */
  skillsPaths?: string[];
  /** MCP 连接管理器（供 MCP 动态工具使用） */
  mcpManager?: McpConnectionManager;
  /** MCP server 配置映射 */
  mcpConfigs?: Map<string, { name: string; config: McpServerConfig }>;
  /** MCP transport 工厂 */
  mcpTransportFactory?: (config: McpServerConfig) => McpTransport;
  selfFunctionName?: string;
  callerFunctionName?: string;
  isSkillSubAgent?: boolean;
}

export interface ResolvedAgent {
  /** Agent 原始定义 */
  definition: AgentDefinition;
  /** 解析后的模型配置 */
  model: Model;
  /** 预设消息列表（可直接用于 new Agent） */
  messages: AgentMessage[];
  /** 已过滤、已实例化的工具列表（可直接用于 new Agent） */
  tools: Tool[];
  /** 重新扫描所有路径、重新装配（仅 resolveAgent 返回的实例支持） */
  refresh(): ResolvedAgent;
}
