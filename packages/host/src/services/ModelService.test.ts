/**
 * 模型服务的验收（F-F3 / F-F4 / F-F7 / D6 / D27）。
 *
 * 覆盖：出厂托管与自定义的标记、可用性与原因、思考档位来自策略表、编辑即转自定义、
 * 恢复出厂是整条替换、删模型时被引用要拒并列出引用者、默认项跟着改指或清空、图片模型与默认图片模型。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AgentRepository, ConfigManager } from "@ai-zen/agents-sdk";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostError } from "../wire/errors.js";
import { ModelService } from "./ModelService.js";

let dataRoot: string;
let configManager: ConfigManager;
let service: ModelService;

/** 写一个 JSON 文件（顺带建目录） */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

/** 读回磁盘上的配置（断言「真的写进去了」用它） */
async function readConfig(): Promise<AppConfig> {
  return JSON.parse(await readFile(join(dataRoot, "config.json"), "utf-8")) as AppConfig;
}

/** 一份用来做断言的配置：两个可用端点、一个没密钥的端点、一个指向不存在端点的模型 */
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
        vision: true,
      },
      {
        id: "m-a2",
        name: "Model A2",
        endpointId: "ep-a",
        tokenThresholds: { handoff: 100, guard: 150 },
      },
      {
        id: "m-b1",
        name: "Model B1",
        endpointId: "ep-b",
        tokenThresholds: { handoff: 100, guard: 150 },
      },
      {
        id: "m-ghost",
        name: "Model Ghost",
        endpointId: "ep-gone",
        tokenThresholds: { handoff: 10, guard: 20 },
      },
    ],
    imageModels: [{ id: "img-1", name: "Image One", endpointId: "ep-a", modelName: "img-one" }],
    defaultModel: "m-a1",
    defaultMigrationModel: "m-a2",
    defaultImageModel: "img-1",
    namingModel: "m-b1",
  };
}

