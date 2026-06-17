import { RequestConfig } from "./Model.js";

export abstract class Endpoint<C extends {} = any> {
  static title: string;

  get title() {
    return (this.constructor as typeof Endpoint).title;
  }

  get name() {
    return this.constructor.name;
  }

  endpoint_config: C;

  constructor(options: C) {
    const { ...endpoint_config } = options;

    this.endpoint_config = (endpoint_config as any) ?? {};
  }

  /**
   * 构建 HTTP 请求配置。
   * @param path - API 路径（如 "chat/completions"、"embeddings"）
   * @param model - 模型标识。
   *                对于 OpenAI 等标准接口，此处为模型名（如 "gpt-4"）；
   *                对于 Azure OpenAI，此处为部署名称（deployment name）。
   */
  abstract build(path: string, model: string): Promise<RequestConfig>;

  /** @param model - 模型名（Azure OpenAI 中为部署名） */
  chatCompletion(model: string) {
    return this.build("chat/completions", model);
  }

  /** @param model - 模型名（Azure OpenAI 中为部署名） */
  embedding(model: string) {
    return this.build("embeddings", model);
  }

  /** @param model - 模型名（Azure OpenAI 中为部署名） */
  imageGeneration(model: string) {
    return this.build("images/generations", model);
  }
}
