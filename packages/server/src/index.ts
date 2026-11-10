/**
 * @ai-zen/agents-server — 会话/工作区服务层。
 *
 * 定位：**客户端无关**的业务层。CLI（TUI）与 Desktop 都只做「渲染 + 输入」，会话编排、
 * 能力装配、持久化、迁移都在这里。
 *
 * 依赖方向（单向，永不反向）：
 *
 *   @ai-zen/cli ─────┐
 *                    ├──→ @ai-zen/agents-server ──→ @ai-zen/agents-sdk ──→ @ai-zen/agents-core
 *   desktop/main ────┘
 *
 * 两条硬约束（可用 grep 检验，命令见 README）：
 *   1. 本包**不得**依赖任何 UI 栈（ink / react / 终端库）——包边界就是进程边界；
 *   2. 本包**不得**读进程级全局（当前工作目录、全局配置路径、全局 locale）——
 *      一切从构造参数来，否则「局部可实例化」和「一个进程服务多个工作区」同时破产。
 *      唯一例外是 `src/cli.ts`（组装根）：它允许读 env/argv，但必须当场转成注入值。
 *      （该检查的正则写在 README 里；这里刻意不把字面量写进源码，否则 grep 会命中注释本身。）
 */

export {
  PhaseTracker,
  pendingToolCalls,
  type PhaseInfo,
  type PhaseKind,
  type PhaseMessageLike,
  type ToolCallRef,
} from "./service/progress/PhaseTracker.js";

// ---- 会话存储与工作区（服务端的产品数据层） ----
export {
  type SessionRecord,
  type SessionStore,
  type SessionRef,
  type SessionPointer,
} from "./service/store/SessionStore.js";
export {
  FileSessionStore,
  type FileSessionStoreOptions,
} from "./service/store/FileSessionStore.js";
export {
  migrateLegacySessions,
  type LegacyMigrationOptions,
  type LegacyMigrationResult,
} from "./service/store/legacyMigration.js";
export {
  ensureWorkspace,
  readWorkspace,
  workspaceIdFor,
  type Workspace,
} from "./service/workspace/workspace.js";
export {
  FileIndex,
  DEFAULT_EXCLUDES,
  INDEX_TTL_MS,
  MAX_ENTRIES,
  SCAN_TIMEOUT_MS,
  type FileIndexDeps,
} from "./service/workspace/FileIndex.js";
export { EventHub } from "./service/events/EventHub.js";

// ---- 会话编排与事件（服务端真正「跑一轮对话」的那一层） ----
export {
  SessionManager,
  type AgentLike,
  type SubAgentLike,
  type CreateAgentInput,
  type SessionAttachInput,
  type SessionCreateInput,
  type SessionManagerOptions,
} from "./service/session/SessionManager.js";
export { createSessionHandlers, type SessionHandlerOptions } from "./daemon/sessionHandlers.js";
export { createAgentHandlers, type AgentHandlerOptions } from "./daemon/agentHandlers.js";
export {
  SessionHandoff,
  isHandoffAborted,
  type HandoffAgentLike,
  type HandoffOutcome,
  type SessionHandoffOptions,
} from "./service/handoff/SessionHandoff.js";
// 自动标题：生成器（只发那一次请求）与会话层（时机 / 落盘 / 事件 / 超时）分开导出，
// 组装根要的是前者，测会话层要的是后者的注入点
export {
  createAutoTitle,
  type AutoTitleFn,
  type AutoTitleOptions,
  type AutoTitleRequest,
} from "./service/session/AutoTitle.js";
export {
  EVENT_METHODS,
  SESSION_EVENTS,
  SESSION_METHODS,
  WORKSPACE_METHODS,
  DEFAULT_MIGRATION_STRATEGY,
  type MessageDeltaEvent,
  type SessionAnswerParams,
  type SessionAnswerResult,
  type SessionAttachParams,
  type SessionAttachResult,
  type SessionCancelParams,
  type SessionCancelResult,
  type SessionCreateParams,
  type SessionCreateResult,
  type ServerEvent,
  type SessionListParams,
  type SessionSnapshotParams,
  type SessionListEntry,
  type SessionListResult,
  type SessionRenameParams,
  type SessionRenameResult,
  type SessionRemoveParams,
  type SessionRemoveResult,
  type SessionRollbackParams,
  type SessionRollbackResult,
  type SessionReloadParams,
  type SessionSetAgentParams,
  type SessionSetAgentResult,
  type SessionCloseParams,
  type SessionCloseResult,
  type SessionKeepAliveSetParams,
  type SessionKeepAliveSetResult,
  type SessionSaveParams,
  type SessionSaveResult,
  type SessionSaveAsParams,
  type SessionSaveAsResult,
  type SessionSnapshotResult,
  type ModelLevel,
  type MigrationStrategy,
  type SessionModelSetParams,
  type SessionModelSetResult,
  type SessionPhaseEvent,
  type SessionQuestionEvent,
  type SessionQuestionKind,
  type SessionSendParams,
  type SessionSendResult,
  type SessionNoticeCode,
  type SessionNoticeEvent,
  type GlobalNoticeCode,
  type GlobalNoticeEvent,
  type HandoffMode,
  type MessageContent,
  type MessageContentBlock,
  type NoticeLevel,
  type NoticePayload,
  GLOBAL_NOTICE_CODES,
  SESSION_NOTICE_CODES,
  type SessionHandoffParams,
  type SessionHandoffResult,
  type SessionIdChangedEvent,
  type SessionTitleChangedEvent,
  type SubAgentStartedEvent,
  type SubAgentEndedEvent,
  type SubAgentSnapshotParams,
  type SubAgentSnapshotResult,
  type SessionMigrateParams,
  type SessionMigrateResult,
  type TurnEndEvent,
  type SessionLastParams,
  type SessionLastResult,
  type WorkspaceFilesParams,
  type WorkspaceFileEntry,
  type WorkspaceFilesResult,
  type WorkspaceResolveParams,
  type WorkspaceResolveResult,
} from "./protocol/sessions.js";

