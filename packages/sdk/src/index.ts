// 类型
export type {
  PermissionPolicy,
  AgentPermissions,
  Endpoint,
  Model,
  ImageModel,
  AgentDefinition,
  AppConfig,
  ToolEnv,
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
export { PermissionEvaluator } from "./capabilities/PermissionEvaluator.js";
export type { CandidateSets } from "./capabilities/PermissionEvaluator.js";

export { createDisclosureParam } from "./capabilities/disclosure.js";
export type { DisclosureParam } from "./capabilities/disclosure.js";

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
  DEFAULT_MCP_CONFIG,
  CONFIG_SUB_DIRS,
} from "./config/ConfigManager.js";

// CRUD — 实体仓储（仅 Agent 定义等能力实体）
export { EntityRepository } from "./shared/EntityRepository.js";
export { AgentRepository } from "./crud/AgentRepository.js";

// 运行时
export { Provider } from "./runtime/Provider.js";
export type { FilterOutput, ExcludeOptions } from "./runtime/Provider.js";
export { createModel } from "./runtime/createModel.js";
export { SdkAgent } from "./runtime/SdkAgent.js";
export type { AgentPlugin, SendContext } from "./runtime/SdkAgent.js";
export { createAgent } from "./runtime/createAgent.js";
export { McpConnectionManager } from "./runtime/McpConnectionManager.js";
export type { McpConnectOptions } from "./runtime/McpConnectionManager.js";
export { SdkCallbackTool } from "./runtime/SdkCallbackTool.js";
export type { SdkCallbackToolOptions } from "./runtime/SdkCallbackTool.js";
export { TaskMigrationService } from "./runtime/TaskMigrationService.js";
export type {
  MigrationContext,
  TaskMigrationServiceOptions,
} from "./runtime/TaskMigrationService.js";

// 插件
export { AutoMigratePlugin } from "./plugin/AutoMigratePlugin.js";
export type { AutoMigrateOptions } from "./plugin/AutoMigratePlugin.js";
export { AutoRefreshToolsPlugin } from "./plugin/AutoRefreshToolsPlugin.js";
export { ContextGuardPlugin } from "./plugin/ContextGuardPlugin.js";
export type { ContextGuardOptions } from "./plugin/ContextGuardPlugin.js";
export { UnknownToolHintPlugin } from "./plugin/UnknownToolHintPlugin.js";

// 工具 — 内置工具类 + 动态工具工厂
export { BUILTIN_TOOL_CLASSES } from "./capabilities/implements/builtin/index.js";
export {
  CwdTool,
  ReadFileTool,
  WriteFileTool,
  ExecTool,
  MkdirTool,
  RmTool,
  GlobTool,
  LsTool,
  ExistTool,
  FindTextTool,
  DownloadFileTool,
  RenameTool,
  CopyTool,
  BatchEditTool,
  EditTool,
  ExecAsyncTool,
  SleepTool,
} from "./capabilities/implements/builtin/index.js";
export { GenerateImageTool } from "./capabilities/implements/builtin/GenerateImageTool.js";
export { ViewImageTool } from "./capabilities/implements/builtin/ViewImageTool.js";
export { createLoadSkillTool, createCallSkillSubAgentTool } from "./capabilities/implements/skillTools.js";
export { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./capabilities/implements/mcpTools.js";
export { createSubAgentTool } from "./capabilities/implements/subAgentTools.js";

// 共享
export { getLogger, setLogger } from "./shared/logger.js";
export type { Logger, LogFunctions } from "./shared/logger.js";
export { SdkError, ContextOverflowError } from "./shared/errors.js";
