import { Agent } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { AgentContext } from "../AgentContext.js";
import { PickRequired } from "../Common.js";
import { FunctionCallContext } from "../FunctionCallContext.js";
import { Message } from "../Message.js";
import { Tool } from "../Tool.js";

/**
 * AgentTool is a combination of Agent and Tool, which has tool definitions and generates output using chat.
 */
export class AgentTool extends AgentContext implements Tool {
  type: "function";
  function: AgentNS.FunctionDefine;

  constructor(options: PickRequired<AgentTool, "function" | "model">) {
    if (!options.function) throw new Error("AgentTool must have a function");
    if (options.messages?.at(-1)?.role != AgentNS.Role.User) {
      throw new Error("AgentTool must end with a user message.");
    }
    super(options);
    this.type = options.type ?? "function";
    this.function = options.function;
  }

  /**
   * 将当前 AgentTool 的配置导出为纯对象，用于创建子 Agent。
   * 会深拷贝 messages 以避免共享引用导致的意外修改。
   */
  toAgentConfig(): PickRequired<AgentContext, "model"> {
    return {
      model: this.model,
      model_config: this.model_config ? { ...this.model_config } : undefined,
      messages: JSON.parse(JSON.stringify(this.messages)),
      tools: this.tools?.map((t) => t),
      rag: this.rag,
      allowJsonParseError: this.allowJsonParseError,
    };
  }

  /**
   * Executes the agent's function with the given function call context.
   * @param ctx - The function call context.
   * @returns {Promise<string>} The result of the function execution.
   */
  async exec(ctx: FunctionCallContext): Promise<string> {
    // Create a chat for the agent using exported config
    const agent = new Agent({
      ...this.toAgentConfig(),
    });

    ctx.agent.events.emit("sub-agent", { agent, ctx });

    // Inject the arguments into the cloned agent's message list
    agent.messages = this.injectArgs(agent.messages, ctx.parsed_args);

    // Get question message
    const questionMessage = agent.messages.at(-1)!;

    // Create an assistant reply message
    agent.append(Message.Assistant());

    // If references are found, insert them before the user question
    await agent.rag?.rewrite(questionMessage, this.messages);

    // Send the agent chat to the server
    try {
      await agent.run();
    } finally {
      // 子 Agent 所有轮次完成（包括 tool_calls 多轮递归）后通知
      ctx.agent.events.emit("sub-agent-end", { agent, ctx });
    }

    // Return the last message content of the agent chat as the result
    return agent.messages.at(-1)?.content as string;
  }

  /**
   * Replace template string with values from the given record.
   * @param template - The template string.
   * @param valueMap - The record containing key-value pairs for replacement.
   * @returns {string} The replaced string.
   */
  static replaceStringWithValues(
    template: string,
    valueMap: Record<string, any>,
  ): string {
    const regex = /{{\s?(\w+)\s?}}/g;

    const replacedString = template.replace(regex, (_, key) => {
      if (valueMap.hasOwnProperty(key)) {
        return valueMap[key];
      } else {
        return `{{ ${key} }}`;
      }
    });

    return replacedString;
  }

  /**
   * Format the messages by replacing the parameters in the messages with their parsed values.
   * @param messages - The list of messages.
   * @param parsed_args - The parsed arguments.
   */
  injectArgs<T extends AgentNS.Message>(messages: T[], parsed_args: any): T[] {
    return JSON.parse(JSON.stringify(messages)).map((message: T) => ({
      ...message,
      content:
        typeof message.content == "string"
          ? AgentTool.replaceStringWithValues(message.content, parsed_args)
          : message.content,
    }));
  }
}
