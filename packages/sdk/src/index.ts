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
export { PermissionEvaluator } from "./scope/PermissionEvaluator.js";
export type { CandidateSets } from "./scope/PermissionEvaluator.js";

export { createDisclosureParam } from "./scope/disclosure.js";
export type { DisclosureParam } from "./scope/disclosure.js";

// 发现
export { discoverBuiltinTools } from "./scope/plugins/builtin/discover.js";
export { discoverSubAgents } from "./scope/plugins/subagents/discover.js";
export { discoverSkills, readSkill } from "./scope/plugins/skills/discover.js";
export type { SkillInfo, Frontmatter } from "./scope/plugins/skills/discover.js";
export { discoverMcpServers } from "./scope/plugins/mcp/discover.js";
export { discoverUserTools } from "./scope/plugins/usertools/discover.js";

// Scope — 全局上下文 + 能力装配编排容器
export { Scope } from "./scope/Scope.js";
export type {
  FilterOutput,
  ExcludeOptions,
  FilterOptions,
} from "./scope/Scope.js";

// ScopePlugin — 能力插件契约 + 标准插件
export type { ScopePlugin, ScopeCandidates } from "./scope/ScopePlugin.js";
export { BuiltinToolsScopePlugin } from "./scope/plugins/builtin/BuiltinToolsScopePlugin.js";
export { UserToolsScopePlugin } from "./scope/plugins/usertools/UserToolsScopePlugin.js";
export { SkillsScopePlugin } from "./scope/plugins/skills/SkillsScopePlugin.js";
export { McpScopePlugin } from "./scope/plugins/mcp/McpScopePlugin.js";
export { SubAgentsScopePlugin } from "./scope/plugins/subagents/SubAgentsScopePlugin.js";
export { allInOne } from "./scope/plugins/allInOne.js";
export type { AllInOneOptions } from "./scope/plugins/allInOne.js";

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
export { createModel } from "./runtime/createModel.js";
export { SdkAgent } from "./runtime/SdkAgent.js";
export type { AgentPlugin, SendContext } from "./runtime/SdkAgent.js";
export { createAgent } from "./runtime/createAgent.js";
export { McpConnectionManager } from "./scope/plugins/mcp/McpConnectionManager.js";
export type { McpConnectOptions } from "./scope/plugins/mcp/McpConnectionManager.js";
export { SdkCallbackTool } from "./scope/plugins/builtin/SdkCallbackTool.js";
export type { SdkCallbackToolOptions } from "./scope/plugins/builtin/SdkCallbackTool.js";
export { TaskMigrationService } from "./runtime/TaskMigrationService.js";
export type {
  MigrationContext,
  MigrationStrategy,
  TaskMigrationServiceOptions,
} from "./runtime/TaskMigrationService.js";

// 插件
export { AutoMigratePlugin } from "./agent-plugins/AutoMigratePlugin.js";
export type { AutoMigrateOptions } from "./agent-plugins/AutoMigratePlugin.js";
export { AutoRefreshToolsPlugin } from "./agent-plugins/AutoRefreshToolsPlugin.js";
export { ContextGuardPlugin } from "./agent-plugins/ContextGuardPlugin.js";
export type { ContextGuardOptions } from "./agent-plugins/ContextGuardPlugin.js";
export { UnknownToolHintPlugin } from "./agent-plugins/UnknownToolHintPlugin.js";

// 工具 — 内置工具类 + 动态工具工厂
export { BUILTIN_TOOL_CLASSES } from "./scope/plugins/builtin/index.js";
export {
  CwdTool,
  ReadFileTool,
  InspectFileTool,
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
} from "./scope/plugins/builtin/index.js";
export { GenerateImageTool } from "./scope/plugins/builtin/GenerateImageTool.js";
export { ViewImageTool } from "./scope/plugins/builtin/ViewImageTool.js";
export { createLoadSkillTool, createCallSkillSubAgentTool } from "./scope/plugins/skills/skillTools.js";
export { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./scope/plugins/mcp/mcpTools.js";
export { createSubAgentTool } from "./scope/plugins/subagents/subAgentTools.js";

// 共享
export { getLogger, setLogger } from "./shared/logger.js";
export type { Logger, LogFunctions } from "./shared/logger.js";
export { SdkError, ContextOverflowError } from "./shared/errors.js";
