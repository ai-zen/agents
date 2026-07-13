import { describe, it, expect, vi } from "vitest";
import { createSession } from "./session";
import type { SessionPlugin } from "./types";

// ---------------------------------------------------------------------------
// 轻量 mock：模拟 Core Agent 的 send 行为
// ---------------------------------------------------------------------------

function mockAgent(opts?: { lastUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; messages?: any[]; tools?: any[]; model?: any }) {
  const messages: any[] = opts?.messages ?? [{ role: "system", content: "You are a helper." }];
  return {
    lastUsage: opts?.lastUsage,
    messages,
    tools: opts?.tools ?? [],
    model: opts?.model ?? {},
    send: vi.fn(async (_content: string) => {
      // 模拟 AI 回复
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
    const builder = createSession({ agent: mockAgent() as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } });

    expect(builder).toBeDefined();
    expect(typeof builder.use).toBe("function");
    expect(typeof builder.init).toBe("function");
  });

  it("use() 返回 SessionBuilder（链式调用）", () => {
    const plugin: SessionPlugin = {};
    const builder = createSession({ agent: mockAgent() as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } });

    const builder2 = builder.use(plugin);
    expect(builder2).toBe(builder); // 返回同一实例，支持链式
  });

  it("init() 返回 Session（有 agent 和 send）", async () => {
    const session = await createSession({ agent: mockAgent() as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } }).init();

    expect(session).toBeDefined();
    expect(session.agent).toBeDefined();
    expect(typeof session.send).toBe("function");
  });
});

describe("Session.send", () => {
  it("委托给 agent.send(content)", async () => {
    const agent = mockAgent();
    const session = await createSession({ agent: agent as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } }).init();

    await session.send("hello");

    expect(agent.send).toHaveBeenCalledWith("hello");
  });

  it("返回 messages", async () => {
    const agent = mockAgent();
    const session = await createSession({ agent: agent as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } }).init();

    const result = await session.send("hello");

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("agent.send 之后调用 plugin.afterRun", async () => {
    const agent = mockAgent();
    const afterRun = vi.fn().mockResolvedValue(undefined);
    const plugin: SessionPlugin = { afterRun };

    const session = await createSession({ agent: agent as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } })
      .use(plugin)
      .init();

    await session.send("hello");

    expect(afterRun).toHaveBeenCalledTimes(1);
    // afterRun 收到 SessionContext
    const ctx = afterRun.mock.calls[0][0];
    expect(ctx.agent).toBeDefined();
    expect(ctx.model).toBeDefined();
  });

  it("plugin.afterRun 返回新 Agent 时替换 session.agent", async () => {
    const agent = mockAgent();
    const newAgent = mockAgent();
    const plugin: SessionPlugin = {
      afterRun: vi.fn().mockResolvedValue(newAgent),
    };

    const session = await createSession({ agent: agent as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } })
      .use(plugin)
      .init();

    expect(session.agent).toBe(agent);

    await session.send("hello");

    expect(session.agent).toBe(newAgent);
  });

  it("多个 plugin 按注册顺序执行", async () => {
    const agent = mockAgent();
    const order: number[] = [];
    const p1: SessionPlugin = { afterRun: vi.fn(async () => { order.push(1); }) };
    const p2: SessionPlugin = { afterRun: vi.fn(async () => { order.push(2); }) };
    const p3: SessionPlugin = { afterRun: vi.fn(async () => { order.push(3); }) };

    const session = await createSession({ agent: agent as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } })
      .use(p1)
      .use(p2)
      .use(p3)
      .init();

    await session.send("hello");

    expect(order).toEqual([1, 2, 3]);
  });

  it("plugin 没有 afterRun 时跳过", async () => {
    const agent = mockAgent();
    const plugin: SessionPlugin = {}; // 无 afterRun

    const session = await createSession({ agent: agent as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } })
      .use(plugin)
      .init();

    // 不应抛异常
    await session.send("hello");
  });

  it("中间 plugin 替换 Agent 后，后续 plugin 拿到新 Agent", async () => {
    const agent = mockAgent();
    const newAgent = mockAgent();
    let capturedAgentInP2: any = null;

    const p1: SessionPlugin = {
      afterRun: vi.fn(async () => newAgent as any),
    };
    const p2: SessionPlugin = {
      afterRun: vi.fn(async (ctx) => {
        capturedAgentInP2 = ctx.agent;
      }),
    };

    const session = await createSession({ agent: agent as any, model: { id: "m1", name: "test", endpointId: "e1", maxContextTokens: 100000 } })
      .use(p1)
      .use(p2)
      .init();

    await session.send("hello");

    expect(capturedAgentInP2).toBe(newAgent);
  });
});
