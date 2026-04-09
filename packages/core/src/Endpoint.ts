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

  abstract build(path: string, model: string): Promise<RequestConfig>;

  chatCompletion(model: string) {
    return this.build("chat/completions", model);
  }

  embedding(model: string) {
    return this.build("embeddings", model);
  }
}
