/**
 * `AgentRegistry` 的用例：agent 存活管理的唯一拥有者。
 *
 * 五条判据各有一组（`acquire` 的复用/重建、`complete` 的陈旧兑现、`invalidate` 的两种结局、
 * `discard` 只丢引用、`disposeAll` 收尾），外加**生命周期事件**那一组 —— 它是「这段对话为什么
 * 没有 agent」的唯一答案，所以每条路径报出的 `action` + `reason` 都钉住。
 *
 * 还有两条结构性的事：agent 替调用方把 Scope 先要出来（创建自上而下），以及 agent 活着就拆不了
 * Scope（回收自下而上）。这里用真的 `ScopeRegistry`（假工厂造真 Scope），于是那两条顺序是整条
 * 跑的，而不是断言在假件上。
 */

import { describe, expect, it } from "vitest";

import { AgentRegistry } from "./AgentRegistry.js";
import type {
  AgentAssemblyFacts,
  AgentCreateInput,
  AgentLifecycleEvent,
} from "./AgentRegistry.js";
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
  /** 「正在跑一轮」的那几段对话（`invalidate` 只认这个来源） */
  running: Set<string>;
  /** 每次生灭决定的记录（`onLifecycle` 收到的原样） */
  lifecycle: AgentLifecycleEvent[];
  /** 把一段对话标成「正在跑一轮」（在实例上模拟 RunRegistry 的答案） */
  markRunning(conversationId: string): void;
  /** 把一段对话标回「空闲」 */
  markIdle(conversationId: string): void;
  /** 这段对话报过的 `action:reason`（顺序即发生顺序） */
  trace(conversationId?: string): string[];
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
  const lifecycle: AgentLifecycleEvent[] = [];
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
    onLifecycle: (event) => void lifecycle.push(event),
  });
  return {
    agents,
    scopes,
    plugin,
    builds,
    created,
    createdScopes,
    running,
    lifecycle,
    markRunning: (conversationId) => void running.add(conversationId),
    markIdle: (conversationId) => void running.delete(conversationId),
    trace: (conversationId) =>
      lifecycle
        .filter((event) => conversationId === undefined || event.conversationId === conversationId)
        .map((event) => `${event.action}:${event.reason}`),
  };
}

/** 一段对话要办的事（装配入参） */
function input(overrides: Partial<AgentCreateInput> = {}): AgentCreateInput {
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

/** 会话行上那三项「会随时间变」的事实 */
function facts(
  overrides: { agentId?: string; modelId?: string | null; thinkingLevel?: string | null } = {},
): AgentAssemblyFacts {
  return {
    agentId: overrides.agentId ?? "default",
    modelId: overrides.modelId === undefined ? "model-1" : overrides.modelId,
    thinkingLevel: overrides.thinkingLevel ?? null,
  };
}

describe("AgentRegistry：agent 唯一的来源（先把 Scope 要出来）", () => {
  it("acquire 会把 Scope 先要出来（空注册表下直接 acquire 也行），agent 挂在同一个 Scope 上", async () => {
    const harness = createHarness();
    expect(harness.scopes.workspaceIds()).toEqual([]);

    const agent = await harness.agents.acquire(input(), facts());

    expect(agent).toBe(harness.created[0]);
    // Scope 被建出来了，而且工厂拿到的就是它（调用方没有背「先要 Scope」的顺序）
    expect(harness.createdScopes).toEqual([WORKSPACE_ID]);
    expect(harness.builds[0]?.scope).toBe(harness.scopes.get(WORKSPACE_ID));
    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
  });

  it("装配入参照原样交给工厂（身份 + 历史）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(
      input({ agentId: "a9", modelId: "m9", thinkingLevel: "high" }),
      facts({ agentId: "a9", modelId: "m9", thinkingLevel: "high" }),
    );

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

    await expect(harness.agents.acquire(input(), facts())).rejects.toThrow("模型端点没配");

    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();
    expect(harness.agents.conversationIds()).toEqual([]);
    expect(harness.scopes.get(WORKSPACE_ID)).toBeDefined();
    expect(harness.plugin.disposeCalls).toBe(0);
  });

  it("两段对话各是一个：键是 conversationId", async () => {
    const harness = createHarness();

    const one = await harness.agents.acquire(input({ conversationId: "c-1" }), facts());
    const two = await harness.agents.acquire(input({ conversationId: "c-2" }), facts());

    expect(one).not.toBe(two);
    expect(harness.agents.get("c-1")).toBe(one);
    expect(harness.agents.get("c-2")).toBe(two);
  });
});

