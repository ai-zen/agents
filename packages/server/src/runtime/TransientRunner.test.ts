/**
 * 临时对话的验收（D3 / F-A2 / R1 / R49）：一次请求跑一轮、结果一次返回；无 id、不落库、
 * 不进列表、不可 attach、不推流式事件；只借 Scope，与 Workspace 无关。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { ConfigManager } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Database } from "../storage/Database.js";
import { migrate } from "../storage/migrations.js";
import type { Scope } from "@ai-zen/agents-sdk";
import { FakeAgent, createFakeScope } from "./TestSupport.js";
import { TransientRunner, cwdOfTransientScopeKey, transientScopeKey } from "./TransientRunner.js";
import type { TransientAgentFactory, TransientScopeBorrower } from "./TransientRunner.js";

/** 借 Scope 的记账实现：真 Scope（cwd 从键里解析），只记借还 */
class RecordingScopes implements TransientScopeBorrower {
  readonly acquired: string[] = [];
  readonly released: string[] = [];
  readonly scopes: Scope[] = [];

  async acquire(key: string): Promise<Scope> {
    this.acquired.push(key);
    const cwd = cwdOfTransientScopeKey(key) ?? "/";
    const { scope } = createFakeScope(cwd);
    this.scopes.push(scope);
    return scope;
  }

  release(key: string): void {
    this.released.push(key);
  }
}

interface Harness {
  dir: string;
  db: Database;
  runner: TransientRunner;
  scopes: RecordingScopes;
  agentCalls: Array<{ agentId: string; modelId: string | null; historyLength: number }>;
  /** 这一轮真正发给模型的内容（F-D9 要验注入段接在末尾） */
  sentContents: Array<AgentNS.MessageContent>;
  behaviour: { fail: Error | null; status: AgentNS.MessageStatus | null; deltas: AgentNS.Delta[] };
}

async function setup(config: Record<string, unknown> = { defaultAgent: "a1" }): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "ai-zen-transient-"));
  const db = new Database(join(dir, "ai-zen.db"));
  await migrate(db);

  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config), "utf-8");

  const scopes = new RecordingScopes();
  const agentCalls: Harness["agentCalls"] = [];
  const sentContents: Array<AgentNS.MessageContent> = [];
  const behaviour: Harness["behaviour"] = {
    fail: null,
    status: null,
    deltas: [{ content: "一次性回答" }],
  };

  const createAgent: TransientAgentFactory = async (context) => {
    agentCalls.push({
      agentId: context.agentId,
      modelId: context.modelId,
      historyLength: context.history.length,
    });
    const agent = new FakeAgent([{ deltas: behaviour.deltas }]);
    if (behaviour.fail) {
      agent.send = async () => {
        throw behaviour.fail;
      };
    } else if (behaviour.status) {
      const status = behaviour.status;
      const send = agent.send.bind(agent);
      agent.send = async (content) => {
        const messages = await send(content);
        const last = messages[messages.length - 1];
        if (last) last.status = status;
        return messages;
      };
    }
    // 把真正发给模型的内容记下来（在所有「换掉 send」的分支之后包一层，包在最外层）
    const send = agent.send.bind(agent);
    agent.send = async (content) => {
      sentContents.push(content);
      return await send(content);
    };
    return agent;
  };

  const runner = new TransientRunner({
    scopes,
    createAgent,
    configManager: new ConfigManager(configPath),
  });

  return { dir, db, runner, scopes, agentCalls, sentContents, behaviour };
}

let harness: Harness;

beforeEach(async () => {
  harness = await setup();
});

