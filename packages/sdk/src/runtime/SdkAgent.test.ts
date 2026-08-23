import { describe, it, expect, vi } from "vitest";
import { AgentNS, Tool } from "@ai-zen/agents-core";
import type { AgentPlugin } from "@ai-zen/agents-core";
import { SdkAgent } from "./SdkAgent.js";
import { CallbackTool } from "@ai-zen/agents-core";

// ---------------------------------------------------------------------------
// mock helpers
// ---------------------------------------------------------------------------

type AnyChunk = any;

/** 构造一个流式 chunk */
function chunk(delta: any, finish_reason: any = null): AnyChunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason }],
  };
}

/** 结束 chunk */
function stopChunk(): AnyChunk {
  return chunk({}, "stop");
}

/** 创建 Mock OpenAI client（返回固定回复） */
function createMockClient(rounds: AnyChunk[][] = [[chunk({ content: "回复" }), stopChunk()]]) {
  let callCount = 0;
  const create = vi.fn(async () => {
    const data = rounds[callCount] ?? [];
    callCount++;
    return {
      async *[Symbol.asyncIterator]() {
        for (const c of data) yield c;
      },
    };
  });
  return { chat: { completions: { create } } } as any;
}

function mockProvider(opts?: { mcpPaths?: string[] }) {
  return {
    config: {
      defaultModel: "m1",
      models: [{ id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 }],
      endpoints: [],
    },
    agentsDir: "",
    subAgentsPaths: [],
    skillsPaths: [],
    toolsPaths: [],
    mcpPaths: opts?.mcpPaths ?? [],
    builtinTools: [],
    userTools: [],
    subagents: [],
    skills: [],
    mcps: [],
    mcpManager: undefined,
    filter: () => ({ tools: [], subagents: [], skills: [], mcps: [] }),
    buildTools: () => [],
    instantiate: () => [],
    refresh: async () => {},
  };
}

