import { describe, it, expect, vi } from "vitest";
import { AgentToolLazy } from "./AgentToolLazy.js";
import { Agent } from "../Agent.js";
import { AgentNS } from "../AgentNS.js";
import { Message } from "../Message.js";
import { ToolCallContext } from "../ToolCallContext.js";
import { addUsage, sumUsage } from "../Usage.js";

function createMockClient(responseText = "mock回复") {
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock",
        choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }],
      };
      yield {
        id: "chunk-2",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
    },
  };
  const create = vi.fn(async () => stream);
  return { chat: { completions: { create } } } as any;
}

describe("AgentToolLazy subagent 委派边界", () => {
  function buildTool(child: Agent) {
    return new AgentToolLazy({
      function: {
        name: "lazyFn",
        description: "测试",
        parameters: { type: "object", properties: {}, required: [] },
      },
      messages: [Message.User("{{task}}")],
      buildAgent: () => child,
    });
  }

  function buildCtx(host: Agent) {
    return new ToolCallContext({
      agent: host,
      tool_call: {
        function: { name: "lazyFn", arguments: JSON.stringify({ task: "写代码" }) },
      },
      resultMessage: Message.Tool({ id: "1", function: { name: "lazyFn" } }),
    });
  }

  it("onSubAgentStart 载荷区分主 agent / subagent，放行后返回 subagent 结果", async () => {
    const childClient = createMockClient("subagent结果");
    const child = new Agent({ client: childClient, model: "gpt-4", lifetime: "one-shot" });
    const tool = buildTool(child);
    const host = new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [tool],
    });

    const seen: any[] = [];
    host.use({
      onSubAgentStart: (c) => {
        seen.push(c);
      },
    });

    const ctx = buildCtx(host);
    const result = await tool.exec(ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0].agent).toBe(host); // 主（宿主）
    expect(seen[0].subAgent).toBe(child); // 子
    expect(seen[0].toolCallContext).toBe(ctx);
    expect(result).toBe("subagent结果");
  });

  it("onSubAgentStart 返回字符串时拒绝委派：subagent 不 run、原因作为工具结果", async () => {
    const childClient = createMockClient("subagent结果");
    const child = new Agent({ client: childClient, model: "gpt-4", lifetime: "one-shot" });
    const tool = buildTool(child);
    const host = new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [tool],
    });

    const endHook = vi.fn();
    host.use({ onSubAgentStart: () => "任务上下文不完整", onSubAgentEnd: endHook });
    const startEvent = vi.fn();
    const endEvent = vi.fn();
    host.on("subAgentStarted", startEvent);
    host.on("subAgentFinished", endEvent);

    const deniedEvents: any[] = [];
    host.on("denied", (payload) => deniedEvents.push(payload));

    const result = await tool.exec(buildCtx(host));

    expect(result).toBe("任务上下文不完整");
    expect(childClient.chat.completions.create).not.toHaveBeenCalled();
    expect(endHook).not.toHaveBeenCalled();
    // 拒了就没什么「开始」可言：钩子在前（能拒），事件在后（已定）
    expect(startEvent).not.toHaveBeenCalled();
    expect(endEvent).not.toHaveBeenCalled();
    // 拒这件事本身要报出来（与另两道门同口径），理由原样带出去
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0].hook).toBe("onSubAgentStart");
    expect(deniedEvents[0].reason).toBe("任务上下文不完整");
  });

  it("onSubAgentEnd 在subagent 完成后触发，且不影响工具结果", async () => {
    const child = new Agent({
      client: createMockClient("subagent结果"),
      model: "gpt-4",
      lifetime: "one-shot",
    });
    const tool = buildTool(child);
    const host = new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [tool],
    });

    const endHook = vi.fn(() => "结束提示");
    host.use({ onSubAgentEnd: endHook });
    const endEvent = vi.fn();
    host.on("subAgentFinished", endEvent);

    const result = await tool.exec(buildCtx(host));

    expect(endHook).toHaveBeenCalledTimes(1);
    expect(endEvent).toHaveBeenCalledTimes(1);
    expect(result).toBe("subagent结果");
  });

  it("省略 messages 时保留 buildAgent 决定的初始消息，不被模板覆盖", async () => {
    const child = new Agent({
      client: createMockClient("subagent结果"),
      model: "gpt-4",
      lifetime: "one-shot",
      messages: [Message.System("动态提示"), Message.User("动态任务")],
    });
    const tool = new AgentToolLazy({
      function: {
        name: "lazyFn",
        description: "测试",
        parameters: { type: "object", properties: {}, required: [] },
      },
      buildAgent: async () => child,
    });
    const host = new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [tool],
    });

    const result = await tool.exec(buildCtx(host));

    expect(result).toBe("subagent结果");
    expect(child.messages.slice(0, 2).map((m) => m.content)).toEqual(["动态提示", "动态任务"]);
  });

  it("省略 messages 时不做末条类型校验；提供模板时仍要求末条为 User", () => {
    const fn: AgentNS.FunctionDefine = {
      name: "lazyFn",
      description: "测试",
      parameters: { type: "object", properties: {}, required: [] },
    };
    const buildAgent = () =>
      new Agent({ client: createMockClient(), model: "gpt-4", lifetime: "one-shot" });

    expect(() => new AgentToolLazy({ function: fn, buildAgent })).not.toThrow();
    expect(
      () =>
        new AgentToolLazy({
          function: fn,
          messages: [Message.System("非 User 结尾")],
          buildAgent,
        }),
    ).toThrow("must end with a user message");
  });

  it("血缘只在名册上：`subAgentStarted` 那一刻就能从父的 `subAgents` 摸到这一项，结束时只填 `endedAt`", async () => {
    const child = new Agent({
      client: createMockClient("结果"),
      model: "gpt-4",
      lifetime: "one-shot",
    });
    const host = new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [buildTool(child)],
    });

    let names = -1;
    let endedAtDuring = "未读到";
    host.on("subAgentStarted", () => {
      names = host.subAgents.length;
      endedAtDuring = String(host.subAgents[0]!.endedAt);
    });

    await buildTool(child).exec(buildCtx(host));

    // 发事件那一刻名册里已经有它（先记名字、再发事件）
    expect(names).toBe(1);
    expect(endedAtDuring).toBe("null");
    // 结束只标注、不移除：父照样答得出它跑过什么
    expect(host.subAgents).toHaveLength(1);
    expect(host.subAgents[0]!.agent).toBe(child);
    expect(host.subAgents[0]!.endedAt).not.toBeNull();
  });

  it("subagent 的事件按同一套名字转发到父，带 subAgent 与 via", async () => {
    const child = new Agent({
      client: createMockClient("结果"),
      model: "gpt-4",
      lifetime: "one-shot",
    });
    const host = new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [buildTool(child)],
    });

    const deltas: any[] = [];
    const added: any[] = [];
    host.on("delta", (payload) => deltas.push(payload));
    host.on("messageAdded", (payload) => added.push(payload));

    await buildTool(child).exec(buildCtx(host));

    // subagent 的原始片转上来了，来源说清楚是谁、哪次委派引起的
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[0].subAgent).toBeUndefined();
    expect(deltas[0].source.subAgent).toBe(child);
    expect(deltas[0].source.toolCall.function.name).toBe("lazyFn");
    // subagent 的消息也转上来了，带上两格标记
    expect(added.some((p) => p.subAgent === child)).toBe(true);
    expect(added.find((p) => p.subAgent === child).via.function.name).toBe("lazyFn");
  });

  it("subagent 那一圈被拒时不复读父的问题，而是说「没产出」", async () => {
    const child = new Agent({
      client: createMockClient("不该被调用"),
      model: "gpt-4",
      lifetime: "one-shot",
    });
    // subagent 自己的内循环被拒 → 一个字都不产出
    child.use({ onInnerLoopStart: () => "上下文超了" });

    const host = new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [buildTool(child)],
    });

    const result = await buildTool(child).exec(buildCtx(host));

    expect(result).toBe("上下文超了");
    expect(result).not.toContain("{{task}}");
    expect(result).not.toBe("写代码");
  });
});

