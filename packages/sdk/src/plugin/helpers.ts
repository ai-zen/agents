import type { Agent } from "@ai-zen/agents-core";

/**
 * 从 Core Agent 提取最近一轮的 prompt_tokens。
 * 用于持久化到 Conversation.lastPromptTokens。
 */
export function getLastPromptTokens(agent: Agent): number | undefined {
  return agent.lastUsage?.prompt_tokens;
}
