import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionAgentFactory } from "./SessionAgentFactory.js";
import {
  AutoMigratePlugin,
  ContextGuardPlugin,
  ContextOverflowError,
  SubAgentGuardInstallerPlugin,
} from "@ai-zen/agents-sdk";
import type { AgentPaths } from "./agentPaths.js";
import type { AgentLike } from "../session/SessionManager.js";

/** 假 Scope：工厂只用它的 `dispose()` 与 `config`（装阈值插件时读） */
function fakeScope(label: string) {
  return {
    label,
    config,
    disposed: false,
    async dispose() {
      this.disposed = true;
    },
  };
}

const fakeAgent: AgentLike = {
  messages: [],
  send: async () => {},
  abort: () => {},
  events: { on: () => {}, off: () => {} },
};

const config = { endpoints: [], models: [], defaultAgent: "default" } as never;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aiz-agent-factory-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个全部外部依赖都被替身的工厂，并记录调用次数 */
function makeFactory(overrides: { failFirstScopeBuild?: boolean } = {}) {
  const calls = { loadConfig: 0, createScope: 0, createAgent: 0 };
  const scopes: Array<ReturnType<typeof fakeScope> & { paths: AgentPaths }> = [];
  let failuresLeft = overrides.failFirstScopeBuild ? 1 : 0;

  const factory = new SessionAgentFactory({
    aiZenDir: join(dir, "zen"),
    homeDir: "/home/u",
    loadConfig: async () => {
      calls.loadConfig++;
      return config;
    },
    createScope: async ({ paths }) => {
      calls.createScope++;
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("scope boom");
      }
      const scope = { ...fakeScope(`scope-${calls.createScope}`), paths };
      scopes.push(scope);
      return scope as never;
    },
    createAgent: async () => {
      calls.createAgent++;
      return fakeAgent;
    },
  });

  return { factory, calls, scopes };
}

describe("SessionAgentFactory", () => {
  it("同一工作区的多个会话共用同一个 Scope（否则每会话一套 MCP 连接）", async () => {
    const { factory, calls, scopes } = makeFactory();

    await factory.create({ workspaceId: "ws", path: "/work/proj", agentId: "default" });
    await factory.create({ workspaceId: "ws", path: "/work/proj", agentId: "coder" });

    expect(calls.createScope).toBe(1);
    expect(calls.createAgent).toBe(2); // 会话各自的 Agent 还是要各造一个
    expect(scopes[0]!.disposed).toBe(false);
  });

  it("不同工作区各建一个 Scope（项目级 skills / tools 不同，不能混）", async () => {
    const { factory, calls, scopes } = makeFactory();

    await factory.create({ workspaceId: "a", path: "/work/a", agentId: "default" });
    await factory.create({ workspaceId: "b", path: "/work/b", agentId: "default" });

    expect(calls.createScope).toBe(2);
    expect(scopes[0]!.paths.skillsDirs[0]).toBe(join("/work/a", ".ai-zen", "skills"));
    expect(scopes[1]!.paths.skillsDirs[0]).toBe(join("/work/b", ".ai-zen", "skills"));
  });

  it("并发建同一工作区的会话：只初始化一次（缓存的是 Promise）", async () => {
    const { factory, calls } = makeFactory();

    await Promise.all([
      factory.create({ workspaceId: "ws", path: "/work/proj", agentId: "default" }),
      factory.create({ workspaceId: "ws", path: "/work/proj", agentId: "default" }),
      factory.create({ workspaceId: "ws", path: "/work/proj", agentId: "default" }),
    ]);

    expect(calls.createScope).toBe(1);
  });

  it("配置改了：invalidate 之后重建，并释放旧 Scope", async () => {
    const { factory, calls, scopes } = makeFactory();

    await factory.create({ workspaceId: "ws", path: "/work/proj", agentId: "default" });
    await factory.invalidate("/work/proj");
    expect(scopes[0]!.disposed).toBe(true);

    await factory.create({ workspaceId: "ws", path: "/work/proj", agentId: "default" });
    expect(calls.createScope).toBe(2);
    expect(calls.loadConfig).toBe(2); // 配置是重新读的，不是缓存的旧值
  });

  it("invalidate(某个工作区) 不影响别的工作区", async () => {
    const { factory, calls, scopes } = makeFactory();

    await factory.create({ workspaceId: "a", path: "/work/a", agentId: "default" });
    await factory.create({ workspaceId: "b", path: "/work/b", agentId: "default" });
    await factory.invalidate("/work/a");

    expect(scopes[0]!.disposed).toBe(true);
    expect(scopes[1]!.disposed).toBe(false);

    await factory.create({ workspaceId: "b", path: "/work/b", agentId: "default" });
    expect(calls.createScope).toBe(2); // b 还是复用
  });

  it("Scope 建失败不缓存：下一次还会重试", async () => {
    const { factory, calls } = makeFactory({ failFirstScopeBuild: true });

    await expect(factory.create({ workspaceId: "ws", path: "/work/proj", agentId: "default" })).rejects.toThrow(
      /scope boom/,
    );
    await expect(
      factory.create({ workspaceId: "ws", path: "/work/proj", agentId: "default" }),
    ).resolves.toBeTruthy();
    expect(calls.createScope).toBe(2);
  });

  it("dispose 释放全部 Scope", async () => {
    const { factory, scopes } = makeFactory();

    await factory.create({ workspaceId: "a", path: "/work/a", agentId: "default" });
    await factory.create({ workspaceId: "b", path: "/work/b", agentId: "default" });
    await factory.dispose();

    expect(scopes.every((scope) => scope.disposed)).toBe(true);
    expect(await factory.create({ workspaceId: "a", path: "/work/a", agentId: "default" })).toBe(fakeAgent);
  });
});

