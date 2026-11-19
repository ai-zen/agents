/**
 * `AgentRegistry` 的用例：agent 存活管理的唯一拥有者。
 *
 * 五条判据各有一组（`acquire` 的复用/重建、`complete` 的陈旧兑现、`invalidate` 的两种结局、
 * `discard` 只丢引用、`disposeAll` 收尾），外加**生命周期事件**那一组 —— 它是「这段对话为什么
 * 没有 agent」的唯一答案，所以每条路径报出的 `action` + `reason` 都钉住。换模型 / 换思考档位
 * 那一手（`invalidateSession`）单独一组：它同样是一对分支（空闲当场退役 / 在跑只打标记），
 * 只是范围到一段对话。
 *
 * 还有两条结构性的事：agent 替调用方把 Scope 先要出来（创建自上而下），以及 agent 活着就拆不了
 * Scope（回收自下而上）。这里用真的 `ScopeRegistry`（假工厂造真 Scope），于是那两条顺序是整条
 * 跑的，而不是断言在假件上。
 */

import { describe, expect, it } from "vitest";

import type { AgentNS } from "@ai-zen/agents-core";

import { AgentRegistry } from "./AgentRegistry.js";
import type {
  AgentAssemblyFacts,
  AgentCreateInput,
  AgentLifecycleEvent,
} from "./AgentRegistry.js";
import type { AgentBuildContext, ChatAgent } from "./ChatRunner.js";
import { ScopeBusyError, ScopeRegistry } from "./ScopeRegistry.js";
import { createFakeScope, deferred, FakeAgent, RecordingScopePlugin } from "./TestSupport.js";
import type { Deferred } from "./TestSupport.js";

const WORKSPACE_ID = "ws-1";
const SESSION_ID = "c-1";

interface Harness {
  agents: AgentRegistry;
  scopes: ScopeRegistry;
  plugin: RecordingScopePlugin;
  /** 每次装配 agent 时交给工厂的事实（看 Scope 是谁给的） */
  builds: AgentBuildContext[];
  /** 每次造出来的假 agent */
  created: FakeAgent[];
  createdScopes: string[];
  /** 「正在跑」的那几段对话：判据就是 agent 身上那一格（`state === "working"`） */
  running: Set<string>;
  /** 每次生灭决定的记录（`onLifecycle` 收到的原样） */
  lifecycle: AgentLifecycleEvent[];
  /**
   * 让它真的「手上有活」（投一批、等 core 自己报 `state:working`）。
   *
   * **不直写 `agent.state`**：那一格是 core 的循环走到哪儿，现在只有 `setState` 能改它（public
   * 可写字段能让状态说谎）。所以这里走真实途径：那一批的请求被一块 `gate` 按住，于是它确实在跑。
   */
  markRunning(sessionId: string): Promise<void>;
  /** 把那块 `gate` 放掉，等它自己跑完这一批、自己报 `state:idle` */
  markIdle(sessionId: string): Promise<void>;
  /** 这段对话报过的 `action:reason`（顺序即发生顺序） */
  trace(sessionId?: string): string[];
}

