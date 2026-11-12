/**
 * 服务层出口：一服务一文件，全部按构造参数注入依赖（单根组装，PRD architecture §3）。
 *
 * 这里只做再导出。除了五个服务类与它们的依赖形状，还把两类**跨层要用的东西**一并导出：
 *
 *   1. {@link ConversationRuntimePort}：运行时（W2-D）要实现的窄接口。服务层靠它读「在不在跑」
 *      与读写「本进程内的临时覆盖」，自己不存这些状态（D28）。
 *   2. `toAgentMessage` / `readUsage` / `toCoreRole`：存储行 → core 消息的唯一一份转换。
 *      运行时要接着往下跑一轮时也得用同一份，否则同一行会读出两个样子（R21）。
 */

export { WorkspaceService, pathExists, toFolderFact } from "./WorkspaceService.js";
export type { WorkspaceServiceDeps, WorkspaceRemovalReport } from "./WorkspaceService.js";

export { ConversationService } from "./ConversationService.js";
export type {
  ConversationRuntimePort,
  ConversationServiceDeps,
  ConversationRemovalReport,
  WorkspaceLocation,
} from "./ConversationService.js";

export { MessageService, readUsage, toAgentMessage, toCoreRole } from "./MessageService.js";
export type { MessageDraftLookup, MessageServiceDeps } from "./MessageService.js";

export { SearchService } from "./SearchService.js";
export type { ConversationSummarizer, SearchServiceDeps } from "./SearchService.js";

export { CredentialService } from "./CredentialService.js";
export type { CredentialServiceDeps } from "./CredentialService.js";
