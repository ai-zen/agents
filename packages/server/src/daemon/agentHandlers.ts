/**
 * Agent 级方法（`agent.*`）的服务端入口。
 *
 * 与 `sessionHandlers.ts` 分开的理由就是命名：改的是**全局的 Agent 定义**，影响所有用
 * 这个 Agent 的会话，不是"对某一段会话做事"。混进 `session.*` 会让调用方以为它只影响
 * 当前会话 —— 那种误解在"切换模型后另一个窗口也变了"时才被发现。
 */

import type { MethodHandler } from "./Daemon.js";
import type { SessionAgentFactory } from "../service/agent/SessionAgentFactory.js";
import { AGENT_METHODS, type AgentSetModelResult } from "../protocol/sessions.js";

export interface AgentHandlerOptions {
  /** 只需装配层的 `setModel`（写入 Agent 定义），不必把整个工厂交出去 */
  factory: Pick<SessionAgentFactory, "setModel">;
}

export function createAgentHandlers(options: AgentHandlerOptions): Record<string, MethodHandler> {
  const { factory } = options;

  return {
    [AGENT_METHODS.setModel]: async (params): Promise<AgentSetModelResult> => {
      const agentId = requireString(params, "agentId");
      const modelId = requireString(params, "modelId");
      return await factory.setModel({ agentId, modelId });
    },
  };
}

function requireString(params: unknown, field: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw badParams(`missing or invalid "${field}"`);
  }
  return value;
}

function badParams(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = "bad-params";
  return error as Error & { code: string };
}
