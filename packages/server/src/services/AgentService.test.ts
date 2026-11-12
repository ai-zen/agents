/**
 * 助手服务的验收（F-B2 / F-B3 / F-B5 / F-B6 / F-B7 / F-F5 / F-G3）。
 *
 * 覆盖：一实体一文件（有 `function` 的落 `sub-agents/`）、不可用的助手也列出并说明原因、
 * 默认助手的回落、编辑即用户自有、改默认模型、思考档位展开成参数、
 * 删默认助手时连带清默认、删除前的引用清单。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigManager } from "@ai-zen/agents-sdk";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerError } from "../wire/errors.js";
import { AgentService } from "./AgentService.js";

let dataRoot: string;
let service: AgentService;
let clock: number;

const SYSTEM = [{ role: "system", content: "you are a test assistant" }];

/** 写一个 JSON 文件（顺带建目录） */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

/** 写一个原始文本文件（造坏文件用） */
async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
}

async function readConfig(): Promise<AppConfig> {
  return JSON.parse(await readFile(join(dataRoot, "config.json"), "utf-8")) as AppConfig;
}

/** 一份够用的配置：一个配好密钥的端点、一个没密钥的端点、三个模型 */
function baseConfig(): AppConfig {
  return {
    endpoints: [
      { id: "ep-a", name: "Endpoint A", baseUrl: "https://a.example/v1", apiKey: "sk-aaaaaaaa1111" },
      { id: "ep-b", name: "Endpoint B", baseUrl: "https://b.example/v1", apiKey: "" },
    ],
    models: [
      {
        id: "m-a1",
        name: "Model A1",
        endpointId: "ep-a",
        tokenThresholds: { handoff: 100, guard: 150 },
        reasoningPreset: "preset-a",
      },
      {
        id: "m-b1",
        name: "Model B1",
        endpointId: "ep-b",
        tokenThresholds: { handoff: 100, guard: 150 },
      },
      {
        id: "m-plain",
        name: "Model Plain",
        endpointId: "ep-a",
        tokenThresholds: { handoff: 100, guard: 150 },
      },
    ],
    defaultModel: "m-a1",
  };
}

