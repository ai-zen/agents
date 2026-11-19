/**
 * handler 表的唯一出口（PLAN §3 / §6）。
 *
 * `WsHub` 只认一张表：方法名 → 实现。方法名的真相在 `wire/methods.ts`（`MethodMap`），
 * 这里把每个有实现者的域拼起来交给接线层。
 *
 * 各域分文件放，是为了让「这一域要哪些持有者」写在它自己的 `deps` 接口上：接线层照着注入，
 * 而不是把一个巨大的 `app` 对象塞进每个 handler 里。
 *
 * 组装方式仍是显式构造注入：`HostApp` 造好服务与运行时之后，把引用交进来，本模块不 new
 * 任何东西、不读全局路径、不持有单例。
 *
 * 四件事在**接线层**而不是这张表里（`handlers/index.test.ts` 把这份名单钉住）：
 *   - `host.hello` / `host.setLanguage`：语言与凭证都是连接状态（`net/WsHub`）；
 *   - `asset.begin` / `asset.end`：上传要按连接分帧落盘（`net/UploadReceiver`）。
 *
 * 除这四条以外，契约里的每个方法都必须在这张表里 —— 否则客户端会拿到 `unsupported`，
 * 而那是「这个宿主没有这个功能」的意思，不该用来掩盖「忘了接」。
 */

import type { HandlerTable } from "../net/index.js";
import type { ChatEventEmitter, ChatRunner, ScopeRegistry } from "../runtime/index.js";
import type { TransientRunner } from "../runtime/TransientRunner.js";
import type { AgentService } from "../services/AgentService.js";
import type { AssetService } from "../services/AssetService.js";
import type { CompletionService } from "../services/CompletionService.js";
import type { ConfigService } from "../services/ConfigService.js";
import type { SessionService } from "../services/SessionService.js";
import type { HandoffDocumentService } from "../services/HandoffDocumentService.js";
import type { MessageService } from "../services/MessageService.js";
import type { ModelService } from "../services/ModelService.js";
import type { NoticeService } from "../services/NoticeService.js";
import type { QuestionService } from "../services/QuestionService.js";
import type { SearchService } from "../services/SearchService.js";
import type { WorkspaceService } from "../services/WorkspaceService.js";
import type { MethodName, HostReloadResult } from "../wire/index.js";
import type { EventMap, EventName } from "../wire/events.js";
import { createAgentHandlers } from "./agentHandlers.js";
import { createAssetHandlers } from "./assetHandlers.js";
import { createCompletionHandlers } from "./completionHandlers.js";
import { createConfigHandlers } from "./configHandlers.js";
import { createSessionHandlers } from "./sessionHandlers.js";
import { createHandoffHandlers } from "./handoffHandlers.js";
import { createMessageHandlers } from "./messageHandlers.js";
import { createModelHandlers } from "./modelHandlers.js";
import { createNoticeHandlers } from "./noticeHandlers.js";
import { createQuestionHandlers } from "./questionHandlers.js";
import { createSearchHandlers } from "./searchHandlers.js";
import { createHostHandlers } from "./hostHandlers.js";
import { createWorkspaceHandlers } from "./workspaceHandlers.js";

export type { AgentHandlerDeps } from "./agentHandlers.js";
export type { AssetHandlerDeps } from "./assetHandlers.js";
export type { CompletionHandlerDeps } from "./completionHandlers.js";
export type { ConfigHandlerDeps } from "./configHandlers.js";
export type { SessionHandlerDeps } from "./sessionHandlers.js";
export type { HandoffHandlerDeps } from "./handoffHandlers.js";
export type { MessageHandlerDeps } from "./messageHandlers.js";
export type { ModelHandlerDeps } from "./modelHandlers.js";
export type { NoticeHandlerDeps } from "./noticeHandlers.js";
export type { QuestionHandlerDeps } from "./questionHandlers.js";
export type { SearchHandlerDeps } from "./searchHandlers.js";
export type { HostHandlerDeps } from "./hostHandlers.js";
export type { WorkspaceHandlerDeps } from "./workspaceHandlers.js";

/**
 * 由接线层代管、因此不在 handler 表里的方法名。
 *
 * 这份名单是「表可以缺哪些」的唯一真相：验收用例按它判「契约里的每个方法要么在表里、
 * 要么在这里」。往这里加一条就等于说「接线层自己实现了它」——`net/WsHub` 也确实在分发时
 * 先处理这四个名字。
 */
