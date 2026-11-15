/**
 * `AgentRegistry` 的用例：agent 唯一的来源、它替调用方把 Scope 先要出来、
 * `ensure` 的 get-or-create（常驻）、`markStale` 的两种结局（空闲立即销毁 / 在跑只打标记）、
 * `dispose` 只丢引用（不停不结算）、以及它与 `ScopeRegistry.dispose` 的上下关系。
 *
 * 这里用真的 `ScopeRegistry`（假工厂造真 Scope），于是「创建自上而下、回收自下而上」
 * 两条顺序是整条跑的，而不是断言在假件上。
 */

import { describe, expect, it } from "vitest";

import { AgentRegistry } from "./AgentRegistry.js";
import type { AgentBuildContext, ChatAgent } from "./ChatRunner.js";
import { ScopeBusyError, ScopeRegistry } from "./ScopeRegistry.js";
import { createFakeScope, FakeAgent, RecordingScopePlugin } from "./TestSupport.js";

const WORKSPACE_ID = "ws-1";
const CONVERSATION_ID = "c-1";

interface Harness {
  agents: AgentRegistry;
  scopes: ScopeRegistry;
  plugin: RecordingScopePlugin;
  /** 每次装配 agent 时交给工厂的事实（看 Scope 是谁给的） */
  builds: AgentBuildContext[];
  /** 每次造出来的假 agent */
  created: FakeAgent[];
  createdScopes: string[];
  /** 「正在跑一轮」的那几段对话（`markStale` 只认这个来源） */
  running: Set<string>;
  /** 把一段对话标成「正在跑一轮」（在实例上模拟 RunRegistry 的答案） */
  markRunning(conversationId: string): void;
  /** 把一段对话标回「空闲」 */
  markIdle(conversationId: string): void;
}

function createHarness(
  options: {
    /** 工厂抛错（装配失败） */
    fail?: Error;
    /** 直接接管工厂 */
    build?: (context: AgentBuildContext) => Promise<ChatAgent>;
  } = {},
): Harness {
  const { scope, plugin } = createFakeScope("/tmp/ai-zen-project");
  const createdScopes: string[] = [];
  const scopes = new ScopeRegistry({
    createScope: async (workspaceId: string) => {
      createdScopes.push(workspaceId);
      return scope;
    },
    // 与单根同一份接线：活着的 agent 由 agent 注册表回答
    liveConversations: (workspaceId) => agents.conversationIds(workspaceId),
  });
  const builds: AgentBuildContext[] = [];
  const created: FakeAgent[] = [];
  // 真单根里这是 `RunRegistry`；这里只要它回答的那一句
  const running = new Set<string>();
  const agents: AgentRegistry = new AgentRegistry({
    scopes,
    runs: { isRunning: (conversationId: string) => running.has(conversationId) },
    createAgent: async (context) => {
      builds.push(context);
      if (options.build) return await options.build(context);
      if (options.fail) throw options.fail;
      const agent = new FakeAgent([{ deltas: [{ content: "好" }] }]);
      created.push(agent);
      return agent;
    },
  });
  return {
    agents,
    scopes,
    plugin,
    builds,
    created,
    createdScopes,
    running,
    markRunning: (conversationId) => void running.add(conversationId),
    markIdle: (conversationId) => void running.delete(conversationId),
  };
}

function input(overrides: Partial<Parameters<AgentRegistry["create"]>[0]> = {}) {
  return {
    conversationId: CONVERSATION_ID,
    workspaceId: WORKSPACE_ID,
    agentId: "default",
    modelId: "model-1",
    thinkingLevel: null,
    history: [],
    ...overrides,
  };
}

