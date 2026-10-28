import * as fsp from "fs/promises";
import * as path from "path";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";

export class DownloadFileTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "download_file",
    description:
      "Download a file from a URL (images, PDFs and other binary files) and save it to the local disk. The file name is inferred from the URL, or you can specify the save path.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to download the file from",
        },
        outputPath: {
          type: "string",
          description:
            "Save path (optional). May be a directory or a full file path. If omitted, the file is saved to the current working directory with the file name inferred from the URL.",
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
      if (!url) throw new Error("url must not be empty");

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
        throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
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
        note: "File saved to local disk",
      });
    } catch (error: any) {
      // 中断（abort）时清理可能残留的半成品文件
      if (signal?.aborted && savePath) {
        await fsp.rm(savePath, { force: true }).catch(() => {});
        return JSON.stringify({
          success: false,
          aborted: true,
          error: "Download aborted",
        });
      }
      return JSON.stringify({
        success: false,
        error: error?.message || "Download failed",
      });
    }
  }
}
