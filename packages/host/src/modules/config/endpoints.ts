import type { AppConfig, Endpoint } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { GeneralConfig } from "./general.js";

export interface EndpointDeps {
  /** 内存里那一份配置：读它、写也经过它（`GeneralConfig.write` 是唯一的写盘口） */
  readonly general: GeneralConfig;
  readonly t: Translator;
}

/**
 * 端点的增删改。
 *
 * 端点是**用户的财产**：出厂清单里有三个，但 SDK 的出厂同步永远不动它们（`syncManagedModels`
 * 只对模型与图片模型动手），所以这里也没有 `reset` —— 「恢复出厂」对端点没有意义，用户的地址
 * 与密钥不是我们能改的。
 *
 * 三件都返回写后的整份 `AppConfig`：客户端拿到的是**改完之后**那一份，不必自己把补丁叠到
 * 手里那份快照上（叠法一旦漏掉一格，界面就安静地显示旧值）。
 */
export class EndpointService {
  constructor(private readonly deps: EndpointDeps) {}

  async add(endpoint: Endpoint): Promise<AppConfig> {
    const current = this.deps.general.read();
    // id 由调用方给：客户端建的端点自己定 id，而模型引用端点用的就是同一个 id。
    // 重名会让「引用它的模型」指向哪一个变成看谁赢，所以在这里就拒掉。
    if (current.endpoints.some((item) => item.id === endpoint.id)) {
      throw new HostError(
        "conflict",
        this.deps.t("已经有 id 为 {endpointId} 的端点了", { endpointId: endpoint.id }),
        { entity: "endpoint", endpointId: endpoint.id },
      );
    }

    return this.write({ ...current, endpoints: [...current.endpoints, endpoint] });
  }

  async update(id: string, change: Partial<Omit<Endpoint, "id">>): Promise<AppConfig> {
    const current = this.deps.general.read();
    const found = current.endpoints.find((item) => item.id === id);
    if (found === undefined) throw this.notFound(id);

    // `id` 不在 `change` 里（入参类型就排掉了）：端点 id 是模型的引用目标，改它等于把所有
    // 指着它的模型一起改指，那不是一次「改个名字」
    const next: Endpoint = { ...found, ...change };
    return this.write({
      ...current,
      endpoints: current.endpoints.map((item) => (item.id === id ? next : item)),
    });
  }

  /**
   * 删端点。**还挂着东西就不删**，并把是哪几个（模型、图片模型）说出来。
   *
   * 不自动把那些模型改指到别的端点：跨端点改指等于把请求发去另一家服务商，那件事由人决定
   * （与 `ModelService.remove` 里改指默认项那句是同一个口径 —— 那条能自动改，是因为默认项
   * 指着一个已经不在的模型比跨端点更糟；这里反过来，悄悄换一家的后果更重）。
   *
   * 图片模型与模型同一条判据：它们也挂在端点 id 上，只报模型的话，删完之后会留下一条指不到
   * 端点的图模 —— 那要到人真的去生成图片那一刻才失败，而界面上看不出原因。
   */
  async remove(id: string): Promise<AppConfig> {
    const current = this.deps.general.read();
    if (!current.endpoints.some((item) => item.id === id)) throw this.notFound(id);

    const models = current.models
      .filter((model) => model.endpointId === id)
      .map((model) => model.id);
    const imageModels = (current.imageModels ?? [])
      .filter((model) => model.endpointId === id)
      .map((model) => model.id);

    if (models.length > 0 || imageModels.length > 0) {
      // 拼一句「模型 X / 图片模型 Y」：只说「还有东西在用」等于让人自己去翻配置
      const hanging: string[] = [];
      if (models.length > 0) {
        hanging.push(this.deps.t("模型 {ids}", { ids: models.join(" / ") }));
      }
      if (imageModels.length > 0) {
        hanging.push(this.deps.t("图片模型 {ids}", { ids: imageModels.join(" / ") }));
      }

      throw new HostError(
        "conflict",
        this.deps.t("端点 {endpointId} 上还挂着{hanging}，先把它们换走或删掉", {
          endpointId: id,
          hanging: hanging.join("、"),
        }),
        { entity: "endpoint", endpointId: id, models, imageModels },
      );
    }

    return this.write({
      ...current,
      endpoints: current.endpoints.filter((item) => item.id !== id),
    });
  }

  /** 唯一的写盘口：与当前一样就不写、不发（判据在 `GeneralConfig.write` 里） */
  private write(next: AppConfig): Promise<AppConfig> {
    return this.deps.general.write(next);
  }

  private notFound(id: string): HostError {
    return new HostError(
      "not_found",
      this.deps.t("找不到 id 为 {endpointId} 的端点", { endpointId: id }),
      { entity: "endpoint", endpointId: id },
    );
  }
}
