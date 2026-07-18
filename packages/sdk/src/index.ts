// 类型
export type {
  PermissionPolicy,
  AgentPermissions,
  Endpoint,
  Model,
  ImageModel,
  AgentDefinition,
  Conversation,
  Draft,
  AppConfig,
  McpIcon,
  McpAnnotations,
  McpToolDef,
  McpResourceDef,
  McpPromptDef,
  McpServerManifest,
  McpServerConfig,
  McpConnectionState,
} from "./types/index.js";

// 能力管线
export { Capabilities } from "./capabilities/Capabilities.js";
export { PermissionEvaluator } from "./capabilities/PermissionEvaluator.js";
export type { CandidateSets } from "./capabilities/PermissionEvaluator.js";

export { createDisclosureParam } from "./capabilities/disclosure.js";
export type { DisclosureParam } from "./capabilities/disclosure.js";
export type { FilterOutput, ExcludeOptions } from "./capabilities/Capabilities.js";

// 发现
export { discoverBuiltinTools } from "./capabilities/discovery/builtin.js";
export { discoverSubAgents } from "./capabilities/discovery/subagents.js";
export { discoverSkills, readSkill } from "./capabilities/discovery/skills.js";
export type { SkillInfo, Frontmatter } from "./capabilities/discovery/skills.js";
export { discoverMcpServers } from "./capabilities/discovery/mcp.js";
export { discoverUserTools } from "./capabilities/discovery/usertools.js";

// 配置 — ConfigManager
export {
  ConfigManager,
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_DEFINITION,
  DEFAULT_SUBAGENT_ID,
  DEFAULT_SUBAGENT_DEFINITION,
  DEFAULT_APP_CONFIG,
  CONFIG_SUB_DIRS,
} from "./config/ConfigManager.js";

// CRUD — EntityRepository + 实体仓储
export { EntityRepository } from "./shared/EntityRepository.js";
export { AgentRepository } from "./crud/AgentRepository.js";
export { ConversationRepository } from "./crud/ConversationRepository.js";
export { DraftRepository } from "./crud/DraftRepository.js";

// 运行时
export { Provider } from "./runtime/Provider.js";
export { createModel } from "./runtime/createModel.js";
export { SdkAgent } from "./runtime/SdkAgent.js";
export type { AgentPlugin, SendContext } from "./runtime/SdkAgent.js";
export { createAgent } from "./runtime/createAgent.js";
export { McpConnectionManager } from "./runtime/McpConnectionManager.js";
export type { McpConnectOptions } from "./runtime/McpConnectionManager.js";
export { TaskMigrationService } from "./runtime/TaskMigrationService.js";
export type { BuildMigrationAgentOptions } from "./runtime/TaskMigrationService.js";

// 插件
export { AutoMigratePlugin } from "./plugin/AutoMigratePlugin.js";
export type { AutoMigrateOptions } from "./plugin/AutoMigratePlugin.js";
export { AutoDraftPlugin } from "./plugin/AutoDraftPlugin.js";
export type { AutoDraftOptions } from "./plugin/AutoDraftPlugin.js";
export { AutoRefreshToolsPlugin } from "./plugin/AutoRefreshToolsPlugin.js";


// 工具
export { BUILTIN_TOOLS } from "./capabilities/implements/builtin/index.js";
export { createGenerateImageTool } from "./capabilities/implements/builtin/generateImage.js";
export { execAsyncTool } from "./capabilities/implements/builtin/execAsync.js";
export { sleepTool } from "./capabilities/implements/builtin/sleep.js";
export { createLoadSkillTool, createCallSkillSubAgentTool } from "./capabilities/implements/skillTools.js";
export { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./capabilities/implements/mcpTools.js";
export { createSubAgentTool } from "./capabilities/implements/subAgentTools.js";

// 共享
export { createLogger } from "./shared/logger.js";
export type { Logger, LogFunctions } from "./shared/logger.js";
export { SdkError } from "./shared/errors.js";