/** 等这个 agent 真的落到那一格（等的是 core 自己报的事件，不是用例替它设的值） */
function waitForState(agent: ChatAgent, target: AgentNS.AgentState): Promise<void> {
  if (agent.state === target) return Promise.resolve();
  const event = target === "working" ? "state:working" : "state:idle";
  return new Promise<void>((resolve) => {
    agent.on(event, () => resolve());
  });
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
    liveSessions: (workspaceId) => agents.sessionIds(workspaceId),
  });
  const builds: AgentBuildContext[] = [];
  const created: FakeAgent[] = [];
  const lifecycle: AgentLifecycleEvent[] = [];
  const running = new Set<string>();
  /** 每个 agent 手那块「这一批还没跑完」的 `gate`（要用例控制的那个时刻） */
  const holds = new Map<string, Deferred<void>>();
  const agents: AgentRegistry = new AgentRegistry({
    scopes,
    createAgent: async (context) => {
      builds.push(context);
      if (options.build) return await options.build(context);
      if (options.fail) throw options.fail;
      // 请求先被 `gate` 按住：那时它真的在跑（core 取到一批就是 `working`），
      // 放掉之后这一批自然收口、它自己报 `idle`
      const hold = deferred<void>();
      holds.set(context.sessionId, hold);
      const agent = new FakeAgent([{ gate: hold.promise, deltas: [{ content: "好" }] }]);
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
    // 「有没有在跑」只能读 agent 身上那一格（`CORE.md` §4）：这里让它真的跑起来，再等那一格
    markRunning: async (sessionId) => {
      const agent = agents.get(sessionId);
      if (!agent) throw new Error(`没有 agent 可跑：${sessionId}`);
      running.add(sessionId);
      const working = waitForState(agent, "working");
      agent.push({
        content: "占住这一批（用例：让它真的在跑）",
        priority: "high",
        source: { kind: "user" },
      });
      void agent.start();
      await working;
    },
    markIdle: async (sessionId) => {
      running.delete(sessionId);
      const agent = agents.get(sessionId);
      if (!agent) return;
      holds.get(sessionId)?.resolve();
      await waitForState(agent, "idle");
    },
    trace: (sessionId) =>
      lifecycle
        .filter((event) => sessionId === undefined || event.sessionId === sessionId)
        .map((event) => `${event.action}:${event.reason}`),
  };
}

/** 一段对话要办的事（装配入参） */
function input(overrides: Partial<AgentCreateInput> = {}): AgentCreateInput {
  return {
    sessionId: SESSION_ID,
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
    expect(harness.builds[0]?.scope).toBe(await harness.scopes.create(WORKSPACE_ID));
    expect(harness.agents.get(SESSION_ID)).toBe(agent);
  });

  it("装配入参照原样交给工厂（身份 + 历史）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(
      input({ agentId: "a9", modelId: "m9", thinkingLevel: "high" }),
      facts({ agentId: "a9", modelId: "m9", thinkingLevel: "high" }),
    );

    expect(harness.builds[0]).toMatchObject({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      agentId: "a9",
      modelId: "m9",
      thinkingLevel: "high",
    });
  });

  it("装配失败不留下登记，Scope 也不因此被回收（活着就是有人持有它）", async () => {
    const harness = createHarness({ fail: new Error("模型端点没配") });

    await expect(harness.agents.acquire(input(), facts())).rejects.toThrow("模型端点没配");

    expect(harness.agents.get(SESSION_ID)).toBeUndefined();
    expect(harness.agents.sessionIds(WORKSPACE_ID)).toEqual([]);
    expect(harness.scopes.workspaceIds()).toEqual([WORKSPACE_ID]);
    expect(harness.plugin.disposeCalls).toBe(0);
  });

  it("两段对话各是一个：键是 sessionId", async () => {
    const harness = createHarness();

    const one = await harness.agents.acquire(input({ sessionId: "c-1" }), facts());
    const two = await harness.agents.acquire(input({ sessionId: "c-2" }), facts());

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
    expect(harness.agents.get(SESSION_ID)).toBe(second);
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
    expect(harness.agents.get(SESSION_ID)).toBeUndefined();

    fail = false;
    const agent = await harness.agents.acquire(input(), facts());
    expect(harness.agents.get(SESSION_ID)).toBe(agent);
  });
});

describe("AgentRegistry：kill 硬着陆 + 丢引用（对话 / 项目被删那条路）", () => {
  it("kill 之后 get 为 undefined，agent 真的死了（再 push 抛 closed），登记也没了", async () => {
    const harness = createHarness();
    const agent = (await harness.agents.acquire(input(), facts())) as FakeAgent;

    harness.agents.kill(SESSION_ID);

    expect(harness.agents.get(SESSION_ID)).toBeUndefined();
    expect(harness.agents.sessionIds(WORKSPACE_ID)).toEqual([]);
    // 「硬着陆」就是这条的全部内容：agent 死了而不是被摘掉就完了 —— 再往里推就抛 closed
    // （于是不会有一个“没人认领的活 agent”在后台接着烧 token）
    expect(() =>
      agent.push({ content: "对话已经删了", priority: "high", source: { kind: "user" } }),
    ).toThrow();
    // 幂等：没登记就什么也不做，也不再多报一条
    harness.agents.kill(SESSION_ID);
    expect(harness.agents.get(SESSION_ID)).toBeUndefined();
    expect(harness.trace()).toEqual(["built:never-built", "retired:session-deleted"]);
  });

  it("sessionIds 报出这个 Workspace 下活着的对话（别的项目不算）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input({ sessionId: "c-1" }), facts());
    await harness.agents.acquire(input({ sessionId: "c-2" }), facts());
    await harness.agents.acquire(
      input({ sessionId: "c-3", workspaceId: "ws-2" }),
      facts(),
    );

    expect(harness.agents.sessionIds(WORKSPACE_ID).sort()).toEqual(["c-1", "c-2"]);
    expect(harness.agents.sessionIds("ws-2")).toEqual(["c-3"]);
    expect(harness.agents.sessionIds("ws-none")).toEqual([]);
  });
});

