/**
 * 临时对话的验收（D3 / F-A2 / R1 / R49）：一次请求跑一轮、结果一次返回；无 id、不落库、
 * 不进列表、不可 attach、不推流式事件；只借 Scope，与 Workspace 无关。
 *
 * 夹具里一个库都不建：`TransientRunner` 的依赖只有 `scopes` / `createAgent` / `configManager`
 * （见它自己的构造参数），根本没有库句柄 —— 以前这里每个用例 `new Database + migrate` 只为
 * 查一句「库里 0 行」，而那句永远为真。「零痕迹」在真库上验才有意义，那条在 `app.test.ts`。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { ConfigManager } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Scope } from "@ai-zen/agents-sdk";
import { FakeAgent, createFakeScope } from "./TestSupport.js";
import { TransientRunner, cwdOfTransientScopeKey, transientScopeKey } from "./TransientRunner.js";
import type { TransientAgentFactory, TransientScopes } from "./TransientRunner.js";

/** 取 Scope 的记账实现：真 Scope（cwd 从键里解析），只记拿过哪些键 */
class RecordingScopes implements TransientScopes {
  readonly created: string[] = [];
  readonly scopes: Scope[] = [];

  async create(key: string): Promise<Scope> {
    this.created.push(key);
    const cwd = cwdOfTransientScopeKey(key) ?? "/";
    const { scope } = createFakeScope(cwd);
    this.scopes.push(scope);
    return scope;
  }
}

interface Harness {
  dir: string;
  runner: TransientRunner;
  scopes: RecordingScopes;
  agentCalls: Array<{ agentId: string; modelId: string | null; historyLength: number }>;
  /** 造出来的假 agent（看它手里最后有哪些消息 / 模型收到了什么） */
  agents: FakeAgent[];
  behaviour: { fail: Error | null; deltas: AgentNS.Delta[] };
}

async function setup(config: Record<string, unknown> = { defaultAgent: "a1" }): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "ai-zen-transient-"));

  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config), "utf-8");

  const scopes = new RecordingScopes();
  const agentCalls: Harness["agentCalls"] = [];
  const agents: FakeAgent[] = [];
  const behaviour: Harness["behaviour"] = {
    fail: null,
    deltas: [{ content: "一次性回答" }],
  };

  const createAgent: TransientAgentFactory = async (context) => {
    agentCalls.push({
      agentId: context.agentId,
      modelId: context.modelId,
      historyLength: context.history.length,
    });
    // 真 core `Agent` + 脚本里的假流：模型那一侧可脚本化（`fail` 模拟端点 500）
    const agent = new FakeAgent([
      behaviour.fail ? { fail: behaviour.fail, deltas: [] } : { deltas: behaviour.deltas },
    ]);
    agents.push(agent);
    return agent;
  };

  const runner = new TransientRunner({
    scopes,
    createAgent,
    configManager: new ConfigManager(configPath),
  });

  return { dir, runner, scopes, agentCalls, agents, behaviour };
}

let harness: Harness;

beforeEach(async () => {
  harness = await setup();
});

afterEach(async () => {
  await rm(harness.dir, { recursive: true, force: true });
});

describe("一次请求跑一轮，结果一次返回（D3）", () => {
  it("回来的就是 core 的那条助手消息", async () => {
    const result = await harness.runner.run({
      cwd: "/tmp/project",
      input: { content: "一句话回答我" },
    });

    expect(result.message.role).toBe(AgentNS.Role.Assistant);
    expect(result.message.content).toBe("一次性回答");
    expect(result.problem).toBeNull();
    // 没有第二份「拼好的正文」之类的重复字段：结果只有这两样（子 Agent 不另给快照，
    // 它们说过的话在那条委派的消息里，要翻就按工具调用 id 取）
    expect(Object.keys(result).sort()).toEqual(["message", "problem"]);
  });

  it("跑一轮就是一次 runOnce，历史永远是空的（没有可续接的东西）", async () => {
    await harness.runner.run({ cwd: "/tmp/project", input: { content: "第一次" } });
    expect(harness.agentCalls).toEqual([{ agentId: "a1", modelId: null, historyLength: 0 }]);
  });

  it("点名助手与模型时按点名的来", async () => {
    await harness.runner.run({
      cwd: "/tmp/project",
      input: { content: "用这个模型" },
      agentId: "a9",
      modelId: "m9",
    });
    expect(harness.agentCalls[0]).toEqual({ agentId: "a9", modelId: "m9", historyLength: 0 });
  });
});

