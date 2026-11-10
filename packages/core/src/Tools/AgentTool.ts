import { Agent, type SubAgentContext } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { sumUsage } from "../Usage.js";
import { AgentContext } from "../AgentContext.js";
import { PickRequired } from "../Common.js";
import { ToolCallContext } from "../ToolCallContext.js";
import { Tool } from "../Tool.js";

/**
 * AgentTool —— 把一个子 Agent 暴露成工具。构造时就把 client / model / messages 定下来，
 * 执行时把 `parsedArgs` 填进消息里的 `{{key}}` 占位符再跑子 Agent。
 *
 * 消息列表最后一条必须是 User 消息（否则子 Agent 没有要回答的东西，构造函数直接拒绝）。
 */
export class AgentTool extends AgentContext implements Tool {
  type: "function";
  function: AgentNS.FunctionDefine;

  constructor(options: PickRequired<AgentTool, "function" | "client" | "model">) {
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

  /** 跑一次子 Agent，把它的最后一条消息内容当作工具结果（拒绝时是拒绝原因） */
  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent> {
    const agent = new Agent({
      ...this.toAgentConfig(),
    });

    agent.messages = AgentTool.injectArgs(agent.messages, ctx.parsedArgs);

    // 委派边界：onSubAgentStart 钩子（可拒绝本次委派；同时广播 sub-agent-start 事件）
    const subCtx: SubAgentContext = {
      agent: ctx.agent,
      subAgent: agent,
      toolCallContext: ctx,
    };
    const denied = await ctx.agent.dispatchHook("onSubAgentStart", subCtx);
    if (denied !== undefined) return denied;

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
      // 把子 Agent（含其孙级）的累计用量钉到本次委派的工具结果消息上，
      // 使其随消息持久化、并可被 sumUsage() 统一求和
      ctx.resultMessage.subAgentUsage = sumUsage(agent.messages);
      // 子 Agent 所有轮次完成（包括 tool_calls 多轮递归）后通知
      await ctx.agent.dispatchHook("onSubAgentEnd", subCtx);
    }

    // Return the last message content of the agent chat as the result
    return agent.messages.at(-1)?.content ?? "";
  }

  /**
   * 把模板里的 `{{key}}` 换成 `valueMap[key]`；没有对应键的占位符原样保留。
   */
  static replaceStringWithValues(template: string, valueMap: Record<string, any>): string {
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
   * 深拷贝一份消息列表，把每条消息的字符串 content 做占位符替换（内容块数组原样保留）。
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
