/**
 * `ScopeRegistry` 的用例：懒创建、依赖计数、10 分钟空闲回收、与 MCP 同生共死、全部回收后的通知。
 *
 * 时间用假时钟（`ManualClock`）推进，不真等十分钟；Scope 用真的 SDK `Scope` 装一个记账式
 * 插件，于是「回收 = `Scope.dispose()` = MCP 连接断开」这条链路是完整跑的，断言落在插件的
 * `disposeCalls` 上。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Scope } from "@ai-zen/agents-sdk";

import {
  createWorkspaceScopeFactory,
  DEFAULT_SCOPE_IDLE_TIMEOUT_MS,
  ScopeRegistry,
} from "./ScopeRegistry.js";
import {
  createFakeScope,
  flushMicrotasks,
  ManualClock,
  RecordingScopePlugin,
} from "./TestSupport.js";

const TEN_MINUTES = 10 * 60 * 1000;

let clock: ManualClock;

beforeEach(() => {
  clock = new ManualClock();
});

/** 记录每次创建：返回同一个 Scope（一个 Workspace 一个 Scope） */
function createTrackingFactory(): {
  factory: (workspaceId: string) => Promise<Scope>;
  plugin: RecordingScopePlugin;
  created: string[];
} {
  const created: string[] = [];
  const { scope, plugin } = createFakeScope();
  return {
    factory: async (workspaceId: string) => {
      created.push(workspaceId);
      return scope;
    },
    plugin,
    created,
  };
}

describe("ScopeRegistry", () => {
  it("同一个 Workspace 只建一个 Scope，第二次 acquire 拿到同一个实例", async () => {
    const { factory, created } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory, clock });

    const first = await registry.acquire("ws-1");
    const second = await registry.acquire("ws-1");

    expect(created).toEqual(["ws-1"]);
    expect(second).toBe(first);
    expect(registry.size()).toBe(1);
    expect(registry.peek("ws-1")).toBe(first);
    expect(registry.peek("ws-2")).toBeUndefined();
  });

  it("并发 acquire 只会创建一次", async () => {
    const { factory, created } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory, clock });

    const [a, b] = await Promise.all([registry.acquire("ws-1"), registry.acquire("ws-1")]);

    expect(created).toEqual(["ws-1"]);
    expect(a).toBe(b);
  });

  it("依赖计数归零后要空闲满 10 分钟才回收，回收即调 Scope.dispose()（MCP 关闭）", async () => {
    const { factory, plugin } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory, clock });

    const scope = await registry.acquire("ws-1");
    registry.release("ws-1");

    // 9 分 59 秒：还在
    clock.advance(TEN_MINUTES - 1000);
    expect(registry.peek("ws-1")).toBe(scope);
    expect(plugin.disposeCalls).toBe(0);

    // 到点：回收，插件的 dispose（= MCP 断开）被调用
    clock.advance(1000);
    await flushMicrotasks();
    expect(registry.peek("ws-1")).toBeUndefined();
    expect(registry.size()).toBe(0);
    expect(plugin.disposeCalls).toBe(1);
  });

  it("归零后又被借走：空闲计时取消，不会在别人用着时被拆掉", async () => {
    const { factory, plugin } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory, clock });

    await registry.acquire("ws-1");
    registry.release("ws-1");
    clock.advance(TEN_MINUTES - 1000);

    const again = await registry.acquire("ws-1");
    clock.advance(TEN_MINUTES * 2);

    expect(registry.peek("ws-1")).toBe(again);
    expect(plugin.disposeCalls).toBe(0);
    expect(clock.pending()).toBe(0);

    // 真正没人用了才开始计时
    registry.release("ws-1");
    clock.advance(TEN_MINUTES);
    await flushMicrotasks();
    expect(plugin.disposeCalls).toBe(1);
  });

  it("依赖计数没归零就不计时（两段对话共用同一个 Scope）", async () => {
    const { factory, created } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory, clock });

    await registry.acquire("ws-1");
    await registry.acquire("ws-1");
    registry.release("ws-1");

    clock.advance(TEN_MINUTES * 3);
    await flushMicrotasks();
    expect(registry.peek("ws-1")).toBeDefined();
    expect(clock.pending()).toBe(0);

    registry.release("ws-1");
    clock.advance(TEN_MINUTES);
    await flushMicrotasks();
    expect(registry.peek("ws-1")).toBeUndefined();
    expect(created).toEqual(["ws-1"]);
  });

  it("全部回收之后通知根对象（进程能不能退出看这一条）", async () => {
    const { factory } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory, clock });
    let notified = 0;
    const off = registry.onAllRecycled(() => {
      notified += 1;
    });

    await registry.acquire("ws-1");
    registry.release("ws-1");
    clock.advance(TEN_MINUTES);
    await flushMicrotasks();
    expect(notified).toBe(1);

    off();
    await registry.acquire("ws-2");
    registry.release("ws-2");
    clock.advance(TEN_MINUTES);
    await flushMicrotasks();
    expect(notified).toBe(1);
  });

  it("recycleAll：空闲的立刻回收，被持有的等最后一次 release 再回收", async () => {
    const { factory, plugin } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory, clock });

    await registry.acquire("ws-idle");
    registry.release("ws-idle");
    await registry.acquire("ws-busy");

    await registry.recycleAll();
    await flushMicrotasks();

    // 空闲的那个已经没了；被持有的那个还在（不在别人用着的时候抽能力）
    expect(registry.size()).toBe(1);
    expect(registry.peek("ws-busy")).toBeDefined();

    registry.release("ws-busy");
    await flushMicrotasks();
    expect(registry.size()).toBe(0);
    expect(plugin.disposeCalls).toBe(2);
  });

  it("disposeWorkspace：Workspace 被删时不等引用归零", async () => {
    const { factory, plugin } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory, clock });

    await registry.acquire("ws-1");
    await registry.disposeWorkspace("ws-1");
    await flushMicrotasks();

    expect(registry.peek("ws-1")).toBeUndefined();
    expect(plugin.disposeCalls).toBe(1);

    // 再 acquire 会重新建
    await registry.acquire("ws-1");
    expect(registry.peek("ws-1")).toBeDefined();
  });

  it("创建失败不留下坏条目：下一次 acquire 重新尝试", async () => {
    let attempts = 0;
    const { scope } = createFakeScope();
    const registry = new ScopeRegistry({
      createScope: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("工作目录不见了");
        return scope;
      },
      clock,
    });

    await expect(registry.acquire("ws-1")).rejects.toThrow("工作目录不见了");
    expect(registry.size()).toBe(0);

    await expect(registry.acquire("ws-1")).resolves.toBe(scope);
    expect(attempts).toBe(2);
  });

  it("回收过程中 Scope.dispose() 抛错不影响回收完成，错误交给 onError", async () => {
    const errors: string[] = [];
    const registry = new ScopeRegistry({
      createScope: async () => {
        const { scope } = createFakeScope();
        scope.dispose = async () => {
          throw new Error("MCP 服务器不理我");
        };
        return scope;
      },
      clock,
      onError: (error) => errors.push(String(error)),
    });

    await registry.acquire("ws-1");
    registry.release("ws-1");
    clock.advance(TEN_MINUTES);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(registry.size()).toBe(0);
    expect(errors.join()).toContain("MCP 服务器不理我");
  });
});

