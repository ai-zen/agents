/**
 * 运行时的出口：Scope 的持有、agent 的持有、一段会话的桥、一次性会话的执行者。
 *
 * 这几块是「比 service 更长寿」的那一层（PLAN §3）：`ScopeRegistry` / `AgentRegistry` /
 * `ChatRunner`（它手上那张 `bridges` 表跟着 agent 活）随进程存活，都由单根注入依赖，不导出
 * 任何模块级单例。
 *
 * 一段会话忙不忙读 agent 身上那一格，要观测就读 `ChatRunner.state`。
 */

export {
  createWorkspaceScopeFactory,
  ScopeBusyError,
  ScopeRegistry,
  systemClock,
} from "./ScopeRegistry.js";
export type {
  Clock,
  LiveSessionsQuery,
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

export {
  ChatRunner,
  createSdkAgentFactory,
  DEFAULT_STREAM_WRITE_INTERVAL_MS,
} from "./ChatRunner.js";
export type {
  AgentBuildContext,
  AgentFactory,
  AttachmentHistoryResolver,
  AttachmentPreparation,
  AttachmentPreparer,
  ChatAgent,
  ChatEventEmitter,
  ChatRunnerOptions,
  SessionReadout,
  SessionStore,
  DeliveryInput,
  HandoffProvider,
  MessageAssetLinker,
  MessageStore,
  ReconcileResult,
  SdkAgentFactoryOptions,
} from "./ChatRunner.js";

export { SessionDrafts } from "./SessionDrafts.js";
export type { SessionDraftStore } from "./SessionDrafts.js";
