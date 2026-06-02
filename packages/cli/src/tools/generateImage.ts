import { CallbackTool, OpenAI, ZhipuImage } from "@ai-zen/agents-core";
import { readConfig } from "../config.js";
import { getImageModel, getDefaultImageModel } from "../models.js";

/**
 * 从文本描述生成图片。根据配置中的图片模型和端点自动选择服务，
 * 返回图片的临时 URL（有效期30天）。如需保存到本地，可配合 downloadFile 工具使用。
 */
export const generateImageTool = new CallbackTool({
  function: {
    name: "generateImage",
    description:
      "根据文字描述生成图片。返回图片 URL，可通过 downloadFile 工具保存到本地。",
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
  },
  async callback(input): Promise<string> {
    try {
      const prompt = input.prompt as string;
      if (!prompt || !prompt.trim()) {
        return JSON.stringify({ success: false, error: "prompt 不能为空" });
      }

      const config = readConfig();

      const modelId = (input.model as string) || config.defaultImageModel;
      const imageModel = modelId ? getImageModel(modelId) : getDefaultImageModel();

      if (!imageModel) {
        throw new Error("未找到可用的图片生成模型。请检查配置中的 imageModels。");
      }

      const endpoint = config.endpoints.find((e) => e.id === imageModel.endpointId);
      if (!endpoint) {
        throw new Error(
          `图片模型 "${imageModel.name}" 对应的端点 "${imageModel.endpointId}" 未配置`,
        );
      }
      if (!endpoint.apiKey) {
        throw new Error(`端点 "${endpoint.name}" 的 API Key 未设置`);
      }

      const ep = new OpenAI({
        openai_endpoint: endpoint.baseUrl,
        api_key: endpoint.apiKey,
      });

      const modelName = (input.model as string) || imageModel.modelName;

      const model = new ZhipuImage({
        request_config: await ep.imageGeneration(modelName),
      });

      const result = await model.generate({
        prompt: prompt.trim(),
        model: modelName,
        size: (input.size as string) || imageModel.defaultSize || undefined,
        quality: (input.quality as string) || imageModel.defaultQuality || undefined,
      });

      const images = result.data.map((img, i) => ({
        index: i,
        url: img.url,
        description: `图片 ${i + 1}`,
      }));

      return JSON.stringify(
        {
          success: true,
          model: imageModel.name,
          modelId: imageModel.id,
          created: result.created,
          images,
          content_filter: result.content_filter || [],
          note: "图片临时链接有效期为30天，请及时转存图片。",
        },
        null,
        2,
      );
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        error: error?.message || "图片生成失败",
      });
    }
  },
});
