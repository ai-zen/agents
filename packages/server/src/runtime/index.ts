/**
 * 运行时的出口：Scope 的持有与回收、轮次占位、一轮的执行者。
 *
 * 这三块是「比 service 更长寿」的那一层（architecture §3）：ScopeRegistry 与 RunRegistry
 * 随进程存活，ChatRunner 无状态（每轮现造），三者都由单根注入依赖，不导出任何模块级单例。
 */

export {
  createWorkspaceScopeFactory,
  DEFAULT_SCOPE_IDLE_TIMEOUT_MS,
  ScopeRegistry,
  systemClock,
} from "./ScopeRegistry.js";
export type {
  Clock,
  ScopeFactory,
  ScopeRegistryOptions,
  WorkspaceScopeFactoryOptions,
} from "./ScopeRegistry.js";

export { RunRegistry } from "./RunRegistry.js";
export type { RunHandle, RunRegistryOptions, RunSummary, RunsView } from "./RunRegistry.js";

export {
  ChatRunner,
  createSdkAgentFactory,
  DEFAULT_STREAM_WRITE_INTERVAL_MS,
} from "./ChatRunner.js";
export type {
  AgentBuildContext,
  AgentFactory,
  AttachmentPreparation,
  AttachmentPreparer,
  ChatAgent,
  ChatEventEmitter,
  ChatRunnerOptions,
  ChatRunParams,
  ChatTurn,
  ConversationStore,
  MessageStore,
  ReconcileResult,
  SdkAgentFactoryOptions,
  TurnSettlement,
} from "./ChatRunner.js";