describe("AgentRegistry：agent 唯一的来源", () => {
  it("create 会把 Scope 先要出来（空注册表下直接 create 也行），agent 挂在同一个 Scope 上", async () => {
    const harness = createHarness();
    expect(harness.scopes.workspaceIds()).toEqual([]);

    const agent = await harness.agents.create(input());

    expect(agent).toBe(harness.created[0]);
    // Scope 被建出来了，而且工厂拿到的就是它（调用方没有背「先要 Scope」的顺序）
    expect(harness.createdScopes).toEqual([WORKSPACE_ID]);
    expect(harness.builds[0]?.scope).toBe(harness.scopes.get(WORKSPACE_ID));
    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
  });

  it("同一段对话再 create 一次会顶掉旧登记（一段对话同时只有一个 agent）", async () => {
    const harness = createHarness();
    const first = await harness.agents.create(input());
    const second = await harness.agents.create(input());

    expect(second).not.toBe(first);
    expect(harness.agents.get(CONVERSATION_ID)).toBe(second);
    // 顶掉的只是引用：旧的 agent 不会因此被停（停是会话级动作）
    expect((first as FakeAgent).abortCalls).toBe(0);
  });

  it("配套事实照原样交给工厂（身份 + 历史）", async () => {
    const harness = createHarness();
    await harness.agents.create(input({ agentId: "a9", modelId: "m9", thinkingLevel: "high" }));

    expect(harness.builds[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      agentId: "a9",
      modelId: "m9",
      thinkingLevel: "high",
    });
  });

  it("装配失败不留下登记，Scope 也不因此被回收（活着就是有人持有它）", async () => {
    const harness = createHarness({ fail: new Error("模型端点没配") });

    await expect(harness.agents.create(input())).rejects.toThrow("模型端点没配");

    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();
    expect(harness.agents.conversationIds()).toEqual([]);
    expect(harness.scopes.get(WORKSPACE_ID)).toBeDefined();
    expect(harness.plugin.disposeCalls).toBe(0);
  });
});

describe("AgentRegistry：dispose 只丢引用", () => {
  it("dispose 之后 get 为 undefined，agent 本身没被停", async () => {
    const harness = createHarness();
    const agent = (await harness.agents.create(input())) as FakeAgent;

    harness.agents.dispose(CONVERSATION_ID);

    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();
    expect(agent.abortCalls).toBe(0);
    // 幂等
    harness.agents.dispose(CONVERSATION_ID);
    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();
  });

  it("conversationIds 报出活着的对话，可以按 Workspace 过滤", async () => {
    const harness = createHarness();
    await harness.agents.create(input({ conversationId: "c-1" }));
    await harness.agents.create(input({ conversationId: "c-2" }));
    await harness.agents.create(input({ conversationId: "c-3", workspaceId: "ws-2" }));

    expect(harness.agents.conversationIds().sort()).toEqual(["c-1", "c-2", "c-3"]);
    expect(harness.agents.conversationIds(WORKSPACE_ID).sort()).toEqual(["c-1", "c-2"]);
    expect(harness.agents.conversationIds("ws-2")).toEqual(["c-3"]);
    expect(harness.agents.conversationIds("ws-none")).toEqual([]);
  });
});

describe("回收自下而上：agent 活着就拆不了 Scope", () => {
  it("agents.dispose 之后 scopes.dispose 才成功（顺序写在代码里）", async () => {
    const harness = createHarness();
    await harness.agents.create(input());

    const error = await harness.scopes.dispose(WORKSPACE_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScopeBusyError);
    expect((error as ScopeBusyError).conversationIds).toEqual([CONVERSATION_ID]);
    expect(harness.scopes.get(WORKSPACE_ID)).toBeDefined();
    expect(harness.plugin.disposeCalls).toBe(0);

    harness.agents.dispose(CONVERSATION_ID);
    await harness.scopes.dispose(WORKSPACE_ID);

    expect(harness.scopes.get(WORKSPACE_ID)).toBeUndefined();
    expect(harness.plugin.disposeCalls).toBe(1);
  });

  it("Scope 被销毁之后再 create 会重新建一个（agent 照样拿得到 Scope）", async () => {
    const harness = createHarness();
    await harness.agents.create(input());
    harness.agents.dispose(CONVERSATION_ID);
    await harness.scopes.dispose(WORKSPACE_ID);

    const agent = await harness.agents.create(input());

    expect(harness.createdScopes).toEqual([WORKSPACE_ID, WORKSPACE_ID]);
    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
  });

  it("ensure 之后再 dispose，scopes.dispose 才成功（常驻不改变这条顺序）", async () => {
    const harness = createHarness();
    // 一段对话跑完一轮：agent 留在登记里（常驻），Scope 仍然拆不了
    await harness.agents.ensure(input());

    const error = await harness.scopes.dispose(WORKSPACE_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScopeBusyError);

    harness.agents.dispose(CONVERSATION_ID);
    await harness.scopes.dispose(WORKSPACE_ID);
    expect(harness.scopes.get(WORKSPACE_ID)).toBeUndefined();
  });
});

