import type { AppConfig, ConfigManager, Model } from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { ConfigEvent } from "./events.js";

export interface ModelDeps {
  readonly config: ConfigManager;
  readonly events: Bus<ConfigEvent>;
  readonly t: Translator;
}

/**
 * 模型的增删改。
 *
 * 三条写入门槛在这一层：SDK 的 `ConfigManager` 只负责读写，判断不了写进去之后还能不能用。
 * 端点不存在、硬线不高于软线、思考档位表不存在，三种组合都必然让请求失败。
 */
export class ModelService {
  constructor(private readonly deps: ModelDeps) {}

  async add(model: Model): Promise<AppConfig> {
    const current = await this.deps.config.read();
    await this.assertWritable(model, current);
    return this.write({ ...current, models: [...current.models, model] });
  }

  async update(id: string, change: Partial<Omit<Model, "id">>): Promise<AppConfig> {
    const current = await this.deps.config.read();
    const found = current.models.find((model) => model.id === id);
    if (found === undefined) throw this.notFound(id);

    const next: Model = { ...found, ...change };
    await this.assertWritable(next, current);
    return this.write({
      ...current,
      models: current.models.map((model) => (model.id === id ? next : model)),
    });
  }

  async remove(id: string): Promise<AppConfig> {
    const current = await this.deps.config.read();
    const removed = current.models.find((model) => model.id === id);
    if (removed === undefined) throw this.notFound(id);

    const models = current.models.filter((model) => model.id !== id);
    // 只改指同端点的第一条剩余模型：跨端点改指等于把请求发去另一家服务商，那件事由人决定
    const replacement = models.find((model) => model.endpointId === removed.endpointId)?.id;
    const redirect = (target: string | undefined): string | undefined =>
      target === id ? replacement : target;

    return this.write({
      ...current,
      models,
      defaultModel: redirect(current.defaultModel),
      defaultMigrationModel: redirect(current.defaultMigrationModel),
      namingModel: redirect(current.namingModel),
    });
  }

  private async write(config: AppConfig): Promise<AppConfig> {
    await this.deps.config.write(config);
    this.deps.events.emit({ kind: "models" });
    return config;
  }

  private async assertWritable(model: Model, config: AppConfig): Promise<void> {
    if (!config.endpoints.some((endpoint) => endpoint.id === model.endpointId)) {
      throw new HostError(
        "config_invalid",
        this.deps.t("找不到 id 为 {endpointId} 的端点", { endpointId: model.endpointId }),
      );
    }

    if (model.tokenThresholds.handoff >= model.tokenThresholds.guard) {
      throw new HostError(
        "config_invalid",
        this.deps.t("交接阈值 {handoff} 必须小于防护阈值 {guard}", {
          handoff: model.tokenThresholds.handoff,
          guard: model.tokenThresholds.guard,
        }),
      );
    }

    // 不写档位表 = 不可调，允许；写了名字却查不到这张表，直到选档那一刻才失败
    if (model.reasoningPreset !== undefined) {
      const presets = await this.deps.config.readReasoningPresets();
      if (!Object.hasOwn(presets, model.reasoningPreset)) {
        throw new HostError(
          "config_invalid",
          this.deps.t("找不到思考档位表 {preset}", { preset: model.reasoningPreset }),
        );
      }
    }
  }

  private notFound(id: string): HostError {
    return new HostError(
      "not_found",
      this.deps.t("找不到 id 为 {modelId} 的模型", { modelId: id }),
    );
  }
}