describe("回收自下而上：agent 活着就拆不了 Scope", () => {
  it("kill 之后 scopes.dispose 才成功（顺序写在代码里）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input(), facts());

    const error = await harness.scopes.dispose(WORKSPACE_ID).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScopeBusyError);
    expect((error as ScopeBusyError).sessionIds).toEqual([SESSION_ID]);
    expect(harness.scopes.workspaceIds()).toEqual([WORKSPACE_ID]);
    expect(harness.plugin.disposeCalls).toBe(0);

    harness.agents.kill(SESSION_ID);
    await harness.scopes.dispose(WORKSPACE_ID);

    expect(harness.scopes.workspaceIds()).toEqual([]);
    expect(harness.plugin.disposeCalls).toBe(1);
  });

  it("Scope 被销毁之后再 acquire 会重新建一个（agent 照样拿得到 Scope）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input(), facts());
    harness.agents.kill(SESSION_ID);
    await harness.scopes.dispose(WORKSPACE_ID);

    const agent = await harness.agents.acquire(input(), facts());

    expect(harness.createdScopes).toEqual([WORKSPACE_ID, WORKSPACE_ID]);
    expect(harness.agents.get(SESSION_ID)).toBe(agent);
  });

  it("killAll(workspaceId)：只硬着陆那个项目下的，别的项目不动", async () => {
    const harness = createHarness();
    const mine = (await harness.agents.acquire(input({ sessionId: "c-1" }), facts())) as FakeAgent;
    const other = (await harness.agents.acquire(
      input({ sessionId: "c-2", workspaceId: "ws-2" }),
      facts(),
    )) as FakeAgent;

    harness.agents.killAll(WORKSPACE_ID);

    expect(harness.agents.sessionIds("ws-2")).toEqual(["c-2"]);
    // 那一个死了（push 抛 closed），另一个还活着
    expect(() => mine.push({ content: "x", priority: "high", source: { kind: "user" } })).toThrow();
    expect(() =>
      other.push({ content: "y", priority: "high", source: { kind: "user" } }),
    ).not.toThrow();
  });
});

