import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";
import * as path from "path";

export const findTextTool = new CallbackTool({
  function: {
    name: "findText",
    description: "查找文本出现的位置",
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
        text: {
          type: "string",
          description: "要查找的文本",
        },
        exclude: {
          type: "array",
          description: "要排除的 glob 模式数组",
          items: {
            type: "string",
          },
        },
      },
      required: ["path", "pattern", "text"],
    },
  },
  async callback(input): Promise<string> {
    try {
      const result: string[] = [];
      for await (const file of fsp.glob(input.pattern as string, {
        cwd: input.path,
        exclude: (input.exclude as string[]) || ["**/node_modules/**"],
      })) {
        const fullPath = path.join(input.path as string, file);
        const stats = await fsp.stat(fullPath);
        if (stats.isFile()) {
          const content = await fsp.readFile(fullPath, "utf-8");
          if (content.includes(input.text as string)) {
            result.push(file);
          }
        }
      }
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  },
});
