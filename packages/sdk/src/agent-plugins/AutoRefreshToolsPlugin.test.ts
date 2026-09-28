import { describe, it, expect, vi } from "vitest";
import { AutoRefreshToolsPlugin } from "./AutoRefreshToolsPlugin.js";
import { SdkAgent } from "../runtime/SdkAgent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 最小 Scope mock —— 只暴露插件用到的 refresh / buildTools */
function mockScope() {
  return {
    refresh: vi.fn(),
    buildTools: vi.fn().mockReturnValue([]),
  };
}

function createTestAgent(opts?: {
  scope?: any;
  permissions?: any;
  definition?: any;
}): SdkAgent {
  const messages: any[] = [{ role: "system", content: "You are a helper." }];
  return new SdkAgent({
    scope: opts?.scope ?? (mockScope() as any),
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

  it("调用 scope.refresh()", async () => {
    const scope = mockScope();
    const agent = createTestAgent({ scope });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(scope.refresh).toHaveBeenCalledTimes(1);
  });

  it("调用 scope.buildTools()", async () => {
    const scope = mockScope();
    const agent = createTestAgent({ scope });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(scope.buildTools).toHaveBeenCalledTimes(1);
  });

  it("buildTools 的结果赋值给 agent.tools", async () => {
    const fakeTools = [{ function: { name: "readFile" } }] as any;
    const scope = mockScope();
    scope.buildTools = vi.fn().mockReturnValue(fakeTools);
    const agent = createTestAgent({ scope });
    expect(agent.tools).toEqual([]);

    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(agent.tools).toBe(fakeTools);
  });

  it("传入 definition（含 permissions）给 buildTools", async () => {
    const scope = mockScope();
    const permissions = { tools: { allow: ["readFile"] } };
    const agent = createTestAgent({ scope, permissions });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(scope.buildTools).toHaveBeenCalledWith(
      expect.objectContaining({ permissions }),
      expect.any(Object),
    );
  });

  it("Agent 定义无 permissions 时传入 definition（权限为空）", async () => {
    const scope = mockScope();
    const agent = createTestAgent({ scope, permissions: undefined });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    expect(scope.buildTools).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: undefined }),
      expect.any(Object),
    );
  });

  it("排除自身的 SubAgent name", async () => {
    const scope = mockScope();
    const agent = createTestAgent({
      scope,
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
    expect(scope.buildTools).toHaveBeenCalledWith(expect.any(Object), {
      exclude: { subagents: ["my_agent_func"] },
    });
  });

  it("非 SubAgent 时 exclude.subagents 为 undefined", async () => {
    const scope = mockScope();
    const agent = createTestAgent({
      scope,
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
    expect(scope.buildTools).toHaveBeenCalledWith(expect.any(Object), {
      exclude: { subagents: undefined },
    });
  });

  it("作为插件注册到 Agent 后在 send 时自动触发", async () => {
    const scope = mockScope();
    const agent = createTestAgent({ scope });
    const plugin = new AutoRefreshToolsPlugin();

    agent.use(plugin);
    await agent.init();

    const ctx = { agent, content: "hello", messages: agent.messages };
    await plugin.onBeforeSend!(ctx);

    expect(scope.refresh).toHaveBeenCalledTimes(1);
    expect(scope.buildTools).toHaveBeenCalledTimes(1);
  });

  it("多次 send 时每次调用 refresh", async () => {
    const scope = mockScope();
    scope.buildTools = vi.fn().mockReturnValue([{ function: { name: "tool1" } }] as any);

    const agent = createTestAgent({ scope });
    const plugin = new AutoRefreshToolsPlugin();
    const ctx = { agent, content: "hello", messages: agent.messages };

    await plugin.onBeforeSend!(ctx);
    await plugin.onBeforeSend!(ctx);
    await plugin.onBeforeSend!(ctx);

    expect(scope.refresh).toHaveBeenCalledTimes(3);
    expect(scope.buildTools).toHaveBeenCalledTimes(3);
  });
});
