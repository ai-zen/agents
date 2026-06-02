import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";
import * as path from "path";

export const writeFileTool = new CallbackTool({
  function: {
    name: "writeFile",
    description: "写入文件",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径",
        },
        content: {
          type: "string",
          description: "文件内容",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      await fsp.mkdir(path.dirname(input.path as string), { recursive: true });
      await fsp.writeFile(input.path as string, input.content as string);
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  },
});
