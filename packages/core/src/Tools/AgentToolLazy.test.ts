import { describe, it, expect, vi } from "vitest";
import { AgentToolLazy } from "./AgentToolLazy.js";
import { Agent } from "../Agent.js";
import { Message } from "../Message.js";
import { ToolCallContext } from "../ToolCallContext.js";

// Helper: 创建 mock OpenAI client，始终返回固定文本
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
      messages: [Message.System("主助手")],
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
      messages: [Message.System("主助手")],
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
      messages: [Message.System("主助手")],
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
      messages: [Message.System("主助手")],
      tools: [tool],
    });

    const result = await tool.exec(buildCtx(host));

    expect(result).toBe("subagent结果");
    // 初始消息保持 buildAgent 的决定（其后仅由 run 追加 Assistant 接收者）
    expect(child.messages.slice(0, 2).map((m) => m.content)).toEqual(["动态提示", "动态任务"]);
  });

  it("省略 messages 时不做末条类型校验；提供模板时仍要求末条为 User", () => {
    const fn = {
      name: "lazyFn",
      description: "测试",
      parameters: { type: "object", properties: {}, required: [] },
    };
    const buildAgent = () => new Agent({ client: createMockClient(), model: "gpt-4", lifetime: "one-shot" });

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
      messages: [Message.System("主助手")],
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
    // 结束只标注、不移除：父照样答得出它跑过什么（§17）
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
      messages: [Message.System("主助手")],
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
      messages: [Message.System("主助手")],
      tools: [buildTool(child)],
    });

    const result = await buildTool(child).exec(buildCtx(host));

    expect(result).toBe("上下文超了");
    expect(result).not.toContain("{{task}}");
    expect(result).not.toBe("写代码");
  });
});