export const BRIDGED_METHODS: readonly MethodName[] = [
  "host.hello",
  "host.setLanguage",
  "asset.begin",
  "asset.end",
];

/**
 * 组装 handler 表要的全部持有者。
 *
 * 一个平坦的形状（而不是每域各注入一个对象）是因为单根本来就把这些都拿在手上；
 * 域函数各自声明自己要哪几样，单根把它们平铺进去，谁需要什么仍然一目了然。
 */
export interface HandlerDeps {
  // ---- 进程事实 ----
  /** 宿主版本（`hello` 报的那一个） */
  version: string;
  /** 进程启动时刻（ISO 8601） */
  startedAt: string;
  // ---- 服务 ----
  workspaces: WorkspaceService;
  sessions: SessionService;
  messages: MessageService;
  search: SearchService;
  assets: AssetService;
  config: ConfigService;
  agents: AgentService;
  models: ModelService;
  completion: CompletionService;
  notices: NoticeService;
  questions: QuestionService;
  handoff: HandoffDocumentService;

  // ---- 运行时 ----
  runner: ChatRunner;
  scopes: ScopeRegistry;
  /** 临时对话的执行者（D3 / R49：不落库、不推流式事件） */
  transient: TransientRunner;

  // ---- 配置与时钟 ----
  /** 刷新思考策略表快照（`session.setThinking` 之前调一次） */
  refreshThinkingPresets: () => Promise<void>;
  /** 时钟：契约里的时间一律 ISO 8601 字符串 */
  now: () => string;
  /** 写一条日志（`session.abort` 的 `reason` 只有这一个去处） */
  log: (message: string, detail?: unknown) => void;
  /** 推事件（`session.changed` 这类多端同步信号）；不注入时不推 */
  emit?: <E extends EventName>(name: E, payload: EventMap[E]) => void;

  // ---- 跨服务的对话钩子 ----
  /** 有挡着的问题就拒发（D23）；发之前问一句 */
  assertSendable: (sessionId: string) => Promise<void>;

  // ---- 进程动作 ----
  /** 请求收尾（`host.shutdown`） */
  requestStop: (reason?: string) => void;
  /** 升级判定与重启排程（`host.upgrade`：比磁盘版本与运行版本） */
  upgrade: (params: { targetVersion?: string }) => Promise<{
    state: "already_latest" | "restart_scheduled" | "not_available";
    currentVersion: string;
    diskVersion: string | null;
    targetVersion: string | null;
  }>;
  /** 从磁盘重载（`host.reload`：与改配置同一条生效路径） */
  reload: () => Promise<HostReloadResult>;
}

/**
 * 造出整张 handler 表。
 *
 * 同名方法不会重复：每个方法名只属于一个域，拼装处若出现重名，后一份会覆盖前一份
 * （`handlers/index.test.ts` 里断言表里的方法名唯一且都在契约内）。
 */
export function createHandlers(deps: HandlerDeps): HandlerTable {
  return {
    ...createHostHandlers(deps),
    ...createWorkspaceHandlers({
      workspaces: deps.workspaces,
      sessions: deps.sessions,
      runner: deps.runner,
      scopes: deps.scopes,
      emit: deps.emit,
      now: deps.now,
    }),
    ...createSessionHandlers({
      sessions: deps.sessions,
      messages: deps.messages,
      // 素材准备搬到了接线层：发一句之前的选路要问模型与端点，那是素材服务的事
      assets: deps.assets,
      runner: deps.runner,
      refreshThinkingPresets: deps.refreshThinkingPresets,
      log: deps.log,
      assertSendable: deps.assertSendable,
      // 临时对话：一次调用给一条结果、不落库、不推流式事件（R1 / R49）
      runTransient: async (params, language) => await deps.transient.run(params, language),
    }),
    ...createMessageHandlers(deps),
    ...createSearchHandlers(deps),
    ...createAssetHandlers({ assets: deps.assets }),
    ...createConfigHandlers({ config: deps.config }),
    ...createAgentHandlers({ agents: deps.agents }),
    ...createModelHandlers({ models: deps.models }),
    ...createCompletionHandlers({ completion: deps.completion }),
    ...createNoticeHandlers({ notices: deps.notices }),
    ...createQuestionHandlers({ questions: deps.questions }),
    // 交接只有一个交给服务层的口：入口判据（先闲着才跑）在服务里，接线层不掐在途
    ...createHandoffHandlers({ handoff: deps.handoff }),
  };
}
