import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

export const rmTool = new CallbackTool({
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
  async callback(input): Promise<string> {
    try {
      await fsp.rm(input.path as string, {
        recursive: (input.recursive as boolean) ?? false,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  },
});