function createTestAgent(opts?: {
  client?: any;
  messages?: any[];
  tools?: any[];
  provider?: any;
}): SdkAgent {
  const messages =
    opts?.messages ?? [{ role: AgentNS.Role.System, content: "You are a helper." }];
  return new SdkAgent({
    provider: opts?.provider ?? (mockProvider() as any),
    definition: {
      id: "test-agent",
      name: "Test Agent",
      messages: [{ role: AgentNS.Role.System, content: "You are a helper." }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    client: opts?.client ?? createMockClient(),
    model: "test-model",
    messages,
    tools: opts?.tools ?? [],
  });
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("SdkAgent", () => {
  it("构造时携带 provider / definition（含 permissions）", () => {
    const provider = mockProvider() as any;
    const agent = new SdkAgent({
      provider,
      definition: {
        id: "t",
        name: "T",
        messages: [],
        permissions: { tools: { allow: ["readFile"] } },
        createdAt: "",
        updatedAt: "",
      },
      client: {} as any,
      model: "m",
    });

    expect(agent.provider).toBe(provider);
    expect(agent.definition.id).toBe("t");
    expect(agent.definition.permissions?.tools).toEqual({ allow: ["readFile"] });
    expect(agent.model).toBe("m");
  });

  describe("use() / init()（继承 Core 插件机制）", () => {
    it("可以注册插件", () => {
      const agent = createTestAgent();
      const plugin: AgentPlugin = { onInit: vi.fn() };
      agent.use(plugin);
      expect((agent as any)._plugins).toHaveLength(1);
    });

    it("依次调用所有插件的 onInit", async () => {
      const agent = createTestAgent();
      const order: number[] = [];
      const p1: AgentPlugin = { onInit: vi.fn(async () => { order.push(1); }) };
      const p2: AgentPlugin = { onInit: vi.fn(async () => { order.push(2); }) };

      agent.use(p1);
      agent.use(p2);
      await agent.init();

      expect(order).toEqual([1, 2]);
    });

    it("插件 onInit 抛错时 init 抛出错误", async () => {
      const agent = createTestAgent();
      const plugin: AgentPlugin = {
        onInit: async () => { throw new Error("Init failed"); },
      };
      agent.use(plugin);
      await expect(agent.init()).rejects.toThrow("Init failed");
    });
  });

  describe("send() — 插件钩子（真实 send 流程 + mock client）", () => {
    it("按顺序执行 onBeforeSend → 消息处理 → onAfterSend", async () => {
      const client = createMockClient([[chunk({ content: "ok" }), stopChunk()]]);
      const agent = createTestAgent({ client });
      const callOrder: string[] = [];

      agent.use({
        onBeforeSend: async () => { callOrder.push("beforeSend"); },
        onAfterSend: async () => { callOrder.push("afterSend"); },
      });

      await agent.send("hello");

      expect(callOrder).toEqual(["beforeSend", "afterSend"]);
      expect(agent.messages.at(-1)!.status).toBe(AgentNS.MessageStatus.Completed);
    });

    it("onBeforeSend 插件收到 SendContext（agent / content / messages）", async () => {
      const agent = createTestAgent();
      const onBeforeSend = vi.fn();
      agent.use({ onBeforeSend });

      await agent.send("hello");

      expect(onBeforeSend).toHaveBeenCalledTimes(1);
      const ctx = onBeforeSend.mock.calls[0][0];
      expect(ctx.agent).toBe(agent);
      expect(ctx.content).toBe("hello");
      expect(Array.isArray(ctx.messages)).toBe(true);
    });

    it("多个插件按注册顺序执行钩子", async () => {
      const agent = createTestAgent();
      const order: number[] = [];
      agent.use({ onBeforeSend: async () => { order.push(1); } });
      agent.use({ onBeforeSend: async () => { order.push(2); } });
      agent.use({ onBeforeSend: async () => { order.push(3); } });

      await agent.send("hi");

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe("send() — 插件 onToolCall 钩子", () => {
    it("任一插件返回字符串即拒绝（短路），全部放行则执行", async () => {
      const denyTool = new CallbackTool({
        function: {
          name: "blockedTool",
          description: "被插件拒绝的工具",
          parameters: { type: "object", properties: {} },
        },
        callback: vi.fn(() => "不应执行"),
      });

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "blockedTool", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "已处理" }), stopChunk()],
      ]);

      const agent = createTestAgent({ client, tools: [denyTool] });
      agent.use({
        onToolCall: (ctx) =>
          ctx.tool_call.function?.name === "blockedTool"
            ? "插件拒绝：不允许"
            : undefined,
      });

      await agent.send("hi");

      expect(denyTool.callback).not.toHaveBeenCalled();
      const toolResult = agent.messages.find((m) => m.role === AgentNS.Role.Tool)!;
      expect(toolResult.content).toContain("插件拒绝");
    });

    it("插件 onToolCall 收到同一个 ToolCallContext 实例", async () => {
      const tool = new CallbackTool({
        function: {
          name: "okTool",
          description: "正常工具",
          parameters: { type: "object", properties: {} },
        },
        callback: (_args: any, ctx: any) => {
          execCtx = ctx;
          return "ok";
        },
      });
      let hookCtx: any;
      let execCtx: any;

      const client = createMockClient([
        [
          chunk({ tool_calls: [{ index: 0, id: "1", type: "function", function: { name: "okTool", arguments: "{}" } }] }),
          chunk({}, "tool_calls"),
        ],
        [chunk({ content: "完成" }), stopChunk()],
      ]);

      const agent = createTestAgent({ client, tools: [tool] });
      agent.use({
        onToolCall: (ctx) => {
          hookCtx = ctx;
          return undefined;
        },
      });

      await agent.send("hi");

      expect(hookCtx).toBeDefined();
      expect(execCtx).toBeDefined();
      expect(hookCtx).toBe(execCtx);
    });
  });
});