describe("SessionAgentFactory（默认装配，真 SDK / 真磁盘）", () => {
  it("给一份带端点与模型的配置，能造出可用的 Agent", async () => {
    const aiZenDir = join(dir, "zen");
    const workspace = join(dir, "proj");
    mkdirSync(join(aiZenDir, "agents"), { recursive: true });
    mkdirSync(workspace, { recursive: true });

    writeFileSync(
      join(aiZenDir, "config.json"),
      JSON.stringify(
        {
          endpoints: [
            { id: "local", name: "Local", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test" },
          ],
          models: [
            {
              id: "test-model",
              name: "Test",
              endpointId: "local",
              tokenThresholds: { handoff: 100_000, guard: 150_000 },
              custom: true,
            },
          ],
          defaultAgent: "default",
          version: 4,
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(aiZenDir, "agents", "default.json"),
      JSON.stringify(
        {
          id: "default",
          name: "默认",
          modelId: "test-model",
          messages: [{ role: "system", content: "hi" }],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const factory = new SessionAgentFactory({ aiZenDir, homeDir: dir });
    try {
      const agent = await factory.create({ workspaceId: "ws", path: workspace, agentId: "default" });
      // 结构面齐全 = 会话管理器能驱动它（具体行为由 SDK 自己的测试管）
      expect(Array.isArray(agent.messages)).toBe(true);
      expect(typeof agent.send).toBe("function");
      expect(typeof agent.abort).toBe("function");
      expect(typeof agent.events.on).toBe("function");
      // 系统提示来自磁盘上的 Agent 定义
      expect(String((agent.messages[0] as { content?: unknown })?.content ?? "")).toContain("hi");
    } finally {
      await factory.dispose();
    }
  });
});

describe("SessionAgentFactory.setModel（换模型 = 写 Agent 定义）", () => {
  /** 造一份带两个模型的配置 + 一个带思考参数的 Agent 定义 */
  function seed(): { aiZenDir: string } {
    const aiZenDir = join(dir, "zen");
    mkdirSync(join(aiZenDir, "agents"), { recursive: true });
    writeFileSync(
      join(aiZenDir, "config.json"),
      JSON.stringify({
        endpoints: [{ id: "e", name: "E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" }],
        models: [
          { id: "m1", name: "M1", endpointId: "e", tokenThresholds: { handoff: 1, guard: 2 }, custom: true },
          { id: "m2", name: "M2", endpointId: "e", tokenThresholds: { handoff: 1, guard: 2 }, custom: true },
        ],
        defaultAgent: "default",
        version: 4,
      }),
    );
    writeFileSync(
      join(aiZenDir, "agents", "default.json"),
      JSON.stringify({
        id: "default",
        name: "默认",
        modelId: "m1",
        modelParams: { thinking: { type: "disabled" } },
        permissions: { exec: "allow" },
        messages: [{ role: "system", content: "sys" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    return { aiZenDir };
  }

  const readDefinition = (aiZenDir: string) =>
    JSON.parse(readFileSync(join(aiZenDir, "agents", "default.json"), "utf-8"));

  it("写 modelId、清空思考参数、其它字段一个不丢", async () => {
    const { aiZenDir } = seed();
    const factory = new SessionAgentFactory({ aiZenDir, homeDir: dir });

    expect(await factory.setModel({ agentId: "default", modelId: "m2" })).toEqual({
      agentId: "default",
      modelId: "m2",
    });

    const definition = readDefinition(aiZenDir);
    expect(definition.modelId).toBe("m2");
    // 旧模型的思考档位对新模型可能非法：必须清掉
    expect(definition).not.toHaveProperty("modelParams");
    // 权限与提示词是用户的，不能被"换模型"顺手抹掉
    expect(definition.permissions).toEqual({ exec: "allow" });
    expect(definition.messages).toHaveLength(1);
  });

  it("未知模型 → unknown-model；未知 Agent → unknown-agent", async () => {
    const { aiZenDir } = seed();
    const factory = new SessionAgentFactory({ aiZenDir, homeDir: dir });

    await expect(factory.setModel({ agentId: "default", modelId: "nope" })).rejects.toThrow(/unknown model/);
    await expect(factory.setModel({ agentId: "ghost", modelId: "m1" })).rejects.toThrow(/unknown agent/);
  });
});

describe("SessionAgentFactory：按模型阈值装护栏与自动迁移", () => {
  /** 有阈值的配置：`handoff` 软线 100 / `guard` 硬线 200 */
  const guardedConfig = {
    endpoints: [],
    models: [{ id: "m", tokenThresholds: { handoff: 100, guard: 200 } }],
    defaultAgent: "default",
  };

  /** 记录 `use()` 收到哪些插件，并带上 `lastUsage`（自动迁移看它） */
  function recordingAgent() {
    const plugins: any[] = [];
    return {
      plugins,
      agent: {
        messages: [],
        definition: { modelId: "m" },
        lastUsage: { prompt_tokens: 999 } as unknown,
        send: async () => {},
        abort: () => {},
        use: (plugin: unknown) => plugins.push(plugin),
        events: { on: () => {}, off: () => {} },
      } as unknown as AgentLike,
    };
  }

  function factoryWith(configValue: unknown, agent: AgentLike, hooks: Record<string, unknown>) {
    return new SessionAgentFactory({
      aiZenDir: join(dir, "zen"),
      homeDir: "/home/u",
      loadConfig: async () => configValue as never,
      createScope: async () => ({ config: configValue, dispose: async () => {} }) as never,
      createAgent: async () => agent,
    });
  }

  it("有阈值：护栏与自动迁移都装上，自动迁移真的回到会话层", async () => {
    const { agent, plugins } = recordingAgent();
    let migrated = 0;
    const factory = factoryWith(guardedConfig, agent, {});

    await factory.create({
      workspaceId: "ws",
      path: "/p",
      agentId: "default",
      autoMigrate: async () => {
        migrated += 1;
      },
      isHandoffBusy: () => false,
    });

    expect(plugins).toHaveLength(3); // ContextGuardPlugin + SubAgentGuardInstallerPlugin + AutoMigratePlugin
    // 子 Agent 的硬线：阈值必须与主 Agent **同源**（同一个 `guardTokens`），另拍一个数就是两套护栏
    const installer = plugins.find((plugin) => plugin instanceof SubAgentGuardInstallerPlugin) as any;
    expect(installer).toBeDefined();
    expect(installer.guardTokens).toBe(200);
    // 真的跑一次自动迁移的触发钩子：用量 999 > 软线 100 → 交给会话层
    const autoMigrate = plugins.find((plugin) => plugin instanceof AutoMigratePlugin) as any;
    await autoMigrate.onAfterSend({ agent });
    expect(migrated).toBe(1);
  });

  it("交接中让行：传给安装器的 isSuspended 就是 isHandoffBusy（驱动子 Agent 硬线验证）", async () => {
    const { agent, plugins } = recordingAgent();
    let busy = true;
    const factory = factoryWith(guardedConfig, agent, {});

    await factory.create({
      workspaceId: "ws",
      path: "/p",
      agentId: "default",
      isHandoffBusy: () => busy,
    });

    const installer = plugins.find((plugin) => plugin instanceof SubAgentGuardInstallerPlugin) as any;
    // 假子 Agent：只捕获安装器装进去的插件（服务端只管「装进去的是谁」，行为仍归 SDK）
    const subPlugins: any[] = [];
    installer.onSubAgentStart({
      agent,
      subAgent: { use: (plugin: unknown) => subPlugins.push(plugin) },
      toolCallContext: {},
    });
    const subGuard = subPlugins.find((plugin) => plugin instanceof ContextGuardPlugin) as any;
    expect(subGuard).toBeDefined();

    // 记录用的 agent 用量 999 > 硬线 200：不让行就必定抛
    // 交接进行中 → 子 Agent 的硬线必须让行，否则交接中派出去的子任务会被自己的硬线打断
    // （甚至「交接触发拦截 → 拦截又触发交接」地打转）
    await expect(subGuard.onInnerLoopStart({ agent })).resolves.toBeUndefined();

    // 交接结束 → 同一颗插件立刻恢复拦截（说明拿到的是函数，不是装配时的快照）
    busy = false;
    await expect(subGuard.onInnerLoopStart({ agent })).rejects.toThrow(ContextOverflowError);
  });

  it("交接进行中让行：插件不触发（否则「交接触发迁移」无限递归）", async () => {
    const { agent, plugins } = recordingAgent();
    let migrated = 0;
    let busy = true;
    const factory = factoryWith(guardedConfig, agent, {});

    await factory.create({
      workspaceId: "ws",
      path: "/p",
      agentId: "default",
      autoMigrate: async () => {
        migrated += 1;
      },
      isHandoffBusy: () => busy,
    });

    const autoMigrate = plugins.find((plugin) => plugin instanceof AutoMigratePlugin) as any;
    await autoMigrate.onAfterSend({ agent });
    expect(migrated).toBe(0);

    busy = false;
    await autoMigrate.onAfterSend({ agent });
    expect(migrated).toBe(1);
  });

  it("不传 autoMigrate：只装两个护栏（没有交接能力就别装作能迁）", async () => {
    const { agent, plugins } = recordingAgent();
    const factory = factoryWith(guardedConfig, agent, {});

    await factory.create({ workspaceId: "ws", path: "/p", agentId: "default" });

    expect(plugins).toHaveLength(2);
    expect(plugins.some((plugin) => plugin instanceof ContextGuardPlugin)).toBe(true);
    expect(plugins.some((plugin) => plugin instanceof SubAgentGuardInstallerPlugin)).toBe(true);
  });

  it("模型没配阈值：一个插件都不装（不凭直觉拍一个数）", async () => {
    const { agent, plugins } = recordingAgent();
    const factory = factoryWith(
      { endpoints: [], models: [{ id: "m" }], defaultAgent: "default" },
      agent,
      {},
    );

    await factory.create({ workspaceId: "ws", path: "/p", agentId: "default", autoMigrate: async () => {} });

    expect(plugins).toHaveLength(0);
  });
});
