/**
 * 服务层出口：一服务一文件，全部按构造参数注入依赖（单根组装，PLAN §3）。
 *
 * 这里只做再导出。除了五个服务类与它们的依赖形状，还把两类**跨层要用的东西**一并导出：
 *
 *   1. {@link SessionRuntimePort}：运行时（W2-D）要实现的窄接口。服务层靠它现读「这一段
 *      此刻落在哪一格、队里压着几条」与「删掉之后丢掉现场」，自己不存这些状态（D28）。
 *   2. `toAgentMessage` / `readUsage` / `toCoreRole`：存储行 → core 消息的唯一一份转换。
 *      运行时写库、装配历史时也得用同一份，否则同一行会读出两个样子（R21）。
 */

export { WorkspaceService, pathExists, toFolderFact } from "./WorkspaceService.js";
export type { WorkspaceServiceDeps, WorkspaceRemovalReport } from "./WorkspaceService.js";

export { SessionService } from "./SessionService.js";
export type {
  SessionRuntimePort,
  SessionServiceDeps,
  SessionRemovalReport,
} from "./SessionService.js";

export { MessageService, readUsage, toAgentMessage, toCoreRole } from "./MessageService.js";
export type { MessageDraftLookup, MessageServiceDeps } from "./MessageService.js";

export { SearchService } from "./SearchService.js";
export type { SessionSummarizer, SearchServiceDeps } from "./SearchService.js";

export { CredentialService } from "./CredentialService.js";
export type { CredentialServiceDeps } from "./CredentialService.js";
