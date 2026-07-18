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
export { Capabilities } from "./capabilities/capabilities.js";
export { matchPermission } from "./capabilities/permission.js";
export { filterByPermissions } from "./capabilities/permissions.js";

export { buildDisclosureParam } from "./capabilities/disclosure.js";
export type { DisclosureItem, DisclosureParam } from "./capabilities/disclosure.js";
export type { FilterOutput } from "./capabilities/capabilities.js";


// 发现
export { discoverBuiltinTools } from "./capabilities/discovery/builtin.js";
export { discoverSubAgents } from "./capabilities/discovery/subagents.js";
export { discoverSkills, readSkill, parseFrontmatter } from "./capabilities/discovery/skills.js";
export type { SkillInfo, Frontmatter } from "./capabilities/discovery/skills.js";
export { discoverMcpServers } from "./capabilities/discovery/mcp.js";
export { discoverUserTools } from "./capabilities/discovery/usertools.js";

// 配置
export { readConfig, writeConfig, getDefaultConfig } from "./config/manager.js";
export { ensureDefaultAgent, ensureConfigDirs, DEFAULT_AGENT_ID, DEFAULT_AGENT_DEFINITION, CONFIG_SUB_DIRS } from "./config/bootstrap.js";

// CRUD
export { listAgents, readAgent, writeAgent, deleteAgent } from "./crud/agents.js";
export { listConversations, readConversation, writeConversation, deleteConversation } from "./crud/conversations.js";
export { readDraft, writeDraft, deleteDraft } from "./crud/drafts.js";

// 运行时
export { Provider } from "./runtime/runtime.js";
export { createModel } from "./runtime/create-model.js";
export { SdkAgent } from "./runtime/sdk-agent.js";
export type { AgentPlugin, SendContext } from "./runtime/sdk-agent.js";
export { createAgent } from "./runtime/create-agent.js";
export { McpConnectionManager } from "./runtime/mcp-connection.js";
export type { McpConnectOptions } from "./runtime/mcp-connection.js";
export { shouldMigrate, buildMigrationPrompt, HANDOFF_SECTIONS, buildMigrationAgentDefinition, buildPostMigrationMessages } from "./runtime/task-migration.js";
export type { BuildMigrationAgentOptions } from "./runtime/task-migration.js";

// 插件（Agent 原生插件机制）
export { autoMigrate } from "./plugin/auto-migrate.js";
export type { AutoMigrateOptions } from "./plugin/auto-migrate.js";
export { autoDraft, checkDraftForRestore } from "./plugin/auto-draft.js";
export type { AutoDraftOptions } from "./plugin/auto-draft.js";
export { autoRefreshTools } from "./plugin/auto-refresh-tools.js";
export { getLastPromptTokens } from "./plugin/helpers.js";

// 工具
export { BUILTIN_TOOLS } from "./capabilities/implements/builtin/index.js";
export { createGenerateImageTool } from "./capabilities/implements/builtin/generateImage.js";
export { createLoadSkillTool, createCallSkillSubAgentTool } from "./capabilities/implements/skill-tools.js";
export { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./capabilities/implements/mcp-tools.js";
export { createSubAgentTool } from "./capabilities/implements/sub-agents-tools.js";

// 共享
export { createLogger } from "./shared/logger.js";
export type { Logger, LogFunctions } from "./shared/logger.js";
export { SdkError } from "./shared/errors.js";

