import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

export const renameTool = new CallbackTool({
  function: {
    name: "rename",
    description: "重命名或移动文件/目录（相当于 mv 命令）",
    parameters: {
      type: "object",
      properties: {
        oldPath: {
          type: "string",
          description: "原路径",
        },
        newPath: {
          type: "string",
          description: "新路径",
        },
      },
      required: ["oldPath", "newPath"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      await fsp.rename(input.oldPath as string, input.newPath as string);
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  },
});
