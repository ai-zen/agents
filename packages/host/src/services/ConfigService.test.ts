/**
 * 配置服务的验收（F-F1 / F-F2 / F-E2 / F-F7 / F-A8 / D21）。
 *
 * 覆盖：密钥掩码与「省略 apiKey 保留原值」、端点被引用时拒删并列出引用者、
 * 改动回报「应用了什么」（重载了什么、回收了哪些 Scope、合成的那条通知）、
 * 默认项的校验与清空、MCP 两个作用域的写入、配置问题的结构化报出。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { AgentRepository, ConfigManager } from "@ai-zen/agents-sdk";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_ASSETS_PER_MESSAGE, MAX_ASSET_BYTES } from "../wire/index.js";
import type { ConfigBehavior } from "../wire/index.js";
import {
  ConfigService,
  type ConfigApplyChange,
  type ConfigApplyOutcome,
  type ConfigApplyPort,
} from "./ConfigService.js";
import { maskSecret } from "./secretMask.js";

const WORKSPACE_ID = "ws-1";
const API_KEY = "sk-aaaaaaaabbbb1111";

let dataRoot: string;
let project: string;
let configManager: ConfigManager;
let applyPort: FakeApply;
let service: ConfigService;

/** 只记账、并回报「刷新了哪个项目的 Scope + 合成哪条通知」的假生效口 */
class FakeApply implements ConfigApplyPort {
  readonly changes: ConfigApplyChange[] = [];
  outcome: ConfigApplyOutcome = { refreshedWorkspaceIds: ["ws-1"], noticeId: "notice-1" };

