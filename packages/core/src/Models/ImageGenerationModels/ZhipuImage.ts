import { RequestConfig } from "../../Model.js";
import {
  ImageGenerationModel,
  ImageGenerationOptions,
  ImageGenerationResponse,
  ImageResult,
} from "../ImageGenerationModel.js";

class FatalError extends Error {}

export interface ZhipuImageModelConfig {
  /** cogview-4(默认), glm-image, cogview-4-250304, cogview-3-flash */
  model?: string;
  size?: string;
  quality?: "hd" | "standard";
}

export class ZhipuImage extends ImageGenerationModel<ZhipuImageModelConfig> {
  static code = "zhipu-image";
  static title = "ZhipuAI Image (GLM-Image/CogView)";

  async generate(options: ImageGenerationOptions): Promise<ImageGenerationResponse> {
    if (!this.request_config) {
      throw new Error("ZhipuImage request_config not set");
    }

    const request_config = this.formatRequestConfig(this.request_config);

    const body: Record<string, any> = {
      model: options.model || "cogview-4",
      prompt: options.prompt,
    };
    if (options.size) body.size = options.size;
    if (options.quality) body.quality = options.quality;
    if (options.n !== undefined) body.n = options.n;

    try {
      const res = await fetch(request_config.url, {
        signal: options.signal,
        method: "POST",
        headers: request_config.headers,
        body: JSON.stringify(body),
      });

      const data: any = await res.json();

      if (!res.ok) {
        const errorMsg =
          data?.error?.message || data?.message || `HTTP ${res.status}`;
        throw new FatalError(`图片生成失败: ${errorMsg}`);
      }

      const images: ImageResult[] = [];
      if (data?.data && Array.isArray(data.data)) {
        for (const item of data.data) {
          if (item.url) images.push({ url: item.url });
          if (item.b64_json) images.push({ b64_json: item.b64_json });
        }
      }

      return {
        created: data.created,
        data: images,
        content_filter: data.content_filter || [],
      };
    } catch (error: any) {
      if (error instanceof FatalError) throw error;
      throw new FatalError(error?.message || "图片生成请求失败");
    }
  }

  formatRequestConfig(request_config?: RequestConfig): RequestConfig {
    return { ...request_config } as RequestConfig;
  }
}
