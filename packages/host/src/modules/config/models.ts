import { DEFAULT_APP_CONFIG } from "@ai-zen/agents-sdk";
import type { AppConfig, ModelDefinition } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { GeneralConfig } from "./general.js";

export interface ModelDeps {
  /** 内存里那一份配置：读它、写也经过它（`GeneralConfig.write` 是唯一的写盘口） */
  readonly general: GeneralConfig;
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

  async add(model: ModelDefinition): Promise<AppConfig> {
    const current = this.deps.general.read();
    // 与端点同一条规矩：id 是默认项与会话行引用它的方式，重名之后「引用的是哪一条」变成
    // 看谁赢 —— 那种配置不报错，只是让某一段会话悄悄换了个模型
    if (current.models.some((item) => item.id === model.id)) {
      throw new HostError(
        "conflict",
        this.deps.t("已经有 id 为 {modelId} 的模型了", { modelId: model.id }),
        { entity: "model", modelId: model.id },
      );
    }

    // 新建的就是用户自有的：不打这一位，下次启动的出厂同步（`syncManagedModels`）
    // 会把它当成「出厂清单里已经没有的那一条」直接丢掉 —— 用户刚加的模型一夜之间没了
    const next: ModelDefinition = { ...model, custom: true };
    await this.assertWritable(next, current);
    return this.write({ ...current, models: [...current.models, next] });
  }

  async update(id: string, change: Partial<Omit<ModelDefinition, "id">>): Promise<AppConfig> {
    const current = this.deps.general.read();
    const found = current.models.find((model) => model.id === id);
    if (found === undefined) throw this.notFound(id);

    /**
     * 改过的那一条从出厂托管转成用户自有。
     *
     * 不转的后果是「改完当场生效、下次启动又变回去」：`syncManagedModels` 只保留 `custom === true`
     * 的条目，其余一律替换成出厂定义 —— 用户把阈值从 400K 调到 600K、把特性开关打开，重启之后
     * 全被抹回出厂值，而且界面上看不出是为什么。
     *
     * 调用方显式给了 `custom` 就听它的（`models.reset` 走的是另一条路，它自己置 `false`）。
     */
    const next: ModelDefinition = {
      ...found,
      ...change,
      custom: change.custom ?? true,
    };
    await this.assertWritable(next, current);
    return this.write({
      ...current,
      models: current.models.map((model) => (model.id === id ? next : model)),
    });
  }

  async remove(id: string): Promise<AppConfig> {
    const current = this.deps.general.read();
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

  /**
   * 恢复出厂：把这一条整条换回 `DEFAULT_APP_CONFIG` 里同 id 的那一条，并把 `custom` 置回
   * `false` —— 「换回出厂定义、然后重新归入托管」。
   *
   * 整条换，不是把出厂那几格叠到用户那份上：出厂之后要给用户的是「出厂长什么样」，
   * 用户此前加在这一条上的字段（自填的描述、额外参数）一并退场；否则「恢复出厂」之后界面上
   * 还留着他改过的痕迹，而下一次启动的出厂同步又会按出厂清单覆盖一次 —— 两个时刻不一样。
   *
   * 写之前照样过 `assertWritable`：出厂那条的端点可能已经被用户删掉了（端点是用户的财产，
   * 宿主不替用户补回来），这时写进去的就是一条指不到端点的模型。
   */
  async reset(id: string): Promise<AppConfig> {
    const current = this.deps.general.read();
    if (!current.models.some((model) => model.id === id)) throw this.notFound(id);

    const factory = DEFAULT_APP_CONFIG.models.find((model) => model.id === id);
    if (factory === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("「{modelId}」不是出厂的那几个模型之一", { modelId: id }),
        { entity: "model", modelId: id },
      );
    }

    const next: ModelDefinition = { ...factory, custom: false };
    await this.assertWritable(next, current);
    return this.write({
      ...current,
      models: current.models.map((model) => (model.id === id ? next : model)),
    });
  }

  private write(next: AppConfig): Promise<AppConfig> {
    return this.deps.general.write(next, "models");
  }

  private async assertWritable(model: ModelDefinition, config: AppConfig): Promise<void> {
    // 形状由边界上的 `.input()` 声明，但那一格是 `z.custom`（`ModelDefinition` 的形状只有 SDK 一处，
    // 不在这里抄第二份）。抄不了就得自己判：读不到两条阈值时下面那次比较会抛 TypeError，
    // 那是宿主事故的报法，而这里是「写进来的一格不对」。
    if (
      typeof model.tokenThresholds?.handoff !== "number" ||
      typeof model.tokenThresholds?.guard !== "number"
    ) {
      throw new HostError(
        "invalid_params",
        this.deps.t("模型 {modelId} 的交接阈值与防护阈值都必须是数字", { modelId: model.id }),
        { entity: "model", modelId: model.id },
      );
    }

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
      const presets = await this.deps.general.presets();
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
