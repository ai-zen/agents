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

// 配置
export { readConfig, writeConfig, getDefaultConfig } from "./config/manager";

// CRUD
export { listAgents, readAgent, writeAgent, deleteAgent } from "./crud/agents";
export { listConversations, readConversation, writeConversation, deleteConversation } from "./crud/conversations";
export { readDraft, writeDraft, deleteDraft } from "./crud/drafts";

// 运行时
export { createAgent } from "./runtime/factory";
export type { CreateAgentInput, ResolvedAgent } from "./runtime/factory";

// 共享
export { createLogger } from "./shared/logger";
export type { Logger, LogFunctions } from "./shared/logger";
export { SdkError } from "./shared/errors";
