import { AgentNS } from "./AgentNS";

/**
 * RAG（检索增强生成）抽象基类。
 * 
 * 子类通过改写用户问题消息（例如注入检索到的参考信息）来增强模型回答质量。
 */
export abstract class Rag {
  /**
   * 改写用户问题消息。
   * 
   * 实现方可直接修改 `questionMessage.content` 来注入上下文、参考信息等。
   * 
   * @param questionMessage - 用户的问题消息，修改其 content 会影响最终发送给模型的请求
   * @param messages - 当前对话的完整消息列表（可选），可供需要参考对话上下文的 RAG 策略使用
   */
  abstract rewrite(
    questionMessage: AgentNS.Message,
    messages?: AgentNS.Message[]
  ): Promise<void>;
}
