/**
 * 模型服务：模型清单、图片模型、模型增删改、恢复出厂（F-F3 / F-F4 / F-F7 / D6 / D27）。
 *
 * 配置只有一处真相（D21）：`config.json`，读写都经 SDK 的 `ConfigManager`。这个服务不缓存配置，
 * 每次调用现读现写 —— 配置是几百行的 JSON，读一次比「缓存与磁盘谁更新」的排查便宜得多。
 *
 * 两条与产品行为直接相关的口径：
 *
 *   - **编辑即转自定义**（F-F3）：改过的模型要打上 `custom: true`，否则 SDK 下次初始化会拿出厂
 *     定义把它冲回去（`syncManagedModels` 只保留 `custom: true` 的条目）。
 *   - **删除要算引用**（F-F2 / F-F7）：被助手引用的模型不能删，并且要列出「还有谁指它」；
 *     默认项指向被删的那个模型时要改指或清空，不留悬空引用。
 */

import type { AgentRepository } from "@ai-zen/agents-sdk";
import {
  DEFAULT_APP_CONFIG,
} from "@ai-zen/agents-sdk";
import type {
  AppConfig,
  ConfigManager,
  Endpoint,
  ImageModel,
  Model,
  ReasoningPreset,
  ReasoningPresets,
  TokenThresholds,
} from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render, type MessageKey } from "../i18n/index.js";
import { HostError } from "../wire/errors.js";
import type {
  ImageModelInput,
  ImageModelView,
  ModelCreateParams,
  ModelCreateResult,
  ModelDeleteImageParams,
  ModelDeleteImageResult,
  ModelDeleteParams,
  ModelDeleteResult,
  ModelInput,
  ModelListImagesResult,
  ModelListParams,
  ModelListResult,
  ModelRestoreFactoryParams,
  ModelRestoreFactoryResult,
  ModelSaveImageParams,
  ModelSaveImageResult,
  ModelUpdateParams,
  ModelUpdateResult,
  ModelView,
  ProblemFact,
  ReferenceList,
} from "../wire/index.js";

/** 一个模型被谁引用（删除前的「还有谁指它」） */
interface ReferenceRecord {
  kind: string;
  id: string;
  name: string;
}

