/**
 * 两条用例：一条证明「改一格写回、再读回来是新的」，一条证明「删模型只改指同端点」——
 * 后者写错不会报错，只会让请求静默落到另一家服务商。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppConfig, Endpoint, Model } from "@ai-zen/agents-sdk";
import { ConfigManager } from "@ai-zen/agents-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBus } from "../../infra/bus.js";
import { createTranslator } from "../i18n/index.js";
import type { ConfigEvent } from "./events.js";
import { GeneralConfig } from "./general.js";
import { ModelService } from "./models.js";

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-zen-host-config-"));
  configPath = join(dir, "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function endpoint(id: string): Endpoint {
  return { id, name: id, baseUrl: `https://${id}.example/v1`, apiKey: "" };
}

function model(id: string, endpointId: string): Model {
  return { id, name: id, endpointId, tokenThresholds: { handoff: 100, guard: 150 } };
}

async function writeConfig(config: AppConfig): Promise<void> {
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

describe("配置", () => {
  it("改一格写回，重新读出来是新的", async () => {
    await writeConfig({
      endpoints: [endpoint("ep-a")],
      models: [model("m-a1", "ep-a")],
      defaultModel: "m-a1",
      language: "zh",
    });
    const config = new ConfigManager(configPath);
    const general = new GeneralConfig({
      config,
      current: await config.read(),
      events: createBus<ConfigEvent>(),
    });

    await general.patch({ language: "en" });

    expect(general.language()).toBe("en");
    const reloaded = await new ConfigManager(configPath).read();
    expect(reloaded.language).toBe("en");
    // 只改这一格：端点与模型不该被这一改抹掉
    expect(reloaded.models.map((item) => item.id)).toEqual(["m-a1"]);
    expect(reloaded.defaultModel).toBe("m-a1");
  });

  it("删模型只改指同端点的第一条剩余模型，同端点没剩的就清空", async () => {
    await writeConfig({
      endpoints: [endpoint("ep-a"), endpoint("ep-b")],
      models: [model("m-a1", "ep-a"), model("m-a2", "ep-a"), model("m-b1", "ep-b")],
      defaultModel: "m-a1",
      defaultMigrationModel: "m-b1",
      namingModel: "m-a1",
    });
    const config = new ConfigManager(configPath);
    const general = new GeneralConfig({
      config,
      current: await config.read(),
      events: createBus<ConfigEvent>(),
    });
    const models = new ModelService({ general, t: createTranslator(() => "zh") });

    const afterFirst = await models.remove("m-a1");

    // 跨端点改指会落到 ep-b 上：那正是这条用例要拦住的事
    expect(afterFirst.defaultModel).toBe("m-a2");
    expect(afterFirst.namingModel).toBe("m-a2");
    expect(afterFirst.defaultMigrationModel).toBe("m-b1");
    expect((await new ConfigManager(configPath).read()).defaultModel).toBe("m-a2");

    const afterSecond = await models.remove("m-b1");

    expect(afterSecond.defaultMigrationModel).toBeUndefined();
    expect(afterSecond.defaultModel).toBe("m-a2");
  });
});
