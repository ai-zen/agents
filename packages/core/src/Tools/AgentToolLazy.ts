import { Agent } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { ToolCallContext } from "../ToolCallContext.js";
import { Message } from "../Message.js";
import { Tool } from "../Tool.js";
import { AgentTool } from "./AgentTool.js";

/**
 * AgentToolLazy — 延遲構建 Agent 的工具。
 *
 * 與 AgentTool 不同，Agent 不在構造時創建，而是在 exec 時通過 buildAgent 回調獲取。
 * 這避免了在工具列表構建階段的遞歸創建問題（SubAgent → buildToolList → SubAgent → ...）。
 *
 * buildAgent 回调通过显式参数 (parsedArgs, ctx) 接收上下文，可通过 ctx.agent 访问父 Agent。
 */
export class AgentToolLazy implements Tool {
  type: "function" = "function";
  function: AgentNS.FunctionDefine;

  /** 模板消息（含 {{key}} 佔位符），將在 exec 時注入參數後替換 agent.messages */
  private messages: AgentNS.Message[];

  /** 延遲構建 Agent 的回調。第二参 ctx 携带 ToolCallContext */
  private buildAgent: (parsedArgs: any, ctx: ToolCallContext) => Agent | Promise<Agent>;

  constructor(options: {
    function: AgentNS.FunctionDefine;
    messages: AgentNS.Message[];
    buildAgent: (parsedArgs: any, ctx: ToolCallContext) => Agent | Promise<Agent>;
  }) {
    if (!options.function) throw new Error("AgentToolLazy must have a function");
    if (options.messages?.at(-1)?.role !== AgentNS.Role.User) {
      throw new Error("AgentToolLazy messages must end with a user message.");
    }
    this.function = options.function;
    this.messages = options.messages;
    this.buildAgent = options.buildAgent;
  }

  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent> {
    // 1. 延遲構建 Agent（model + tools + system prompt 在此時確定）
    const agent = await this.buildAgent(ctx.parsedArgs, ctx);

    // 2. 注入參數到模板消息 → 替換 agent.messages
    agent.messages = AgentTool.injectArgs(
      JSON.parse(JSON.stringify(this.messages)),
      ctx.parsedArgs,
    );

    // 3. 拼接 Assistant 接收者
    agent.append(Message.Assistant());

    // 4. 執行：监听外部中断信号，abort 时联动中止子 Agent
    ctx.agent.events.emit("sub-agent", { agent, ctx });
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
      ctx.agent.events.emit("sub-agent-end", { agent, ctx });
    }

    return agent.messages.at(-1)?.content ?? "";
  }
}