describe("AgentRegistry：ensure 是 get-or-create（常驻的机关）", () => {
  it("没有就装配一个：与 create 一样先把 Scope 要出来，然后登记", async () => {
    const harness = createHarness();

    const agent = await harness.agents.ensure(input());

    expect(agent).toBe(harness.created[0]);
    expect(harness.createdScopes).toEqual([WORKSPACE_ID]);
    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
  });

  it("已经有了就返回同一个实例：不重装配、也不再去要 Scope", async () => {
    const harness = createHarness();
    const first = await harness.agents.ensure(input());

    const second = await harness.agents.ensure(input());

    // 引用相等就是「常驻」本身：同一个对象，所以它的 messages / 模型客户端 / 插件都接着用
    expect(second).toBe(first);
    expect(harness.builds).toHaveLength(1);
    // 已有实例时连 Scope 也不碰（不是「再取一次同一个」，而是一次都没取）
    expect(harness.createdScopes).toEqual([WORKSPACE_ID]);
  });

  it("两段对话各是一个：ensure 的键是 conversationId", async () => {
    const harness = createHarness();

    const one = await harness.agents.ensure(input({ conversationId: "c-1" }));
    const two = await harness.agents.ensure(input({ conversationId: "c-2" }));

    expect(one).not.toBe(two);
    expect(harness.agents.get("c-1")).toBe(one);
    expect(harness.agents.get("c-2")).toBe(two);
  });

  it("装配失败不留下登记：ensure 下一次会重新尝试", async () => {
    let fail = true;
    const harness = createHarness({
      build: async () => {
        if (fail) throw new Error("模型端点没配");
        return new FakeAgent([{ deltas: [{ content: "好" }] }]);
      },
    });

    await expect(harness.agents.ensure(input())).rejects.toThrow("模型端点没配");
    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();

    fail = false;
    const agent = await harness.agents.ensure(input());
    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
  });
});

