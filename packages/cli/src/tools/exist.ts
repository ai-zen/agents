import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

export const existTool = new CallbackTool({
  function: {
    name: "exist",
    description: "检查文件或目录是否存在",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件或目录路径",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    return await fsp
      .access(input.path as string)
      .then(() => "true")
      .catch(() => "false");
  },
});
