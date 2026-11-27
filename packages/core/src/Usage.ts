import { AgentNS } from "./AgentNS.js";

/**
 * Token 用量工具，全部是纯函数。
 *
 * 一条消息可归因的 token 用量有两种，互斥出现：
 *   - `message.usage`：本条消息自身那次 API 响应的用量（assistant 消息），
 *   - `message.subAgentUsage`：本条 tool 消息「内部委派」产生的累计用量（如 subagent）。
 *
 * 两者相加才是「这段会话花了多少」，所以求和走 `sumUsage()`：它把两者一起加，不会漏算
 * subagent（含其孙级）的开销。
 */

export const ZERO_USAGE: AgentNS.Usage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

/** 逐字段相加，返回新对象，不改动入参 */
export function addUsage(a: AgentNS.Usage, b: AgentNS.Usage): AgentNS.Usage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

/**
 * 求和一组消息可归因的 token 用量：`usage`（自身响应）加 `subAgentUsage`（内部委派）。
 *
 * 嵌套自动成立：subagent 自己的 tool 消息也携带 `subAgentUsage`，故对 subagent 的 `messages`
 * 调用本函数即天然含孙级。对父 agent 的 `messages` 调用即得整棵委派树的累计。
 */
export function sumUsage(messages: readonly AgentNS.Message[]): AgentNS.Usage {
  let acc = { ...ZERO_USAGE };
  for (const message of messages) {
    if (message.usage) acc = addUsage(acc, message.usage);
    if (message.subAgentUsage) acc = addUsage(acc, message.subAgentUsage);
  }
  return acc;
}