describe("AgentRegistry：invalidate（配置改过的生效手段）", () => {
  it("空闲的当场退役，不进返回列表（没什么要等的）", async () => {
    const harness = createHarness();
    const agent = (await harness.agents.acquire(input(), facts())) as FakeAgent;

    const marked = harness.agents.invalidate(WORKSPACE_ID);

    expect(marked).toEqual([]);
    expect(harness.agents.get(SESSION_ID)).toBeUndefined();
    // 只丢引用：停不是这里的事（那一段本来就没在跑）
    expect(agent.abortCalls).toBe(0);
    expect(harness.trace()).toEqual(["built:never-built", "retired:config-changed"]);
  });

  it("正在跑的只打标记、不退役，且出现在返回列表里；`complete` 之后才退役", async () => {
    const harness = createHarness();
    const agent = (await harness.agents.acquire(input(), facts())) as FakeAgent;
    await harness.markRunning(SESSION_ID);

    const marked = harness.agents.invalidate(WORKSPACE_ID);

    expect(marked).toEqual([SESSION_ID]);
    // 还在登记里（那一段还得用它跑完），只是带上了标记 —— 这一刻什么也没报（没退役）
    expect(harness.agents.get(SESSION_ID)).toBe(agent);
    expect(harness.trace()).toEqual(["built:never-built"]);

    // 变闲那一刻 `ChatRunner` 调 `complete`：陈旧 → 退役
    await harness.markIdle(SESSION_ID);
    harness.agents.complete(SESSION_ID);

    expect(harness.agents.get(SESSION_ID)).toBeUndefined();
    expect((agent as FakeAgent).abortCalls).toBe(0);
    expect(harness.trace()).toEqual([
      "built:never-built",
      "retired:stale-on-idle",
    ]);
  });

  it("只碰这个 Workspace 的 agent（别的项目一个不动）", async () => {
    const harness = createHarness();
    await harness.agents.acquire(input({ sessionId: "c-1" }), facts());
    const other = await harness.agents.acquire(
      input({ sessionId: "c-2", workspaceId: "ws-2" }),
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

describe("AgentRegistry：invalidateSession（换模型 / 换思考档位那一手）", () => {
  it("空闲的当场退役（理由 assembly-facts-changed），下一次 acquire 按新事实重造", async () => {
    const harness = createHarness();
    const first = await harness.agents.acquire(input(), facts());

    expect(harness.agents.invalidateSession(SESSION_ID)).toBe(true);

    expect(harness.agents.get(SESSION_ID)).toBeUndefined();
    expect(harness.trace()).toEqual(["built:never-built", "retired:assembly-facts-changed"]);

    const second = await harness.agents.acquire(input(), facts({ modelId: "model-2" }));
    expect(second).not.toBe(first);
    expect(harness.trace()).toEqual([
      "built:never-built",
      "retired:assembly-facts-changed",
      "rebuilt:assembly-facts-changed",
    ]);
  });

  it("只动这一段：同项目的另一段一个不动", async () => {
    const harness = createHarness();
    const mine = await harness.agents.acquire(input(), facts());
    const other = await harness.agents.acquire(input({ sessionId: "c-2" }), facts());

    harness.agents.invalidateSession(SESSION_ID);

    expect(harness.agents.get(SESSION_ID)).toBeUndefined();
    expect(harness.agents.get("c-2")).toBe(other);
    expect(mine).not.toBe(other);
  });

  it("在跑的只打标记（不打断那批活），`complete` 之后才退役", async () => {
    const harness = createHarness();
    const agent = await harness.agents.acquire(input(), facts());
    await harness.markRunning(SESSION_ID);

    expect(harness.agents.invalidateSession(SESSION_ID)).toBe(false);
    // 还在登记里，只是带上了标记
    expect(harness.agents.get(SESSION_ID)).toBe(agent);
    expect(harness.trace()).toEqual(["built:never-built"]);
    expect((agent as FakeAgent).abortCalls).toBe(0);

    await harness.markIdle(SESSION_ID);
    harness.agents.complete(SESSION_ID);

    expect(harness.agents.get(SESSION_ID)).toBeUndefined();
    expect(harness.trace()).toEqual(["built:never-built", "retired:stale-on-idle"]);
  });

  it("没有这一段时什么也不做（回 false，不报事件）", () => {
    const harness = createHarness();

    expect(harness.agents.invalidateSession(SESSION_ID)).toBe(false);
    expect(harness.trace()).toEqual([]);
  });
});

describe("AgentRegistry：complete 兑现陈旧标记", () => {
  it("陈旧 → 退役，下一次 acquire 重新装配", async () => {
    const harness = createHarness();
    const first = await harness.agents.acquire(input(), facts());
    await harness.markRunning(SESSION_ID);
    harness.agents.invalidate(WORKSPACE_ID);
    await harness.markIdle(SESSION_ID);

    harness.agents.complete(SESSION_ID);
    expect(harness.agents.get(SESSION_ID)).toBeUndefined();

    const second = await harness.agents.acquire(input(), facts());
    expect(second).not.toBe(first);
    expect(harness.builds).toHaveLength(2);
    expect(harness.trace()).toEqual([
      "built:never-built",
      "retired:stale-on-idle",
      "rebuilt:stale-on-idle",
    ]);
  });

  it("不陈旧 → 保留（只有配置改过才换，别把它当成了每轮都换）", async () => {
    const harness = createHarness();
    const agent = await harness.agents.acquire(input(), facts());

    harness.agents.complete(SESSION_ID);
    harness.agents.complete(SESSION_ID);

    expect(harness.agents.get(SESSION_ID)).toBe(agent);
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
  it("全部硬着陆，每段报一条 `shutdown`，之后登记表是空的", async () => {
    const harness = createHarness();
    const one = (await harness.agents.acquire(input({ sessionId: "c-1" }), facts())) as FakeAgent;
    const two = (await harness.agents.acquire(input({ sessionId: "c-2" }), facts())) as FakeAgent;

    harness.agents.disposeAll();

    expect(harness.agents.sessionIds(WORKSPACE_ID)).toEqual([]);
    // 收尾不等排空：进程要退了，那些存量没有去处 —— 所以是 kill（硬着陆），不是 stop。
    // 验收方式：两个实例都已经关门（再 push 抛 closed）。
    expect(() => one.push({ content: "x", priority: "high", source: { kind: "user" } })).toThrow();
    expect(() => two.push({ content: "y", priority: "high", source: { kind: "user" } })).toThrow();
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
    harness.agents.kill(SESSION_ID);

    expect(harness.trace()).toEqual([
      "built:never-built",
      "reused:assembly-facts-unchanged",
      "retired:assembly-facts-changed",
      "rebuilt:assembly-facts-changed",
      "retired:config-changed",
      "rebuilt:config-changed",
      "retired:session-deleted",
    ]);
    // 每条都带得回是哪段对话
    expect(harness.lifecycle.every((event) => event.sessionId === SESSION_ID)).toBe(true);
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
      createAgent: async () => new FakeAgent([]),
    });

    const agent = await agents.acquire(input(), facts());
    agents.complete(SESSION_ID);
    agents.kill(SESSION_ID);

    expect(agents.get(SESSION_ID)).toBeUndefined();
    expect(agent).toBeDefined();
  });
});
