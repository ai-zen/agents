/**
 * 运行时的出口：Scope 的持有、agent 的持有、轮次占位、一轮的执行者。
 *
 * 这几块是「比 service 更长寿」的那一层（PLAN §3）：`ScopeRegistry` /
 * `AgentRegistry` / `RunRegistry` 随进程存活，ChatRunner 无状态（每轮现造），
 * 都由单根注入依赖，不导出任何模块级单例。
 */

export {
  createWorkspaceScopeFactory,
  ScopeBusyError,
  ScopeRegistry,
  systemClock,
} from "./ScopeRegistry.js";
export type {
  Clock,
  LiveConversationsQuery,
  ScopeFactory,
  ScopeRegistryOptions,
  WorkspaceScopeFactoryOptions,
} from "./ScopeRegistry.js";

export { AgentRegistry } from "./AgentRegistry.js";
export type {
  AgentAssemblyFacts,
  AgentCreateInput,
  AgentLifecycleAction,
  AgentLifecycleEvent,
  AgentLifecycleReason,
  AgentRegistryOptions,
} from "./AgentRegistry.js";

export { RunRegistry } from "./RunRegistry.js";
export type { RunHandle, RunRegistryOptions, RunSummary, RunsView } from "./RunRegistry.js";

export {
  ChatRunner,
  createSdkAgentFactory,
  DEFAULT_STREAM_WRITE_INTERVAL_MS,
} from "./ChatRunner.js";
export type {
  AcceptedTurn,
  AgentBuildContext,
  AgentFactory,
  AgentInboxEvent,
  AgentStateEvent,
  AttachmentPreparation,
  AttachmentPreparer,
  ChatAgent,
  ChatEventEmitter,
  ChatRunnerOptions,
  ChatRunParams,
  ChatTurn,
  ConversationStore,
  HandoffProvider,
  MessageStore,
  QueuedTurn,
  ReconcileResult,
  SdkAgentFactoryOptions,
  TurnSettlement,
  TurnSettledFacts,
} from "./ChatRunner.js";

export { ConversationDrafts } from "./ConversationDrafts.js";
export type { ConversationDraftStore } from "./ConversationDrafts.js";