describe("AgentRegistry：markStale（配置改过的生效手段）", () => {
  it("空闲的立即销毁，不进返回列表（没什么要等的）", async () => {
    const harness = createHarness();
    const agent = (await harness.agents.ensure(input())) as FakeAgent;

    const marked = harness.agents.markStale(WORKSPACE_ID);

    expect(marked).toEqual([]);
    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();
    // 只丢引用：停不是这里的事（那一段本来就没在跑）
    expect(agent.abortCalls).toBe(0);
  });

  it("正在跑的只打标记、不进销毁：等它结算（判据只有 RunRegistry 一处）", async () => {
    const harness = createHarness();
    const agent = (await harness.agents.ensure(input())) as FakeAgent;
    harness.markRunning(CONVERSATION_ID);

    const marked = harness.agents.markStale(WORKSPACE_ID);

    expect(marked).toEqual([CONVERSATION_ID]);
    // 还在登记里（那一段还得用它跑完），只是带上了标记
    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
    expect(harness.agents.isStale(CONVERSATION_ID)).toBe(true);

    // 结算那一刻由 ChatRunner 叫 `dispose`：标记随登记一起消失
    harness.agents.dispose(CONVERSATION_ID);
    expect(harness.agents.isStale(CONVERSATION_ID)).toBe(false);
  });

  it("只碰这个 Workspace 的 agent（别的项目一个不动）", async () => {
    const harness = createHarness();
    await harness.agents.ensure(input({ conversationId: "c-1" }));
    const other = await harness.agents.ensure(input({ conversationId: "c-2", workspaceId: "ws-2" }));

    const marked = harness.agents.markStale(WORKSPACE_ID);

    expect(marked).toEqual([]);
    expect(harness.agents.get("c-1")).toBeUndefined();
    expect(harness.agents.get("c-2")).toBe(other);
    expect(harness.agents.isStale("c-2")).toBe(false);
  });

  it("空闲的那一批被销毁之后，下一次 ensure 会造一个新实例", async () => {
    const harness = createHarness();
    const first = await harness.agents.ensure(input());

    harness.agents.markStale(WORKSPACE_ID);
    const second = await harness.agents.ensure(input());

    expect(second).not.toBe(first);
    expect(harness.builds).toHaveLength(2);
    expect(harness.agents.isStale(CONVERSATION_ID)).toBe(false);
  });

  it("没打过标记的 agent，isStale 是 false（ensure 新造出来的从不陈旧）", async () => {
    const harness = createHarness();
    await harness.agents.ensure(input());

    expect(harness.agents.isStale(CONVERSATION_ID)).toBe(false);
    expect(harness.agents.isStale("c-none")).toBe(false);
  });
});

describe("AgentRegistry：fits（手里那个还是不是照现在的事实造的）", () => {
  it("刚装配出来的当然合：三项事实都对得上", async () => {
    const harness = createHarness();
    await harness.agents.ensure(input({ agentId: "a1", modelId: "m1", thinkingLevel: "high" }));

    expect(harness.agents.fits(CONVERSATION_ID, { agentId: "a1", modelId: "m1", thinkingLevel: "high" })).toBe(true);
    // 没有登记：没什么可复用的
    expect(harness.agents.fits("c-none", { agentId: "a1", modelId: "m1", thinkingLevel: "high" })).toBe(false);
  });

  it("模型 / 思考档位 / 助手任何一项变了，就不合用（模型客户端是装配那一刻读的）", async () => {
    const harness = createHarness();
    await harness.agents.ensure(input({ agentId: "a1", modelId: "m1", thinkingLevel: null }));

    // 换了模型（`conversation.setModel` 写的就是会话行）
    expect(harness.agents.fits(CONVERSATION_ID, { agentId: "a1", modelId: "m2", thinkingLevel: null })).toBe(false);
    // 换了思考档位（`conversation.setThinking`）
    expect(harness.agents.fits(CONVERSATION_ID, { agentId: "a1", modelId: "m1", thinkingLevel: "high" })).toBe(false);
    // 换了助手（会话行上的 agentId 创建时定死，理论上不变，但这一条事实同样参与判定）
    expect(harness.agents.fits(CONVERSATION_ID, { agentId: "a2", modelId: "m1", thinkingLevel: null })).toBe(false);
    // `undefined` 与 `null` 同义：不是「变了」
    expect(
      harness.agents.fits(CONVERSATION_ID, {
        agentId: "a1",
        modelId: "m1",
        thinkingLevel: undefined as unknown as null,
      }),
    ).toBe(true);
  });

  it("丢掉之后重新装配：新实例按新事实记账", async () => {
    const harness = createHarness();
    await harness.agents.ensure(input({ modelId: "m1" }));
    harness.agents.dispose(CONVERSATION_ID);

    const rebuilt = await harness.agents.ensure(input({ modelId: "m2" }));

    expect(harness.agents.get(CONVERSATION_ID)).toBe(rebuilt);
    expect(harness.agents.fits(CONVERSATION_ID, { agentId: "default", modelId: "m2", thinkingLevel: null })).toBe(true);
    expect(harness.agents.fits(CONVERSATION_ID, { agentId: "default", modelId: "m1", thinkingLevel: null })).toBe(false);
  });
});
