import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class CopyTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
        name: "copy",
        description: "复制文件或目录（相当于 cp 命令）",
        parameters: {
          type: "object",
          properties: {
            src: {
              type: "string",
              description: "源路径",
            },
            dest: {
              type: "string",
              description: "目标路径",
            },
            recursive: {
              type: "boolean",
              description: "是否递归复制目录，复制目录时需设为 true",
            },
          },
          required: ["src", "dest"],
          additionalProperties: false,
        },
      },
      env,
    });
  }

  async call(input: { src: string; dest: string; recursive?: boolean }): Promise<string> {
    try {
      await fsp.cp(this.resolve(input.src), this.resolve(input.dest), {
        recursive: input.recursive ?? false,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  }
}
