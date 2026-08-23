import { Agent } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { AgentContext } from "../AgentContext.js";
import { PickRequired } from "../Common.js";
import { ToolCallContext } from "../ToolCallContext.js";
import { Tool } from "../Tool.js";

/**
 * AgentTool is a combination of Agent and Tool, which has tool definitions and generates output using chat.
 */
export class AgentTool extends AgentContext implements Tool {
  type: "function";
  function: AgentNS.FunctionDefine;

  constructor(
    options: PickRequired<AgentTool, "function" | "client" | "model">,
  ) {
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
  toAgentConfig(): PickRequired<AgentContext, "client" | "model"> {
    return {
      client: this.client,
      model: this.model,
      modelConfig: this.modelConfig ? { ...this.modelConfig } : undefined,
      messages: JSON.parse(JSON.stringify(this.messages)),
      tools: this.tools?.map((t) => t),
      allowJsonParseError: this.allowJsonParseError,
    };
  }

  /**
   * Executes the agent's function with the given function call context.
   * @param ctx - The function call context.
   * @returns {Promise<AgentNS.MessageContent>} The result of the agent execution (last message content).
   */
  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent> {
    // Create a chat for the agent using exported config
    const agent = new Agent({
      ...this.toAgentConfig(),
    });

    ctx.agent.events.emit("sub-agent", { agent, ctx });

    // Inject the arguments into the cloned agent's message list
    agent.messages = AgentTool.injectArgs(agent.messages, ctx.parsedArgs);

    // （Assistant 占位由 run 内循环开头统一追加）

    // Send the agent chat to the server
    try {
      // 子 Agent 中断联动：外层 abort → agent.abort()
      const onAbort = () => agent.abort();
      if (ctx.signal) {
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        await agent.run();
      } finally {
        ctx.signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      // 子 Agent 所有轮次完成（包括 tool_calls 多轮递归）后通知
      ctx.agent.events.emit("sub-agent-end", { agent, ctx });
    }

    // Return the last message content of the agent chat as the result
    return agent.messages.at(-1)?.content ?? "";
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
   * @param parsedArgs - The parsed arguments.
   */
  static injectArgs<T extends AgentNS.Message>(messages: T[], parsedArgs: any): T[] {
    return JSON.parse(JSON.stringify(messages)).map((message: T) => ({
      ...message,
      content:
        typeof message.content == "string"
          ? AgentTool.replaceStringWithValues(message.content, parsedArgs)
          : message.content,
    }));
  }
}
