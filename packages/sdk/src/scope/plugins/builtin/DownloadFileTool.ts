import * as fsp from "fs/promises";
import * as path from "path";
import { createWriteStream } from "fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
        timeout: {
          type: "number",
          description:
            "Timeout in milliseconds (required). The download is aborted on timeout. Large files need a larger value.",
        },
      },
      required: ["url", "timeout"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(
    input: { url: string; outputPath?: string; timeout: number },
    ctx?: ToolCallContext,
  ): Promise<string> {
    const url = input.url;
    const { timeout } = input;

    if (!url) throw new Error("download_file: url must not be empty");
    // 运行时双校验：timeout 必填且必须为正数（与 exec 同口径）
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(
        `download_file: timeout is required and must be a positive number (milliseconds), got: ${JSON.stringify(timeout)}`,
      );
    }

    let savePath: string | undefined;
    // 是否已开始写盘：仅用于如实说明"文件可能不完整"，不做任何删除动作
    let startedWriting = false;

    try {
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

      // 总时长上限：fetch 自身只对"响应头"有兜底，响应体可以无限期地流下去
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`timeout after ${timeout}ms`)),
        timeout,
      );
      const onAbort = () => controller.abort(ctx?.signal?.reason);
      ctx?.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
        }
        if (!response.body) {
          throw new Error("Download failed: response has no body");
        }

        const contentType = response.headers.get("content-type") || "";

        // 流式写盘：不把整个文件读进内存（大文件下 arrayBuffer() 会吃掉数倍于文件大小的堆）
        startedWriting = true;
        await pipeline(Readable.fromWeb(response.body as any), createWriteStream(savePath));

        const stats = await fsp.stat(savePath);
        const fileSizeKB = (stats.size / 1024).toFixed(1);

        return JSON.stringify({
          success: true,
          filePath: path.resolve(savePath),
          fileSize: `${fileSizeKB} KB`,
          contentType,
          note: "File saved to local disk",
        });
      } finally {
        clearTimeout(timer);
        ctx?.signal?.removeEventListener("abort", onAbort);
      }
    } catch (error: any) {
      const aborted = ctx?.signal?.aborted ?? false;
      return JSON.stringify({
        success: false,
        ...(aborted ? { aborted: true } : {}),
        error: error?.message || "Download failed",
        // 已开始写盘时文件可能不完整：只如实告知，绝不去删（同路径的原文件可能本来就存在）
        ...(startedWriting
          ? { note: "The file at the save path may be incomplete or overwritten" }
          : {}),
      });
    }
  }
}
