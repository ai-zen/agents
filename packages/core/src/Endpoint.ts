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

  /**
   * 同步构建 HTTP 请求配置。
   * 默认实现直接调用异步 build() 并用 Promise 包装，子类可覆盖为纯同步实现。
   * @param path - API 路径
   * @param model - 模型标识
   */
  buildSync(path: string, model: string): RequestConfig {
    // 默认通过异步 build 实现，子类应覆盖为纯同步版本
    throw new Error(
      `${this.constructor.name} 未实现 buildSync，请使用异步 build()`,
    );
  }

  /** @param model - 模型名（Azure OpenAI 中为部署名） */
  chatCompletion(model: string) {
    return this.build("chat/completions", model);
  }

  /** @param model - 模型名（Azure OpenAI 中为部署名） */
  chatCompletionSync(model: string) {
    return this.buildSync("chat/completions", model);
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