describe("只取 Scope，与 Workspace 无关（D3）", () => {
  it("按 cwd 取，同一个键下去（没有归还这回事）", async () => {
    await harness.runner.run({ cwd: "/tmp/project", input: { content: "x" } });
    expect(harness.scopes.created).toEqual([transientScopeKey("/tmp/project")]);
    expect(transientScopeKey("/tmp/project")).toBe("transient:/tmp/project");
    expect(cwdOfTransientScopeKey("transient:/tmp/project")).toBe("/tmp/project");
    expect(cwdOfTransientScopeKey("w1")).toBeNull();
  });

  it("不同目录要的是不同的 Scope", async () => {
    await harness.runner.run({ cwd: "/tmp/a", input: { content: "x" } });
    await harness.runner.run({ cwd: "/tmp/b", input: { content: "y" } });
    expect(harness.scopes.created).toEqual(["transient:/tmp/a", "transient:/tmp/b"]);
  });

  it("跑挂了 Scope 也不回收（它不属于这一次请求）", async () => {
    // 请求失败（端点 500）现在落在那条消息上（见「失败与结局的说明」）：
    // 无论成不成，Scope 都不还 —— 它属于那个目录，不属于这一次请求
    harness.behaviour.fail = new Error("端点 500");
    const result = await harness.runner.run({ cwd: "/tmp/project", input: { content: "x" } });
    expect(result.problem?.code).toBe("transient.error");
    // 拿过的那一个还在手里（本文件没有销毁它的口子），跑挂了也不动它
    expect(harness.scopes.created).toEqual([transientScopeKey("/tmp/project")]);
    expect(harness.scopes.scopes).toHaveLength(1);
  });
});

describe("告诉模型「现在在哪个目录」（F-D9）", () => {
  it("cwd 是一条独立的 hidden 消息，发出去的正文就是用户打的那一句", async () => {
    await harness.runner.run(
      { cwd: "/tmp/project", input: { content: "一句话回答我" } },
      "zh",
    );

    // 发出去的正文不再附注入段：模型第一次请求里最后一条 user 消息就是用户打的那句
    const request = harness.agents[0]?.requests[0] ?? [];
    const userMessages = request.filter((message) => message.role === AgentNS.Role.User);
    expect(userMessages.at(-1)?.content).toBe("一句话回答我");

    // 而 agent 收到的第一条是那条 hidden 的 user 消息：形状与落库那一条同形同文，正文就是路径
    const cwdMessage = harness.agents[0]?.messages[0];
    expect(cwdMessage?.role).toBe(AgentNS.Role.User);
    expect(cwdMessage?.hidden).toBe(true);
    expect(cwdMessage?.source).toEqual({ kind: "system", label: "cwd" });
    expect(cwdMessage?.content).toBe("/tmp/project");
  });
});

describe("失败与结局的说明", () => {
  it("请求失败不再是一个异常：core 把它记在那条消息上，结果照样带回来（problem 说明）", async () => {
    // core 重写之后「请求没连上」是**世界里发生的事**，不是调用方的异常（`CORE.md` §7）：
    // 它落在 `message.status = error` / `message.error` 上，一轮照常收尾。临时对话于是回到
    // 「结果 + 一句说明」这个形状，而不是把异常甩给调用方。
    harness.behaviour.fail = new Error("端点 500");
    const result = await harness.runner.run({
      cwd: "/tmp/project",
      input: { content: "x" },
    });
    expect(result.message.status).toBe(AgentNS.MessageStatus.Error);
    expect(result.message.error).toBeInstanceOf(Error);
    expect(result.problem?.messageKey).toBe("error.transientFailed");
    expect(result.problem?.code).toBe("transient.error");
  });

  it("cwd 为空按参数不对拒", async () => {
    await expect(harness.runner.run({ cwd: "   ", input: { content: "x" } })).rejects.toMatchObject({
      code: "invalid_params",
      detail: { field: "cwd" },
    });
    expect(harness.scopes.created).toEqual([]);
  });

  it("没点名助手、配置里也没有默认助手 → config_invalid（说不清用哪个）", async () => {
    const bare = await setup({});
    try {
      await expect(
        bare.runner.run({ cwd: "/tmp/project", input: { content: "x" } }),
      ).rejects.toMatchObject({ code: "config_invalid" });
      expect(bare.scopes.created).toEqual([]);
    } finally {
      await rm(bare.dir, { recursive: true, force: true });
    }
  });
});
