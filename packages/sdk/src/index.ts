// 类型
export type {
  PermissionPolicy,
  AgentPermissions,
  Endpoint,
  Model,
  ImageModel,
  AgentDefinition,
  AgentMessage,
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
  McpTransport,
  McpConnectionState,
} from "./types";

// 能力管线
export { matchPermission } from "./capabilities/permission";
export { filterByPermissions } from "./capabilities/permissions";
export { prefilterSubAgents, prefilterSkillTools } from "./capabilities/prefilter";
export { buildDisclosureParam } from "./capabilities/disclosure";
export type { DisclosureItem, DisclosureParam } from "./capabilities/disclosure";
export { assembleCapabilities } from "./capabilities/pipeline";
export type { AssemblyInput, AssemblyOutput } from "./capabilities/pipeline";

// 发现
export { discoverBuiltinTools } from "./capabilities/discovery/builtin";
export { discoverSubAgents } from "./capabilities/discovery/subagents";
export { discoverSkills, readSkill, parseFrontmatter } from "./capabilities/discovery/skills";
export type { SkillInfo, Frontmatter } from "./capabilities/discovery/skills";
export { discoverMcpServers } from "./capabilities/discovery/mcp";
export { discoverUserTools } from "./capabilities/discovery/usertools";

// 配置
export { readConfig, writeConfig, getDefaultConfig } from "./config/manager";
export { ensureDefaultAgent, DEFAULT_AGENT_ID, DEFAULT_AGENT_DEFINITION } from "./config/bootstrap";

// CRUD
export { listAgents, readAgent, writeAgent, deleteAgent } from "./crud/agents";
export { listConversations, readConversation, writeConversation, deleteConversation } from "./crud/conversations";
export { readDraft, writeDraft, deleteDraft } from "./crud/drafts";

// 运行时
export { assembleAgent } from "./runtime/factory";
export type { AssembleAgentInput, ResolvedAgent } from "./runtime/factory";
export { resolveAgent } from "./runtime/resolve";
export type { ResolveAgentInput } from "./runtime/resolve";
export { createSkillSubAgent } from "./runtime/skill-sub-agent";
export type { CreateSkillSubAgentInput } from "./runtime/skill-sub-agent";
export { McpConnectionManager } from "./runtime/mcp-connection";
export type { McpConnectOptions } from "./runtime/mcp-connection";
export { shouldMigrate, buildMigrationPrompt, HANDOFF_SECTIONS, buildMigrationAgentDefinition, buildPostMigrationMessages } from "./runtime/task-migration";
export type { BuildMigrationAgentOptions } from "./runtime/task-migration";

// 会话运行时
export { createSession } from "./session/session";
export type { Session, SessionBuilder, SessionPlugin, SessionContext } from "./session/types";
export { autoMigrate } from "./session/auto-migrate";
export type { AutoMigrateOptions } from "./session/auto-migrate";
export { autoDraft, checkDraftForRestore } from "./session/auto-draft";
export type { AutoDraftOptions } from "./session/auto-draft";
export { getLastPromptTokens } from "./session/helpers";

// 工具
export { BUILTIN_TOOLS } from "./capabilities/implements/builtin";
export { createGenerateImageTool } from "./capabilities/implements/builtin/generateImage";
export { createLoadSkillTool } from "./capabilities/implements/skill-tools";
export { createLoadMcpTool, createCallMcpTool, createReadMcpResourceTool } from "./capabilities/implements/mcp-tools";

// 共享
export { createLogger } from "./shared/logger";
export type { Logger, LogFunctions } from "./shared/logger";
export { SdkError } from "./shared/errors";
