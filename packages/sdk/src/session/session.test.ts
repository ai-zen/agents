import { describe, it, expect, vi } from "vitest";
import { createSession } from "./session";
import type { SessionPlugin } from "./types";

// ---------------------------------------------------------------------------
// 轻量 mock：模拟 Core Agent 的 send 行为
// ---------------------------------------------------------------------------

function mockRuntime(config?: any) {
  return {
    config: config ?? {
      defaultModel: "m1",
      models: [
        { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 },
      ],
      endpoints: [],
    },
    agentsDir: "",
    subAgentsPaths: [],
    skillsPaths: [],
    toolsPaths: [],
    mcpPaths: [],
    conversationsDir: "",
    draftsDir: "",
    createModel: vi.fn(),
  };
}

function mockAgent(opts?: {
  lastUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  messages?: any[];
  tools?: any[];
  model?: any;
}): any {
  const messages: any[] = opts?.messages ?? [{ role: "system", content: "You are a helper." }];
  return {
    runtime: mockRuntime(),
    definition: {
      id: "test-agent",
      name: "Test Agent",
      messages: [{ role: "system", content: "You are a helper." }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    lastUsage: opts?.lastUsage,
    messages,
    tools: opts?.tools ?? [],
    model: opts?.model ?? {},
    caps: undefined,
    permissions: undefined,
    send: vi.fn(async (_content: string) => {
      messages.push({ role: "user", content: _content });
      messages.push({ role: "assistant", content: "OK" });
      return messages;
    }),
  };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("返回 SessionBuilder（有 use 和 init 方法）", () => {
    const builder = createSession({ agent: mockAgent() });

    expect(builder).toBeDefined();
    expect(typeof builder.use).toBe("function");
    expect(typeof builder.init).toBe("function");
  });

  it("use() 返回 SessionBuilder（链式调用）", () => {
    const plugin: SessionPlugin = {};
    const builder = createSession({ agent: mockAgent() });

    const builder2 = builder.use(plugin);
    expect(builder2).toBe(builder);
  });

  it("init() 返回 Session（有 agent 和 send）", async () => {
    const session = await createSession({ agent: mockAgent() }).init();

    expect(session).toBeDefined();
    expect(session.agent).toBeDefined();
    expect(typeof session.send).toBe("function");
  });
});

describe("Session.send", () => {
  it("委托给 agent.send(content)", async () => {
    const agent = mockAgent();
    const session = await createSession({ agent: agent }).init();

    await session.send("hello");

    expect(agent.send).toHaveBeenCalledWith("hello");
  });

  it("返回 messages", async () => {
    const agent = mockAgent();
    const session = await createSession({ agent: agent }).init();

    const result = await session.send("hello");

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("agent.send 之后调用 plugin.afterSend", async () => {
    const agent = mockAgent();
    const afterSend = vi.fn();
    const plugin: SessionPlugin = { afterSend };

    const session = await createSession({ agent: agent })
      .use(plugin)
      .init();

    await session.send("hello");

    expect(afterSend).toHaveBeenCalledTimes(1);
    const ctx = afterSend.mock.calls[0][0];
    expect(ctx.agent).toBeDefined();
    expect(ctx.model).toBeDefined();
  });

  it("plugin 通过 ctx.agent 替换 session.agent", async () => {
    const agent = mockAgent();
    const newAgent = mockAgent();
    const plugin: SessionPlugin = {
      afterSend: vi.fn(async (ctx) => {
        ctx.agent = newAgent;
      }),
    };

    const session = await createSession({ agent: agent })
      .use(plugin)
      .init();

    expect(session.agent).toBe(agent);

    await session.send("hello");

    expect(session.agent).toBe(newAgent);
  });

  it("多个 plugin 按注册顺序执行", async () => {
    const agent = mockAgent();
    const order: number[] = [];
    const p1: SessionPlugin = { afterSend: vi.fn(async () => { order.push(1); }) };
    const p2: SessionPlugin = { afterSend: vi.fn(async () => { order.push(2); }) };
    const p3: SessionPlugin = { afterSend: vi.fn(async () => { order.push(3); }) };

    const session = await createSession({ agent: agent })
      .use(p1)
      .use(p2)
      .use(p3)
      .init();

    await session.send("hello");

    expect(order).toEqual([1, 2, 3]);
  });

  it("plugin 没有 afterSend 时跳过", async () => {
    const agent = mockAgent();
    const plugin: SessionPlugin = {};

    const session = await createSession({ agent: agent })
      .use(plugin)
      .init();

    await session.send("hello");
  });

  it("中间 plugin 替换 Agent 后，后续 plugin 拿到新 Agent", async () => {
    const agent = mockAgent();
    const newAgent = mockAgent();
    let capturedAgentInP2: any = null;

    const p1: SessionPlugin = {
      afterSend: vi.fn(async (ctx) => {
        ctx.agent = newAgent;
      }),
    };
    const p2: SessionPlugin = {
      afterSend: vi.fn(async (ctx) => {
        capturedAgentInP2 = ctx.agent;
      }),
    };

    const session = await createSession({ agent: agent })
      .use(p1)
      .use(p2)
      .init();

    await session.send("hello");

    expect(capturedAgentInP2).toBe(newAgent);
  });

  it("Session 的 model 来自 agent.runtime.config", async () => {
    const agent = mockAgent();
    const session = await createSession({ agent: agent }).init();

    const ctxModel = (session as any)._model;
    expect(ctxModel).toBeDefined();
    expect(ctxModel.id).toBe("m1");
  });
});

describe("SessionPlugin.beforeSend", () => {
  it("agent.send 之前调用 plugin.beforeSend", async () => {
    const agent = mockAgent();
    const callOrder: string[] = [];
    const plugin: SessionPlugin = {
      beforeSend: vi.fn(async () => { callOrder.push("beforeSend"); }),
      afterSend: vi.fn(async () => { callOrder.push("afterSend"); }),
    };

    const origSend = agent.send;
    agent.send = vi.fn(async (content: string) => {
      callOrder.push("send");
      return origSend(content);
    });

    const session = await createSession({ agent: agent })
      .use(plugin)
      .init();

    await session.send("hello");

    expect(callOrder).toEqual(["beforeSend", "send", "afterSend"]);
  });

  it("beforeSend 收到 SessionContext", async () => {
    const agent = mockAgent();
    const beforeSend = vi.fn();
    const plugin: SessionPlugin = { beforeSend };

    const session = await createSession({ agent: agent })
      .use(plugin)
      .init();

    await session.send("hello");

    expect(beforeSend).toHaveBeenCalledTimes(1);
    const ctx = beforeSend.mock.calls[0][0];
    expect(ctx.agent).toBe(agent);
    expect(ctx.model).toBeDefined();
    expect(ctx.model.id).toBe("m1");
  });

  it("多个 beforeSend 按注册顺序执行", async () => {
    const agent = mockAgent();
    const order: number[] = [];
    const p1: SessionPlugin = { beforeSend: vi.fn(async () => { order.push(1); }) };
    const p2: SessionPlugin = { beforeSend: vi.fn(async () => { order.push(2); }) };
    const p3: SessionPlugin = { beforeSend: vi.fn(async () => { order.push(3); }) };

    const session = await createSession({ agent: agent })
      .use(p1)
      .use(p2)
      .use(p3)
      .init();

    await session.send("hello");

    expect(order).toEqual([1, 2, 3]);
  });

  it("plugin 没有 beforeSend 时跳过", async () => {
    const agent = mockAgent();
    const plugin: SessionPlugin = { afterSend: vi.fn() };

    const session = await createSession({ agent: agent })
      .use(plugin)
      .init();

    await expect(session.send("hello")).resolves.toBeDefined();
  });
});
