import path from "node:path";
import { promises as fs } from "node:fs";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { AgentDefinition, AppConfig, ToolEnv } from "../../../types/index.js";
import { fileToContentSection, mimeOf, resolveModelAndEndpoint } from "../../../shared/content-blocks.js";

/**
 * 是否为"本地 URL"——指向本地/回环地址，API 服务商无法下载访问。
 * 覆盖 file:// 等本地协议，以及指向本机的 http(s) 地址（localhost、127.0.0.1、[::1]、0.0.0.0）。
 */
function isLocalUrl(value: string): boolean {
  if (/^file:\/\//i.test(value)) return true;
  const m = value.match(/^https?:\/\/([^/?#]+)/i);
  return !!m && /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(m[1]);
}

/**
 * 查看图片工具 — 让 Agent 主动查看/分析一张图片。**仅对视觉模型可用**：
 * 由 `isAvailable(config, definition)` 声明（从 definition.modelId 解析模型，检查 Model.vision），
 * buildTools 阶段按声明过滤——非视觉模型不会拿到该工具，故无需运行时重复校验。
 *
 * 输入 `path_or_url`：
 *   - http(s) URL → 直接以 `image_url` 内容块返回；
 *   - 本地路径 → 交给 `fileToContentSection()` 统一处理：
 *       端点声明 `capabilities.filesApi`（出厂仅 deepseek）→ Files API 上传，`file` 块（file_id）；
 *       其余端点 → base64 data URL 内联（`image_url`），不再要求必须配置 deepseek。
 *
 * 端点按**当前模型**反查（`ctx.agent.model`），不硬编码端点 id——`file_id` 是端点维度
 * 资源，传错端点会返回 not found。
 */
export class ViewImageTool extends SdkCallbackTool {
  /** 仅视觉模型可用：从 definition.modelId 解析当前模型，非视觉模型由 buildTools 过滤 */
  isAvailable(config: AppConfig, definition: AgentDefinition): boolean {
    const modelId = definition.modelId;
    const model = (config.models ?? []).find((m) => m.id === modelId);
    return model?.vision === true;
  }

  function: AgentNS.FunctionDefine = {
    name: "view_image",
    description:
      "View an image and analyze its content. Pass a local image path or an http(s) image URL. Local images are uploaded when the endpoint supports the Files API and are otherwise referenced as inline base64; remote images are referenced directly. Local URLs are not supported (such as the file:// protocol, or http(s) addresses pointing to localhost/127.0.0.1 on this machine); use a file path for local images. Suitable for reading text in images, describing image content and analyzing charts.",
    parameters: {
      type: "object",
      properties: {
        path_or_url: {
          type: "string",
          description:
            "Local image path (relative or absolute) or an http(s) image URL. Supported formats: JPEG, PNG, GIF, WebP. Local URLs are not supported (such as the file:// protocol, or http(s) addresses pointing to localhost/127.0.0.1 on this machine); use a file path for local images.",
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
      return "view_image requires the path_or_url parameter (a local image path or an http(s) URL)";
    }
    const value = target.trim();

    // 拒绝服务商无法访问的"本地 URL"：file:// 等本地协议，或指向本机回环地址的 http(s) 地址
    if (isLocalUrl(value)) {
      return "Local URLs are not supported (the API provider cannot download them). Use a file path for local images, not a local link";
    }

    // 按当前模型定位端点：决定走 Files API 上传还是 base64 内联
    const { model, endpoint } = resolveModelAndEndpoint(this.env.config, ctx?.agent?.model);

    try {
      const isUrl = /^https?:\/\//i.test(value);
      // 本工具只处理图片：先按扩展名把关，给出比通用入口更贴切的提示
      if (!isUrl) {
        const abs = this.resolve(value);
        // 先 stat 一次，把 ENOENT 变成对人友好的提示（通用入口的报错面向任意文件）
        try {
          await fs.stat(abs);
        } catch {
          return `Local image not found: ${abs}`;
        }
        const mime = mimeOf(abs);
        if (!mime || !mime.startsWith("image/")) {
          return `Unsupported image format "${path.extname(abs) || "(no extension)"}". Supported formats: JPEG, PNG, GIF, WebP`;
        }
      }
      const result = await fileToContentSection({
        source: isUrl ? { url: value } : { path: this.resolve(value) },
        endpoint,
        model,
        signal,
      });

      const label = isUrl ? `Fetched remote image: ${value}` : `Fetched local image (${path.basename(value)})`;
      const how =
        result.transport === "files-api"
          ? `, uploaded to the Files API (file_id: ${(result.section as { file_id?: string }).file_id ?? "?"})`
          : result.transport === "inline"
            ? `, inlined as base64 (${(result.bytes / 1024).toFixed(0)} KB)`
            : "";
      const extra = result.warning ? ` (fallback: ${result.warning})` : "";

      return [{ type: "text", text: `${label}${how}${extra}` }, result.section];
    } catch (error: unknown) {
      // 中断（abort）时返回明确的中断结果
      if (signal?.aborted) {
        return "Image view aborted";
      }
      return `Failed to view image: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
