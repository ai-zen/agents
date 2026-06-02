import { Endpoint } from "../Endpoint.js";

export interface AzureOpenAIConfig {
  azure_endpoint: string;
  api_key: string;
  api_version: string;
  headers?: Record<string, string>;
  body?: Record<string, any>;
}

export class AzureOpenAI extends Endpoint<AzureOpenAIConfig> {
  static title = "Azure OpenAI";

  async build(
    path: string,
    deployment_name: string,
  ) {
    let { azure_endpoint, api_version, api_key } = this.endpoint_config;

    if (!azure_endpoint) {
      throw new Error("Azure OpenAI endpoint requires azure_endpoint");
    }

    if (!azure_endpoint.endsWith("/")) {
      azure_endpoint += "/";
    }

    return {
      ...this.endpoint_config,
      url: `${azure_endpoint}openai/deployments/${deployment_name}/${path}?api-version=${api_version}`,
      headers: {
        "Content-Type": "application/json",
        ...this.endpoint_config?.headers,
        "api-key": api_key,
      },
      body: {
        ...this.endpoint_config?.body,
      },
    };
  }

  chatCompletion(deployment_name: string) {
    return this.build("chat/completions", deployment_name);
  }

  embedding(deployment_name: string) {
    return this.build("embeddings", deployment_name);
  }

  imageGeneration(deployment_name: string) {
    return this.build("images/generations", deployment_name);
  }
}
