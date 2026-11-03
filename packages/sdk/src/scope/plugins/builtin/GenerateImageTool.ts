import OpenAI from "openai";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type {
  AgentDefinition,
  AppConfig,
  ToolEnv,
  ImageModel,
  GenerateImageFn,
} from "../../../types/index.js";

/** 默认图片生成实现：走 OpenAI SDK 的 `images.generate`（任何 OpenAI 兼容端点均可） */
const defaultGenerateImage: GenerateImageFn = async ({
  endpoint,
  model,
  prompt,
  size,
  quality,
  signal,
}) => {
  const client = new OpenAI({ apiKey: endpoint.apiKey, baseURL: endpoint.baseUrl });
  // 厂商特有字段（size / quality）用 any 透传
  const result = await client.images.generate({ model, prompt, size, quality } as any, { signal });
  return {
    created: result.created,
    // 有的端点只返回 b64_json，两类字段都原样带出去，由调用方决定怎么落地
    data: (result.data ?? []) as { url?: string; b64_json?: string }[],
  };
};

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
          description:
            "Text description of the desired image; describe the subject, style, composition and other details",
        },
        model: {
          type: "string",
          description:
            "Image model ID. Defaults to the configured default image model; if the given model does not exist, this tool returns the list of currently available models.",
        },
        size: {
          type: "string",
          description:
            "Image size. Defaults to the model default size. cogview series: 1024x1024, 768x1344, 864x1152, 1344x768, 1152x864, 1440x720, 720x1440. glm-image: 1280x1280, 1568x1056, 1056x1568, 1472x1088, 1088x1472, 1728x960, 960x1728.",
        },
        quality: {
          type: "string",
          description:
            "Image quality. hd: fine (about 20 seconds), standard: fast (about 5-10 seconds)",
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

      const endpoint = config.endpoints.find((e) => e.id === imageModel.endpointId);
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

      const modelName = input.model || imageModel.modelName;

      // 出网动作走注入的 deps（缺省时用 OpenAI SDK），测试无需 mock openai 模块
      const generateImage = this.env.deps?.generateImage ?? defaultGenerateImage;
      const result = await generateImage({
        endpoint,
        model: modelName,
        prompt: prompt.trim(),
        size: input.size || imageModel.defaultSize || undefined,
        quality: input.quality || imageModel.defaultQuality || undefined,
        signal,
      });

      // 逐个收集：有 url 的直接给链接；只有 b64_json 的端点则落盘后给本地路径。
      // 只看 url 会把「只返回 b64_json 的模型」变成 success: true + images: []（假成功）。
      const images: { index: number; url?: string; filePath?: string }[] = [];
      for (const [index, item] of (result.data ?? []).entries()) {
        if (item.url) {
          images.push({ index, url: item.url });
          continue;
        }
        if (item.b64_json) {
          images.push({ index, filePath: await saveBase64Image(item.b64_json) });
        }
      }

      if (images.length === 0) {
        return JSON.stringify({
          success: false,
          model: imageModel.name,
          modelId: imageModel.id,
          created: result.created,
          images: [],
          error:
            "The endpoint returned no image: neither `url` nor `b64_json` was present in the response",
        });
      }

      // 统一返回字符串（JSON）：生成结果如何处理（查看/下载/转发）由模型与上层自由决定，
      // 不替模型做「看或不看」的假设。需要让模型看图 → 模型可主动调用 view_image；
      // 需要保存 → download_file 下载。
      const hasUrl = images.some((img) => img.url);
      return JSON.stringify(
        {
          success: true,
          model: imageModel.name,
          modelId: imageModel.id,
          created: result.created,
          images,
          note: hasUrl
            ? "Image links are temporary and expire after 30 days. To inspect the image content, use the view_image tool (pass the image URL); to save it, use download_file."
            : "The endpoint returned base64 images; they were written to local files, so use view_image with the filePath to inspect them.",
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

/** 依据 base64 头部字节判断图片扩展名（判断不了就当 png） */
function imageExtension(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return "png";
}

/**
 * 把 `b64_json` 写成本地文件，返回绝对路径。
 *
 * 落盘到系统临时目录下的独立子目录（与工具输出落盘同一习惯），不污染工作目录。
 */
async function saveBase64Image(b64: string): Promise<string> {
  const buffer = Buffer.from(b64, "base64");
  const dir = path.join(os.tmpdir(), "ai-zen", "generated-images");
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(
    dir,
    `image-${Date.now()}-${randomBytes(4).toString("hex")}.${imageExtension(buffer)}`,
  );
  await fsp.writeFile(filePath, buffer);
  return filePath;
}
