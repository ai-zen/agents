/**
 * `server.*`：进程事实（PRD F-E5 / F-I5 / D4 / L4）。
 *
 * 三件事在这里：
 *   - `version` / `capabilities`：报事实，供帮助页与指令菜单渲染（能力清单只在配置层维护一份，
 *     这里不编造）；
 *   - `usage`：按对话 / 项目 / 整机给一份累计用量（PRD F-I5）。三个范围的差别只在「取哪些
 *     对话的消息」，求和用 core 的 `sumUsage`（含子 Agent，与计费同口径）；
 *   - `shutdown`：受理一次收尾请求。真正退不退由单根的退出判据决定（PRD L4 / 裁定 R53）。
 *
 * `server.hello` / `server.setLanguage` / `asset.*` 由接线层自己接管（语言是连接状态、
 * 上传要按连接分帧），这里不重复注册。
 */

import type { AgentNS } from "@ai-zen/agents-core";

import type { HandlerTable } from "../net/index.js";
import type { ConversationService } from "../services/ConversationService.js";
import type { MessageService } from "../services/MessageService.js";
import type {
  CapabilityView,
  ServerUsageParams,
  ServerUsageResult,
} from "../wire/index.js";
import { PROTOCOL_VERSION } from "../wire/index.js";
import { usageOfMessages } from "./conversationHandlers.js";

/** `server.*` 的实现要的持有者 */
export interface ServerHandlerDeps {
  /** 服务端版本（`hello` 报的那一个） */
  version: string;
  /** 进程启动时刻（ISO 8601） */
  startedAt: string;
  /** 能力清单（PRD F-E5）；内容归配置层，本轮由单根注入 */
  capabilities: () => CapabilityView[];
  /** 按范围算用量要能列出对话 */
  conversations: ConversationService;
  messages: MessageService;
  /** 时钟（ISO 8601 时间戳） */
  now: () => string;
  /** 请求收尾（`server.shutdown`）：单根排程，先让回包写出去 */
  requestStop: (reason?: string) => void;
}

export function createServerHandlers(deps: ServerHandlerDeps): HandlerTable {
  return {
    "server.version": () => ({
      version: deps.version,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: deps.startedAt,
      pid: process.pid,
    }),

    "server.capabilities": () => ({ capabilities: deps.capabilities() }),

    "server.shutdown": (context) => {
      deps.requestStop(context.params.reason);
      return { accepted: true };
    },

    "server.usage": async (context) => await usageOf(deps, context.params),
  };
}

/**
 * 一段范围（对话 / 项目 / 整机）的累计用量。
 *
 * 范围只在「取哪些对话」上有差别；空范围（整机还没有任何对话）就是零值，
 * 不是错误 —— `sumUsage([])` 正好给出 core 的零值。
 */
async function usageOf(
  deps: ServerHandlerDeps,
  params: ServerUsageParams,
): Promise<ServerUsageResult> {
  const conversationIds = await conversationIdsOf(deps, params);
  const collected: AgentNS.Message[] = [];
  for (const conversationId of conversationIds) {
    const page = await deps.messages.list({ conversationId });
    collected.push(...page.messages);
  }
  return {
    scope:
      params.conversationId !== undefined
        ? "conversation"
        : params.workspaceId !== undefined
          ? "workspace"
          : "server",
    usage: usageOfMessages(collected, deps.now()),
  };
}

async function conversationIdsOf(
  deps: ServerHandlerDeps,
  params: ServerUsageParams,
): Promise<string[]> {
  if (params.conversationId !== undefined) return [params.conversationId];
  const scope =
    params.workspaceId === undefined ? {} : { workspaceId: params.workspaceId };
  const listed = await deps.conversations.list(scope);
  return listed.conversations.map((conversation) => conversation.id);
}
