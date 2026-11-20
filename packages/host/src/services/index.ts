/**
 * 服务层出口：一服务一文件，全部按构造参数注入依赖（单根组装，PLAN §3）。
 *
 * 这里只做再导出。除了五个服务类与它们的依赖形状，还把两类**跨层要用的东西**一并导出：
 *
 *   1. {@link SessionRuntimePort}：运行时（`app.ts` 的 `createSessionRuntime`）实现的窄接口。
 *      服务层靠它现读「这一段此刻落在哪一格、队里压着几条」与「删掉之后丢掉现场」，自己不存
 *      这些状态。
 *   2. `toAgentMessage` / `readUsage` / `toCoreRole`：存储行 → core 消息的唯一一份转换。
 *      侧栏摘要、自动命名、搜索命中、硬线判定都走它，同一行因此只有一个读法。
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
