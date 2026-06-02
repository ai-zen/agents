import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

export const readFileTool = new CallbackTool({
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
  async callback(input): Promise<string> {
    try {
      const stats = await fsp.stat(input.path as string);
      if (stats.size > 300 * 1024) {
        throw new Error(`文件过大，无法读取，当前文件大小 ${stats.size} 字节`);
      }
      const result = await fsp.readFile(input.path as string, "utf-8");
      return result;
    } catch (error: any) {
      return error?.message;
    }
  },
});