describe("AgentRegistry：acquire 把「在就复用 / 不合用就重建」合成一步", () => {
  it("在且合用：同一个实例，工厂只调一次，也不再去要 Scope", async () => {
    const harness = createHarness();
    const first = await harness.agents.acquire(input(), facts());

    const second = await harness.agents.acquire(input(), facts());

    // 引用相等就是「常驻」本身：同一个对象，所以它的 messages / 模型客户端 / 插件都接着用
    expect(second).toBe(first);
    expect(harness.builds).toHaveLength(1);
    // 复用时连 Scope 也不碰（不是「再取一次同一个」，而是一次都没取）
    expect(harness.createdScopes).toEqual([WORKSPACE_ID]);
    expect(harness.trace()).toEqual(["built:never-built", "reused:assembly-facts-unchanged"]);
  });

  it("模型变了：旧实例退役、新实例不同引用，工厂按新模型再装一次", async () => {
    const harness = createHarness();
    const first = await harness.agents.acquire(input({ modelId: "model-1" }), facts());

    const second = await harness.agents.acquire(
      input({ modelId: "model-2" }),
      facts({ modelId: "model-2" }),
    );

    expect(second).not.toBe(first);
    expect(harness.agents.get(CONVERSATION_ID)).toBe(second);
    expect(harness.builds).toHaveLength(2);
    expect(harness.builds[1]?.modelId).toBe("model-2");
    // 丢掉只是丢引用：停是会话级动作（这里压根没在跑）
    expect((first as FakeAgent).abortCalls).toBe(0);
    expect(harness.trace()).toEqual([
      "built:never-built",
      "retired:assembly-facts-changed",
      "rebuilt:assembly-facts-changed",
    ]);
  });

  it("思考档位 / 助手变了同样算「装配事实变了」（三项任一参与判定）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input(), facts());

    const byThinking = await harness.agents.acquire(
      input({ thinkingLevel: "high" }),
      facts({ thinkingLevel: "high" }),
    );
    expect(byThinking).toBe(harness.created[1]);

    const byAgent = await harness.agents.acquire(input({ agentId: "a2" }), facts({ agentId: "a2" }));
    expect(byAgent).toBe(harness.created[2]);
    expect(harness.builds).toHaveLength(3);
  });

  it("`undefined` 与 `null` 同义：不算「变了」，同一个实例接着用", async () => {
    const harness = createHarness();
    const first = await harness.agents.acquire(input({ thinkingLevel: null }), facts());

    const second = await harness.agents.acquire(
      input({ thinkingLevel: null }),
      { agentId: "default", modelId: "model-1", thinkingLevel: undefined as unknown as null },
    );

    expect(second).toBe(first);
    expect(harness.builds).toHaveLength(1);
  });

  it("装配失败不留下登记：下一次 acquire 重新尝试", async () => {
    let fail = true;
    const harness = createHarness({
      build: async () => {
        if (fail) throw new Error("模型端点没配");
        return new FakeAgent([{ deltas: [{ content: "好" }] }]);
      },
    });

    await expect(harness.agents.acquire(input(), facts())).rejects.toThrow("模型端点没配");
    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();

    fail = false;
    const agent = await harness.agents.acquire(input(), facts());
    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
  });
});

describe("AgentRegistry：discard 只丢引用", () => {
  it("discard 之后 get 为 undefined，agent 本身没被停，登记也没了", async () => {
    const harness = createHarness();
    const agent = (await harness.agents.acquire(input(), facts())) as FakeAgent;

    harness.agents.discard(CONVERSATION_ID);

    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();
    expect(harness.agents.conversationIds()).toEqual([]);
    // 「不 abort、不结算」就是这条的全部内容
    expect(agent.abortCalls).toBe(0);
    expect(agent.sendCalls).toBe(0);
    // 幂等：没登记就什么也不做，也不再多报一条
    harness.agents.discard(CONVERSATION_ID);
    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();
    expect(harness.trace()).toEqual(["built:never-built", "retired:conversation-deleted"]);
  });

  it("conversationIds 报出活着的对话，可以按 Workspace 过滤", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input({ conversationId: "c-1" }), facts());
    await harness.agents.acquire(input({ conversationId: "c-2" }), facts());
    await harness.agents.acquire(
      input({ conversationId: "c-3", workspaceId: "ws-2" }),
      facts(),
    );

    expect(harness.agents.conversationIds().sort()).toEqual(["c-1", "c-2", "c-3"]);
    expect(harness.agents.conversationIds(WORKSPACE_ID).sort()).toEqual(["c-1", "c-2"]);
    expect(harness.agents.conversationIds("ws-2")).toEqual(["c-3"]);
    expect(harness.agents.conversationIds("ws-none")).toEqual([]);
  });
});

