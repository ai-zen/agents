import OpenAI, { toFile } from "openai";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { AgentDefinition, AppConfig, ToolEnv } from "../../../types/index.js";

const SUPPORTED_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

/**
 * 查看图片工具 — 让 Agent 主动查看/分析一张图片。**仅对视觉模型可用**：
 * 由 `isAvailable(config, definition)` 声明（从 definition.modelId 解析模型，检查 Model.vision），
 * buildTools 阶段按声明过滤——非视觉模型不会拿到该工具，故无需运行时重复校验。
 *
 * 输入 `path_or_url`：
 *   - http(s) URL → 直接以 `image_url` 内容块返回，模型直接查看；
 *   - 本地路径 → 自动通过 Files API（DeepSeek）上传，以 `file` 内容块（file_id）返回。
 *
 * 不使用 base64 内联（本地图片走 Files API，符合 DeepSeek 推荐与 48 MiB 请求体限制）。
 * 依赖配置中的 deepseek 端点（Files API 能力）；URL 场景不依赖上传。
 */
export class ViewImageTool extends SdkCallbackTool {
  /** 仅视觉模型可用：从 definition.modelId 解析当前模型，非视觉模型由 buildTools 过滤 */
  isAvailable(config: AppConfig, definition: AgentDefinition): boolean {
    const modelId = definition.modelId ?? config.defaultModel;
    const model = (config.models ?? []).find((m) => m.id === modelId);
    return model?.vision === true;
  }

  function: AgentNS.FunctionDefine = {
    name: "viewImage",
    description:
      "查看一张图片并分析其内容。传入本地图片路径或 http(s) 图片 URL。本地图片会自动上传（Files API）后引用，网络图片直接引用。适合识别图片文字、描述图片内容、分析图表等。",
    parameters: {
      type: "object",
      properties: {
        path_or_url: {
          type: "string",
          description:
            "本地图片路径（相对/绝对）或 http(s) 图片 URL。支持的格式：JPEG、PNG、GIF、WebP。",
        },
      },
      required: ["path_or_url"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(
    input: { path_or_url?: string },
    ctx?: ToolCallContext,
  ): Promise<AgentNS.MessageContent> {
    const signal = ctx?.signal;
    const target = input?.path_or_url;
    if (!target || !target.trim()) {
      return "viewImage 需要提供 path_or_url 参数（本地图片路径或 http(s) URL）。";
    }
    const value = target.trim();

    try {
      // 网络图片：直接返回 image_url 内容块（无需上传）
      if (/^https?:\/\//i.test(value)) {
        return [
          {
            type: "text",
            text: `已获取网络图片：${value}`,
          },
          { type: "image_url", image_url: { url: value } },
        ];
      }

      // 本地图片：解析路径 + 校验 + Files API 上传
      const absPath = path.isAbsolute(value)
        ? value
        : path.join(this.env.cwd, value);

      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch {
        return `本地图片不存在: ${absPath}`;
      }
      if (!stat.isFile()) {
        return `"${absPath}" 不是文件。`;
      }

      const ext = path.extname(absPath).toLowerCase();
      if (!SUPPORTED_EXT.includes(ext)) {
        return `不支持的图片格式 "${ext || "(无扩展名)"}"。支持的格式：JPEG、PNG、GIF、WebP。`;
      }

      // 上传端点：deepseek（Files API 能力）
      const endpoint = (this.env.config.endpoints ?? []).find(
        (e) => e.id === "deepseek",
      );
      if (!endpoint) {
        return "未配置 deepseek 端点，无法上传本地图片（Files API）。如需查看本地图片，请先配置 deepseek 端点；网络图片 URL 可直接使用。";
      }
      if (!endpoint.apiKey) {
        return `端点 "${endpoint.name}" 的 API Key 未设置，无法上传本地图片。`;
      }

      const client = new OpenAI({
        apiKey: endpoint.apiKey,
        baseURL: endpoint.baseUrl,
      });

      const file = await toFile(
        await fs.readFile(absPath),
        path.basename(absPath),
      );
      const uploaded = await client.files.create(
        { file, purpose: "user_data" },
        { signal },
      );

      return [
        {
          type: "text",
          text: `图片已上传（${path.basename(absPath)}），file_id: ${uploaded.id}`,
        },
        { type: "file", file_id: uploaded.id },
      ];
    } catch (error: unknown) {
      // 中断（abort）时返回明确的中断结果
      if (signal?.aborted) {
        return "图片查看被中断（aborted）";
      }
      return `查看图片失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
