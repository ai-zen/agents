import { Agent, type SubAgentContext } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { ToolCallContext } from "../ToolCallContext.js";
import { Tool } from "../Tool.js";
import { AgentTool } from "./AgentTool.js";

/**
 * AgentToolLazy — 延遲構建 Agent 的工具。
 *
 * 與 AgentTool 不同，Agent 不在構造時創建，而是在 exec 時通過 buildAgent 回調獲取。
 * 這避免了在工具列表構建階段的遞歸創建問題（SubAgent → buildToolList → SubAgent → ...）。
 *
 * buildAgent 回调通过显式参数 (parsedArgs, ctx) 接收上下文，可通过 ctx.agent 访问父 Agent。
 *
 * 初始消息有兩種來源，二選一：
 *   - 提供 messages 模板：exec 时把 parsedArgs 注入 {{key}} 占位符，覆盖 agent.messages；
 *   - 省略 messages：初始消息由 buildAgent 自行决定（如初始消息依赖运行时参数时），
 *     AgentToolLazy 不接管 messages。
 */
export class AgentToolLazy implements Tool {
  type: "function" = "function";
  function: AgentNS.FunctionDefine;

  /** 模板消息（含 {{key}} 佔位符），將在 exec 時注入參數後替換 agent.messages；省略則由 buildAgent 自行决定 */
  private messages?: AgentNS.Message[];

  /** 延遲構建 Agent 的回調。第二参 ctx 携带 ToolCallContext */
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
    // 1. 延遲構建 Agent（model + tools + 初始消息在此時確定）
    const agent = await this.buildAgent(ctx.parsedArgs, ctx);

    // 2. 提供模板消息时：注入參數後替換 agent.messages；
    //    省略时初始消息由 buildAgent 自行决定，此处不接管
    // （Assistant 占位由 run 内循环开头统一追加）
    if (this.messages) {
      agent.messages = AgentTool.injectArgs(
        JSON.parse(JSON.stringify(this.messages)),
        ctx.parsedArgs,
      );
    }

    // 3. 委派边界：onSubAgentStart 钩子（可拒绝本次委派；同时广播 sub-agent-start 事件），
    //    并监听外部中断信号，abort 时联动中止子 Agent
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
      await ctx.agent.dispatchHook("onSubAgentEnd", subCtx);
    }

    return agent.messages.at(-1)?.content ?? "";
  }
}
