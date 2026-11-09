/**
 * Agent 处理器 —— 两种粒度一起测：`agent.model.set`（改一个字段）与
 * `agent.list/get/save/remove`（整份定义）。
 *
 * 直接调方法表（理由同 `configHandlers.test.ts`）：要钉的是「校验 + 转调」，
 * 帧与连接已由 `Daemon.test.ts` 覆盖。落盘用真的临时目录，不 mock `fs`。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "@ai-zen/agents-sdk";
import type { Connection, MethodHandler } from "./Daemon.js";
import { createAgentHandlers } from "./agentHandlers.js";
import { ConfigService } from "../service/config/ConfigService.js";
import { AGENT_METHODS } from "../protocol/sessions.js";
import { AGENT_ADMIN_METHODS } from "../protocol/config.js";

let root: string;
let handlers: Record<string, MethodHandler>;
/** `setModel` 的调用记录：证明它仍然是原来那条路（写 Agent 定义交给装配层） */
let setModelCalls: Array<{ agentId: string; modelId: string }>;

const connection: Connection = {
  id: 1,
  send: () => {},
  close: () => {},
  onClose: () => () => {},
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aiz-agent-handlers-"));
  setModelCalls = [];
  const config = new ConfigService({
    configFile: join(root, "config.json"),
    agentsDir: join(root, "agents"),
    subAgentsDir: join(root, "sub-agents"),
    globalMcpFile: join(root, "mcp.json"),
    workspacesRoot: join(root, "workspaces"),
  });
  handlers = createAgentHandlers({
    config,
    factory: {
      setModel: async (input) => {
        setModelCalls.push(input);
        return { agentId: input.agentId, modelId: input.modelId };
      },
    },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function call(method: string, params?: unknown): Promise<unknown> {
  const handler = handlers[method];
  expect(handler, `method not registered: ${method}`).toBeTypeOf("function");
  return await handler(params, connection);
}

/**
 * 一份能落盘的 Agent 定义（`id` 决定文件名）。
 *
 * 末尾的断言只为省掉一个依赖：`role` 在 core 里是 string enum，本包不直接依赖 core，
 * 所以这里造一个**形状**正确的对象（落盘层不校验、也不该校验 SDK 的枚举）。
 */
function definition(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    messages: [{ id: `${id}-m1`, role: "system", content: "你是助手" }],
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...extra,
  } as unknown as AgentDefinition;
}

describe("agent.model.set（原有方法，语义不变）", () => {
  it("转交给装配层，参数原样", async () => {
    await expect(call(AGENT_METHODS.setModel, { agentId: "default", modelId: "glm-5.3" })).resolves
      .toEqual({ agentId: "default", modelId: "glm-5.3" });
    expect(setModelCalls).toEqual([{ agentId: "default", modelId: "glm-5.3" }]);
  });

  it("缺 agentId / modelId → bad-params", async () => {
    await expect(call(AGENT_METHODS.setModel, { agentId: "default" })).rejects.toMatchObject({
      code: "bad-params",
    });
    expect(setModelCalls).toEqual([]);
  });
});

describe("agent.list / agent.get", () => {
  it("list 两路分开给", async () => {
    await call(AGENT_ADMIN_METHODS.save, { kind: "agent", definition: definition("a") });
    await call(AGENT_ADMIN_METHODS.save, { kind: "subagent", definition: definition("x") });

    const result = (await call(AGENT_ADMIN_METHODS.list)) as {
      agents: AgentDefinition[];
      subAgents: AgentDefinition[];
    };
    expect(result.agents.map((item) => item.id)).toEqual(["a"]);
    expect(result.subAgents.map((item) => item.id)).toEqual(["x"]);
  });

  it("get 命中回定义，没命中回 null（不是错误）", async () => {
    await call(AGENT_ADMIN_METHODS.save, { kind: "agent", definition: definition("a") });

    const found = (await call(AGENT_ADMIN_METHODS.get, { id: "a" })) as {
      agent: AgentDefinition | null;
    };
    expect(found.agent?.name).toBe("a");

    await expect(call(AGENT_ADMIN_METHODS.get, { id: "ghost" })).resolves.toEqual({ agent: null });
  });

  it("get 缺 id → bad-params", async () => {
    await expect(call(AGENT_ADMIN_METHODS.get, {})).rejects.toMatchObject({ code: "bad-params" });
  });
});

/**
 * `agent.get` 的 `kind`（查哪个池子）。
 *
 * 这一组是回归保护：同名 id 在两个目录里是常态（出厂两栏各一个 `default`），而早版
 * `agent.get` 只收 `id` —— 客户端两栏界面点中子 Agent 的 `default`，拿到的是顶层那份。
 */
describe("agent.get 的 kind（区分顶层 Agent / 子 Agent）", () => {
  beforeEach(async () => {
    await call(AGENT_ADMIN_METHODS.save, {
      kind: "agent",
      definition: definition("default", { name: "顶层" }),
    });
    await call(AGENT_ADMIN_METHODS.save, {
      kind: "subagent",
      definition: definition("default", { name: "子里的 default" }),
    });
    await call(AGENT_ADMIN_METHODS.save, {
      kind: "subagent",
      definition: definition("helper", { name: "帮手" }),
    });
  });

  it("不指定 kind：同名时拿到顶层那份", async () => {
    const result = (await call(AGENT_ADMIN_METHODS.get, { id: "default" })) as {
      agent: AgentDefinition | null;
    };
    expect(result.agent?.name).toBe("顶层");
  });

  it("kind: subagent → 子 Agent 那份（不被顶层抢走）", async () => {
    const result = (await call(AGENT_ADMIN_METHODS.get, {
      id: "default",
      kind: "subagent",
    })) as { agent: AgentDefinition | null };
    expect(result.agent?.name).toBe("子里的 default");
  });

  it("kind: agent → 顶层那份", async () => {
    const result = (await call(AGENT_ADMIN_METHODS.get, {
      id: "default",
      kind: "agent",
    })) as { agent: AgentDefinition | null };
    expect(result.agent?.name).toBe("顶层");
  });

  it("只有子 Agent 有该 id、不指定 kind：拿到子 Agent 那份", async () => {
    const result = (await call(AGENT_ADMIN_METHODS.get, { id: "helper" })) as {
      agent: AgentDefinition | null;
    };
    expect(result.agent?.name).toBe("帮手");
  });

  it("非法 kind → bad-params，不静默退化成顶层优先", async () => {
    // 拼错/大小写/空串都是客户端 bug，当场报：“数据错乱”比“参数错”难查得多
    for (const kind of ["sub-agent", "Agent", "agents", ""]) {
      await expect(call(AGENT_ADMIN_METHODS.get, { id: "default", kind })).rejects.toMatchObject({
        code: "bad-params",
      });
    }
    // `null` 也不算“没给”：客户端给了个说不清的值
    await expect(
      call(AGENT_ADMIN_METHODS.get, { id: "default", kind: null }),
    ).rejects.toMatchObject({ code: "bad-params" });
  });
});

describe("agent.save / agent.remove", () => {
  it("save 按 kind 落到对应目录", async () => {
    await call(AGENT_ADMIN_METHODS.save, {
      kind: "subagent",
      definition: definition("helper", { name: "帮手" }),
    });

    const onDisk = JSON.parse(readFileSync(join(root, "sub-agents", "helper.json"), "utf-8"));
    expect(onDisk.name).toBe("帮手");
    expect(() => statSync(join(root, "agents", "helper.json"))).toThrow();
  });

  it("save 的 kind 只认两个取值、definition 必须有 id", async () => {
    await expect(
      call(AGENT_ADMIN_METHODS.save, { kind: "agent", definition: { name: "无 id" } }),
    ).rejects.toMatchObject({ code: "bad-params" });
    await expect(call(AGENT_ADMIN_METHODS.save, { kind: "agent" })).rejects.toMatchObject({
      code: "bad-params",
    });
    await expect(
      call(AGENT_ADMIN_METHODS.save, { kind: "sub-agent", definition: definition("a") }),
    ).rejects.toMatchObject({ code: "bad-params" });
    await expect(
      call(AGENT_ADMIN_METHODS.save, { kind: "agent", definition: [definition("a")] }),
    ).rejects.toMatchObject({ code: "bad-params" });
  });

  it("remove：删得掉回 true，删不存在回 false", async () => {
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "gone.json"), JSON.stringify(definition("gone")), "utf-8");

    await expect(call(AGENT_ADMIN_METHODS.remove, { kind: "agent", id: "gone" })).resolves.toEqual({
      removed: true,
    });
    expect(() => statSync(join(root, "agents", "gone.json"))).toThrow();
    await expect(call(AGENT_ADMIN_METHODS.remove, { kind: "agent", id: "gone" })).resolves.toEqual({
      removed: false,
    });
  });

  it("remove 缺 kind / id → bad-params", async () => {
    await expect(call(AGENT_ADMIN_METHODS.remove, { id: "a" })).rejects.toMatchObject({
      code: "bad-params",
    });
    await expect(call(AGENT_ADMIN_METHODS.remove, { kind: "agent" })).rejects.toMatchObject({
      code: "bad-params",
    });
  });
});
