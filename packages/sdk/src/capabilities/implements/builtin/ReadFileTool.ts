import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class ReadFileTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
        name: "readFile",
        description: "读取文件",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "文件路径",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      env,
    });
  }

  async call(input: { path: string }): Promise<string> {
    try {
      const filePath = this.resolve(input.path);
      const stats = await fsp.stat(filePath);
      if (stats.size > 300 * 1024) {
        throw new Error(`文件过大，无法读取，当前文件大小 ${stats.size} 字节`);
      }
      return await fsp.readFile(filePath, "utf-8");
    } catch (error: any) {
      return error?.message;
    }
  }
}
