/**
 * `model.*` 接线壳的验收：方法齐、参数转发、不可用原因按连接语言渲染（D8）。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigManager } from "@ai-zen/agents-sdk";
import type { AppConfig } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Language } from "../i18n/index.js";
import type { MethodCallContext } from "../net/WsHub.js";
import { ModelService } from "../services/ModelService.js";
import type { MethodName } from "../wire/index.js";
import { createModelHandlers } from "./modelHandlers.js";

let dataRoot: string;
let handlers: ReturnType<typeof createModelHandlers>;

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

function config(): AppConfig {
  return {
    endpoints: [
      {
        id: "ep-a",
        name: "Endpoint A",
        baseUrl: "https://a.example/v1",
        apiKey: "sk-aaaaaaaa1111",
      },
      { id: "ep-b", name: "Endpoint B", baseUrl: "https://b.example/v1", apiKey: "" },
    ],
    models: [
      {
        id: "m-a1",
        name: "Model A1",
        endpointId: "ep-a",
        tokenThresholds: { handoff: 100, guard: 150 },
      },
      {
        id: "m-b1",
        name: "Model B1",
        endpointId: "ep-b",
        tokenThresholds: { handoff: 100, guard: 150 },
      },
    ],
    imageModels: [{ id: "img-1", name: "Image One", endpointId: "ep-a", modelName: "img-one" }],
    defaultImageModel: "img-1",
  };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "ai-zen-model-handlers-"));
  await writeJson(join(dataRoot, "config.json"), config());
  await writeJson(join(dataRoot, "reasoning-presets.json"), {});
  handlers = createModelHandlers({
    models: new ModelService({ configManager: new ConfigManager(join(dataRoot, "config.json")) }),
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("createModelHandlers", () => {
  it("八个方法都注册上了", () => {
    expect(Object.keys(handlers).sort()).toEqual([
      "model.create",
      "model.delete",
      "model.deleteImage",
      "model.list",
      "model.listImages",
      "model.restoreFactory",
      "model.saveImage",
      "model.update",
    ]);
  });

  it("model.list 的不可用原因按连接语言渲染", async () => {
    const zh = await handlers["model.list"]!(call("model.list", {}, "zh"));
    const reason = zh.models.find((model) => model.id === "m-b1")?.unavailableReason;
    expect(reason?.messageKey).toBe("endpoint.noKey");
    expect(reason?.message).toContain("密钥");
  });

  it("create / update / delete / restoreFactory 转发", async () => {
    const created = await handlers["model.create"]!(
      call("model.create", {
        model: {
          id: "m-new",
          name: "New",
          endpointId: "ep-a",
          tokenThresholds: { handoff: 10, guard: 20 },
        },
      }),
    );
    expect(created.model.custom).toBe(true);

    const updated = await handlers["model.update"]!(
      call("model.update", { modelId: "m-new", patch: { name: "New 2" } }),
    );
    expect(updated.model.name).toBe("New 2");

    const removed = await handlers["model.delete"]!(call("model.delete", { modelId: "m-new" }));
    expect(removed.removed).toBe(true);

    await expect(
      Promise.resolve(
        handlers["model.restoreFactory"]!(call("model.restoreFactory", { modelId: "m-a1" })),
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("图片模型：listImages / saveImage / deleteImage 转发", async () => {
    const images = await handlers["model.listImages"]!(call("model.listImages", {}));
    expect(images.defaultImageModel).toBe("img-1");

    const saved = await handlers["model.saveImage"]!(
      call("model.saveImage", {
        imageModel: { id: "img-2", name: "Two", endpointId: "ep-a", modelName: "two" },
      }),
    );
    expect(saved.imageModel.custom).toBe(true);

    const removed = await handlers["model.deleteImage"]!(
      call("model.deleteImage", { imageModelId: "img-2" }),
    );
    expect(removed.removed).toBe(true);
  });
});
