import { Agent, type SubAgentHookContext } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { sumUsage } from "../Usage.js";
import { ToolCallContext } from "../ToolCallContext.js";
import { Tool } from "../Tool.js";

/**
 * AgentToolLazy —— 延迟构建 Agent 的委派工具。
 *
 * Agent 不在构造时创建，而在 `exec` 时通过 `buildAgent` 回调获取 —— 这避免了工具列表
 * 构建阶段的递归创建问题（SubAgent → buildToolList → SubAgent → ...）。
 *
 * ## 委派的形态：燃料 + 一把钥匙
 *
 * 交给这里的 agent，`messages` 里已经装好了历史，末尾那条 user 就是这一趟要回答的问题。
 * 所以**不需要把消息搬进 inbox**：`runOnce()` 不给正文，就是拧钥匙。
 *
 * 初始消息有两种来源，二选一：
 * - 提供 `messages` 模板：`exec` 时把 `parsedArgs` 注入 `{{key}}` 占位符，替换 `agent.messages`；
 * - 省略 `messages`：初始消息由 `buildAgent` 自行决定，本类不接管。
 *
 * 两种都要满足同一条契约：**交给委派动作时，`messages` 里必须已经有东西**（`runOnce`
 * 没燃料会直接抛）。
 */
export class AgentToolLazy implements Tool {
  type: "function" = "function";
  function: AgentNS.FunctionDefine;

  /** 模板消息（含 `{{key}}` 占位符）：exec 时注入参数后替换 agent.messages */
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
    const label = this.function.name;

    if (this.messages) {
      // 模板注入：深拷贝后替引用。构造期换引用是合法的（§12）—— 这一刻还没有第二个持有者
      agent.messages = AgentToolLazy.injectArgs(this.messages, ctx.parsedArgs, label);
    } else {
      // 历史由 buildAgent 自己装：只补 `source` 这一格
      AgentToolLazy.fillSource(agent.messages, label);
    }

    // 委派边界：`onSubAgentStart` 可拒（原因作为工具结果回给模型）
    const subCtx: SubAgentHookContext = {
      agent: ctx.agent,
      subAgent: agent,
      toolCallContext: ctx,
    };
    const denied = await ctx.agent.dispatchSubAgentHook("onSubAgentStart", subCtx);
    if (denied !== undefined) return denied;

    try {
      // 跑它、等它闲、收尸 —— 全在 runOnce 里。中断信号直接交过去，
      // 不再需要手工把父的 abort 转成子 agent 的 abort。
      await agent.runOnce(undefined, { signal: ctx.signal });
    } finally {
      // 把子 Agent（含其孙级）的累计用量钉到本次委派的工具结果消息上，
      // 使其随消息持久化、并可被 sumUsage() 统一求和
      ctx.resultMessage.subAgentUsage = sumUsage(agent.messages);
      await ctx.agent.dispatchSubAgentHook("onSubAgentEnd", subCtx);
    }

    return agent.messages.at(-1)?.content ?? "";
  }

  /**
   * 把模板里的 `{{key}}` 换成 `valueMap[key]`；没有对应键的占位符原样保留。
   */
  static replaceStringWithValues(template: string, valueMap: Record<string, any>): string {
    const regex = /{{\s?(\w+)\s?}}/g;

    return template.replace(regex, (_, key) => {
      if (Object.prototype.hasOwnProperty.call(valueMap, key)) {
        return valueMap[key];
      }
      return `{{ ${key} }}`;
    });
  }

  /**
   * 深拷贝一份消息列表，把每条消息的字符串 content 做占位符替换（内容块数组原样保留），
   * 并给 `role: user` 的消息补上 `source`。
   *
   * 为什么 `source` 由这里补：§3 要求所有 user 消息都带 `source`，而模板是定义文件里的
   * JSON，压根没有这个概念。规矩与「宿主注入的 cwd 消息由宿主自己填」是同一条 ——
   * **谁注入谁填**。
   */
  static injectArgs(
    messages: AgentNS.Message[],
    parsedArgs: any,
    label: string,
  ): AgentNS.Message[] {
    return JSON.parse(JSON.stringify(messages)).map((message: AgentNS.Message) => ({
      ...message,
      content:
        typeof message.content == "string"
          ? AgentToolLazy.replaceStringWithValues(message.content, parsedArgs)
          : message.content,
      source:
        message.role === AgentNS.Role.User
          ? (message.source ?? { kind: "agent", label })
          : message.source,
    }));
  }

  /** 就地给 `role: user` 的消息补 `source`（已有的不覆盖） */
  static fillSource(messages: AgentNS.Message[], label: string): void {
    for (const message of messages) {
      if (message.role === AgentNS.Role.User && !message.source) {
        message.source = { kind: "agent", label };
      }
    }
  }
}