/** 一个绑在某个模型上的助手定义 */
function agentDefinition(id: string, modelId: string): AgentDefinition {
  return {
    id,
    name: id,
    messages: [{ role: "system", content: "you are a test" } as AgentDefinition["messages"][number]],
    modelId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ai-zen-models-"));
  await writeJson(join(dataRoot, "config.json"), baseConfig());
  await writeJson(join(dataRoot, "reasoning-presets.json"), {
    "preset-a": {
      levels: {
        low: { reasoning_effort: "low" },
        high: { reasoning_effort: "high" },
      },
    },
  });
  await writeJson(join(dataRoot, "agents", "writer.json"), agentDefinition("writer", "m-a2"));

  configManager = new ConfigManager(join(dataRoot, "config.json"));
  service = new ModelService({
    configManager,
    agents: new AgentRepository(join(dataRoot, "agents")),
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("ModelService.list", () => {
  it("出厂托管与自定义分开、思考档位来自策略表", async () => {
    const { models } = await service.list();
    expect(models.map((model) => model.id)).toEqual(["m-a1", "m-a2", "m-b1", "m-ghost"]);

    const a1 = models.find((model) => model.id === "m-a1");
    expect(a1?.custom).toBe(false);
    expect(a1?.available).toBe(true);
    expect(a1?.unavailableReason).toBeNull();
    expect(a1?.thinkingLevels).toEqual(["low", "high"]);
    expect(a1?.reasoningPreset).toBe("preset-a");
    expect(a1?.vision).toBe(true);
    expect(a1?.tokenThresholds).toEqual({ handoff: 100, guard: 150 });

    const a2 = models.find((model) => model.id === "m-a2");
    expect(a2?.thinkingLevels).toEqual([]);
    expect(a2?.vision).toBe(false);
  });

  it("用不了的模型也列出来，并说明为什么（F-B5）", async () => {
    const { models } = await service.list();
    const noKey = models.find((model) => model.id === "m-b1");
    expect(noKey?.available).toBe(false);
    expect(noKey?.unavailableReason?.messageKey).toBe("endpoint.noKey");
    expect(noKey?.unavailableReason?.params.endpoint).toBe("Endpoint B");

    const ghost = models.find((model) => model.id === "m-ghost");
    expect(ghost?.available).toBe(false);
    expect(ghost?.unavailableReason?.messageKey).toBe("model.endpointMissing");
  });

  it("includeUnavailable: false 只要能用的", async () => {
    const { models } = await service.list({ includeUnavailable: false });
    expect(models.map((model) => model.id)).toEqual(["m-a1", "m-a2"]);
  });

  it("图片模型与默认图片模型（F-F4）", async () => {
    const result = await service.listImages();
    expect(result.defaultImageModel).toBe("img-1");
    expect(result.imageModels).toEqual([
      {
        id: "img-1",
        name: "Image One",
        endpointId: "ep-a",
        modelName: "img-one",
        description: null,
        defaultSize: null,
        defaultQuality: null,
        custom: false,
      },
    ]);
  });
});

describe("ModelService.create / update", () => {
  it("新建出来就是自定义", async () => {
    const { model } = await service.create({
      model: {
        id: "m-new",
        name: "New Model",
        endpointId: "ep-a",
        tokenThresholds: { handoff: 10, guard: 20 },
      },
    });
    expect(model.custom).toBe(true);
    expect(model.available).toBe(true);
    const written = await readConfig();
    expect(written.models.map((item) => item.id)).toContain("m-new");
    expect(written.models.find((item) => item.id === "m-new")?.custom).toBe(true);
  });

  it("id 重复、端点不存在、阈值颠倒、策略名不认识都拒", async () => {
    const cases: (() => Promise<unknown>)[] = [
      () =>
        service.create({
          model: {
            id: "m-a1",
            name: "dup",
            endpointId: "ep-a",
            tokenThresholds: { handoff: 10, guard: 20 },
          },
        }),
      () =>
        service.create({
          model: {
            id: "m-x",
            name: "x",
            endpointId: "ep-nope",
            tokenThresholds: { handoff: 10, guard: 20 },
          },
        }),
      () =>
        service.create({
          model: {
            id: "m-y",
            name: "y",
            endpointId: "ep-a",
            tokenThresholds: { handoff: 30, guard: 20 },
          },
        }),
      () =>
        service.create({
          model: {
            id: "m-z",
            name: "z",
            endpointId: "ep-a",
            tokenThresholds: { handoff: 10, guard: 20 },
            reasoningPreset: "preset-unknown",
          },
        }),
    ];
    for (const run of cases) {
      await expect(run()).rejects.toBeInstanceOf(HostError);
    }
  });

  it("编辑即转自定义（否则下轮初始化会被出厂定义冲回去）", async () => {
    const { model } = await service.update({ modelId: "m-a2", patch: { name: "Renamed" } });
    expect(model.name).toBe("Renamed");
    expect(model.custom).toBe(true);
    expect((await readConfig()).models.find((item) => item.id === "m-a2")?.custom).toBe(true);
  });

  it("改不存在的模型是 not_found", async () => {
    await expect(service.update({ modelId: "nope", patch: {} })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("ModelService.restoreFactory", () => {
  it("整条替换回出厂定义，并重新归 SDK 托管", async () => {
    // 先拿一个出厂 id 造一个「用户改过的」模型
    await writeJson(join(dataRoot, "config.json"), {
      ...baseConfig(),
      models: [
        ...baseConfig().models,
        {
          id: "deepseek-flash",
          name: "我的改名",
          endpointId: "ep-a",
          tokenThresholds: { handoff: 1, guard: 2 },
          custom: true,
        },
      ],
    });

    const { model } = await service.restoreFactory({ modelId: "deepseek-flash" });
    expect(model.name).toBe("DeepSeek-V4.1-Flash");
    expect(model.tokenThresholds).toEqual({ handoff: 250_000, guard: 375_000 });
    expect(model.custom).toBe(false);

    const written = (await readConfig()).models.find((item) => item.id === "deepseek-flash");
    expect(written?.name).toBe("DeepSeek-V4.1-Flash");
    expect(written?.custom).toBeUndefined();
    expect(written?.endpointId).toBe("deepseek");
  });

  it("出厂清单里没有的模型没有可恢复的版本", async () => {
    await expect(service.restoreFactory({ modelId: "m-a1" })).rejects.toMatchObject({
      code: "invalid_params",
      messageKey: "error.notFactoryModel",
    });
  });
});

describe("ModelService.delete", () => {
  it("被助手引用时拒删并列出引用者", async () => {
    await expect(service.delete({ modelId: "m-a2" })).rejects.toMatchObject({
      code: "config_invalid",
      detail: {
        references: {
          referenced: true,
          items: [{ kind: "agent", id: "writer", name: "writer" }],
        },
      },
    });
    // 拒了就不能真删
    expect((await readConfig()).models.map((item) => item.id)).toContain("m-a2");
  });

  it("dryRun 只算引用、不动配置", async () => {
    const result = await service.delete({ modelId: "m-a1", dryRun: true });
    expect(result.removed).toBe(false);
    expect(result.references.referenced).toBe(false);
    expect((await readConfig()).models.map((item) => item.id)).toContain("m-a1");
  });

  it("默认项指向被删的模型时改指到同端点的剩余模型", async () => {
    const result = await service.delete({ modelId: "m-a1" });
    expect(result.removed).toBe(true);

    const written = await readConfig();
    expect(written.models.map((item) => item.id)).toEqual(["m-a2", "m-b1", "m-ghost"]);
    expect(written.defaultModel).toBe("m-a2");
  });

  it("同端点没有剩余模型时清空默认指向", async () => {
    await service.delete({ modelId: "m-b1" });
    const written = await readConfig();
    // namingModel 原本指向 m-b1，而 ep-b 没有别的模型了
    expect(written.namingModel).toBeUndefined();
    expect(written.defaultMigrationModel).toBe("m-a2");
  });
});

describe("ModelService 的图片模型", () => {
  it("创建与修改都算自定义", async () => {
    const created = await service.saveImage({
      imageModel: { id: "img-2", name: "Image Two", endpointId: "ep-a", modelName: "img-two" },
    });
    expect(created.imageModel.custom).toBe(true);

    const updated = await service.saveImage({
      imageModel: {
        id: "img-2",
        name: "Image Two B",
        endpointId: "ep-a",
        modelName: "img-two",
        defaultSize: "1024x1024",
      },
    });
    expect(updated.imageModel.name).toBe("Image Two B");
    expect(updated.imageModel.defaultSize).toBe("1024x1024");

    const written = await readConfig();
    expect(written.imageModels?.map((item) => item.id)).toEqual(["img-1", "img-2"]);
  });

  it("被默认图片模型指着时拒删", async () => {
    await expect(service.deleteImage({ imageModelId: "img-1" })).rejects.toMatchObject({
      code: "config_invalid",
      detail: { imageModelId: "img-1" },
    });
    expect((await readConfig()).imageModels?.map((item) => item.id)).toEqual(["img-1"]);
  });
});
