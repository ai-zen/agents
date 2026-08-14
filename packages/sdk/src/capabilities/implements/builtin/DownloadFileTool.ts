import * as fsp from "fs/promises";
import * as path from "path";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";

export class DownloadFileTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "downloadFile",
    description:
      "从 URL 下载文件（图片、PDF 等二进制文件）并保存到本地磁盘。自动从 URL 推断文件名，也可指定保存路径。",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "文件下载链接",
        },
        outputPath: {
          type: "string",
          description:
            "保存路径（可选）。可以是目录或完整文件路径。不指定则下载到当前工作目录，自动从 URL 推断文件名。",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(
    input: { url: string; outputPath?: string },
    ctx?: ToolCallContext,
  ): Promise<string> {
    const signal = ctx?.signal;
    let savePath: string | undefined;

    try {
      const url = input.url;
      if (!url) throw new Error("url 不能为空");

      if (input.outputPath) {
        savePath = this.resolve(input.outputPath);
        const stat = await fsp.stat(savePath).catch(() => null);
        if (stat?.isDirectory()) {
          const urlPath = new URL(url).pathname;
          const fileName = path.basename(urlPath) || `download_${Date.now()}`;
          savePath = path.join(savePath, fileName);
        }
      } else {
        const urlPath = new URL(url).pathname;
        const fileName = path.basename(urlPath) || `download_${Date.now()}`;
        savePath = path.join(this.env.cwd, fileName);
      }

      await fsp.mkdir(path.dirname(savePath), { recursive: true });

      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(`下载失败: HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await fsp.writeFile(savePath, buffer);

      const stats = await fsp.stat(savePath);
      const fileSizeKB = (stats.size / 1024).toFixed(1);

      return JSON.stringify({
        success: true,
        filePath: path.resolve(savePath),
        fileSize: `${fileSizeKB} KB`,
        contentType,
        note: "文件已保存到本地",
      });
    } catch (error: any) {
      // 中断（abort）时清理可能残留的半成品文件
      if (signal?.aborted && savePath) {
        await fsp.rm(savePath, { force: true }).catch(() => {});
        return JSON.stringify({
          success: false,
          aborted: true,
          error: "下载被中断（aborted）",
        });
      }
      return JSON.stringify({
        success: false,
        error: error?.message || "下载失败",
      });
    }
  }
}