type AnyChunk = any;

/** 一段回答的流：正文 + 收尾片。收尾片带这次响应的 `usage`（真实端点就是这么给的） */
function usageStream(text: string, usage: AgentNS.Usage): AnyChunk[] {
  return [
    {
      id: "c-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      id: "c-2",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage,
    },
  ];
}

/** 一轮「要调一次工具」的流 */
function toolCallStream(id: string, name: string, args: string): AnyChunk[] {
  return [
    {
      id: "c-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "c-2",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

/** 每一轮按顺序取下一份流（用具那几轮就走完几轮） */
function sequenceClient(rounds: AnyChunk[][]) {
  let round = 0;
  const create = vi.fn(async () => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of rounds[round++] ?? []) yield chunk;
    },
  }));
  return { chat: { completions: { create } } } as any;
}

const usageOf = (prompt: number, completion: number, total: number): AgentNS.Usage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: total,
});

describe("AgentToolLazy 委派用量", () => {
  const functionOf = (name: string): AgentNS.FunctionDefine => ({
    name,
    description: "测试",
    parameters: { type: "object", properties: {}, required: [] },
  });

  function ctxOf(host: Agent) {
    return new ToolCallContext({
      agent: host,
      tool_call: {
        id: "call-1",
        function: { name: "lazyFn", arguments: JSON.stringify({ task: "写代码" }) },
      },
      resultMessage: Message.Tool({ id: "result-1", function: { name: "lazyFn" } }),
    });
  }

  it("委派跑完那一拍，把这次委派的全部用量写到结果那条 tool 消息上", async () => {
    const sub = usageOf(100, 20, 120);
    const child = new Agent({
      client: sequenceClient([usageStream("查到了", sub)]),
      model: "gpt-4",
      lifetime: "one-shot",
    });
    const tool = new AgentToolLazy({
      function: functionOf("lazyFn"),
      messages: [Message.User("{{task}}")],
      buildAgent: () => child,
    });
    const host = new Agent({
      client: sequenceClient([usageStream("好", usageOf(1, 1, 2))]),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [tool],
    });

    const ctx = ctxOf(host);
    await tool.exec(ctx);

    // 这条 tool 消息上是「这次委派花了多少」—— 也就是 subagent 全部消息的累计
    expect(ctx.resultMessage.subAgentUsage).toEqual(sumUsage(child.messages));
    expect(ctx.resultMessage.subAgentUsage).toEqual(sub);
    // 与它自身那次响应的 `usage` 互斥：tool 消息没有 `usage`
    expect(ctx.resultMessage.usage).toBeUndefined();
  });

  it("嵌套一层：父那条上是整棵树的累计（含孙级、不重复计）", async () => {
    const grandTotal = usageOf(300, 30, 330);
    const childTotal = usageOf(200, 20, 220);

    const grandchild = new Agent({
      client: sequenceClient([usageStream("孙的结果", grandTotal)]),
      model: "gpt-4",
      lifetime: "one-shot",
    });
    const grandchildTool = new AgentToolLazy({
      function: functionOf("grandFn"),
      messages: [Message.User("{{task}}")],
      buildAgent: () => grandchild,
    });

    // 子：先委派给孙，再给出结论
    const child = new Agent({
      client: sequenceClient([
        toolCallStream("grand-call", "grandFn", JSON.stringify({ task: "查孙级" })),
        usageStream("子的结论", childTotal),
      ]),
      model: "gpt-4",
      lifetime: "one-shot",
      tools: [grandchildTool],
    });
    const tool = new AgentToolLazy({
      function: functionOf("lazyFn"),
      messages: [Message.User("{{task}}")],
      buildAgent: () => child,
    });
    const host = new Agent({
      client: sequenceClient([usageStream("好", usageOf(1, 1, 2))]),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [tool],
    });

    const ctx = ctxOf(host);
    await tool.exec(ctx);

    // 孙级确实跑过：它自己的 messages 上就是那 330
    expect(sumUsage(grandchild.messages)).toEqual(grandTotal);
    // subagent 自己那条 tool 消息上是孙级那份（写法与父那一层同一个）
    const childDelegation = child.messages.find((message) => message.subAgentUsage);
    expect(childDelegation?.subAgentUsage).toEqual(grandTotal);
    // 父那条 = 子自己的响应 + 孙级，一次求和即整棵树
    expect(ctx.resultMessage.subAgentUsage).toEqual(addUsage(childTotal, grandTotal));
    // 整段求和 = 整棵树一份，孙级没有被算两遍
    expect(sumUsage([...host.messages, ctx.resultMessage])).toEqual(
      addUsage(childTotal, grandTotal),
    );
  });
});

