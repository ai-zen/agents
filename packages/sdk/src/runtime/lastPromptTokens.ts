import { AgentNS } from "@ai-zen/agents-core";

/**
 * 上一轮的 prompt 用量 —— **只从消息上取，不另立快照**。
 *
 * 用量是消息自己的事实：core 跑流时把响应收尾片的 `usage` 钉在那条 assistant 消息上（它不属于
 * 那一片增量，也就不过 `applyChunk`），随消息持久化（core 不算、不存、不报用量，公理 4）。所以这里也不存第二份：两个护栏插件
 * （`ContextGuardPlugin` / `AutoMigratePlugin`）读的是**同一份事实、同一个读法** —— 从
 * `agent.messages` 倒着找最近一条带 `usage` 的 assistant 消息。
 *
 * 读「最近一条」而不是求和：护栏判的是「这一圈请求会带多大的输入」，而每次请求都会重发
 * 完整历史，上一轮那条 prompt 用量就是这件事的唯一现成读数。
 *
 * 找不到（首轮请求之前）返回 `undefined` —— 那是「还没有可依的用量」，不是 0。
 */
export function lastPromptTokens(agent: {
  messages: readonly AgentNS.Message[];
}): number | undefined {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const message = agent.messages[i]!;
    if (message.role !== AgentNS.Role.Assistant) continue;
    const promptTokens = message.usage?.prompt_tokens;
    if (typeof promptTokens === "number") return promptTokens;
  }
  return undefined;
}
