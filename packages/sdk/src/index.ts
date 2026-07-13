// 类型
export type {
  PermissionPolicy,
  AgentPermissions,
  Endpoint,
  Model,
  AgentDefinition,
  AgentMessage,
  Conversation,
  Draft,
  AppConfig,
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
export { BUILTIN_TOOLS } from "./capabilities/discovery/builtin";
export type { BuiltinToolName } from "./capabilities/discovery/builtin";
export { discoverSubAgents } from "./capabilities/discovery/subagents";
export { discoverSkills, readSkill, parseFrontmatter } from "./capabilities/discovery/skills";
export type { SkillInfo, Frontmatter } from "./capabilities/discovery/skills";
export { discoverMcpServers } from "./capabilities/discovery/mcp";

// 配置
export { readConfig, writeConfig, getDefaultConfig } from "./config/manager";
export { ensureDefaultAgent, DEFAULT_AGENT_ID, DEFAULT_AGENT_DEFINITION } from "./config/bootstrap";

// CRUD
export { listAgents, readAgent, writeAgent, deleteAgent } from "./crud/agents";
export { listConversations, readConversation, writeConversation, deleteConversation } from "./crud/conversations";
export { readDraft, writeDraft, deleteDraft } from "./crud/drafts";

// 运行时
export { createAgent } from "./runtime/factory";
export type { CreateAgentInput, ResolvedAgent } from "./runtime/factory";
export { resolveAgent } from "./runtime/resolve";
export type { ResolveAgentInput } from "./runtime/resolve";
export { createSkillSubAgent } from "./runtime/skill-sub-agent";
export type { CreateSkillSubAgentInput } from "./runtime/skill-sub-agent";
export { McpConnectionManager } from "./runtime/mcp-connection";
export type { McpConnectOptions } from "./runtime/mcp-connection";
export { shouldMigrate, countContextChars, buildMigrationPrompt, HANDOFF_SECTIONS } from "./runtime/task-migration";

// 共享
export { createLogger } from "./shared/logger";
export type { Logger, LogFunctions } from "./shared/logger";
export { SdkError } from "./shared/errors";
