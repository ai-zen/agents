/**
 * handler 表的唯一出口（architecture §3 / §6）。
 *
 * `WsHub` 只认一张表：方法名 → 实现。方法名的真相在 `wire/methods.ts`（`MethodMap`），
 * 这里把每个有实现者的域拼起来交给接线层。
 *
 * 各域分文件放，是为了让「这一域要哪些持有者」写在它自己的 `deps` 接口上：接线层照着注入，
 * 而不是把一个巨大的 `app` 对象塞进每个 handler 里。
 *
 * 组装方式仍是显式构造注入：`ServerApp` 造好服务与运行时之后，把引用交进来，本模块不 new
 * 任何东西、不读全局路径、不持有单例。
 *
 * 四件事在**接线层**而不是这张表里（`handlers/index.test.ts` 把这份名单钉住）：
 *   - `server.hello` / `server.setLanguage`：语言与凭证都是连接状态（`net/WsHub`）；
 *   - `asset.begin` / `asset.end`：上传要按连接分帧落盘（`net/UploadReceiver`）。
 *
 * 除这四条以外，契约里的每个方法都必须在这张表里 —— 否则客户端会拿到 `unsupported`，
 * 而那是「这个服务端没有这个功能」的意思，不该用来掩盖「忘了接」。
 */

import type { AppConfig } from "@ai-zen/agents-sdk";

import type { Language } from "../i18n/index.js";
import type { HandlerTable } from "../net/index.js";
import type { ChatRunner, ScopeRegistry } from "../runtime/index.js";
import type { TransientRunner } from "../runtime/TransientRunner.js";
import type { AgentService } from "../services/AgentService.js";
import type { AssetService } from "../services/AssetService.js";
import type { CompletionService } from "../services/CompletionService.js";
import type { ConfigService } from "../services/ConfigService.js";
import type { ConversationService } from "../services/ConversationService.js";
import type { CredentialService } from "../services/CredentialService.js";
import type { HandoffService } from "../services/HandoffService.js";
import type { MessageService } from "../services/MessageService.js";
import type { ModelService } from "../services/ModelService.js";
import type { NoticeService } from "../services/NoticeService.js";
import type { QuestionService } from "../services/QuestionService.js";
import type { SearchService } from "../services/SearchService.js";
import type { WorkspaceService } from "../services/WorkspaceService.js";
import type { CapabilityView, MethodName, QuestionView } from "../wire/index.js";
import { createAgentHandlers } from "./agentHandlers.js";
import { createAssetHandlers } from "./assetHandlers.js";
import { createCompletionHandlers } from "./completionHandlers.js";
import { createConfigHandlers } from "./configHandlers.js";
import { createConversationHandlers } from "./conversationHandlers.js";
import { createCredentialHandlers } from "./credentialHandlers.js";
import { createHandoffHandlers } from "./handoffHandlers.js";
import { createMessageHandlers } from "./messageHandlers.js";
import { createModelHandlers } from "./modelHandlers.js";
import { createNoticeHandlers } from "./noticeHandlers.js";
import { createQuestionHandlers } from "./questionHandlers.js";
import { createSearchHandlers } from "./searchHandlers.js";
import { createServerHandlers } from "./serverHandlers.js";
import { createWorkspaceHandlers } from "./workspaceHandlers.js";

export type { AgentHandlerDeps } from "./agentHandlers.js";
export type { CompletionHandlerDeps } from "./completionHandlers.js";
export type { ConfigHandlerDeps } from "./configHandlers.js";
export type { ConversationHandlerDeps } from "./conversationHandlers.js";
export type { CredentialHandlerDeps } from "./credentialHandlers.js";
export type { HandoffHandlerDeps } from "./handoffHandlers.js";
export type { MessageHandlerDeps } from "./messageHandlers.js";
export type { ModelHandlerDeps } from "./modelHandlers.js";
export type { NoticeHandlerDeps } from "./noticeHandlers.js";
export type { QuestionHandlerDeps } from "./questionHandlers.js";
export type { SearchHandlerDeps } from "./searchHandlers.js";
export type { ServerHandlerDeps } from "./serverHandlers.js";
export type { WorkspaceHandlerDeps } from "./workspaceHandlers.js";
export { createCapabilities } from "./capabilities.js";

/**
 * 由接线层代管、因此不在 handler 表里的方法名。
 *
 * 这份名单是「表可以缺哪些」的唯一真相：验收用例按它判「契约里的每个方法要么在表里、
 * 要么在这里」。往这里加一条就等于说「接线层自己实现了它」——`net/WsHub` 也确实在分发时
 * 先处理这四个名字。
 */
