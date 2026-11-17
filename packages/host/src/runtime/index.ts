/**
 * 运行时的出口：Scope 的持有、agent 的持有、一段对话的桥、一次性对话的执行者。
 *
 * 这几块是「比 service 更长寿」的那一层（PLAN §3）：`ScopeRegistry` / `AgentRegistry` /
 * `ChatRunner`（它手上那张 bridge 表跟着 agent 活）随进程存活，都由单根注入依赖，不导出任何
 * 模块级单例。
 *
 * **这里没有「轮次占位」这种东西**（从前那本账叫 `RunRegistry`）：一段对话现在忙不忙，直接读
 * agent 身上那一格；要观测就读 `ChatRunner.state`。
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

export {
  ChatRunner,
  createSdkAgentFactory,
  DEFAULT_STREAM_WRITE_INTERVAL_MS,
  injectedContextOf,
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
  ConversationReadout,
  ConversationStore,
  DeliveryInput,
  HandoffProvider,
  MessageAssetLinker,
  MessageStore,
  ReconcileResult,
  SdkAgentFactoryOptions,
  SubAgentReadout,
} from "./ChatRunner.js";

export { ConversationDrafts } from "./ConversationDrafts.js";
export type { ConversationDraftStore } from "./ConversationDrafts.js";
