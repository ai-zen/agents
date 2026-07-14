import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

export const lsTool = new CallbackTool({
  function: {
    name: "ls",
    description: "列出目录",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "目录路径",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      const result = await fsp.readdir(input.path as string);
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  },
});
