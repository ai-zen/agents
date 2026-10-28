import OpenAI from "openai";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { AgentDefinition, AppConfig, ToolEnv, ImageModel } from "../../../types/index.js";

/**
 * 根据文字描述生成图片。**统一返回字符串**（JSON，含图片 URL 列表）：
 * 生成结果如何处理（查看/下载/转发）由模型与上层自由决定——
 * 需要让模型看图时，模型可主动调用 view_image(URL)；需要保存时用 download_file。
 *
 * 依赖 AppConfig 中的 imageModels 和 defaultImageModel 配置（isAvailable 声明），
 * 未配置时由 buildTools 过滤，不暴露给 Agent。
 */
export class GenerateImageTool extends SdkCallbackTool {
  /** 依赖图片模型配置（defaultImageModel），未配置时由 buildTools 按 isAvailable 过滤 */
  isAvailable(config: AppConfig, _definition: AgentDefinition): boolean {
    return !!config.defaultImageModel;
  }

  function: AgentNS.FunctionDefine = {
    name: "generate_image",
    description:
      "Generate an image from a text description and return a list of image URLs (JSON). To inspect the image content, use the view_image tool (pass the image URL); to save it locally, use download_file.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the desired image; describe the subject, style, composition and other details",
        },
        model: {
          type: "string",
          description:
            "Image model ID. Defaults to the configured default image model; if the given model does not exist, this tool returns the list of currently available models.",
        },
        size: {
          type: "string",
          description:
            'Image size. Defaults to the model default size. cogview series: 1024x1024, 768x1344, 864x1152, 1344x768, 1152x864, 1440x720, 720x1440. glm-image: 1280x1280, 1568x1056, 1056x1568, 1472x1088, 1088x1472, 1728x960, 960x1728.',
        },
        quality: {
          type: "string",
          description: "Image quality. hd: fine (about 20 seconds), standard: fast (about 5-10 seconds)",
          enum: ["hd", "standard"],
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(
    input: {
      prompt: string;
      model?: string;
      size?: string;
      quality?: string;
    },
    ctx?: ToolCallContext,
  ): Promise<string> {
    const signal = ctx?.signal;
    try {
      const prompt = input.prompt;
      if (!prompt || !prompt.trim()) {
        return JSON.stringify({ success: false, error: "prompt must not be empty" });
      }

      const config = this.env.config;
      const imageModels = config.imageModels;
      const defaultImageModel = config.defaultImageModel;

      if (!imageModels || imageModels.length === 0) {
        return JSON.stringify({
          success: false,
          error: "No image generation model configured. Add imageModels to the configuration.",
        });
      }

      const modelId = input.model || defaultImageModel;
      const imageModel: ImageModel | undefined = modelId
        ? imageModels.find((m) => m.id === modelId)
        : imageModels[0];

      if (!imageModel) {
        return JSON.stringify({
          success: false,
          error: `Image model "${modelId}" does not exist. Available image models: ${imageModels.map((m) => m.id).join(", ")}`,
        });
      }

      const endpoint = config.endpoints.find(
        (e) => e.id === imageModel.endpointId,
      );
      if (!endpoint) {
        return JSON.stringify({
          success: false,
          error: `Endpoint "${imageModel.endpointId}" for image model "${imageModel.name}" is not configured`,
        });
      }
      if (!endpoint.apiKey) {
        return JSON.stringify({
          success: false,
          error: `API Key for endpoint "${endpoint.name}" is not set`,
        });
      }

      const client = new OpenAI({
        apiKey: endpoint.apiKey,
        baseURL: endpoint.baseUrl,
      });

      const modelName = input.model || imageModel.modelName;

      // 通过官方 SDK 生成图片（厂商特有字段如 size/quality 用 any 透传）
      const result = await client.images.generate(
        {
          model: modelName,
          prompt: prompt.trim(),
          size: input.size || imageModel.defaultSize || undefined,
          quality:
            input.quality || imageModel.defaultQuality || undefined,
        } as any,
        { signal },
      );

      const urls = ((result.data ?? []) as { url?: string }[])
        .map((img) => img.url)
        .filter((url): url is string => !!url);

      // 统一返回字符串（JSON）：生成结果如何处理（查看/下载/转发）由模型与上层自由决定，
      // 不替模型做「看或不看」的假设。需要让模型看图 → 模型可主动调用 view_image(URL)；
      // 需要保存 → download_file 下载。
      return JSON.stringify(
        {
          success: true,
          model: imageModel.name,
          modelId: imageModel.id,
          created: result.created,
          images: urls.map((url, i) => ({ index: i, url })),
          note: "Image links are temporary and expire after 30 days. To inspect the image content, use the view_image tool (pass the image URL); to save it, use download_file.",
        },
        null,
        2,
      );
    } catch (error: unknown) {
      // 中断（abort）时返回明确的中断结果
      if (signal?.aborted) {
        return JSON.stringify({
          success: false,
          aborted: true,
          error: "Image generation aborted",
        });
      }
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Image generation failed",
      });
    }
  }
}
