import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

export const mkdirTool = new CallbackTool({
  function: {
    name: "mkdir",
    description: "创建目录",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "目录路径",
        },
        recursive: {
          type: "boolean",
          description: "是否递归创建子目录",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      await fsp.mkdir(input.path as string, {
        recursive: input.recursive as boolean,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  },
});