afterEach(async () => {
  await harness.db.close();
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
    expect(result.subagents).toEqual([]);
    // 没有第二份「拼好的正文」之类的重复字段：结果只有这三样
    expect(Object.keys(result).sort()).toEqual(["message", "problem", "subagents"]);
  });

  it("过程中不落库：库里 0 行（对话 / 消息 / 通知 / 问题全都没有）", async () => {
    await harness.runner.run({ cwd: "/tmp/project", input: { content: "不留痕迹" } });

    const tables = ["conversations", "messages", "notices", "questions", "workspaces"];
    for (const table of tables) {
      const rows = await harness.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(rows[0]?.n, table).toBe(0);
    }
  });

  it("跑一轮就是一次 send，历史永远是空的（没有可续接的东西）", async () => {
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

describe("只借 Scope，与 Workspace 无关（D3）", () => {
  it("按 cwd 借、按同一个键还", async () => {
    await harness.runner.run({ cwd: "/tmp/project", input: { content: "x" } });
    expect(harness.scopes.acquired).toEqual([transientScopeKey("/tmp/project")]);
    expect(harness.scopes.released).toEqual([transientScopeKey("/tmp/project")]);
    expect(transientScopeKey("/tmp/project")).toBe("transient:/tmp/project");
    expect(cwdOfTransientScopeKey("transient:/tmp/project")).toBe("/tmp/project");
    expect(cwdOfTransientScopeKey("w1")).toBeNull();
  });

  it("不同目录借的是不同的 Scope", async () => {
    await harness.runner.run({ cwd: "/tmp/a", input: { content: "x" } });
    await harness.runner.run({ cwd: "/tmp/b", input: { content: "y" } });
    expect(harness.scopes.acquired).toEqual(["transient:/tmp/a", "transient:/tmp/b"]);
    expect(harness.scopes.released).toEqual(["transient:/tmp/a", "transient:/tmp/b"]);
  });

  it("跑挂了也要把 Scope 还回去", async () => {
    harness.behaviour.fail = new Error("端点 500");
    await expect(
      harness.runner.run({ cwd: "/tmp/project", input: { content: "x" } }),
    ).rejects.toMatchObject({ code: "internal" });
    expect(harness.scopes.released).toEqual([transientScopeKey("/tmp/project")]);
  });
});

describe("告诉模型「现在在哪个目录」（F-D9）", () => {
  it("cwd 作为注入段接在用户内容末尾", async () => {
    await harness.runner.run(
      { cwd: "/tmp/project", input: { content: "一句话回答我" } },
      "zh",
    );

    const content = harness.sentContents[0];
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content[0]).toEqual({ type: "text", text: "一句话回答我" });
    const injected = content.at(-1);
    expect(injected?.type).toBe("text");
    const text = injected && "text" in injected ? injected.text : "";
    expect(text).toContain("/tmp/project");
  });
});

describe("失败与结局的说明", () => {
  it("执行抛错：报 internal + 「这次一次性请求没跑完」那条文案", async () => {
    harness.behaviour.fail = new Error("端点 500");
    await expect(
      harness.runner.run({ cwd: "/tmp/project", input: { content: "x" } }),
    ).rejects.toMatchObject({
      code: "internal",
      messageKey: "error.transientFailed",
      detail: { reason: "端点 500" },
    });
  });

  it("跑完但结局是错误：消息照样带回来，problem 说明", async () => {
    harness.behaviour.status = AgentNS.MessageStatus.Error;
    const result = await harness.runner.run({
      cwd: "/tmp/project",
      input: { content: "x" },
    });
    expect(result.message.status).toBe(AgentNS.MessageStatus.Error);
    expect(result.problem?.messageKey).toBe("error.transientFailed");
    expect(result.problem?.code).toBe("transient.error");
  });

  it("cwd 为空按参数不对拒", async () => {
    await expect(harness.runner.run({ cwd: "   ", input: { content: "x" } })).rejects.toMatchObject({
      code: "invalid_params",
      detail: { field: "cwd" },
    });
    expect(harness.scopes.acquired).toEqual([]);
  });

  it("没点名助手、配置里也没有默认助手 → config_invalid（说不清用哪个）", async () => {
    const bare = await setup({});
    try {
      await expect(
        bare.runner.run({ cwd: "/tmp/project", input: { content: "x" } }),
      ).rejects.toMatchObject({ code: "config_invalid" });
      expect(bare.scopes.acquired).toEqual([]);
    } finally {
      await bare.db.close();
      await rm(bare.dir, { recursive: true, force: true });
    }
  });
});