describe("回收自下而上：agent 活着就拆不了 Scope", () => {
  it("discard 之后 scopes.dispose 才成功（顺序写在代码里）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input(), facts());

    const error = await harness.scopes.dispose(WORKSPACE_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScopeBusyError);
    expect((error as ScopeBusyError).conversationIds).toEqual([CONVERSATION_ID]);
    expect(harness.scopes.get(WORKSPACE_ID)).toBeDefined();
    expect(harness.plugin.disposeCalls).toBe(0);

    harness.agents.discard(CONVERSATION_ID);
    await harness.scopes.dispose(WORKSPACE_ID);

    expect(harness.scopes.get(WORKSPACE_ID)).toBeUndefined();
    expect(harness.plugin.disposeCalls).toBe(1);
  });

  it("Scope 被销毁之后再 acquire 会重新建一个（agent 照样拿得到 Scope）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input(), facts());
    harness.agents.discard(CONVERSATION_ID);
    await harness.scopes.dispose(WORKSPACE_ID);

    const agent = await harness.agents.acquire(input(), facts());

    expect(harness.createdScopes).toEqual([WORKSPACE_ID, WORKSPACE_ID]);
    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
  });
});

describe("AgentRegistry：invalidate（配置改过的生效手段）", () => {
  it("空闲的当场退役，不进返回列表（没什么要等的）", async () => {
    const harness = createHarness();
    const agent = (await harness.agents.acquire(input(), facts())) as FakeAgent;

    const marked = harness.agents.invalidate(WORKSPACE_ID);

    expect(marked).toEqual([]);
    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();
    // 只丢引用：停不是这里的事（那一段本来就没在跑）
    expect(agent.abortCalls).toBe(0);
    expect(harness.trace()).toEqual(["built:never-built", "retired:config-changed"]);
  });

  it("正在跑的只打标记、不退役，且出现在返回列表里；`complete` 之后才退役", async () => {
    const harness = createHarness();
    const agent = (await harness.agents.acquire(input(), facts())) as FakeAgent;
    harness.markRunning(CONVERSATION_ID);

    const marked = harness.agents.invalidate(WORKSPACE_ID);

    expect(marked).toEqual([CONVERSATION_ID]);
    // 还在登记里（那一段还得用它跑完），只是带上了标记 —— 这一刻什么也没报（没退役）
    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
    expect(harness.trace()).toEqual(["built:never-built"]);

    // 结算那一刻 `ChatRunner` 调 `complete`：陈旧 → 退役
    harness.markIdle(CONVERSATION_ID);
    harness.agents.complete(CONVERSATION_ID);

    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();
    expect((agent as FakeAgent).abortCalls).toBe(0);
    expect(harness.trace()).toEqual([
      "built:never-built",
      "retired:stale-on-settle",
    ]);
  });

  it("只碰这个 Workspace 的 agent（别的项目一个不动）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input({ conversationId: "c-1" }), facts());
    const other = await harness.agents.acquire(
      input({ conversationId: "c-2", workspaceId: "ws-2" }),
      facts(),
    );

    const marked = harness.agents.invalidate(WORKSPACE_ID);

    expect(marked).toEqual([]);
    expect(harness.agents.get("c-1")).toBeUndefined();
    expect(harness.agents.get("c-2")).toBe(other);
    expect(harness.trace("c-2")).toEqual(["built:never-built"]);
  });

  it("空闲的那一批退役之后，下一次 acquire 造一个新实例（且说得出理由）", async () => {
    const harness = createHarness();
    const first = await harness.agents.acquire(input(), facts());

    harness.agents.invalidate(WORKSPACE_ID);
    const second = await harness.agents.acquire(input(), facts());

    expect(second).not.toBe(first);
    expect(harness.builds).toHaveLength(2);
    // 它「不在过」的理由一直记到下一次装配：这一次是 rebuild，不是 build
    expect(harness.trace()).toEqual([
      "built:never-built",
      "retired:config-changed",
      "rebuilt:config-changed",
    ]);
  });
});

