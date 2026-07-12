import { Agent } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { FunctionCallContext } from "../FunctionCallContext.js";
import { Message } from "../Message.js";
import { Tool } from "../Tool.js";
import { AgentTool } from "./AgentTool.js";

/**
 * AgentToolLazy — 延遲構建 Agent 的工具。
 *
 * 與 AgentTool 不同，Agent 不在構造時創建，而是在 exec 時通過 buildAgent 回調獲取。
 * 這避免了在工具列表構建階段的遞歸創建問題（SubAgent → buildToolList → SubAgent → ...）。
 *
 * buildAgent 回調中 this 綁定為 FunctionCallContext，可通過 this.agent 訪問父 Agent。
 */
export class AgentToolLazy implements Tool {
  type: "function" = "function";
  function: AgentNS.FunctionDefine;

  /** 模板消息（含 {{key}} 佔位符），將在 exec 時注入參數後替換 agent.messages */
  private messages: AgentNS.Message[];

  /** 延遲構建 Agent 的回調。this = FunctionCallContext */
  private buildAgent: (this: FunctionCallContext, parsedArgs: any) => Promise<Agent>;

  constructor(options: {
    function: AgentNS.FunctionDefine;
    messages: AgentNS.Message[];
    buildAgent: (this: FunctionCallContext, parsedArgs: any) => Promise<Agent>;
  }) {
    if (!options.function) throw new Error("AgentToolLazy must have a function");
    if (options.messages?.at(-1)?.role !== AgentNS.Role.User) {
      throw new Error("AgentToolLazy messages must end with a user message.");
    }
    this.function = options.function;
    this.messages = options.messages;
    this.buildAgent = options.buildAgent;
  }

  async exec(ctx: FunctionCallContext): Promise<string> {
    // 1. 延遲構建 Agent（model + tools + system prompt 在此時確定）
    const agent = await this.buildAgent.call(ctx, ctx.parsed_args);

    // 2. 注入參數到模板消息 → 替換 agent.messages
    agent.messages = AgentTool.injectArgs(
      JSON.parse(JSON.stringify(this.messages)),
      ctx.parsed_args,
    );

    // 3. 拼接 Assistant 接收者
    agent.append(Message.Assistant());

    // 4. RAG rewrite（如有）
    const questionMessage = agent.messages.at(-2)!;
    await agent.rag?.rewrite(questionMessage, agent.messages);

    // 5. 執行
    ctx.agent.events.emit("sub-agent", { agent, ctx });
    try {
      await agent.run();
    } finally {
      ctx.agent.events.emit("sub-agent-end", { agent, ctx });
    }

    return agent.messages.at(-1)?.content as string;
  }
}
