import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

export const copyTool = new CallbackTool({
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
  async callback(input): Promise<string> {
    try {
      await fsp.cp(input.src as string, input.dest as string, {
        recursive: input.recursive as boolean,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  },
});
