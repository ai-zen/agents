/**
 * `agent.*` 接线壳的验收：方法齐、参数转发、出参里的原因按连接语言渲染（D8）。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { ConfigManager, DEFAULT_AGENT_DEFINITION } from "@ai-zen/agents-sdk";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Language } from "../i18n/index.js";
import type { MethodCallContext } from "../net/WsHub.js";
import { AgentService } from "../services/AgentService.js";
import type { MethodName } from "../wire/index.js";
import { createAgentHandlers } from "./agentHandlers.js";

let dataRoot: string;
let handlers: ReturnType<typeof createAgentHandlers>;

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

function call<M extends MethodName>(
  method: M,
  params: unknown,
  language: Language = "en",
): MethodCallContext<M> {
  return {
    method,
    params: params as MethodCallContext<M>["params"],
    connection: { id: "conn-1", language, clientInfo: null, credentialId: null },
  };
}

/** 一个端点没密钥的配置：助手因此不可用，正好用来看「原因」的渲染 */
function config(): AppConfig {
  return {
    endpoints: [{ id: "ep-b", name: "Endpoint B", baseUrl: "https://b.example/v1", apiKey: "" }],
    models: [
      {
        id: "m-b1",
        name: "Model B1",
        endpointId: "ep-b",
        tokenThresholds: { handoff: 100, guard: 150 },
      },
    ],
    defaultModel: "m-b1",
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ai-zen-agent-handlers-"));
  await writeJson(join(dataRoot, "config.json"), config());
  await writeJson(join(dataRoot, "reasoning-presets.json"), {});
  const agent: AgentDefinition = {
    id: "default",
    name: "Default",
    messages: [{ id: "sys", role: AgentNS.Role.System, content: "hi" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeJson(join(dataRoot, "agents", "default.json"), agent);

  handlers = createAgentHandlers({
    agents: new AgentService({ configManager: new ConfigManager(join(dataRoot, "config.json")) }),
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("createAgentHandlers", () => {
  it("八个方法都注册上了（含 F-F5 的 agent.restoreFactory）", () => {
    expect(Object.keys(handlers).sort()).toEqual([
      "agent.create",
      "agent.delete",
      "agent.get",
      "agent.list",
      "agent.restoreFactory",
      "agent.setModel",
      "agent.setThinking",
      "agent.update",
    ]);
  });

  it("agent.list 的不可用原因按连接语言渲染", async () => {
    const en = await handlers["agent.list"]!(call("agent.list", {}, "en"));
    const zh = await handlers["agent.list"]!(call("agent.list", {}, "zh"));

    const enReason = en.agents[0]?.unavailableReason;
    const zhReason = zh.agents[0]?.unavailableReason;
    expect(enReason?.messageKey).toBe("endpoint.noKey");
    expect(enReason?.message).toContain("no access key");
    expect(zhReason?.message).toContain("密钥");
    // 结构化事实两边一致
    expect(zhReason?.params).toEqual(enReason?.params);
  });

  it("create / get / update / setModel / setThinking / delete 转发", async () => {
    const created = await handlers["agent.create"]!(
      call("agent.create", {
        agent: { id: "writer", name: "Writer", messages: [{ role: "system", content: "hi" }] },
      }),
    );
    expect(created.agent.id).toBe("writer");

    const got = await handlers["agent.get"]!(call("agent.get", { agentId: "writer" }));
    expect(got.agent.name).toBe("Writer");

    const updated = await handlers["agent.update"]!(
      call("agent.update", { agentId: "writer", patch: { name: "Writer 2" } }),
    );
    expect(updated.agent.name).toBe("Writer 2");

    const bound = await handlers["agent.setModel"]!(
      call("agent.setModel", { agentId: "writer", modelId: "m-b1" }),
    );
    expect(bound.agent.modelId).toBe("m-b1");

    // 这个模型没有思考策略：服务层拒，接线壳原样把错误抛出去
    await expect(
      Promise.resolve(
        handlers["agent.setThinking"]!(
          call("agent.setThinking", { agentId: "writer", level: "high" }),
        ),
      ),
    ).rejects.toMatchObject({ code: "unsupported" });

    const removed = await handlers["agent.delete"]!(call("agent.delete", { agentId: "writer" }));
    expect(removed.removed).toBe(true);
  });
});

/** 出厂默认助手那一份（时间戳是实例化时补的，SDK 常量里没有） */
function factoryDefault(): AgentDefinition {
  return {
    ...DEFAULT_AGENT_DEFINITION,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("agent.restoreFactory（F-F5：与 model.restoreFactory 同形，可先预演）", () => {
  it("dryRun 只算出恢复之后会是什么样，一个字都不落盘", async () => {
    const path = join(dataRoot, "agents", "default.json");
    const before = await readFile(path, "utf-8");

    const preview = await handlers["agent.restoreFactory"]!(
      call("agent.restoreFactory", { agentId: "default", dryRun: true }),
    );
    // 预演给出的就是恢复之后的那一份：名字与提示词都回到出厂定义
    expect(preview.restored).toBe(true);
    expect(preview.agent.name).toBe(DEFAULT_AGENT_DEFINITION.name);
    expect(preview.agent.messages).toEqual(DEFAULT_AGENT_DEFINITION.messages);
    expect(preview.agent.custom).toBe(false);

    // 文件字节不变
    expect(await readFile(path, "utf-8")).toBe(before);
    // 再读一次定义，还是恢复之前那份（没有顺手写进去）
    const still = await handlers["agent.get"]!(call("agent.get", { agentId: "default" }));
    expect(still.agent.name).toBe("Default");
    expect(still.agent.modelParams).toEqual({});
  });

  it("本来就在出厂状态的助手回 restored: false，这不是错误", async () => {
    const path = join(dataRoot, "agents", "default.json");
    await writeJson(path, factoryDefault());
    const before = await readFile(path, "utf-8");

    const result = await handlers["agent.restoreFactory"]!(
      call("agent.restoreFactory", { agentId: "default" }),
    );

    // 没有可恢复的改动：如实回 false，不是失败（没有抛错、也没写空动作）
    expect(result.restored).toBe(false);
    expect(result.agent.name).toBe(DEFAULT_AGENT_DEFINITION.name);
    expect(result.agent.custom).toBe(false);
    expect(await readFile(path, "utf-8")).toBe(before);
  });

  it("改过的助手恢复后，agent.get 读回来的就是出厂定义（提示词 / 模型 / 权限都回退）", async () => {
    const modified: AgentDefinition = {
      ...factoryDefault(),
      name: "我的助手",
      modelId: "m-b1",
      modelParams: { reasoning_effort: "high" },
      permissions: { tools: { deny: ["*"] } },
      messages: [{ id: "mine", role: AgentNS.Role.System, content: "you are mine" }],
      custom: true,
    };
    await writeJson(join(dataRoot, "agents", "default.json"), modified);

    const result = await handlers["agent.restoreFactory"]!(
      call("agent.restoreFactory", { agentId: "default" }),
    );
    expect(result.restored).toBe(true);

    const back = await handlers["agent.get"]!(call("agent.get", { agentId: "default" }));
    expect(back.agent.name).toBe(DEFAULT_AGENT_DEFINITION.name);
    expect(back.agent.description).toBe(DEFAULT_AGENT_DEFINITION.description);
    expect(back.agent.messages).toEqual(DEFAULT_AGENT_DEFINITION.messages);
    expect(back.agent.modelId).toBe(DEFAULT_AGENT_DEFINITION.modelId);
    expect(back.agent.modelParams).toEqual({});
    expect(back.agent.permissions).toEqual(DEFAULT_AGENT_DEFINITION.permissions);
    // 恢复之后重新归 SDK 托管（下次初始化跟着出厂定义同步提示词）
    expect(back.agent.custom).toBe(false);
  });

  it("用户自建的助手不在出厂清单里：按现有错误码拒，文案按连接语言渲染", async () => {
    await handlers["agent.create"]!(
      call("agent.create", {
        agent: { id: "mine", name: "Mine", messages: [{ role: "system", content: "hi" }] },
      }),
    );

    const rejecting = handlers["agent.restoreFactory"]!(
      call("agent.restoreFactory", { agentId: "mine" }, "zh"),
    );
    await expect(rejecting).rejects.toMatchObject({
      code: "invalid_params",
      messageKey: "agent.notFactory",
    });
    // 定义还在（拒不是删）
    const still = await handlers["agent.get"]!(call("agent.get", { agentId: "mine" }));
    expect(still.agent.name).toBe("Mine");
  });
});