  apply(change: ConfigApplyChange): ConfigApplyOutcome {
    this.changes.push(change);
    return this.outcome;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

async function readConfig(): Promise<AppConfig> {
  return JSON.parse(await readFile(join(dataRoot, "config.json"), "utf-8")) as AppConfig;
}

function baseConfig(): AppConfig {
  return {
    endpoints: [
      { id: "ep-a", name: "Endpoint A", baseUrl: "https://a.example/v1", apiKey: API_KEY },
      { id: "ep-empty", name: "Endpoint Empty", baseUrl: "https://e.example/v1", apiKey: "" },
    ],
    models: [
      {
        id: "m-a1",
        name: "Model A1",
        endpointId: "ep-a",
        tokenThresholds: { handoff: 100, guard: 150 },
      },
      {
        id: "m-ghost",
        name: "Model Ghost",
        endpointId: "ep-gone",
        tokenThresholds: { handoff: 200, guard: 150 },
      },
    ],
    imageModels: [{ id: "img-1", name: "Image One", endpointId: "ep-a", modelName: "img-one" }],
    defaultModel: "m-a1",
    defaultImageModel: "img-1",
    defaultMigrationModel: "m-gone",
    maxToolOutput: 4_096,
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ai-zen-config-"));
  project = join(dataRoot, "project");
  await mkdir(project, { recursive: true });
  await writeJson(join(dataRoot, "config.json"), baseConfig());
  await writeJson(join(dataRoot, "reasoning-presets.json"), {});

  const agent: AgentDefinition = {
    id: "default",
    name: "Default",
    messages: [{ id: "sys", role: AgentNS.Role.System, content: "hi" }],
    modelId: "m-a1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeJson(join(dataRoot, "agents", "default.json"), agent);

  configManager = new ConfigManager(join(dataRoot, "config.json"));
  applyPort = new FakeApply();
  service = new ConfigService({
    configManager,
    agents: new AgentRepository(join(dataRoot, "agents")),
    findWorkspace: (workspaceId) => (workspaceId === WORKSPACE_ID ? { cwd: project } : undefined),
    apply: applyPort,
    now: () => Date.parse("2026-03-03T00:00:00.000Z"),
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("ConfigService.get", () => {
  it("密钥读出即掩码，明文不出网（F-F2）", async () => {
    const { config } = await service.get();
    const endpoint = config.endpoints.find((item) => item.id === "ep-a");
    expect(endpoint?.apiKeyMasked).toBe(maskSecret(API_KEY));
    expect(endpoint?.apiKeySet).toBe(true);
    expect(maskSecret(API_KEY)).not.toContain("aaaaaaaab");
    // 整份出参里都没有明文
    expect(JSON.stringify(config)).not.toContain(API_KEY);

    const empty = config.endpoints.find((item) => item.id === "ep-empty");
    expect(empty?.apiKeyMasked).toBe("");
    expect(empty?.apiKeySet).toBe(false);
  });

  it("整份配置的形状：默认项、上限、行为开关、配置文件在哪", async () => {
    const { config } = await service.get();
    expect(config.configDir).toBe(dataRoot);
    expect(config.defaults).toEqual({
      defaultAgent: null,
      defaultModel: "m-a1",
      defaultMigrationModel: "m-gone",
      defaultImageModel: "img-1",
      namingModel: null,
      autoTitle: true,
      // 缺省语言没设置时读回 `null`（与「设成了 en」区分开）
      language: null,
    });
    expect(config.limits).toEqual({
      maxToolOutput: 4_096,
      maxAssetBytes: MAX_ASSET_BYTES,
      maxAssetsPerMessage: MAX_ASSETS_PER_MESSAGE,
    });
    // 没写就是运行时真正会用的那一档（SDK 迁移把中断策略补成出厂默认）
    expect(config.behavior).toEqual({
      abortedMessageStrategy: "keep",
      abortedToolRoundStrategy: "fill",
      autoRefreshTools: "inner-loop-start",
    });
    expect(config.models.map((model) => model.id)).toEqual(["m-a1", "m-ghost"]);
    expect(config.imageModels.map((model) => model.id)).toEqual(["img-1"]);
  });

  it("配错了要能当场修：问题指到具体字段（F-A8）", async () => {
    const { issues } = await service.get();
    const byCode = new Map(issues.map((issue) => [issue.code, issue]));

    expect(byCode.get("model_endpoint_missing")?.severity).toBe("error");
    expect(byCode.get("model_endpoint_missing")?.path).toBe("models[1].endpointId");
    expect(byCode.get("threshold_order")?.severity).toBe("warning");
    expect(byCode.get("threshold_order")?.path).toBe("models[1].tokenThresholds");
    expect(byCode.get("endpoint_no_key")?.path).toBe("endpoints[1].apiKey");
    expect(byCode.get("default_model_missing")?.path).toBe("defaultMigrationModel");

    // 默认助手还在，就没有那条警告
    expect(byCode.has("default_agent_missing")).toBe(false);
    await writeJson(join(dataRoot, "config.json"), { ...baseConfig(), defaultAgent: "default" });
    await rm(join(dataRoot, "agents", "default.json"));
    const withMissingAgent = await service.get();
    expect(
      withMissingAgent.issues.find((issue) => issue.code === "default_agent_missing")?.path,
    ).toBe("defaultAgent");
  });

  it("问题文案按结构化事实给出（哪一条、缺什么）", async () => {
    const { issues } = await service.get();
    const ghost = issues.find((issue) => issue.code === "model_endpoint_missing");
    expect(ghost?.text.messageKey).toBe("model.endpointMissing");
    expect(ghost?.text.params).toEqual({ model: "Model Ghost", id: "ep-gone" });
    expect(ghost?.text.message).toContain("Model Ghost");
  });
});

describe("ConfigService.saveEndpoint", () => {
  it("新建端点，密钥回掩码", async () => {
    const { endpoint, applied } = await service.saveEndpoint({
      endpoint: {
        id: "ep-new",
        name: "Endpoint New",
        baseUrl: "https://new.example/v1/",
        apiKey: "sk-newnewnew9999",
      },
    });
    expect(endpoint.baseUrl).toBe("https://new.example/v1");
    expect(endpoint.apiKeyMasked).toBe(maskSecret("sk-newnewnew9999"));
    expect(endpoint.apiKeySet).toBe(true);
    expect(applied.reloaded.config).toBe(true);
    expect((await readConfig()).endpoints.map((item) => item.id)).toContain("ep-new");
  });

  it("省略 apiKey = 保留原值（不能把掩码存回去）", async () => {
    await service.saveEndpoint({
      endpoint: { id: "ep-a", name: "Endpoint A2", baseUrl: "https://a.example/v1" },
    });
    const written = (await readConfig()).endpoints.find((item) => item.id === "ep-a");
    expect(written?.name).toBe("Endpoint A2");
    expect(written?.apiKey).toBe(API_KEY);

    // 客户端把读到的掩码原样写回来也一样
    await service.saveEndpoint({
      endpoint: {
        id: "ep-a",
        name: "Endpoint A3",
        baseUrl: "https://a.example/v1",
        apiKey: maskSecret(API_KEY),
      },
    });
    expect((await readConfig()).endpoints.find((item) => item.id === "ep-a")?.apiKey).toBe(API_KEY);
  });

  it("空串才把密钥清掉", async () => {
    const { endpoint } = await service.saveEndpoint({
      endpoint: { id: "ep-a", name: "Endpoint A", baseUrl: "https://a.example/v1", apiKey: "" },
    });
    expect(endpoint.apiKeySet).toBe(false);
    expect((await readConfig()).endpoints.find((item) => item.id === "ep-a")?.apiKey).toBe("");
  });

  it("地址不像 http(s) 就拒", async () => {
    await expect(
      service.saveEndpoint({
        endpoint: { id: "ep-x", name: "X", baseUrl: "ftp://x.example" },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("ConfigService.deleteEndpoint", () => {
  it("被模型引用时拒删并列出引用者（F-F2）", async () => {
    await expect(service.deleteEndpoint({ endpointId: "ep-a" })).rejects.toMatchObject({
      code: "config_invalid",
      detail: {
        endpointId: "ep-a",
        references: {
          referenced: true,
          items: [
            { kind: "model", id: "m-a1", name: "Model A1" },
            { kind: "image_model", id: "img-1", name: "Image One" },
          ],
        },
      },
    });
  });

  it("dryRun 只算引用，没引用就真删", async () => {
    const dry = await service.deleteEndpoint({ endpointId: "ep-empty", dryRun: true });
    expect(dry.removed).toBe(false);
    expect(dry.references.referenced).toBe(false);
    expect((await readConfig()).endpoints.map((item) => item.id)).toContain("ep-empty");

    const real = await service.deleteEndpoint({ endpointId: "ep-empty" });
    expect(real.removed).toBe(true);
    expect((await readConfig()).endpoints.map((item) => item.id)).toEqual(["ep-a"]);
  });
});

describe("ConfigService.patch / setDefaults", () => {
  it("改小设置并回报「应用了什么」（F-E2）", async () => {
    const { config, applied } = await service.patch({
      patch: {
        defaults: { namingModel: "m-a1", autoTitle: false },
        limits: { maxToolOutput: 8_192 },
        behavior: { autoRefreshTools: "off", abortedMessageStrategy: "keep" },
      },
    });

    expect(config.limits.maxToolOutput).toBe(8_192);
    expect(config.defaults.namingModel).toBe("m-a1");
    expect(config.defaults.autoTitle).toBe(false);
    expect(config.behavior.autoRefreshTools).toBe("off");
    expect(config.behavior.abortedMessageStrategy).toBe("keep");

    expect(applied.appliedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(applied.reloaded).toEqual({
      config: true,
      tools: true,
      skills: false,
      agents: false,
      mcp: false,
    });
    expect(applied.refreshedWorkspaceIds).toEqual(["ws-1"]);
    expect(applied.noticeId).toBe("notice-1");
    expect(applied.restartRequired).toBe(false);
    expect(applyPort.changes[0]?.sections).toEqual(["defaults", "limits", "behavior"]);

    const written = await readConfig();
    expect(written.maxToolOutput).toBe(8_192);
    expect(written.autoTitle).toBe(false);
  });

  it("空补丁不写盘，但仍回报一次「已是最新」", async () => {
    const { applied } = await service.patch({ patch: {} });
    expect(applied.reloaded.config).toBe(false);
    expect(applyPort.changes[0]?.sections).toEqual([]);
  });

  it("上限不是正整数、行为开关取值不认识都拒", async () => {
    await expect(
      service.patch({ patch: { limits: { maxToolOutput: 0 } } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    // 客户端可能传一个不认识的值进来：类型上拦不住，宿主要担
    await expect(
      service.patch({
        patch: { behavior: { autoRefreshTools: "always" as ConfigBehavior["autoRefreshTools"] } },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("默认项要落到实处：模型、图片模型、助手都要在（F-F7）", async () => {
    await expect(
      service.setDefaults({ defaults: { defaultModel: "m-gone" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      service.setDefaults({ defaults: { defaultImageModel: "img-gone" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      service.setDefaults({ defaults: { defaultAgent: "agent-gone" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("传 null 就是清空（不是「不改」）", async () => {
    const { config } = await service.setDefaults({
      defaults: { defaultModel: null, defaultImageModel: null },
    });
    expect(config.defaults.defaultModel).toBeNull();
    expect(config.defaults.defaultImageModel).toBeNull();
    const written = await readConfig();
    expect(written.defaultModel).toBeUndefined();
    expect(written.defaultImageModel).toBeUndefined();
  });

  it("默认助手设得上就写进去", async () => {
    const { config } = await service.setDefaults({ defaults: { defaultAgent: "default" } });
    expect(config.defaults.defaultAgent).toBe("default");
    expect((await readConfig()).defaultAgent).toBe("default");
  });

  it("缺省语言写得进，config.get 读得回（R58）", async () => {
    const written = await service.setDefaults({ defaults: { language: "zh" } });
    expect(written.config.defaults.language).toBe("zh");
    expect((await readConfig()).language).toBe("zh");

    // 走一遍读路径：`config.get` 的 `defaults` 里有它（不是只有写路径认识它）
    const { config } = await service.get();
    expect(config.defaults.language).toBe("zh");
  });

  it("缺省语言传 null 就是清掉，回落英文", async () => {
    await service.setDefaults({ defaults: { language: "zh" } });
    const { config } = await service.setDefaults({ defaults: { language: null } });
    expect(config.defaults.language).toBeNull();
    expect((await readConfig()).language).toBeUndefined();

    // 认不出来的语言直接驳，不悄悄换成英文
    await expect(
      service.setDefaults({ defaults: { language: "fr" as unknown as "zh" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("ConfigService.saveMcp / deleteMcp", () => {
  it("user 作用域写数据根下的 mcp.json；没给的 id 是新建", async () => {
    const { layer, applied } = await service.saveMcp({
      scope: "user",
      entry: { id: "pty", transport: "stdio", command: "npx", args: ["pty"] },
    });

    expect(layer.path).toBe(join(dataRoot, "mcp.json"));
    expect(layer.editable).toBe(true);
    expect(layer.scope).toBe("user");
    expect(layer.state).toBe("ok");
    expect(layer.entries.map((entry) => entry.id)).toEqual(["pty"]);
    expect(applied.reloaded.mcp).toBe(true);
    expect(applied.reloaded.tools).toBe(true);
    expect(applyPort.changes[0]).toMatchObject({ mcp: true, sections: ["mcp"], workspaceIds: [] });

    const written = JSON.parse(await readFile(join(dataRoot, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers)).toEqual(["pty"]);
  });

  it("同一个 id 再存一次是改那一条，层里别的条目不动", async () => {
    await writeJson(join(dataRoot, "mcp.json"), {
      mcpServers: {
        pty: { type: "stdio", command: "npx", "x-keep": true },
        other: { type: "http", url: "https://other.example" },
      },
    });

    const { layer } = await service.saveMcp({
      scope: "user",
      entry: { id: "pty", transport: "stdio", command: "npx", args: ["-y", "pty"] },
    });

    const written = JSON.parse(await readFile(join(dataRoot, "mcp.json"), "utf-8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(written.mcpServers.pty).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "pty"],
      "x-keep": true,
    });
    expect(written.mcpServers.other).toEqual({ type: "http", url: "https://other.example" });
    expect(layer.entries.map((entry) => entry.id).sort()).toEqual(["other", "pty"]);
  });

  it("deleteMcp 删掉那一条；本来就没有时 removed: false（不是失败）", async () => {
    await writeJson(join(dataRoot, "mcp.json"), {
      mcpServers: { pty: { type: "stdio", command: "npx" } },
    });

    const removed = await service.deleteMcp({ scope: "user", id: "pty" });
    expect(removed.removed).toBe(true);
    expect(removed.layer.entries).toEqual([]);
    expect(removed.applied.reloaded.mcp).toBe(true);

    const again = await service.deleteMcp({ scope: "user", id: "pty" });
    expect(again.removed).toBe(false);
    expect(again.layer.entries).toEqual([]);
  });

  it("workspace 作用域要落到项目里，所以必须给项目", async () => {
    await expect(
      service.saveMcp({ scope: "workspace", entry: { id: "local", transport: "stdio" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(service.deleteMcp({ scope: "workspace", id: "local" })).rejects.toMatchObject({
      code: "invalid_params",
    });

    const { layer, applied } = await service.saveMcp({
      scope: "workspace",
      workspaceId: WORKSPACE_ID,
      entry: { id: "local", transport: "http", url: "https://local.example" },
    });
    expect(layer.path).toBe(join(project, ".ai-zen", "mcp.json"));
    expect(layer.scope).toBe("workspace");
    expect(applied.reloaded.mcp).toBe(true);
    expect(applyPort.changes.at(-1)?.workspaceIds).toEqual([WORKSPACE_ID]);
  });

  it("项目不存在就拒", async () => {
    await expect(
      service.saveMcp({
        scope: "workspace",
        workspaceId: "ws-gone",
        entry: { id: "local", transport: "stdio" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.deleteMcp({ scope: "workspace", workspaceId: "ws-gone", id: "local" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
