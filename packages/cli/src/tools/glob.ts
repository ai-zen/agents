import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";

export const globTool = new CallbackTool({
  function: {
    name: "glob",
    description:
      "使用 glob 模式递归扫描和查找文件。这是进行文件系统搜索的首选工具，功能远优于简单的 'ls' 列表命令。当你需要查找特定类型的文件、遍历目录树或需要排除特定文件时，请优先使用此函数。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "glob cwd",
        },
        pattern: {
          type: "string",
          description: "glob pattern",
        },
        exclude: {
          type: "array",
          description: "glob pattern to exclude",
          items: {
            type: "string",
          },
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    try {
      const result: string[] = [];
      for await (const file of fsp.glob(input.pattern as string, {
        exclude: (input.exclude as string[]) || ["**/node_modules/**"],
        cwd: input.path,
      })) {
        result.push(file);
      }
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  },
});
