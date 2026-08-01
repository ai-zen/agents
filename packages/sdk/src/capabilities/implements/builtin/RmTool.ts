import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class RmTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
        name: "rm",
        description: "删除文件或目录",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "文件或目录路径",
            },
            recursive: {
              type: "boolean",
              description: "是否递归删除子目录",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      env,
    });
  }

  async call(input: { path: string; recursive?: boolean }): Promise<string> {
    try {
      await fsp.rm(this.resolve(input.path), {
        recursive: input.recursive ?? false,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  }
}