export const BRIDGED_METHODS: readonly MethodName[] = [
  "server.hello",
  "server.setLanguage",
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
  /** 服务端版本（`hello` 报的那一个） */
  version: string;
  /** 进程启动时刻（ISO 8601） */
  startedAt: string;
  /** 能力清单（PRD F-E5） */
  capabilities: () => CapabilityView[];

  // ---- 服务 ----
  workspaces: WorkspaceService;
  conversations: ConversationService;
  messages: MessageService;
  search: SearchService;
  credentials: CredentialService;
  assets: AssetService;
  config: ConfigService;
  agents: AgentService;
  models: ModelService;
  completion: CompletionService;
  notices: NoticeService;
  questions: QuestionService;
  handoff: HandoffService;

  // ---- 运行时 ----
  runner: ChatRunner;
  scopes: ScopeRegistry;
  /** 临时对话的执行者（D3 / R49：不落库、不推流式事件） */
  transient: TransientRunner;

  // ---- 配置与时钟 ----
  /** 读配置（上下文阈值跟着模型走，PRD F-D1 / D27） */
  readConfig: () => Promise<AppConfig>;
  /** 刷新思考策略表快照（`conversation.setThinking` 之前调一次） */
  refreshThinkingPresets: () => Promise<void>;
  /** 时钟：契约里的时间一律 ISO 8601 字符串 */
  now: () => string;

  // ---- 跨服务的对话钩子（分属三个服务，契约里却是同一对方法的位置）----
  /** 有挡着的问题就拒发（D23）；发之前问一句 */
  assertSendable: (conversationId: string) => Promise<void>;
  /** 一轮结算之后起一次自动命名（D2） */
  autoNameAfterTurn: (conversationId: string, language: Language) => Promise<void>;
  /** 结算后钩子失败的去处（命名没跑成不该让已经结算的一轮变成失败） */
  onHookError: (error: unknown, hook: string) => void;
  /** 现场快照里那段对话的问题（D22：多端看同一批） */
  questionsFor: (conversationId: string) => Promise<QuestionView[]>;

  // ---- 进程动作 ----
  /** 请求收尾（`server.shutdown`）；真正的退出判定在单根 */
  requestStop: (reason?: string) => void;
  /** 一轮结算之后重算退出判据（L4：这是「什么都不欠了」的触发源之一） */
  onTurnSettled: () => void;
  /** 升级判定与重启排程（`server.upgrade`：比磁盘版本与运行版本） */
  upgrade: (params: { targetVersion?: string }) => Promise<{
    state: "already_latest" | "restart_scheduled" | "not_available";
    currentVersion: string;
    diskVersion: string | null;
    targetVersion: string | null;
  }>;
}

/**
 * 造出整张 handler 表。
 *
 * 同名方法不会重复：每个方法名只属于一个域，拼装处若出现重名，后一份会覆盖前一份
 * （`handlers/index.test.ts` 里断言表里的方法名唯一且都在契约内）。
 */
export function createHandlers(deps: HandlerDeps): HandlerTable {
  return {
    ...createServerHandlers(deps),
    ...createWorkspaceHandlers(deps),
    ...createConversationHandlers({
      conversations: deps.conversations,
      messages: deps.messages,
      assets: deps.assets,
      runner: deps.runner,
      readConfig: deps.readConfig,
      refreshThinkingPresets: deps.refreshThinkingPresets,
      now: deps.now,
      onTurnSettled: deps.onTurnSettled,
      assertSendable: deps.assertSendable,
      autoNameAfterTurn: deps.autoNameAfterTurn,
      onHookError: deps.onHookError,
      questionsFor: deps.questionsFor,
      // 临时对话：一次调用跑一轮、不落库、不推流式事件（R1 / R49）
      runTransient: async (params, language) => await deps.transient.run(params, language),
    }),
    ...createMessageHandlers(deps),
    ...createSearchHandlers(deps),
    ...createCredentialHandlers(deps),
    ...createAssetHandlers(),
    ...createConfigHandlers({ config: deps.config }),
    ...createAgentHandlers({ agents: deps.agents }),
    ...createModelHandlers({ models: deps.models }),
    ...createCompletionHandlers({ completion: deps.completion }),
    ...createNoticeHandlers({ notices: deps.notices }),
    ...createQuestionHandlers({ questions: deps.questions }),
    ...createHandoffHandlers({ handoff: deps.handoff }),
  };
}
