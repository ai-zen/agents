import { describe, it, expect, vi } from "vitest";
import { AutoRefreshToolsPlugin } from "./AutoRefreshToolsPlugin.js";
import { SdkAgent } from "../runtime/SdkAgent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(config?: any) {
  return {
    config: config ?? {
      defaultModel: "m1",
      models: [{ id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 }],
      endpoints: [],
    },
    agentsDir: "",
    subAgentsPaths: [],
    skillsPaths: [],
    toolsPaths: [],
    mcpPaths: [],

    builtinTools: [],
    userTools: [],
    subagents: [],
    skills: [],
    mcps: [],

    refresh: vi.fn(),
    buildTools: vi.fn().mockReturnValue([]),
    filter: vi.fn(),
    instantiate: vi.fn(),
    mcpManager: undefined,
  };
}

function createTestAgent(opts?: {
  provider?: any;
  permissions?: any;
  definition?: any;
}): SdkAgent {
  const messages: any[] = [{ role: "system", content: "You are a helper." }];
  return new SdkAgent({
    provider: opts?.provider ?? mockProvider() as any,
    definition: opts?.definition ?? {
      id: "test-agent",
      name: "Test Agent",
      messages: [{ role: "system", content: "You are a helper." }],
      permissions: opts?.permissions, // 权限统一从 definition 读取
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    client: {} as any,
    model: "test-model",
    messages,
    tools: [],
  });
}

// ==================================================================
// 测试
// ==================================================================

describe("AutoRefreshToolsPlugin", () => {
  it("返回 AgentPlugin 对象", () => {
    const plugin = new AutoRefreshToolsPlugin();
    expect(plugin).toBeDefined();
    expect(typeof plugin.onBeforeSend).toBe("function");
  });

  it("调用 provider.refresh()", async () => {
    const provider = mockProvider();
    const agent = createTestAgent({ provider });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it("调用 provider.buildTools()", async () => {
    const provider = mockProvider();
    const agent = createTestAgent({ provider });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(provider.buildTools).toHaveBeenCalledTimes(1);
  });

  it("buildTools 的结果赋值给 agent.tools", async () => {
    const fakeTools = [{ function: { name: "readFile" } }] as any;
    const provider = mockProvider();
    provider.buildTools = vi.fn().mockReturnValue(fakeTools);
    const agent = createTestAgent({ provider });
    expect(agent.tools).toEqual([]);

    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(agent.tools).toBe(fakeTools);
  });

  it("传入 definition（含 permissions）给 buildTools", async () => {
    const provider = mockProvider();
    const permissions = { tools: { allow: ["readFile"] } };
    const agent = createTestAgent({ provider, permissions });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(provider.buildTools).toHaveBeenCalledWith(
      expect.objectContaining({ permissions }),
      expect.any(Object),
    );
  });

  it("Agent 定义无 permissions 时传入 definition（权限为空）", async () => {
    const provider = mockProvider();
    const agent = createTestAgent({ provider, permissions: undefined });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(provider.buildTools).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: undefined }),
      expect.any(Object),
    );
  });

  it("排除自身的 SubAgent name", async () => {
    const provider = mockProvider();
    const agent = createTestAgent({
      provider,
      definition: {
        id: "my-agent",
        name: "My Agent",
        messages: [{ role: "system", content: "You are helpful." }],
        function: { name: "my_agent_func", description: "", parameters: { type: "object", properties: {}, required: [] } },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(provider.buildTools).toHaveBeenCalledWith(expect.any(Object), {
      exclude: { subagents: ["my_agent_func"] },
    });
  });

  it("非 SubAgent 时 exclude.subagents 为 undefined", async () => {
    const provider = mockProvider();
    const agent = createTestAgent({
      provider,
      definition: {
        id: "my-agent",
        name: "My Agent",
        messages: [{ role: "system", content: "You are helpful." }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(provider.buildTools).toHaveBeenCalledWith(expect.any(Object), {
      exclude: { subagents: undefined },
    });
  });

  it("作为插件注册到 Agent 后在 send 时自动触发", async () => {
    const provider = mockProvider();
    const agent = createTestAgent({ provider });
    const plugin = new AutoRefreshToolsPlugin();

    agent.use(plugin);
    await agent.init();

    const ctx = { agent, content: "hello", messages: agent.messages };
    await plugin.onBeforeSend!(ctx);

    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(provider.buildTools).toHaveBeenCalledTimes(1);
  });

  it("多次 send 时每次调用 refresh", async () => {
    const provider = mockProvider();
    provider.buildTools = vi.fn().mockReturnValue([{ function: { name: "tool1" } }] as any);

    const agent = createTestAgent({ provider });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    await plugin.onBeforeSend!(ctx);
    await plugin.onBeforeSend!(ctx);

    expect(provider.refresh).toHaveBeenCalledTimes(3);
    expect(provider.buildTools).toHaveBeenCalledTimes(3);
  });
});
