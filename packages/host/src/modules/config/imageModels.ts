import { DEFAULT_APP_CONFIG } from "@ai-zen/agents-sdk";
import type { AppConfig, ImageModelDefinition } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { GeneralConfig } from "./general.js";

export interface ImageModelDeps {
  /** 内存里那一份配置：读它、写也经过它（`GeneralConfig.write` 是唯一的写盘口） */
  readonly general: GeneralConfig;
  readonly t: Translator;
}

/**
 * 图片模型的增删改。
 *
 * `custom` 这一格照出厂托管的规矩：客户端建的图模自带
 * `custom: true`，由调用方给，服务不替它定 —— 服务替它定，就等于替用户决定了「这一条
 * 下次启动该不该被出厂清单覆盖」。恢复出厂那一支反过来：`custom` 置回 `false`，重新归入托管。
 */
export class ImageModelService {
  constructor(private readonly deps: ImageModelDeps) {}

  async add(model: ImageModelDefinition): Promise<AppConfig> {
    const current = this.deps.general.read();
    const imageModels = current.imageModels ?? [];
    if (imageModels.some((item) => item.id === model.id)) {
      throw new HostError(
        "conflict",
        this.deps.t("已经有 id 为 {imageModelId} 的图片模型了", { imageModelId: model.id }),
        { entity: "imageModel", imageModelId: model.id },
      );
    }

    this.assertEndpoint(model, current);
    return this.write({ ...current, imageModels: [...imageModels, model] });
  }

  async update(id: string, change: Partial<Omit<ImageModelDefinition, "id">>): Promise<AppConfig> {
    const current = this.deps.general.read();
    const imageModels = current.imageModels ?? [];
    const found = imageModels.find((item) => item.id === id);
    if (found === undefined) throw this.notFound(id);

    const next: ImageModelDefinition = { ...found, ...change };
    this.assertEndpoint(next, current);
    return this.write({
      ...current,
      imageModels: imageModels.map((item) => (item.id === id ? next : item)),
    });
  }

  /**
   * 删图片模型。`defaultImageModel` 指着它的，改指同端点剩余的第一条，同端点一条不剩就
   * 清空（`undefined`）。
   *
   * 与 `ModelService.remove` 里 `redirect` 那一格是同一套规则：只改指同端点的，跨端点改指
   * 等于把图片请求发去另一家服务商；而默认项指着一个已经不在的模型比这更糟，所以这一格必须
   * 当场改掉。两处不共用一段代码（一个是模型、一个是图片模型，字段名也不同），规则共用一句话。
   */
  async remove(id: string): Promise<AppConfig> {
    const current = this.deps.general.read();
    const imageModels = current.imageModels ?? [];
    const removed = imageModels.find((item) => item.id === id);
    if (removed === undefined) throw this.notFound(id);

    const remaining = imageModels.filter((item) => item.id !== id);
    const replacement = remaining.find((item) => item.endpointId === removed.endpointId)?.id;

    return this.write({
      ...current,
      imageModels: remaining,
      defaultImageModel: current.defaultImageModel === id ? replacement : current.defaultImageModel,
    });
  }

  /**
   * 恢复出厂：整条换回出厂清单里同 id 的那一条，`custom` 置回 `false`（重新归入托管）。
   * 与 `ModelService.reset` 同一条口径：整条换，不是把出厂那几格叠到用户那份上。
   */
  async reset(id: string): Promise<AppConfig> {
    const current = this.deps.general.read();
    const imageModels = current.imageModels ?? [];
    if (!imageModels.some((item) => item.id === id)) throw this.notFound(id);

    const factory = DEFAULT_APP_CONFIG.imageModels?.find((item) => item.id === id);
    if (factory === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("「{imageModelId}」不是出厂的那几个图片模型之一", { imageModelId: id }),
        { entity: "imageModel", imageModelId: id },
      );
    }

    const next: ImageModelDefinition = { ...factory, custom: false };
    this.assertEndpoint(next, current);
    return this.write({
      ...current,
      imageModels: imageModels.map((item) => (item.id === id ? next : item)),
    });
  }

  private write(next: AppConfig): Promise<AppConfig> {
    return this.deps.general.write(next);
  }

  /**
   * 图模挂在哪个端点上，与模型是同一条判据（`ModelService.assertWritable` 的第一条）：
   * 端点不在的话，这个图模要到真去生成图片那一刻才失败。
   */
  private assertEndpoint(model: ImageModelDefinition, config: AppConfig): void {
    if (config.endpoints.some((endpoint) => endpoint.id === model.endpointId)) return;
    throw new HostError(
      "config_invalid",
      this.deps.t("找不到 id 为 {endpointId} 的端点", { endpointId: model.endpointId }),
    );
  }

  private notFound(id: string): HostError {
    return new HostError(
      "not_found",
      this.deps.t("找不到 id 为 {imageModelId} 的图片模型", { imageModelId: id }),
    );
  }
}