describe("AgentRegistry：complete 兑现陈旧标记", () => {
  it("陈旧 → 退役，下一次 acquire 重新装配", async () => {
    const harness = createHarness();
    const first = await harness.agents.acquire(input(), facts());
    harness.markRunning(CONVERSATION_ID);
    harness.agents.invalidate(WORKSPACE_ID);
    harness.markIdle(CONVERSATION_ID);

    harness.agents.complete(CONVERSATION_ID);
    expect(harness.agents.get(CONVERSATION_ID)).toBeUndefined();

    const second = await harness.agents.acquire(input(), facts());
    expect(second).not.toBe(first);
    expect(harness.builds).toHaveLength(2);
    expect(harness.trace()).toEqual([
      "built:never-built",
      "retired:stale-on-settle",
      "rebuilt:stale-on-settle",
    ]);
  });

  it("不陈旧 → 保留（只有配置改过才换，别把它当成了每轮都换）", async () => {
    const harness = createHarness();
    const agent = await harness.agents.acquire(input(), facts());

    harness.agents.complete(CONVERSATION_ID);
    harness.agents.complete(CONVERSATION_ID);

    expect(harness.agents.get(CONVERSATION_ID)).toBe(agent);
    // 没发生任何生灭决定：结算不陈旧时什么也不报
    expect(harness.trace()).toEqual(["built:never-built"]);
  });

  it("没有登记时什么也不做（对话已经没了 / 从没装配过）", async () => {
    const harness = createHarness();

    harness.agents.complete("c-none");

    expect(harness.lifecycle).toEqual([]);
  });
});

describe("AgentRegistry：disposeAll（收尾）", () => {
  it("全部退役，每段报一条 `shutdown`，之后登记表是空的", async () => {
    const harness = createHarness();
    const one = (await harness.agents.acquire(input({ conversationId: "c-1" }), facts())) as FakeAgent;
    const two = (await harness.agents.acquire(input({ conversationId: "c-2" }), facts())) as FakeAgent;

    harness.agents.disposeAll();

    expect(harness.agents.conversationIds()).toEqual([]);
    // 收尾只丢引用：进程要退了，但 abort / 结算不是这里的事
    expect(one.abortCalls).toBe(0);
    expect(two.abortCalls).toBe(0);
    expect(harness.trace()).toEqual([
      "built:never-built",
      "built:never-built",
      "retired:shutdown",
      "retired:shutdown",
    ]);
    // 幂等
    harness.agents.disposeAll();
    expect(harness.trace()).toHaveLength(4);
  });
});

describe("AgentRegistry：onLifecycle 是「为什么这段对话没有 agent」的唯一答案", () => {
  it("一条完整的一生：装配 → 复用 → 事实变了重建 → 配置换掉 → 复活 → 对话被删", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input(), facts());
    await harness.agents.acquire(input(), facts());
    await harness.agents.acquire(input({ modelId: "model-2" }), facts({ modelId: "model-2" }));
    harness.agents.invalidate(WORKSPACE_ID);
    await harness.agents.acquire(input({ modelId: "model-2" }), facts({ modelId: "model-2" }));
    harness.agents.discard(CONVERSATION_ID);

    expect(harness.trace()).toEqual([
      "built:never-built",
      "reused:assembly-facts-unchanged",
      "retired:assembly-facts-changed",
      "rebuilt:assembly-facts-changed",
      "retired:config-changed",
      "rebuilt:config-changed",
      "retired:conversation-deleted",
    ]);
    // 每条都带得回是哪段对话
    expect(harness.lifecycle.every((event) => event.conversationId === CONVERSATION_ID)).toBe(true);
  });

  it("装配失败不报 built（它并没有造出来）", async () => {
    const harness = createHarness({ fail: new Error("模型端点没配") });

    await expect(harness.agents.acquire(input(), facts())).rejects.toThrow();

    expect(harness.lifecycle).toEqual([]);
  });

  it("没接 onLifecycle 也照样正常工作（它只是观察）", async () => {
    const { scope } = createFakeScope("/tmp/ai-zen-project");
    const scopes = new ScopeRegistry({ createScope: async () => scope });
    const agents = new AgentRegistry({
      scopes,
      runs: { isRunning: () => false },
      createAgent: async () => new FakeAgent([]),
    });

    const agent = await agents.acquire(input(), facts());
    agents.complete(CONVERSATION_ID);
    agents.discard(CONVERSATION_ID);

    expect(agents.get(CONVERSATION_ID)).toBeUndefined();
    expect(agent).toBeDefined();
  });
});
