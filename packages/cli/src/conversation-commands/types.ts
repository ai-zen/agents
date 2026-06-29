import { Agent, AgentNS } from "@ai-zen/agents-core";

/**
 * 对话上下文，由 runConversation 创建并传递给各命令处理函数
 */
export interface ConversationContext {
  input: string;
  currentName: string;
  modelId: string;
  currentId: string | undefined;
  agentId: string | undefined;
  running: boolean;
  /** 对话开始时系统提示词列表（不含用户消息），用于重建新会话 */
  systemMessages: AgentNS.Message[];
}

/**
 * 命令处理函数签名
 * 通过修改 ctx.input 或 ctx.running 来控制主循环行为
 */
export type CommandHandler = (agent: Agent, ctx: ConversationContext) => void | Promise<void>;
