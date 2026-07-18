import { describe, it, expect, vi } from "vitest";
import { AutoRefreshToolsPlugin } from "./AutoRefreshToolsPlugin.js";
import { SdkAgent } from "../runtime/SdkAgent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRuntime(config?: any) {
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
    conversationsDir: "",
    draftsDir: "",
  };
}

function createMockCaps() {
  return {
    refresh: vi.fn(),
    buildTools: vi.fn().mockReturnValue([]),
  };
}

function createTestAgent(opts?: {
  caps?: any;
  permissions?: any;
  definition?: any;
}): SdkAgent {
  const messages: any[] = [{ role: "system", content: "You are a helper." }];
  return new SdkAgent({
    provider: mockRuntime() as any,
    definition: opts?.definition ?? {
      id: "test-agent",
      name: "Test Agent",
      messages: [{ role: "system", content: "You are a helper." }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    model: { name: "test-model", createStream: vi.fn() } as any,
    messages,
    tools: [],
    permissions: opts?.permissions,
    caps: opts?.caps,
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

  it("caps 不存在时跳过（不抛异常）", async () => {
    const agent = createTestAgent({ caps: undefined });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await expect(plugin.onBeforeSend!(ctx)).resolves.toBeUndefined();
  });

  it("caps 存在时调用 caps.refresh()", async () => {
    const caps = createMockCaps();
    const agent = createTestAgent({ caps });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(caps.refresh).toHaveBeenCalledTimes(1);
  });

  it("caps 存在时调用 caps.buildTools()", async () => {
    const caps = createMockCaps();
    const agent = createTestAgent({ caps });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(caps.buildTools).toHaveBeenCalledTimes(1);
  });

  it("buildTools 的结果赋值给 agent.tools", async () => {
    const fakeTools = [{ function: { name: "readFile" } }] as any;
    const caps = {
      refresh: vi.fn(),
      buildTools: vi.fn().mockReturnValue(fakeTools),
    };
    const agent = createTestAgent({ caps });
    expect(agent.tools).toEqual([]);

    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(agent.tools).toBe(fakeTools);
  });

  it("传入 agent.permissions 给 buildTools", async () => {
    const caps = createMockCaps();
    const permissions = { tools: { allow: ["readFile"] } };
    const agent = createTestAgent({ caps, permissions });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(caps.buildTools).toHaveBeenCalledWith(permissions, expect.any(Object));
  });

  it("Agent 无 permissions 时传入空对象", async () => {
    const caps = createMockCaps();
    const agent = createTestAgent({ caps, permissions: undefined });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(caps.buildTools).toHaveBeenCalledWith({}, expect.any(Object));
  });

  it("排除自身的 SubAgent name", async () => {
    const caps = createMockCaps();
    const agent = createTestAgent({
      caps,
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
    expect(caps.buildTools).toHaveBeenCalledWith(expect.any(Object), {
      exclude: { subagents: ["my_agent_func"] },
    });
  });

  it("非 SubAgent 时 exclude.subagents 为 undefined", async () => {
    const caps = createMockCaps();
    const agent = createTestAgent({
      caps,
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
    expect(caps.buildTools).toHaveBeenCalledWith(expect.any(Object), {
      exclude: { subagents: undefined },
    });
  });

  it("作为插件注册到 Agent 后在 send 时自动触发", async () => {
    const caps = createMockCaps();
    const agent = createTestAgent({ caps });
    const plugin = new AutoRefreshToolsPlugin();

    agent.use(plugin);
    await agent.init();

    const ctx = { agent, content: "hello", messages: agent.messages };
    await plugin.onBeforeSend!(ctx);

    expect(caps.refresh).toHaveBeenCalledTimes(1);
    expect(caps.buildTools).toHaveBeenCalledTimes(1);
  });

  it("多次 send 时每次调用 refresh", async () => {
    const caps = createMockCaps();
    caps.buildTools.mockReturnValue([{ function: { name: "tool1" } }] as any);

    const agent = createTestAgent({ caps });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    await plugin.onBeforeSend!(ctx);
    await plugin.onBeforeSend!(ctx);

    expect(caps.refresh).toHaveBeenCalledTimes(3);
    expect(caps.buildTools).toHaveBeenCalledTimes(3);
  });
});
