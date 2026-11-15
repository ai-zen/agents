/**
 * `AgentRegistry` 的用例：agent 唯一的来源、它替调用方把 Scope 先要出来、
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
  const agents: AgentRegistry = new AgentRegistry({
    scopes,
    createAgent: async (context) => {
      builds.push(context);
      if (options.build) return await options.build(context);
      if (options.fail) throw options.fail;
      const agent = new FakeAgent([{ deltas: [{ content: "好" }] }]);
      created.push(agent);
      return agent;
    },
  });
  return { agents, scopes, plugin, builds, created, createdScopes };
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
});
