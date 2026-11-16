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
 * ## 它造出来的必须是一次性 agent
 *
 * `buildAgent` 交出来的 agent 必须 `lifetime: "one-shot"`（`CORE.md` §9）。这条路是用来
 * 干一件已经看得见结果的活，不是用来养一个常驻节点的 —— 那个得有人定地址、有人负责 `stop`。
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

    // 血缘先记上，再问钩子：`subAgentStarted` 是在 `dispatchSubAgentHook` 里发的，
    // 订阅方要在那一刻就能从 `parent` / `children` 摸到关系（§9-2「造点和记关系是同一次动作」）。
    // 拒了就把关系撤回去 —— 没造出来的东西不该挂在世上。
    agent.parent = ctx.agent;
    ctx.agent.children.add(agent);

    const subCtx: SubAgentHookContext = {
      agent: ctx.agent,
      subAgent: agent,
      toolCallContext: ctx,
    };
    const denied = await ctx.agent.dispatchSubAgentHook("onSubAgentStart", subCtx);
    if (denied !== undefined) {
      ctx.agent.children.delete(agent);
      agent.parent = undefined;
      return denied;
    }

    const before = agent.messages.length;
    const forwarded = this.forward(agent, ctx);

    // 子 agent 自己那一圈被拒时，它一个字都不会产出；理由只在 `denied` 事件里
    let refused: string | undefined;
    const offDenied = agent.on("denied", (payload) => {
      refused = payload.reason;
    });

    try {
      // 跑它、等它闲、收尸 —— 全在 runOnce 里。中断信号直接交过去，
      // 不再需要手工把父的 abort 转成子 agent 的 abort。
      await agent.runOnce(undefined, { signal: ctx.signal });
    } finally {
      offDenied();
      for (const off of forwarded) off();
      ctx.agent.children.delete(agent);
      // 把子 Agent（含其孙级）的累计用量钉到本次委派的工具结果消息上，
      // 使其随消息持久化、并可被 sumUsage() 统一求和
      ctx.resultMessage.subAgentUsage = sumUsage(agent.messages);
      await ctx.agent.dispatchSubAgentHook("onSubAgentEnd", subCtx);
    }

    // 被拒的一圈不产生任何消息。此时交回「最后一条消息的内容」，父模型读到的会是**它自己
    // 那句问题原文** —— 等于子 agent 装傻复读了一遍。这种情况必须显式说「没产出」。
    if (agent.messages.length <= before) {
      return refused ?? "子 agent 没有产出：这一圈被拒绝了，或者它一个字也没说";
    }

    return agent.messages.at(-1)?.content ?? "";
  }

  /**
   * 把子 agent 的事件按**同一套名字**转发到父身上（§9-3）。
   *
   * 不另起一套平行名字：父和宿主的订阅方只多认两格 —— `subAgent`（这些事发生在谁身上）
   * 与 `via`（是哪一次委派引起的）。`delta` 走它的 `source` 第二格。
   *
   * 只转发「子 agent 内部发生了什么」这三类（消息、原始片、工具）；`state` 不转发 ——
   * 父自己的三格是父的，混进来会让「这个 agent 现在忙不忙」变得没法回答。
   */
  private forward(sub: Agent, ctx: ToolCallContext): Array<() => void> {
    const host = ctx.agent;
    const via = ctx.tool_call;
    const offs: Array<() => void> = [];

    for (const type of ["messageAdded", "messageChanged", "messageRemoved"] as const) {
      offs.push(
        sub.on(type, (payload) => host.emit(type, { ...payload, agent: host, subAgent: sub, via })),
      );
    }

    for (const type of ["toolStarted", "toolFinished"] as const) {
      offs.push(
        sub.on(type, (payload) => host.emit(type, { ...payload, agent: host, subAgent: sub, via })),
      );
    }

    offs.push(
      sub.on("delta", (payload) =>
        host.emit("delta", { ...payload, agent: host, source: { subAgent: sub, toolCall: via } }),
      ),
    );

    return offs;
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