/** 模型服务的依赖；由单根组装后注入 */
export interface ModelServiceOptions {
  /** 配置唯一入口（SDK） */
  configManager: ConfigManager;
  /** 助手定义仓储（`<basePath>/agents/`）：模型被谁引用要读它 */
  agents?: AgentRepository;
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

/** 一条给人看的事实（码 = 文案键，与素材层同口径：存码不存句子，D8） */
function text(messageKey: MessageKey, params: Record<string, unknown> = {}): ProblemFact {
  return {
    code: messageKey,
    messageKey,
    params,
    message: render(DEFAULT_LANGUAGE, messageKey, params),
  };
}

// ---------------------------------------------------------------------------
// 出厂默认的两条阈值
// ---------------------------------------------------------------------------

/**
 * 新建模型不传阈值时套的默认档（F-F3）。
 *
 * 唯一来源是 SDK 出厂配置里各模型的那份 `tokenThresholds`，这里不另写数字：取清单里
 * **用得最多的那一档**（出厂清单里绝大多数模型的窗口都很大，用的是同一档；只有一个
 * 200K 窗口的模型例外，那档给新模型既过度保守也说不通）。出厂清单改了，这里跟着改。
 */
function factoryDefaultThresholds(): TokenThresholds {
  const tally = new Map<string, { value: TokenThresholds; hits: number }>();
  for (const model of DEFAULT_APP_CONFIG.models) {
    const { handoff, guard } = model.tokenThresholds;
    const key = `${handoff}/${guard}`;
    const seen = tally.get(key);
    if (seen) seen.hits += 1;
    else tally.set(key, { value: { handoff, guard }, hits: 1 });
  }

  let winner: { value: TokenThresholds; hits: number } | undefined;
  for (const candidate of tally.values()) {
    if (winner === undefined || candidate.hits > winner.hits) winner = candidate;
  }
  // 出厂清单为空是 SDK 侧的不变量被破坏；当场报出来，不默默写出一个没有阈值的模型
  if (winner === undefined) throw new Error("SDK 的出厂配置里没有任何模型，拿不到默认阈值");
  return { handoff: winner.value.handoff, guard: winner.value.guard };
}

// ---------------------------------------------------------------------------
// 纯函数（配置里那些「查一查」的公共口径，助手服务也用）
// ---------------------------------------------------------------------------

/** 按 id 找端点 */
export function findEndpoint(config: AppConfig, endpointId: string): Endpoint | undefined {
  return config.endpoints.find((endpoint) => endpoint.id === endpointId);
}

/** 按 id 找模型 */
export function findModel(config: AppConfig, modelId: string): Model | undefined {
  return config.models.find((model) => model.id === modelId);
}

/** 按 id 找图片模型 */
export function findImageModel(config: AppConfig, imageModelId: string): ImageModel | undefined {
  return (config.imageModels ?? []).find((model) => model.id === imageModelId);
}

/**
 * 这个模型现在能不能用；能用回 `null`，不能用回一条带原因的事实（F-B5：藏着不如说清楚）。
 *
 * 两种用不了的原因都在配置层：端点没了（模型指向一个已删的端点），或端点还没配密钥
 * （F-A7 的「这个端点配好了没」）。模型自身的字段没有第三种「用不了」的形态。
 */
export function modelUnavailableProblem(
  config: AppConfig,
  model: Model,
): ProblemFact | null {
  const endpoint = findEndpoint(config, model.endpointId);
  if (!endpoint) {
    return text("model.endpointMissing", { model: model.name, id: model.endpointId });
  }
  if (endpoint.apiKey.trim() === "") {
    return text("endpoint.noKey", { endpoint: endpoint.name === "" ? endpoint.id : endpoint.name });
  }
  return null;
}

/** 模型引用的思考策略（表里没有、或者一条档位都没有，就是这个模型不可调，PRD F-B7） */
export function reasoningPresetOf(
  model: Model | undefined,
  presets: ReasoningPresets,
): ReasoningPreset | undefined {
  const name = model?.reasoningPreset;
  if (!name) return undefined;
  const preset = presets[name];
  return preset && Object.keys(preset.levels).length > 0 ? preset : undefined;
}

/** 这个模型可选的思考档位名（客户端据此渲染「能调哪几档」） */
export function thinkingLevelsOf(model: Model | undefined, presets: ReasoningPresets): string[] {
  const preset = reasoningPresetOf(model, presets);
  return preset ? Object.keys(preset.levels) : [];
}

/** 两条阈值的合法性：都是正数，且硬线要留出交接的余量（handoff < guard） */
function assertThresholds(thresholds: { handoff: number; guard: number }): void {
  const { handoff, guard } = thresholds;
  if (!Number.isFinite(handoff) || !Number.isFinite(guard) || handoff <= 0 || guard <= 0) {
    throw new HostError("invalid_params", {
      params: { field: "tokenThresholds" },
      detail: { field: "tokenThresholds", reason: "not_positive", thresholds },
    });
  }
  if (handoff >= guard) {
    throw new HostError("invalid_params", {
      params: { field: "tokenThresholds" },
      detail: { field: "tokenThresholds", reason: "handoff_not_below_guard", thresholds },
    });
  }
}

/** 必填的字符串参数：空串按「参数不对」处理，不拿它去查配置 */
function requireText(value: unknown, field: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") {
    throw new HostError("invalid_params", {
      params: { field },
      detail: { field, reason: "empty" },
    });
  }
  return raw;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class ModelService {
  private readonly configManager: ConfigManager;
  private readonly agents?: AgentRepository;

  constructor(options: ModelServiceOptions) {
    this.configManager = options.configManager;
    this.agents = options.agents;
  }

  /** 读一次配置（写方法都从这里出发，避免「基于旧快照覆盖别人刚写的东西」） */
  async readConfig(): Promise<AppConfig> {
    return await this.configManager.read();
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  /**
   * 模型清单（F-F3）。
   *
   * 默认连不可用的也列（F-B5 的口径：藏起来会让人以为它没了），`includeUnavailable: false`
   * 时才把它们筛掉。
   */
  async list(params: ModelListParams = {}): Promise<ModelListResult> {
    const config = await this.readConfig();
    const presets = await this.configManager.readReasoningPresets();
    const models = config.models.map((model) => this.toView(config, model, presets));
    return {
      models:
        params.includeUnavailable === false ? models.filter((model) => model.available) : models,
    };
  }

  /** 图片模型与那个「默认图片模型」（F-F4 / D6） */
  async listImages(): Promise<ModelListImagesResult> {
    const config = await this.readConfig();
    const imageModels = (config.imageModels ?? []).map((model) => toImageModelView(model));
    return { imageModels, defaultImageModel: config.defaultImageModel ?? null };
  }

  // -------------------------------------------------------------------------
  // 写：文本模型
  // -------------------------------------------------------------------------

  /** 新建模型（建出来就是自定义，F-F3） */
  async create(params: ModelCreateParams): Promise<ModelCreateResult> {
    const input = params.model;
    const config = await this.readConfig();
    const id = requireText(input?.id, "model.id");
    if (findModel(config, id)) {
      throw new HostError("invalid_params", {
        params: { field: "model.id" },
        detail: { field: "model.id", reason: "already_exists", id },
      });
    }
    const presets = await this.configManager.readReasoningPresets();
    const model = this.buildModel(config, presets, id, input);

    const next: AppConfig = { ...config, models: [...config.models, model] };
    await this.configManager.write(next);
    return { model: this.toView(next, model, presets) };
  }

  /** 编辑模型（编辑即转自定义，F-F3 —— 否则下轮初始化会被出厂定义冲回去） */
  async update(params: ModelUpdateParams): Promise<ModelUpdateResult> {
    const config = await this.readConfig();
    const modelId = requireText(params.modelId, "modelId");
    const existing = findModel(config, modelId);
    if (!existing) {
      throw new HostError("not_found", {
        params: { entity: "model" },
        detail: { modelId },
      });
    }

    const presets = await this.configManager.readReasoningPresets();
    const patch = params.patch ?? {};
    const merged: Model = {
      ...existing,
      ...definedOnly({
        name: patch.name,
        endpointId: patch.endpointId,
        modelName: patch.modelName,
        tokenThresholds: patch.tokenThresholds,
        defaultParams: patch.defaultParams,
        reasoningPreset: patch.reasoningPreset,
        vision: patch.vision,
        description: patch.description,
      }),
      custom: true,
    };
    validateModelShape(config, presets, merged);

    const next: AppConfig = {
      ...config,
      models: config.models.map((model) => (model.id === modelId ? merged : model)),
    };
    await this.configManager.write(next);
    return { model: this.toView(next, merged, presets) };
  }

  /**
   * 删除模型（F-F2 / F-F7）。
   *
   * 被助手引用时拒删并列出引用者；默认项（兜底模型 / 迁移模型 / 取名模型）指向它时改指或清空
   * —— 留在配置里指向一个不存在的 id，会在下一次真要跑的时候才炸出来。
   */
  async delete(params: ModelDeleteParams): Promise<ModelDeleteResult> {
    const config = await this.readConfig();
    const modelId = requireText(params.modelId, "modelId");
    if (!findModel(config, modelId)) {
      throw new HostError("not_found", { params: { entity: "model" }, detail: { modelId } });
    }

    const references = await this.referencesOf(modelId);
    if (references.length > 0) {
      throw new HostError("config_invalid", {
        messageKey: "config.referenced",
        params: { count: references.length, names: references.map((item) => item.name).join(", ") },
        detail: { modelId, references: { referenced: true, items: references } },
      });
    }
    if (params.dryRun === true) {
      return { removed: false, references: { referenced: false, items: [] } };
    }

    const remaining = config.models.filter((model) => model.id !== modelId);
    const next: AppConfig = {
      ...config,
      models: remaining,
      ...redirectDefaults(config, modelId, remaining),
    };
    await this.configManager.write(next);
    return { removed: true, references: { referenced: false, items: [] } };
  }

  /**
   * 恢复出厂（F-F3：整条替换）。
   *
   * 只有出厂清单里有的模型才有「出厂版本」可恢复；用户自建的模型没有，回
   * `error.notFactoryModel`。恢复之后这一条重新归 SDK 托管（去掉 `custom`），
   * 所以下次初始化会跟着出厂清单走。
   */
  async restoreFactory(params: ModelRestoreFactoryParams): Promise<ModelRestoreFactoryResult> {
    const config = await this.readConfig();
    const modelId = requireText(params.modelId, "modelId");
    if (!findModel(config, modelId)) {
      throw new HostError("not_found", { params: { entity: "model" }, detail: { modelId } });
    }
    const factory = DEFAULT_APP_CONFIG.models.find((model) => model.id === modelId);
    if (!factory) {
      throw new HostError("invalid_params", {
        messageKey: "error.notFactoryModel",
        params: { id: modelId },
        detail: { modelId, reason: "not_a_factory_model" },
      });
    }

    const restored: Model = { ...structuredClone(factory) };
    const next: AppConfig = {
      ...config,
      models: config.models.map((model) => (model.id === modelId ? restored : model)),
    };
    await this.configManager.write(next);
    const presets = await this.configManager.readReasoningPresets();
    return { model: this.toView(next, restored, presets) };
  }

  // -------------------------------------------------------------------------
  // 写：图片模型
  // -------------------------------------------------------------------------

  /** 图片模型的创建与修改（F-F4：同一个方法兼两件事，`id` 在就改、不在就建） */
  async saveImage(params: ModelSaveImageParams): Promise<ModelSaveImageResult> {
    const input = params.imageModel;
    const config = await this.readConfig();
    const id = requireText(input?.id, "imageModel.id");
    requireText(input?.name, "imageModel.name");
    requireText(input?.modelName, "imageModel.modelName");
    const endpointId = requireText(input?.endpointId, "imageModel.endpointId");
    if (!findEndpoint(config, endpointId)) {
      throw new HostError("invalid_params", {
        params: { field: "imageModel.endpointId" },
        detail: { field: "imageModel.endpointId", reason: "endpoint_not_found", endpointId },
      });
    }

    const imageModels = config.imageModels ?? [];
    const existing = imageModels.find((model) => model.id === id);
    const saved: ImageModel = {
      ...(existing ?? {}),
      ...definedOnly({
        description: input.description,
        defaultSize: input.defaultSize,
        defaultQuality: input.defaultQuality,
      }),
      id,
      name: requireText(input.name, "imageModel.name"),
      endpointId,
      modelName: requireText(input.modelName, "imageModel.modelName"),
      custom: true,
    };
    const next: AppConfig = {
      ...config,
      imageModels: existing
        ? imageModels.map((model) => (model.id === id ? saved : model))
        : [...imageModels, saved],
    };
    await this.configManager.write(next);
    return { imageModel: toImageModelView(saved) };
  }

  /** 删除图片模型；它正被「默认图片模型」指着时拒删（F-F4 / F-F7） */
  async deleteImage(params: ModelDeleteImageParams): Promise<ModelDeleteImageResult> {
    const config = await this.readConfig();
    const imageModelId = requireText(params.imageModelId, "imageModelId");
    const imageModels = config.imageModels ?? [];
    if (!imageModels.some((model) => model.id === imageModelId)) {
      throw new HostError("not_found", {
        params: { entity: "image model" },
        detail: { imageModelId },
      });
    }

    const references: ReferenceList =
      config.defaultImageModel === imageModelId
        ? {
            referenced: true,
            items: [{ kind: "default", id: "defaultImageModel", name: imageModelId }],
          }
        : { referenced: false, items: [] };

    if (references.referenced) {
      throw new HostError("config_invalid", {
        messageKey: "config.referenced",
        params: {
          count: references.items.length,
          names: references.items.map((item) => item.name).join(", "),
        },
        detail: { imageModelId, references },
      });
    }
    if (params.dryRun === true) return { removed: false, references };

    const next: AppConfig = {
      ...config,
      imageModels: imageModels.filter((model) => model.id !== imageModelId),
    };
    await this.configManager.write(next);
    return { removed: true, references };
  }

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  /** 一行模型定义 → 对外形状 */
  toView(config: AppConfig, model: Model, presets: ReasoningPresets): ModelView {
    const unavailable = modelUnavailableProblem(config, model);
    return {
      id: model.id,
      name: model.name,
      endpointId: model.endpointId,
      modelName: model.modelName ?? null,
      tokenThresholds: {
        handoff: model.tokenThresholds.handoff,
        guard: model.tokenThresholds.guard,
      },
      defaultParams: model.defaultParams ?? {},
      reasoningPreset: model.reasoningPreset ?? null,
      thinkingLevels: thinkingLevelsOf(model, presets),
      vision: model.vision === true,
      description: model.description ?? null,
      custom: model.custom === true,
      available: unavailable === null,
      unavailableReason: unavailable,
    };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /** 入参（新建）→ 一条模型定义；校验全在这里，写盘之前就拦下 */
  private buildModel(
    config: AppConfig,
    presets: ReasoningPresets,
    id: string,
    input: ModelInput,
  ): Model {
    const model: Model = {
      id,
      name: requireText(input?.name, "model.name"),
      endpointId: requireText(input?.endpointId, "model.endpointId"),
      ...definedOnly({
        modelName: input.modelName,
        tokenThresholds: input.tokenThresholds,
        defaultParams: input.defaultParams,
        reasoningPreset: input.reasoningPreset,
        vision: input.vision,
        description: input.description,
      }),
      // 阈值：入参给了用入参，省略就套出厂默认（出厂清单里最多人用的那一档）
      tokenThresholds: input.tokenThresholds ?? factoryDefaultThresholds(),
      custom: true,
    };
    validateModelShape(config, presets, model);
    return model;
  }

  /**
   * 谁在引用这个模型：读助手定义（一实体一文件，F-G3）。
   *
   * 默认项不列在这里：它们会跟着改指或清空（F-F7），是「删完自动收拾」而不是「拦住删除」。
   */
  private async referencesOf(modelId: string): Promise<ReferenceRecord[]> {
    const references: ReferenceRecord[] = [];
    const agents = this.agents ? await this.agents.list() : [];
    for (const agent of agents) {
      if (agent.modelId === modelId) {
        references.push({ kind: "agent", id: agent.id, name: agent.name });
      }
    }
    return references;
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 只保留「入参真的给了」的那些字段（`undefined` 表示这次不改它） */
function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/** 一条模型定义的形状校验：端点要在、阈值要合法、引用的思考策略要在表里 */
function validateModelShape(config: AppConfig, presets: ReasoningPresets, model: Model): void {
  requireText(model.name, "model.name");
  if (!findEndpoint(config, model.endpointId)) {
    throw new HostError("invalid_params", {
      params: { field: "model.endpointId" },
      detail: { field: "model.endpointId", reason: "endpoint_not_found", endpointId: model.endpointId },
    });
  }
  assertThresholds(model.tokenThresholds);
  if (model.reasoningPreset !== undefined && !presets[model.reasoningPreset]) {
    throw new HostError("invalid_params", {
      params: { field: "model.reasoningPreset" },
      detail: {
        field: "model.reasoningPreset",
        reason: "unknown_preset",
        preset: model.reasoningPreset,
        presets: Object.keys(presets),
      },
    });
  }
}

/**
 * 被删模型的默认指望去向（F-F7：自动改指或清空）。
 *
 * 口径是「同端点的第一条剩余模型」：换指到别的端点等于把请求发去另一家服务商，那件事该由人决定。
 * 同一端点没有剩余模型时清空（`null`），让界面显示「还没选」而不是显示一个不存在的 id。
 */
function redirectDefaults(
  config: AppConfig,
  removedModelId: string,
  remaining: Model[],
): Pick<AppConfig, "defaultModel" | "defaultMigrationModel" | "namingModel"> {
  const removed = findModel(config, removedModelId);
  const replacement =
    remaining.find((model) => model.endpointId === removed?.endpointId)?.id ?? null;

  const pick = (current: string | undefined): string | undefined =>
    current === removedModelId ? (replacement ?? undefined) : current;

  return {
    defaultModel: pick(config.defaultModel),
    defaultMigrationModel: pick(config.defaultMigrationModel),
    namingModel: pick(config.namingModel),
  };
}

/** 图片模型定义 → 对外形状 */
function toImageModelView(model: ImageModel): ImageModelView {
  return {
    id: model.id,
    name: model.name,
    endpointId: model.endpointId,
    modelName: model.modelName,
    description: model.description ?? null,
    defaultSize: model.defaultSize ?? null,
    defaultQuality: model.defaultQuality ?? null,
    custom: model.custom === true,
  };
}