// ---- 配置与管理面（客户端的配置中心要用；不属于某一段会话，所以不在 session.* 下） ----
export {
  CONFIG_METHODS,
  AGENT_METHODS,
  type AgentGetParams,
  type AgentGetResult,
  type AgentKind,
  type AgentListResult,
  type AgentRemoveParams,
  type AgentRemoveResult,
  type AgentSaveParams,
  type AgentSaveResult,
  type AgentSetModelParams,
  type AgentSetModelResult,
  type ConfigGetResult,
  type ConfigMcpGetParams,
  type ConfigMcpGetResult,
  type ConfigMcpSaveParams,
  type ConfigMcpSaveResult,
  type ConfigReasoningPresetsResult,
  type ConfigSaveParams,
  type ConfigSaveResult,
  type ConfigSetDefaultAgentParams,
  type ConfigSetDefaultAgentResult,
  type ConfigSetDefaultModelParams,
  type ConfigSetDefaultModelResult,
  type McpScope,
} from "./protocol/config.js";
export { ConfigService, type ConfigServiceOptions } from "./service/config/ConfigService.js";
export { createConfigHandlers, type ConfigHandlerOptions } from "./daemon/configHandlers.js";

// ---- 守护进程与协议（客户端只需要协议类型 + Daemon 用于进程内嵌入/测试） ----
export {
  Daemon,
  type Connection,
  type DaemonOptions,
  type MethodHandler,
} from "./daemon/Daemon.js";
export {
  descriptorPath,
  isProcessAlive,
  readDescriptor,
  removeDescriptor,
  writeDescriptor,
  type ServerDescriptor,
} from "./daemon/discovery.js";
export { isLoopbackHost } from "./daemon/host.js";
export {
  encodeFrame,
  FrameDecoder,
  MAX_FRAME_BYTES,
  ProtocolError,
  type ProtocolErrorCode,
} from "./protocol/frames.js";
export {
  PROTOCOL_VERSION,
  isHelloRequest,
  isRequestFrame,
  type EventFrame,
  type ErrorFrame,
  type HelloRequest,
  type HelloResponse,
  type RequestFrame,
  type ResponseFrame,
  type ResultFrame,
} from "./protocol/messages.js";
export { SERVER_NAME, SERVER_VERSION } from "./version.js";
export {
  DAEMON_METHODS,
  type DaemonStatusResult,
  type PingResult,
  type ShutdownResult,
} from "./protocol/daemon.js";

// ---- Agent 装配（会话「能跑」的一环：配置 + Scope + 能力发现） ----
export { agentPaths, type AgentPaths, type AgentPathsInput } from "./service/agent/agentPaths.js";
export {
  SessionAgentFactory,
  type SessionAgentFactoryOptions,
} from "./service/agent/SessionAgentFactory.js";
