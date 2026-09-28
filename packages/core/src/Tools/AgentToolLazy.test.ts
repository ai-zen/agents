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

describe("AgentToolLazy 子 Agent 委派边界", () => {
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

  it("onSubAgentStart 载荷区分主/子 Agent，放行后返回子 Agent 结果", async () => {
    const childClient = createMockClient("子Agent结果");
    const child = new Agent({ client: childClient, model: "gpt-4" });
    const tool = buildTool(child);
    const host = new Agent({
      client: createMockClient(),
      model: "gpt-4",
      messages: [Message.System("主助手")],
      tools: [tool],
    });

    const seen: any[] = [];
    host.use({ onSubAgentStart: (c) => { seen.push(c); } });

    const ctx = buildCtx(host);
    const result = await tool.exec(ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0].agent).toBe(host); // 主（宿主）
    expect(seen[0].subAgent).toBe(child); // 子
    expect(seen[0].toolCallContext).toBe(ctx);
    expect(result).toBe("子Agent结果");
  });

  it("onSubAgentStart 返回字符串时拒绝委派：子 Agent 不 run、原因作为工具结果", async () => {
    const childClient = createMockClient("子Agent结果");
    const child = new Agent({ client: childClient, model: "gpt-4" });
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
    host.events.on("sub-agent-start", startEvent);
    host.events.on("sub-agent-end", endEvent);

    const result = await tool.exec(buildCtx(host));

    expect(result).toBe("任务上下文不完整");
    expect(childClient.chat.completions.create).not.toHaveBeenCalled();
    expect(endHook).not.toHaveBeenCalled();
    // 非阻塞事件：开始事件仍广播，结束事件不触发
    expect(startEvent).toHaveBeenCalledTimes(1);
    expect(endEvent).not.toHaveBeenCalled();
  });

  it("onSubAgentEnd 在子 Agent 完成后触发，且不影响工具结果", async () => {
    const child = new Agent({ client: createMockClient("子Agent结果"), model: "gpt-4" });
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
    host.events.on("sub-agent-end", endEvent);

    const result = await tool.exec(buildCtx(host));

    expect(endHook).toHaveBeenCalledTimes(1);
    expect(endEvent).toHaveBeenCalledTimes(1);
    expect(result).toBe("子Agent结果");
  });
});
