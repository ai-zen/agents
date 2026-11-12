/**
 * `agent.*` 接线壳的验收：方法齐、参数转发、出参里的原因按连接语言渲染（D8）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { ConfigManager } from "@ai-zen/agents-sdk";
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
  it("七个方法都注册上了", () => {
    expect(Object.keys(handlers).sort()).toEqual([
      "agent.create",
      "agent.delete",
      "agent.get",
      "agent.list",
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
        handlers["agent.setThinking"]!(call("agent.setThinking", { agentId: "writer", level: "high" })),
      ),
    ).rejects.toMatchObject({ code: "unsupported" });

    const removed = await handlers["agent.delete"]!(
      call("agent.delete", { agentId: "writer" }),
    );
    expect(removed.removed).toBe(true);
  });
});
