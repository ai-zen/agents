import { SignJWT } from "jose";
import { Endpoint } from "../Endpoint.js";
import { ModelType } from "../Model.js";

export interface ZhipuConfig {
  zhipu_endpoint?: string;
  api_key: string;
  headers?: Record<string, string>;
  body?: Record<string, any>;
}

/**
 * @deprecated
 */
export class Zhipu extends Endpoint<ZhipuConfig> {
  static title = "Zhipu";

  async build(path: string, model: string) {
    let { zhipu_endpoint, api_key } = this.endpoint_config;

    if (!zhipu_endpoint) {
      zhipu_endpoint = "https://open.bigmodel.cn/api/paas/v4/";
    }

    if (!zhipu_endpoint.endsWith("/")) {
      zhipu_endpoint += "/";
    }

    return {
      ...this.endpoint_config,
      url: `${zhipu_endpoint}${path}`,
      headers: {
        "Content-Type": "application/json",
        ...this.endpoint_config?.headers,
        Authorization: `Bearer ${await this.generateToken(api_key, 3600)}`,
      },
      body: {
        ...this.endpoint_config?.body,
        model: model,
      },
    };
  }

  async generateToken(api_key: string, exp_seconds: number) {
    try {
      let [id, secret] = api_key.split(".");

      if (!id || !secret) {
        throw new Error("invalid api_key");
      }

      const payload = {
        api_key: id,
        exp: Date.now() + exp_seconds * 1000,
        timestamp: Date.now(),
      };

      const jwt = await new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256", sign_type: "SIGN" })
        .sign(new TextEncoder().encode(secret));

      return jwt;
    } catch (error) {
      console.error("generateToken failed:", error);
      throw error;
    }
  }
}
