import OpenAI from "openai";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { AgentDefinition, AppConfig, ToolEnv, ImageModel } from "../../../types/index.js";

/**
 * 根据文字描述生成图片。**统一返回字符串**（JSON，含图片 URL 列表）：
 * 生成结果如何处理（查看/下载/转发）由模型与上层自由决定——
 * 需要让模型看图时，模型可主动调用 viewImage(URL)；需要保存时用 downloadFile。
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
    name: "generateImage",
    description:
      "根据文字描述生成图片，返回图片 URL 列表（JSON）。如需查看图片内容，请用 viewImage 工具（传入图片 URL）；如需保存到本地，用 downloadFile 下载。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "所需图像的文本描述，应详细描述画面内容、风格、构图等",
        },
        model: {
          type: "string",
          description:
            "图片模型 ID，不指定则使用配置中的默认图片模型。配置中的图片模型可通过 'aiz config show' 查看。",
        },
        size: {
          type: "string",
          description:
            '图片尺寸。不指定则使用模型的默认尺寸。cogview系列: 1024x1024, 768x1344, 864x1152, 1344x768, 1152x864, 1440x720, 720x1440。glm-image: 1280x1280, 1568x1056, 1056x1568, 1472x1088, 1088x1472, 1728x960, 960x1728。',
        },
        quality: {
          type: "string",
          description: "图像质量。hd: 精细(约20秒), standard: 快速(约5-10秒)",
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
        return JSON.stringify({ success: false, error: "prompt 不能为空" });
      }

      const config = this.env.config;
      const imageModels = config.imageModels;
      const defaultImageModel = config.defaultImageModel;

      if (!imageModels || imageModels.length === 0) {
        return JSON.stringify({
          success: false,
          error: "未配置图片生成模型。请在配置中添加 imageModels。",
        });
      }

      const modelId = input.model || defaultImageModel;
      const imageModel: ImageModel | undefined = modelId
        ? imageModels.find((m) => m.id === modelId)
        : imageModels[0];

      if (!imageModel) {
        return JSON.stringify({
          success: false,
          error: `图片模型 "${modelId}" 不存在。可用的图片模型: ${imageModels.map((m) => m.id).join(", ")}`,
        });
      }

      const endpoint = config.endpoints.find(
        (e) => e.id === imageModel.endpointId,
      );
      if (!endpoint) {
        return JSON.stringify({
          success: false,
          error: `图片模型 "${imageModel.name}" 对应的端点 "${imageModel.endpointId}" 未配置`,
        });
      }
      if (!endpoint.apiKey) {
        return JSON.stringify({
          success: false,
          error: `端点 "${endpoint.name}" 的 API Key 未设置`,
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
      // 不替模型做「看或不看」的假设。需要让模型看图 → 模型可主动调用 viewImage(URL)；
      // 需要保存 → downloadFile 下载。
      return JSON.stringify(
        {
          success: true,
          model: imageModel.name,
          modelId: imageModel.id,
          created: result.created,
          images: urls.map((url, i) => ({ index: i, url })),
          note: "图片临时链接有效期为30天。如需查看图片内容，可用 viewImage 工具（传入图片 URL）；如需保存，可用 downloadFile 下载。",
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
          error: "图片生成被中断（aborted）",
        });
      }
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "图片生成失败",
      });
    }
  }
}