describe("createWorkspaceScopeFactory", () => {
  it("按 SDK 口径装配：cwd 来自 Workspace，五个标准插件都在，init 做了首次发现", async () => {
    const createScope = createWorkspaceScopeFactory({
      resolveWorkspace: async (workspaceId) =>
        workspaceId === "ws-1" ? { cwd: "/tmp/ai-zen-project" } : undefined,
      getConfig: () => ({ endpoints: [], models: [] }),
      agentsDir: "/tmp/ai-zen/agents",
      skillsPaths: [],
      toolsPaths: [],
      subAgentsPaths: [],
      mcpPaths: () => [],
    });

    const scope = await createScope("ws-1");

    expect(scope.cwd).toBe("/tmp/ai-zen-project");
    expect(scope.agentsDir).toBe("/tmp/ai-zen/agents");
    expect(scope.plugins.map((plugin) => plugin.id)).toEqual([
      "builtin",
      "user-tools",
      "skills",
      "mcp",
      "subagents",
    ]);
  });

  it("给了平级会话端口才装 `peer-sessions` 插件（两个工具），不给就不装", async () => {
    const common = {
      resolveWorkspace: async () => ({ cwd: "/tmp/ai-zen-project" }),
      getConfig: () => ({ endpoints: [], models: [] }),
      agentsDir: "/tmp/ai-zen/agents",
    };

    const withoutPort = await createWorkspaceScopeFactory(common)("ws-1");
    expect(withoutPort.plugins.map((plugin) => plugin.id)).not.toContain("peer-sessions");

    const port = {
      create: async () => ({ ok: false as const, reason: "depth_exceeded" as const, hint: "no" }),
      status: async () => ({ state: "gone" as const }),
    };
    const withPort = await createWorkspaceScopeFactory({ ...common, peerSessions: port })("ws-1");
    expect(withPort.plugins.map((plugin) => plugin.id)).toContain("peer-sessions");
    // 端口在 → 两个工具的候选名就出现在 `tools` 维度里（权限过滤之前的那一份）
    const plugin = withPort.getPluginById("peer-sessions");
    expect(plugin?.candidates(withPort, {} as never)).toEqual({
      tools: ["create_session", "read_session_status"],
    });
  });

  it("Workspace 不存在时抛错（不静默造一个没有 cwd 的 Scope）", async () => {
    const createScope = createWorkspaceScopeFactory({
      resolveWorkspace: async () => undefined,
      getConfig: () => ({ endpoints: [], models: [] }),
      agentsDir: "/tmp/ai-zen/agents",
    });

    await expect(createScope("ws-missing")).rejects.toThrow("ws-missing");
  });
});

describe("空闲回收的缺省时长", () => {
  it("是 10 分钟（PRD D28）", () => {
    expect(DEFAULT_SCOPE_IDLE_TIMEOUT_MS).toBe(TEN_MINUTES);
  });
});
