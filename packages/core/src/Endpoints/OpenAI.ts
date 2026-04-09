import { Endpoint } from "../Endpoint.js";

export interface OpenAIConfig {
  openai_endpoint?: string;
  api_key: string;
  organization?: string;
  headers?: Record<string, string>;
  body?: Record<string, any>;
}

export class OpenAI extends Endpoint<OpenAIConfig> {
  static title = "OpenAI";

  async build(path: "chat/completions" | "embeddings", model: string) {
    let { openai_endpoint, api_key } = this.endpoint_config;

    if (!openai_endpoint) {
      openai_endpoint = "https://api.openai.com/v1/";
    }

    if (!openai_endpoint.endsWith("/")) {
      openai_endpoint += "/";
    }
    return {
      ...this.endpoint_config,
      url: `${openai_endpoint}${path}`,
      headers: {
        "Content-Type": "application/json",
        ...this.endpoint_config?.headers,
        Authorization: `Bearer ${api_key}`,
        ...(this.endpoint_config?.organization
          ? {
              "OpenAI-Organization": this.endpoint_config?.organization,
            }
          : {}),
      },
      body: {
        ...this.endpoint_config?.body,
        model: model,
      },
    };
  }
}
