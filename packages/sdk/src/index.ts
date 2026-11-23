// 类型
export type {
  PermissionPolicy,
  AgentPermissions,
  EndpointDefinition,
  EndpointCapabilities,
  ModelDefinition,
  TokenThresholds,
  ModelParams,
  ReasoningPatch,
  ReasoningPreset,
  ReasoningPresets,
  ImageModelDefinition,
  AgentDefinition,
  AppConfig,
  ToolEnv,
  ToolEnvDeps,
  GenerateImageFn,
  McpIcon,
  McpAnnotations,
  McpToolDef,
  McpResourceDef,
  McpPromptDef,
  McpServerManifest,
  McpServerDefinition,
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
export type { DiscoverSubAgentsOptions } from "./scope/plugins/subagents/discover.js";
export { discoverSkills, readSkill } from "./scope/plugins/skills/discover.js";
export type {
  SkillInfo,
  Frontmatter,
  DiscoverSkillsOptions,
} from "./scope/plugins/skills/discover.js";
export { discoverMcpServers } from "./scope/plugins/mcp/discover.js";
export type { DiscoverMcpServersOptions } from "./scope/plugins/mcp/discover.js";
export { discoverUserTools, discoverUserToolFiles } from "./scope/plugins/usertools/discover.js";
export type { UserToolFile, DiscoverUserToolsOptions } from "./scope/plugins/usertools/discover.js";

// Scope — 全局上下文 + 能力装配编排容器
export { Scope } from "./scope/Scope.js";
export type {
  FilterOutput,
  ExcludeOptions,
  FilterOptions,
  ScopeConfigSource,
} from "./scope/Scope.js";

// ScopePlugin — 能力插件契约 + 标准插件
export type { ScopePlugin, ScopeCandidates } from "./scope/ScopePlugin.js";
export { BuiltinToolsScopePlugin } from "./scope/plugins/builtin/BuiltinToolsScopePlugin.js";
export { UserToolsScopePlugin } from "./scope/plugins/usertools/UserToolsScopePlugin.js";
export { SkillsScopePlugin } from "./scope/plugins/skills/SkillsScopePlugin.js";
export { McpScopePlugin } from "./scope/plugins/mcp/McpScopePlugin.js";
export { SubAgentsScopePlugin } from "./scope/plugins/subagents/SubAgentsScopePlugin.js";
// PeerSession：能力来自宿主注入的端口，不给端口就不产出任何工具
export { PeerSessionsScopePlugin } from "./scope/plugins/peers/PeerSessionsScopePlugin.js";
export {
  PEER_SESSION_TOOL_NAMES,
  CREATE_SESSION_TOOL,
  READ_SESSION_STATUS_TOOL,
  POST_MESSAGE_TOOL,
} from "./scope/plugins/peers/peerSessionTools.js";
export type {
  PeerSessionPort,
  PeerSessionCreated,
  PeerSessionStatus,
  PeerSessionActivity,
  PeerSessionRejectReason,
  PeerSessionCreateInput,
  PeerSessionPosted,
  PeerSessionPostInput,
  PeerSessionSendRejectReason,
} from "./scope/plugins/peers/peerSessionTools.js";
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
export type { ConfigRecoveredHandler } from "./config/ConfigManager.js";

// 出厂资产 — 出厂 Skill（随版本释放到 <basePath>/skills/）
export {
  FACTORY_SKILLS,
  HANDOFF_SKILL_ID,
  FALLBACK_HANDOFF_TEMPLATE,
  isCustomSkill,
} from "./config/factory-skills.js";

// 出厂资产 — 思考策略表（随版本释放到 <basePath>/reasoning-presets.json）
// 表是跨客户端共享的「定义 + 出厂默认」，SDK 不拿它生成请求参数
export { FACTORY_REASONING_PRESETS, REASONING_PRESETS_FILE } from "./config/reasoning-presets.js";

// CRUD — 实体仓储（仅 Agent 定义等能力实体）
export { EntityRepository } from "./shared/EntityRepository.js";
export { AgentRepository } from "./crud/AgentRepository.js";

// 文件 → 内容块（统一入口）：走上传、内联还是直接引用 URL，由它判断
export {
  fileToContentSection,
  resolveModelAndEndpoint,
  supportsFilesApi,
  mimeOf,
  toDataUrl,
  base64ByteLength,
  contentHash,
  MIME_BY_EXT,
  DEFAULT_MAX_INLINE_BYTES,
} from "./shared/content-blocks.js";
export type {
  FileSource,
  FileToSectionInput,
  FileToSectionResult,
  ContentTransport,
  UploadFn,
} from "./shared/content-blocks.js";

// 运行时
export { createModel, createModelFromConfig } from "./runtime/createModel.js";
export type { AgentModel } from "./runtime/createModel.js";
// 一次性模型调用（不流式 / 不带工具）：交接摘要、会话自动标题共用这一份请求体形状
export { completeOnce } from "./runtime/completeOnce.js";
export type { CompleteOnceInput } from "./runtime/completeOnce.js";
export { SdkAgent } from "./runtime/SdkAgent.js";
export type {
  AgentPlugin,
  InnerLoopContext,
  OuterLoopContext,
  SubAgentHookContext,
  ToolHookContext,
} from "./runtime/SdkAgent.js";
export { createAgent } from "./runtime/createAgent.js";
export type { CreateAgentOptions } from "./runtime/createAgent.js";
// 运行时：让 Agent 活着、让它们互相说话（登记、唤醒、发话）
export { AgentRuntime } from "./runtime/AgentRuntime.js";
export type {
  WakeMaterials,
  NewPeerSession,
  OpenPeerSession,
  RuntimePorts,
  RuntimeFact,
  PostResult,
} from "./runtime/AgentRuntime.js";
// Scope 按目录存活：什么时候造、什么时候拆
export { Scopes } from "./runtime/Scopes.js";
export type {
  ScopesDeps,
  ScopeCapabilities,
  ScopeEvent,
  ScopeRefreshFailure,
  ScopeRefreshReport,
} from "./runtime/Scopes.js";
// 模型三级解析（唯一实现）：档位类型也导出，宿主与客户端按它渲染「当前生效档」
export { resolveModel, resolveModelParams } from "./runtime/resolveModel.js";
export type {
  ModelLevel,
  ModelResolutionInput,
  ModelParamsResolutionInput,
  ResolvedModel,
} from "./runtime/resolveModel.js";
export { McpConnectionManager } from "./scope/plugins/mcp/McpConnectionManager.js";
export type { McpConnectOptions } from "./scope/plugins/mcp/McpConnectionManager.js";
export { SdkCallbackTool } from "./scope/plugins/builtin/SdkCallbackTool.js";
export type { SdkCallbackToolOptions } from "./scope/plugins/builtin/SdkCallbackTool.js";
export { HandoffAbortedError, HandoffService } from "./runtime/HandoffService.js";
export type {
  HandoffContext,
  HandoffFact,
  HandoffMode,
  HandoffParams,
  HandoffServiceOptions,
  MemoryCommit,
  MigrateParams,
  MigrationStrategy,
} from "./runtime/HandoffService.js";
export { HandoffGuardPlugin } from "./runtime/HandoffGuardPlugin.js";

// 插件
export { AutoMigratePlugin } from "./agent-plugins/AutoMigratePlugin.js";
export type {
  AutoMigrateOptions,
  AutoMigrateTriggerInfo,
  AutoMigrateModeResolver,
} from "./agent-plugins/AutoMigratePlugin.js";
export {
  AutoRefreshToolsPlugin,
  type AutoRefreshWhen,
} from "./agent-plugins/AutoRefreshToolsPlugin.js";
export { ContextGuardPlugin } from "./agent-plugins/ContextGuardPlugin.js";
export type { ContextGuardOptions } from "./agent-plugins/ContextGuardPlugin.js";
export { UnknownToolHintPlugin } from "./agent-plugins/UnknownToolHintPlugin.js";
export { AssetTransportPlugin } from "./agent-plugins/AssetTransportPlugin.js";
export type { AssetTransportOptions } from "./agent-plugins/AssetTransportPlugin.js";
export { SubAgentGuardInstallerPlugin } from "./agent-plugins/SubAgentGuardInstallerPlugin.js";
export type { SubAgentGuardOptions } from "./agent-plugins/SubAgentGuardInstallerPlugin.js";

// 工具 — 内置工具类 + 动态工具工厂
export { BUILTIN_TOOL_CLASSES } from "./scope/plugins/builtin/index.js";
export {
  CwdTool,
  ReadTool,
  InspectFileTool,
  WriteTool,
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
  SpawnTool,
  SleepTool,
  AsyncExecTool,
  AsyncTimeoutTool,
} from "./scope/plugins/builtin/index.js";
// 两个后台工具的名字：一次性 Agent 手上没有它们（装配期按这份名单剔除）
export {
  ASYNC_TASK_TOOL_NAMES,
  ASYNC_EXEC_TOOL,
  ASYNC_TIMEOUT_TOOL,
} from "./scope/plugins/builtin/asyncTasks.js";
export { GenerateImageTool } from "./scope/plugins/builtin/GenerateImageTool.js";
export { ViewImageTool } from "./scope/plugins/builtin/ViewImageTool.js";
export {
  createLoadSkillTool,
  createCallSkillSubAgentTool,
} from "./scope/plugins/skills/skillTools.js";
export {
  createLoadMcpTool,
  createCallMcpTool,
  createReadMcpResourceTool,
  createGetMcpTaskResultTool,
  createCancelMcpTaskTool,
} from "./scope/plugins/mcp/mcpTools.js";
// MCP 任务：两条工具的名字、终态判定与通知投递口（口由宿主实现）
export {
  GET_MCP_TASK_RESULT_TOOL,
  CANCEL_MCP_TASK_TOOL,
  isTerminalTaskStatus,
} from "./scope/plugins/mcp/mcpTaskNotice.js";
export type {
  McpTaskNotice,
  McpTaskNoticePort,
  McpTaskTerminalStatus,
} from "./scope/plugins/mcp/mcpTaskNotice.js";
export { createSubAgentTool } from "./scope/plugins/subagents/subAgentTools.js";

// 共享
// 日志口：只有类型（谁要用日志，就从参数收一个 `LogSink` 往下传；不注入就不记）
export type { LogSink } from "./shared/logger.js";
export { SdkError, ContextOverflowError } from "./shared/errors.js";
