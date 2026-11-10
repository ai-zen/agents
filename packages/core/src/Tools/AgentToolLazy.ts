import { Agent, type SubAgentContext } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { sumUsage } from "../Usage.js";
import { ToolCallContext } from "../ToolCallContext.js";
import { Tool } from "../Tool.js";
import { AgentTool } from "./AgentTool.js";

/**
 * AgentToolLazy —— 延迟构建 Agent 的工具。
 *
 * 与 AgentTool 不同，Agent 不在构造时创建，而是在 exec 时通过 buildAgent 回调获取。
 * 这避免了在工具列表构建阶段的递归创建问题（SubAgent → buildToolList → SubAgent → ...）。
 *
 * buildAgent 回调通过显式参数 (parsedArgs, ctx) 接收上下文，可通过 ctx.agent 访问父 Agent。
 *
 * 初始消息有两种来源，二选一：
 *   - 提供 messages 模板：exec 时把 parsedArgs 注入 {{key}} 占位符，覆盖 agent.messages；
 *   - 省略 messages：初始消息由 buildAgent 自行决定（如初始消息依赖运行时参数时），
 *     AgentToolLazy 不接管 messages。
 */
export class AgentToolLazy implements Tool {
  type: "function" = "function";
  function: AgentNS.FunctionDefine;

  /** 模板消息（含 `{{key}}` 占位符）：exec 时注入参数后替换 agent.messages；省略则由 buildAgent 自行决定 */
  private messages?: AgentNS.Message[];

  private buildAgent: (parsedArgs: any, ctx: ToolCallContext) => Agent | Promise<Agent>;

  constructor(options: {
    function: AgentNS.FunctionDefine;
    messages?: AgentNS.Message[];
    buildAgent: (parsedArgs: any, ctx: ToolCallContext) => Agent | Promise<Agent>;
  }) {
    if (!options.function) throw new Error("AgentToolLazy must have a function");
    if (options.messages && options.messages.at(-1)?.role !== AgentNS.Role.User) {
      throw new Error("AgentToolLazy messages must end with a user message.");
    }
    this.function = options.function;
    this.messages = options.messages;
    this.buildAgent = options.buildAgent;
  }

  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent> {
    const agent = await this.buildAgent(ctx.parsedArgs, ctx);

    // 给了模板才接管初始消息：没给时初始消息由 buildAgent 决定
    if (this.messages) {
      agent.messages = AgentTool.injectArgs(
        JSON.parse(JSON.stringify(this.messages)),
        ctx.parsedArgs,
      );
    }

    // 委派边界：onSubAgentStart 钩子（可拒绝本次委派；同时广播 sub-agent-start 事件），
    // 并监听外部中断信号，abort 时联动中止子 Agent
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
      await ctx.agent.dispatchHook("onSubAgentEnd", subCtx);
    }

    return agent.messages.at(-1)?.content ?? "";
  }
}