/** 一条助手定义 */
function definition(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name: id,
    messages: SYSTEM as AgentDefinition["messages"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ai-zen-agents-"));
  await writeJson(join(dataRoot, "config.json"), baseConfig());
  await writeJson(join(dataRoot, "reasoning-presets.json"), {
    "preset-a": {
      levels: {
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" },
      },
    },
  });

  await writeJson(join(dataRoot, "agents", "default.json"), definition("default", { modelId: "m-a1" }));
  await writeJson(
    join(dataRoot, "agents", "writer.json"),
    definition("writer", { name: "Writer", modelId: "m-a2" }),
  );
  await writeJson(join(dataRoot, "agents", "broken.json"), {});
  await writeText(join(dataRoot, "agents", "broken.json"), "{ 这里坏掉了");
  await writeJson(
    join(dataRoot, "sub-agents", "sub-one.json"),
    definition("sub-one", {
      modelId: "m-a1",
      function: {
        name: "sub_fn",
        description: "does sub things",
        parameters: { type: "object", properties: {} },
      },
    }),
  );

  clock = Date.parse("2026-02-02T00:00:00.000Z");
  service = new AgentService({
    configManager: new ConfigManager(join(dataRoot, "config.json")),
    now: () => (clock += 1_000),
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("AgentService.list", () => {
  it("主助手与子 Agent 一起列，坏文件也占一行并说明原因（F-B5）", async () => {
    const { agents, defaultAgentId } = await service.list();
    expect(agents.map((agent) => agent.id)).toEqual([
      "broken",
      "default",
      "writer",
      "sub-one",
    ]);
    expect(agents.find((agent) => agent.id === "sub-one")?.isSubAgent).toBe(true);
    expect(agents.find((agent) => agent.id === "default")?.isSubAgent).toBe(false);

    const broken = agents.find((agent) => agent.id === "broken");
    expect(broken?.available).toBe(false);
    expect(broken?.unavailableReason?.messageKey).toBe("agent.fileBroken");

    // 配置里没写默认助手时回落到出厂的那一个（F-B3「为空时有回落」）
    expect(defaultAgentId).toBe("default");
  });

  it("模型没了 / 端点没密钥 / 没有可用模型，各有各的说法", async () => {
    await writeJson(join(dataRoot, "agents", "missing-model.json"), definition("missing-model", {
      modelId: "m-gone",
    }));
    await writeJson(join(dataRoot, "agents", "no-key.json"), definition("no-key", { modelId: "m-b1" }));

    const withKey = await service.list();
    const missingModel = withKey.agents.find((agent) => agent.id === "missing-model");
    expect(missingModel?.available).toBe(false);
    expect(missingModel?.unavailableReason?.messageKey).toBe("agent.modelMissing");

    const noKey = withKey.agents.find((agent) => agent.id === "no-key");
    expect(noKey?.available).toBe(false);
    expect(noKey?.unavailableReason?.messageKey).toBe("endpoint.noKey");

    // 没有兜底模型、助手自己也没绑时，就是「解析不出模型」
    await writeJson(join(dataRoot, "config.json"), { ...baseConfig(), defaultModel: undefined });
    await writeJson(join(dataRoot, "agents", "no-model.json"), definition("no-model"));
    const withoutDefault = await service.list();
    const noModel = withoutDefault.agents.find((agent) => agent.id === "no-model");
    expect(noModel?.available).toBe(false);
    expect(noModel?.unavailableReason?.messageKey).toBe("error.modelUnresolved");

    // 助手自己绑了模型就轮不到兜底层
    const bound = withoutDefault.agents.find((agent) => agent.id === "default");
    expect(bound?.available).toBe(true);
  });

  it("默认助手：配置里那个还在就用它，否则回落 default", async () => {
    await writeJson(join(dataRoot, "config.json"), { ...baseConfig(), defaultAgent: "writer" });
    expect((await service.list()).defaultAgentId).toBe("writer");

    await writeJson(join(dataRoot, "config.json"), { ...baseConfig(), defaultAgent: "gone" });
    expect((await service.list()).defaultAgentId).toBe("default");

    const { agents } = await service.list();
    expect(agents.find((agent) => agent.id === "default")?.isDefault).toBe(false);
  });
});

describe("AgentService.describe", () => {
  it("只回名字与可用性；定义没了、文件读不出来都回 null", async () => {
    await writeJson(
      join(dataRoot, "agents", "named.json"),
      definition("named", { name: "Named Assistant", modelId: "m-a1" }),
    );
    expect(await service.describe("named")).toEqual({
      agentId: "named",
      name: "Named Assistant",
      available: true,
    });

    // 模型不存在：名字照样有，只是不可用（F-B5 的口径）
    expect(await service.describe("writer")).toEqual({
      agentId: "writer",
      name: "Writer",
      available: false,
    });

    // 文件不在：助手已经被删（对话可能还记着那个 id，L7）
    expect(await service.describe("gone")).toBeNull();
    // 文件在但读不出来：同样没有可报的名字与可用性
    expect(await service.describe("broken")).toBeNull();
  });
});

describe("AgentService.create / update", () => {
  it("没有 function 的进 agents/，有 function 的进 sub-agents/", async () => {
    const plain = await service.create({
      agent: { id: "plain", name: "Plain", messages: SYSTEM as AgentDefinition["messages"] },
    });
    expect(plain.agent.isSubAgent).toBe(false);
    expect(plain.agent.custom).toBe(true);
    const inAgents = JSON.parse(
      await readFile(join(dataRoot, "agents", "plain.json"), "utf-8"),
    ) as AgentDefinition;
    expect(inAgents.name).toBe("Plain");

    const sub = await service.create({
      agent: {
        id: "sub-two",
        name: "Sub Two",
        messages: SYSTEM as AgentDefinition["messages"],
        function: {
          name: "sub_two_fn",
          description: "d",
          parameters: { type: "object", properties: {} },
        },
      },
    });
    expect(sub.agent.isSubAgent).toBe(true);
    const inSubAgents = JSON.parse(
      await readFile(join(dataRoot, "sub-agents", "sub-two.json"), "utf-8"),
    ) as AgentDefinition;
    expect(inSubAgents.function?.name).toBe("sub_two_fn");
  });

  it("id 重复、id 不像文件名、没有 system、模型不存在都拒", async () => {
    const runs: (() => Promise<unknown>)[] = [
      () => service.create({ agent: { id: "default", name: "dup", messages: SYSTEM as AgentDefinition["messages"] } }),
      () => service.create({ agent: { id: "../escape", name: "bad", messages: SYSTEM as AgentDefinition["messages"] } }),
      () => service.create({ agent: { id: "empty", name: "e", messages: [] } }),
      () =>
        service.create({
          agent: { id: "no-system", name: "n", messages: [{ role: "user", content: "hi" }] as AgentDefinition["messages"] },
        }),
      () =>
        service.create({
          agent: { id: "bad-model", name: "b", modelId: "m-gone", messages: SYSTEM as AgentDefinition["messages"] },
        }),
    ];
    for (const run of runs) {
      await expect(run()).rejects.toBeInstanceOf(ServerError);
    }
  });

  it("局部更新：改名、清模型绑定、算用户自有", async () => {
    const renamed = await service.update({ agentId: "writer", patch: { name: "Writer 2" } });
    expect(renamed.agent.name).toBe("Writer 2");
    expect(renamed.agent.custom).toBe(true);
    expect(renamed.agent.updatedAt).toBe(new Date(clock).toISOString());

    const cleared = await service.update({ agentId: "writer", patch: { modelId: "" } });
    expect(cleared.agent.modelId).toBeNull();
    // 绑定的模型清掉之后走配置里的兜底模型
    expect(cleared.agent.thinking.levels).toEqual(["low", "high"]);
  });

  it("坏文件读不出内容，改它就报 config_invalid", async () => {
    await expect(service.update({ agentId: "broken", patch: { name: "x" } })).rejects.toMatchObject({
      code: "config_invalid",
      messageKey: "agent.fileBroken",
    });
  });
});

describe("AgentService.delete", () => {
  it("删默认助手时连带清默认（F-F5）", async () => {
    await writeJson(join(dataRoot, "config.json"), { ...baseConfig(), defaultAgent: "default" });

    const result = await service.delete({ agentId: "default" });
    expect(result.removed).toBe(true);
    expect(result.defaultsCleared).toBe(true);
    expect(result.references.items).toEqual([
      { kind: "default", id: "defaultAgent", name: "default" },
    ]);
    expect((await readConfig()).defaultAgent).toBeUndefined();
    expect((await service.list()).agents.map((agent) => agent.id)).not.toContain("default");
  });

  it("dryRun 只算「还有谁指它」", async () => {
    await writeJson(
      join(dataRoot, "agents", "delegator.json"),
      definition("delegator", {
        modelId: "m-a1",
        permissions: { subagents: { allow: ["sub_fn"] } },
      }),
    );

    const result = await service.delete({ agentId: "sub-one", dryRun: true });
    expect(result.removed).toBe(false);
    expect(result.references.referenced).toBe(true);
    expect(result.references.items).toEqual([
      { kind: "agent", id: "delegator", name: "delegator" },
    ]);
    expect((await service.list()).agents.map((agent) => agent.id)).toContain("sub-one");
  });
});

describe("AgentService.setModel / setThinking", () => {
  it("改默认模型：只认存在的模型", async () => {
    const { agent } = await service.setModel({ agentId: "writer", modelId: "m-plain" });
    expect(agent.modelId).toBe("m-plain");
    expect(agent.available).toBe(true);

    await expect(service.setModel({ agentId: "writer", modelId: "m-gone" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("思考档位展开成参数写进定义（F-B6）", async () => {
    const { agent, thinking } = await service.setThinking({ agentId: "default", level: "high" });
    expect(thinking.selected).toBe("high");
    expect(thinking.source).toBe("manual");
    expect(thinking.params).toEqual({ reasoning_effort: "high" });
    expect(agent.modelParams).toEqual({ reasoning_effort: "high" });

    const written = JSON.parse(
      await readFile(join(dataRoot, "agents", "default.json"), "utf-8"),
    ) as AgentDefinition;
    expect(written.modelParams).toEqual({ reasoning_effort: "high" });
  });

  it("换模型时清掉定义上「旧模型档位带来的那些参数」（其它参数不动）", async () => {
    await writeJson(
      join(dataRoot, "agents", "tuned.json"),
      definition("tuned", {
        modelId: "m-a1",
        modelParams: { reasoning_effort: "high", temperature: 0.2 },
      }),
    );

    // m-a1 → m-plain（后者没有思考策略表）：旧档位那个键跟着走就是错的
    const { agent } = await service.setModel({ agentId: "tuned", modelId: "m-plain" });
    expect(agent.modelId).toBe("m-plain");
    expect(agent.modelParams).toEqual({ temperature: 0.2 });

    const written = JSON.parse(
      await readFile(join(dataRoot, "agents", "tuned.json"), "utf-8"),
    ) as AgentDefinition;
    expect(written.modelParams).toEqual({ temperature: 0.2 });
  });

  it("换成同一个模型时参数一个字都不动", async () => {
    await writeJson(
      join(dataRoot, "agents", "same.json"),
      definition("same", { modelId: "m-a1", modelParams: { reasoning_effort: "high" } }),
    );

    const { agent } = await service.setModel({ agentId: "same", modelId: "m-a1" });
    expect(agent.modelParams).toEqual({ reasoning_effort: "high" });
    expect(agent.thinking).toMatchObject({ selected: "high", source: "manual" });
  });

  it("档位不认识、模型不可调，都拒", async () => {
    await expect(
      service.setThinking({ agentId: "default", level: "ultra" }),
    ).rejects.toMatchObject({ code: "invalid_params" });

    await service.setModel({ agentId: "writer", modelId: "m-plain" });
    await expect(
      service.setThinking({ agentId: "writer", level: "high" }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("定义上的参数正好是一档时，状态是 manual；没有就是跟随默认", async () => {
    await writeJson(
      join(dataRoot, "agents", "low.json"),
      definition("low", { modelId: "m-a1", modelParams: { reasoning_effort: "low" } }),
    );
    await writeJson(join(dataRoot, "agents", "plain-params.json"), definition("plain-params", {
      modelId: "m-a1",
      modelParams: { temperature: 0.2 },
    }));

    const { agents } = await service.list();
    const low = agents.find((agent) => agent.id === "low");
    expect(low?.thinking).toMatchObject({ selected: "low", source: "manual" });

    const plainParams = agents.find((agent) => agent.id === "plain-params");
    expect(plainParams?.thinking).toMatchObject({
      selected: null,
      source: "following_default",
    });
  });
});
