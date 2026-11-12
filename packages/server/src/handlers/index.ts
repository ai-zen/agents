/**
 * handler 表的唯一出口（architecture §3 / §6）。
 *
 * `WsHub` 只认一张表：方法名 → 实现。方法名的真相在 `wire/methods.ts`（`MethodMap`），
 * 这里把**已经有实现者**的域拼起来，没拼进来的方法由接线层回 `unsupported`
 * （裁定 R11：方法名存在、但这个服务端没实现）。
 *
 * 各域分文件放，是为了让「这一域要哪些持有者」写在它自己的 `deps` 接口上：接线层照着注入，
 * 而不是把一个巨大的 `app` 对象塞进每个 handler 里。
 *
 * 组装方式仍是显式构造注入：`ServerApp` 造好服务与运行时之后，把引用交进来，本模块不 new
 * 任何东西、不读全局路径、不持有单例。
 *
 * 目前**没有**注册的域（实现者还没来，归 W4）：
 *   - `config.*` / `agent.*` / `model.*` / `completion.*`（配置与发现层）
 *   - `notice.*` / `question.*` / `handoff.*`（通知、问题对象、交接）
 *   - `conversation.transient`（临时对话要走不落库的执行路径）
 *   - `server.upgrade`（升级即重启的判定与排程）
 *   - `asset.begin` / `asset.end`：由接线层直接接管（见 `assetHandlers.ts` 的说明）
 */

import type { AppConfig } from "@ai-zen/agents-sdk";

import type { HandlerTable } from "../net/index.js";
import type { ChatRunner, ScopeRegistry } from "../runtime/index.js";
import type { AssetService } from "../services/AssetService.js";
import type { ConversationService } from "../services/ConversationService.js";
import type { CredentialService } from "../services/CredentialService.js";
import type { MessageService } from "../services/MessageService.js";
import type { SearchService } from "../services/SearchService.js";
import type { WorkspaceService } from "../services/WorkspaceService.js";
import type { CapabilityView } from "../wire/index.js";
import { createAssetHandlers } from "./assetHandlers.js";
import { createConversationHandlers } from "./conversationHandlers.js";
import { createCredentialHandlers } from "./credentialHandlers.js";
import { createMessageHandlers } from "./messageHandlers.js";
import { createSearchHandlers } from "./searchHandlers.js";
import { createServerHandlers } from "./serverHandlers.js";
import { createWorkspaceHandlers } from "./workspaceHandlers.js";

export type { ConversationHandlerDeps } from "./conversationHandlers.js";
export type { CredentialHandlerDeps } from "./credentialHandlers.js";
export type { MessageHandlerDeps } from "./messageHandlers.js";
export type { SearchHandlerDeps } from "./searchHandlers.js";
export type { ServerHandlerDeps } from "./serverHandlers.js";
export type { WorkspaceHandlerDeps } from "./workspaceHandlers.js";

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

  // ---- 运行时 ----
  runner: ChatRunner;
  scopes: ScopeRegistry;

  // ---- 配置与时钟 ----
  /** 读配置（上下文阈值跟着模型走，PRD F-D1 / D27） */
  readConfig: () => Promise<AppConfig>;
  /** 刷新思考策略表快照（`conversation.setThinking` 之前调一次） */
  refreshThinkingPresets: () => Promise<void>;
  /** 时钟：契约里的时间一律 ISO 8601 字符串 */
  now: () => string;

  // ---- 进程动作 ----
  /** 请求收尾（`server.shutdown`）；真正的退出判定在单根 */
  requestStop: (reason?: string) => void;
  /** 一轮结算之后重算退出判据（L4：这是「什么都不欠了」的触发源之一） */
  onTurnSettled: () => void;
}

/**
 * 造出整张 handler 表。
 *
 * 同名方法在上面几处不会重复：每个方法名只属于一个域，拼装处若出现重名，后一份会覆盖前一份
 * （`handlers.test.ts` 里断言表里的方法名唯一且都在契约内）。
 */
export function createHandlers(deps: HandlerDeps): HandlerTable {
  return {
    ...createServerHandlers(deps),
    ...createWorkspaceHandlers(deps),
    ...createConversationHandlers(deps),
    ...createMessageHandlers(deps),
    ...createSearchHandlers(deps),
    ...createCredentialHandlers(deps),
    ...createAssetHandlers(),
  };
}
