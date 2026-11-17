/**
 * `ScopeRegistry` 的用例：幂等 get-or-create、显式 `dispose`（撞上存活 agent 就拒绝）、
 * `disposeAll` 收尾、与 MCP 同生共死，以及配置生效那条路（`refreshWorkspace`：就地刷，不销毁重建）。
 *
 * 这一层刻意**没有**空闲计时、引用计数与自动回收，所以这里也不再推进假时钟去等回收：
 * 「建出来就一直在」本身就是被钉住的语义（`Scope` 用真的 SDK 实例装一个记账式插件，
 * 于是「销毁 = `Scope.dispose()` = MCP 连接断开」这条链路是完整跑的，断言落在 `disposeCalls`）。
 */

import { describe, expect, it } from "vitest";
import { Scope } from "@ai-zen/agents-sdk";
import type { AppConfig } from "@ai-zen/agents-sdk";

import { createWorkspaceScopeFactory, ScopeBusyError, ScopeRegistry } from "./ScopeRegistry.js";
import { createFakeScope, flushMicrotasks, ManualClock, RecordingScopePlugin } from "./TestSupport.js";

/** 记录每次创建：按 workspaceId 造一个真 Scope（一个 Workspace 一个 Scope） */
function createTrackingFactory(): {
  factory: (workspaceId: string) => Promise<Scope>;
  created: string[];
  pluginOf: (workspaceId: string) => RecordingScopePlugin;
  disposeCalls: () => number;
} {
  const created: string[] = [];
  const plugins = new Map<string, RecordingScopePlugin>();
  const scopes = new Map<string, Scope>();
  return {
    factory: async (workspaceId: string) => {
      created.push(workspaceId);
      const { scope, plugin } = createFakeScope(`/tmp/${workspaceId}`);
      plugins.set(workspaceId, plugin);
      scopes.set(workspaceId, scope);
      return scope;
    },
    created,
    pluginOf: (workspaceId) => plugins.get(workspaceId)!,
    disposeCalls: () => [...plugins.values()].reduce((total, item) => total + item.disposeCalls, 0),
  };
}

describe("ScopeRegistry：幂等的 get-or-create", () => {
  it("同一个 Workspace 只建一个 Scope，第二次 create 拿到同一个实例", async () => {
    const { factory, created } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory });

    const first = await registry.create("ws-1");
    const second = await registry.create("ws-1");

    expect(created).toEqual(["ws-1"]);
    expect(second).toBe(first);
    // 「现在有没有」只有一个口：`workspaceIds` 报持有哪几个（看而不建的那个口已删）
    expect(registry.workspaceIds()).toEqual(["ws-1"]);
  });

  it("并发 create 只会创建一次", async () => {
    const { factory, created } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory });

    const [a, b] = await Promise.all([registry.create("ws-1"), registry.create("ws-1")]);

    expect(created).toEqual(["ws-1"]);
    expect(a).toBe(b);
  });

  it("创建失败不留下坏条目：下一次 create 重新尝试", async () => {
    let attempts = 0;
    const { scope } = createFakeScope();
    const registry = new ScopeRegistry({
      createScope: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("工作目录不见了");
        return scope;
      },
    });

    await expect(registry.create("ws-1")).rejects.toThrow("工作目录不见了");
    expect(registry.workspaceIds()).toEqual([]);

    await expect(registry.create("ws-1")).resolves.toBe(scope);
    expect(attempts).toBe(2);
  });
});

describe("ScopeRegistry：没有自动回收", () => {
  it("create 之后没有任何计时器能把它收掉（推进远超原 10 分钟仍在）", async () => {
    const clock = new ManualClock();
    const { factory, pluginOf } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory });

    const scope = await registry.create("ws-1");
    // 本文件一个定时器都不该排（原来的 10 分钟空闲计时已撤掉）
    expect(clock.pending()).toBe(0);

    clock.advance(10 * 60 * 1000 * 24);
    await flushMicrotasks();

    // 还是原来那个（`create` 幂等：条目在就交还它自己）
    expect(await registry.create("ws-1")).toBe(scope);
    expect(pluginOf("ws-1").disposeCalls).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it("构造函数不再接受 clock / idleTimeoutMs（只认 createScope / liveConversations / onError）", () => {
    // 类型层面已经把这两个参数删掉了（下面两条 @ts-expect-error 就是在钉这件事），
    // 运行时多塞进去的键也不会被读到 —— 没有空闲回收的代码路径了
    const createScope = async () => createFakeScope().scope;
    const withIdle = new ScopeRegistry({
      createScope,
      // @ts-expect-error 空闲计时已撤：这个键不再属于构造参数
      idleTimeoutMs: 1,
    });
    const withClock = new ScopeRegistry({
      createScope,
      // @ts-expect-error 时钟不再参与 Scope 的生命周期
      clock: new ManualClock(),
    });

    expect(withIdle.workspaceIds()).toEqual([]);
    expect(withClock.workspaceIds()).toEqual([]);
  });
});

