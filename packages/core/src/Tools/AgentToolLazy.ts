import { Agent, type SubAgentHookContext } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { ToolCallContext } from "../ToolCallContext.js";
import { Tool } from "../Tool.js";
import { sumUsage } from "../Usage.js";

/**
 * AgentToolLazy —— 延迟构建 Agent 的委派工具。
 *
 * Agent 不在构造时创建，而在 `exec` 时通过 `buildAgent` 回调获取 —— 这避免了工具列表
 * 构建阶段的递归创建问题（SubAgent → buildToolList → SubAgent → ...）。
 *
 * ## 委派的形态：燃料 + 钥匙
 *
 * 交给这里的 agent，`messages` 里已经装好了历史，末尾那条 user 就是这一趟要回答的问题。
 * 所以**不需要把消息搬进 inbox**：`runOnce()` 不给正文，就是拧钥匙。
 *
 * ## 它造出来的 agent 是一次性的
 *
 * 这一趟走 `runOnce()`，它只接受 `lifetime: "one-shot"` 的 agent（常驻的调它直接抛，`CORE.md` §9）。
 * 这条路是用来干一件已经看得见结果的活，不是用来养一个常驻节点的 —— 那个得有人定地址、
 * 有人负责 `stop`。
 *
 * 初始消息有两种来源，二选一：
 * - 提供 `messages` 模板：`exec` 时把 `parsedArgs` 注入 `{{key}}` 占位符，替换 `agent.messages`；
 * - 省略 `messages`：初始消息由 `buildAgent` 自行决定，本类不接管。
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

    // 血缘**不在这里记**：只有名册一份（§17）。`dispatchSubAgentHook` 在发 `subAgentStarted`
    // 之前就把这一项压进父 agent 的名册，订阅方在那一刻就已经能从父的 `subAgents` 摸到它。
    // 拒了这一项压根不记 —— 没造出来的东西不该挂在世上。
    const subCtx: SubAgentHookContext = {
      agent: ctx.agent,
      subAgent: agent,
      toolCallContext: ctx,
    };
    const denied = await ctx.agent.dispatchSubAgentHook("onSubAgentStart", subCtx);
    if (denied !== undefined) {
      return denied;
    }

    const before = agent.messages.length;
    const forwarded = this.forward(agent, ctx);

    // subagent 这一次请求被拒时，它一个字都不会产出；理由只在 `denied` 事件里
    let refused: string | undefined;
    const offDenied = agent.on("denied", (payload) => {
      refused = payload.reason;
    });

    try {
      // 跑它、等它空闲、收尾 —— 全在 runOnce 里。中断信号直接交过去，
      // 不再需要手工把父的 abort 转成 subagent 的 abort。
      await agent.runOnce(undefined, { signal: ctx.signal });
    } finally {
      offDenied();
      for (const off of forwarded) off();
      // 把 subagent（含其孙级）的累计用量钉到本次委派的工具结果消息上，
      // 使其随消息持久化、并可被 `sumUsage()` 统一求和
      ctx.resultMessage.subAgentUsage = sumUsage(agent.messages);
      await ctx.agent.dispatchSubAgentHook("onSubAgentEnd", subCtx);
    }

    // 被拒的那一次请求不产生任何消息。此时若还交回「最后一条消息的内容」，父模型读到的会是
    // **它自己那句问题原文** —— 等于 subagent 把问题原文重复了一遍，而调用方以为拿到了结果。
    if (agent.messages.length <= before) {
      return refused ?? "subagent 没有产出：这次请求被拒了，或者它一个字也没说";
    }

    return agent.messages.at(-1)?.content ?? "";
  }

  /**
   * 把 subagent 的事件按**同一套名字**转发到父身上（§9-3）。
   *
   * 不另起一套平行名字：父和宿主的订阅方只多认两格 —— `subAgent`（这些事发生在谁身上）
   * 与 `via`（是哪一次委派引起的）。`delta` 走它的 `source` 第二格。
   *
   * 只转发「subagent 内部发生了什么」这几类（消息、原始片、工具、收口那一条）；`state` 不转发 ——
   * 父自己的那一格（`state`）是父的，混进来会让「这个 agent 现在在不在干」变得没法回答。
   */
  private forward(sub: Agent, ctx: ToolCallContext): Array<() => void> {
    const host = ctx.agent;
    const via = ctx.tool_call;
    const offs: Array<() => void> = [];

    // 转发是一次新的发出：载荷里带着子 Agent 的 `seq` / `at`，父的 `emit` 会用**父自己的**号与时刻覆盖掉。
    for (const type of ["messageAdded", "messageChanged", "messageRemoved"] as const) {
      offs.push(
        sub.on(type, (payload) => host.emit(type, { ...payload, agent: host, subAgent: sub, via })),
      );
    }

    // 同上：转发是一次新的发出，序号与时刻记的是父 Agent 自己的。
    for (const type of ["toolStarted", "toolFinished"] as const) {
      offs.push(
        sub.on(type, (payload) => host.emit(type, { ...payload, agent: host, subAgent: sub, via })),
      );
    }

    // **收口那一条也要转发。** 主转录靠 `responseFinished` 把**最后一片正文**、`status`、
    // `finish_reason`、`usage` 钉到消息上（§10：收流之后才发）—— 派出去的那个也一样欠这一条：
    // 不转发的话，subagent 的最后一片正文就没有机会带出来：最后一片没有下一片（那段正文
    // 就此丢失），父级看到的 subagent 消息还会长期停在 `writing`。
    //
    // 载荷改写与「消息」那几条**同一套**（`agent` 换成父、加 `subAgent` / `via`）；带出去的是
    // **那条活消息本身**、不是 id —— 接收方读它就把收尾三格一起拿到了，与 `messageChanged` 同理。
    // 序号与时刻同样换成父自己的：转发是一次新的发出。
    offs.push(
      sub.on("responseFinished", (payload) =>
        host.emit("responseFinished", { ...payload, agent: host, subAgent: sub, via }),
      ),
    );

    // `delta` 也一样：转发是一次新的发出，序号与时刻记的是父 Agent 自己的。
    offs.push(
      sub.on("delta", (payload) =>
        host.emit("delta", { ...payload, agent: host, source: { subAgent: sub, toolCall: via } }),
      ),
    );

    return offs;
  }

  /**
   * 把模板里的 `{{key}}` 换成 `valueMap[key]`；找不到对应键的占位符留着（写作 `{{ key }}`）。
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
   * 为什么 `source` 由这里补：模板是定义文件里的 JSON，压根没有这个概念，而注入它的这一层
   * 知道它从哪来（宿主注入的 cwd 消息同理 —— 谁注入谁填）。
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
