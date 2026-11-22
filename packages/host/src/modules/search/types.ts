import type { AgentNS } from "@ai-zen/agents-core";

/**
 * 消息搜索的范围：一段会话内 / 一个项目下 / 什么都不给。
 *
 * 做成联合而不是两个可选字段：两个都省略在类型上就分不出「只要这一段」与「全库」，
 * 而全库搜索得由调用方明确写出来。
 */
export type MessageSearchScope = { sessionId: string } | { workspaceId: string } | undefined;

/**
 * 命中一条消息。`snippet` 是命中位置附近的一小段正文，由 SQL 截出来；`message` 是那条消息
 * 本身，角色之类由调用方从它上面取。
 */
export interface SearchHit {
  messageId: string;
  sessionId: string;
  sessionName: string;
  snippet: string;
  message: AgentNS.Message;
}