describe("ScopeRegistry：显式 dispose", () => {
  it("dispose 之后不再持有它，再 create 得到新实例", async () => {
    const { factory, disposeCalls } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory });

    const first = await registry.create("ws-1");
    await registry.dispose("ws-1");

    expect(registry.workspaceIds()).toEqual([]);
    // 销毁 = Scope.dispose()：插件的 dispose（= MCP 断开）被调用
    expect(disposeCalls()).toBe(1);

    const second = await registry.create("ws-1");
    expect(second).not.toBe(first);
    expect(await registry.create("ws-1")).toBe(second);
  });

  it("dispose 不存在的 Workspace 是幂等的空操作", async () => {
    const { factory, disposeCalls } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory });

    await registry.dispose("ws-none");
    expect(disposeCalls()).toBe(0);
  });

  it("撞上还活着的 agent 就拒绝，错误里带着 conversationId 列表；agent 丢掉之后就能销毁", async () => {
    const { factory, disposeCalls } = createTrackingFactory();
    // 活着的 agent 由 `AgentRegistry` 报（这里用同一形状的假件）
    let live = ["c-1", "c-2"];
    const registry = new ScopeRegistry({
      createScope: factory,
      liveConversations: (workspaceId) => (workspaceId === "ws-1" ? live : []),
    });

    await registry.create("ws-1");

    const error = await registry.dispose("ws-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScopeBusyError);
    expect((error as ScopeBusyError).workspaceId).toBe("ws-1");
    expect((error as ScopeBusyError).conversationIds).toEqual(["c-1", "c-2"]);
    expect((error as Error).message).toContain("c-1");
    // 拒绝就是拒绝：Scope 还在，谁也没被掐掉
    expect(registry.workspaceIds()).toEqual(["ws-1"]);
    expect(disposeCalls()).toBe(0);

    // 调用方先让会话停下 / 丢掉 agent，再回来销毁
    live = [];
    await registry.dispose("ws-1");
    expect(registry.workspaceIds()).toEqual([]);
    expect(disposeCalls()).toBe(1);
  });

  it("不注入 liveConversations 时当作「没有活着的 agent」（单独用本文件的场合）", async () => {
    const { factory, disposeCalls } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory });

    await registry.create("ws-1");
    await registry.dispose("ws-1");

    expect(disposeCalls()).toBe(1);
  });

  it("disposeAll：全部销毁（收尾用，撞上活着的 agent 也不拒绝）", async () => {
    const { factory, disposeCalls } = createTrackingFactory();
    const registry = new ScopeRegistry({
      createScope: factory,
      // 收尾时「还有 agent 活着」不是要挡住销毁的理由
      liveConversations: () => ["c-1"],
    });

    await registry.create("ws-a");
    await registry.create("ws-b");
    expect(registry.workspaceIds().sort()).toEqual(["ws-a", "ws-b"]);

    await registry.disposeAll();

    expect(registry.workspaceIds()).toEqual([]);
    expect(disposeCalls()).toBe(2);
  });

  it("Scope.dispose() 抛错不影响销毁完成，错误交给 onError", async () => {
    const errors: string[] = [];
    const registry = new ScopeRegistry({
      createScope: async () => {
        const { scope } = createFakeScope();
        scope.dispose = async () => {
          throw new Error("MCP 服务器不理我");
        };
        return scope;
      },
      onError: (error) => errors.push(String(error)),
    });

    await registry.create("ws-1");
    await registry.dispose("ws-1");
    await flushMicrotasks();

    expect(registry.workspaceIds()).toEqual([]);
    expect(errors.join()).toContain("MCP 服务器不理我");
  });
});

describe("ScopeRegistry：配置生效走 refresh，不销毁重建", () => {
  it("refreshWorkspace：就地刷同一个 Scope（重读配置 + 重新发现），不销毁也不重建", async () => {
    let config: AppConfig = { endpoints: [], models: [] };
    const plugin = new RecordingScopePlugin();
    const scope = new Scope({ getConfig: () => config, agentsDir: "/tmp/ws/agents", cwd: "/tmp/ws" });
    scope.use(plugin);
    await scope.init();

    let created = 0;
    const registry = new ScopeRegistry({
      createScope: async () => {
        created += 1;
        return scope;
      },
    });
    await registry.create("ws-1");

    const next: AppConfig = { endpoints: [], models: [], maxToolOutput: 1234 };
    config = next;
    await registry.refreshWorkspace("ws-1");

    // 刷的是同一个实例：读到的配置是新的，能力重新发现了一轮，但谁也没被销毁
    expect(await registry.create("ws-1")).toBe(scope);
    expect(scope.config).toBe(next);
    expect(plugin.discoverCalls).toBe(2); // init 一次 + 刷新一次
    expect(plugin.disposeCalls).toBe(0);
    expect(created).toBe(1);
  });

  it("refreshWorkspace：不存在的就不刷（不为刷新去创建一个 Scope）", async () => {
    const { factory, created } = createTrackingFactory();
    const registry = new ScopeRegistry({ createScope: factory });

    await registry.refreshWorkspace("ws-unknown");

    expect(created).toEqual([]);
    expect(registry.workspaceIds()).toEqual([]);
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

  it("给了平级会话端口才装 `peer-sessions` 插件（三个工具），不给就不装", async () => {
    const common = {
      resolveWorkspace: async () => ({ cwd: "/tmp/ai-zen-project" }),
      getConfig: () => ({ endpoints: [], models: [] }),
      agentsDir: "/tmp/ai-zen/agents",
    };

    const withoutPort = await createWorkspaceScopeFactory(common)("ws-1");
    expect(withoutPort.plugins.map((plugin) => plugin.id)).not.toContain("peer-sessions");

    const port = {
      create: async () => ({ ok: false as const, reason: "depth_exceeded" as const, hint: "no" }),
      status: async () => ({ found: false as const, status: null }),
      send: async () => ({ ok: false as const, reason: "gone" as const }),
    };
    const withPort = await createWorkspaceScopeFactory({ ...common, peerSessions: port })("ws-1");
    expect(withPort.plugins.map((plugin) => plugin.id)).toContain("peer-sessions");
    // 端口在 → 三个工具的候选名就出现在 `tools` 维度里（权限过滤之前的那一份）
    const plugin = withPort.getPluginById("peer-sessions");
    expect(plugin?.candidates(withPort, {} as never)).toEqual({
      tools: ["create_session", "read_session_status", "postMessage"],
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