/**
 * 一段回答的流：正文分两片到，第二片自己带收尾信息（`finish_reason` + `usage`）。
 *
 * 真实端点最后一片正文往往就是流里最后一条带增量的 chunk。core 派发 `delta` 排在把这个片
 * 攒进消息之前，所以接收方看到的最后一条「原始片」永远缺这一片正文；它只能由收口那一条补。
 */
function tailPieceStream(first: string, last: string, usage: AgentNS.Usage): AnyChunk[] {
  return [
    {
      id: "c-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: { content: first }, finish_reason: null }],
    },
    {
      id: "c-2",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: { content: last }, finish_reason: "stop" }],
      usage,
    },
  ];
}

describe("AgentToolLazy 收口转发", () => {
  it("subagent 跑到收口时，父级收到的 responseFinished 带着完整正文（含最后一片）", async () => {
    const subUsage = usageOf(10, 5, 15);
    const child = new Agent({
      client: sequenceClient([tailPieceStream("前半", "最后一片", subUsage)]),
      model: "gpt-4",
      lifetime: "one-shot",
    });
    const tool = new AgentToolLazy({
      function: {
        name: "lazyFn",
        description: "测试",
        parameters: { type: "object", properties: {}, required: [] },
      },
      messages: [Message.User("{{task}}")],
      buildAgent: () => child,
    });
    const host = new Agent({
      client: sequenceClient([]),
      model: "gpt-4",
      messages: [Message.System("主AgentDefinition")],
      tools: [tool],
    });
    const ctx = new ToolCallContext({
      agent: host,
      tool_call: {
        id: "call-1",
        function: { name: "lazyFn", arguments: JSON.stringify({ task: "写代码" }) },
      },
      resultMessage: Message.Tool({ id: "result-1", function: { name: "lazyFn" } }),
    });

    // 接收方手里有两条路：原始片只带「已经攒进去的那部分」（最后一片还没攒），收口那一条才是完整
    const seenAtDelta: unknown[] = [];
    const finished: any[] = [];
    host.on("delta", ({ source }) => {
      if ("subAgent" in source) seenAtDelta.push(source.subAgent.messages.at(-1)?.content);
    });
    host.on("responseFinished", (payload) => finished.push(payload));

    await tool.exec(ctx);

    // 父级自己一趟请求都没发，这一条只可能是从 subagent 转发上来的
    expect(finished).toHaveLength(1);
    expect(finished[0].agent).toBe(host);
    expect(finished[0].subAgent).toBe(child);
    expect(finished[0].via.function.name).toBe("lazyFn");
    // 交出去的是那条活消息本身（不是 id、不是拷贝）：接收方读它就把正文与收尾三格一起拿到
    expect(finished[0].message).toBe(child.messages.at(-1));
    expect(finished[0].message.content).toBe("前半最后一片");
    // 原始片那条路停在「最后一片」之前 —— 这正是收口那一条必须转发的原因
    expect(seenAtDelta.at(-1)).toBe("前半");
    // 收尾三格也随它一起到：`status` 不再停在 `writing`
    expect(finished[0].message.status).toBe(AgentNS.MessageStatus.Completed);
    expect(finished[0].message.finish_reason).toBe("stop");
    expect(finished[0].message.usage).toEqual(subUsage);
  });
});
