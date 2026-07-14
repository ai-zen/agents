import { CallbackTool } from "@ai-zen/agents-core";
import * as fsp from "fs/promises";
import * as path from "path";

interface MatchItem {
  line: number;
  content: string;
  match?: string;
}

interface MatchResult {
  file: string;
  matches: MatchItem[];
}

export const findTextTool = new CallbackTool({
  function: {
    name: "findText",
    description: "查找文本出现的位置，支持普通文本或正则匹配，返回文件名及具体行号、行内容",
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
          description: "要查找的文本（与 regex 二选一）",
        },
        regex: {
          type: "string",
          description: "正则表达式（与 text 二选一，例如 \\bconst\\s+\\w+）",
        },
        exclude: {
          type: "array",
          description: "要排除的 glob 模式数组",
          items: {
            type: "string",
          },
        },
      },
      required: ["path", "pattern"],
    },
  },
  async callback(input): Promise<string> {
    try {
      const result: MatchResult[] = [];
      const text = input.text as string | undefined;
      const regexStr = input.regex as string | undefined;

      if (!text && !regexStr) {
        return "请提供 text 或 regex 参数";
      }

      const regex = regexStr ? new RegExp(regexStr) : null;

      for await (const file of fsp.glob(input.pattern as string, {
        cwd: input.path,
        exclude: (input.exclude as string[]) || ["**/node_modules/**"],
      })) {
        const fullPath = path.join(input.path as string, file);
        const stats = await fsp.stat(fullPath);
        if (stats.isFile()) {
          const content = await fsp.readFile(fullPath, "utf-8");
          const lines = content.split("\n");
          const matches: MatchItem[] = [];

          lines.forEach((lineContent, index) => {
            if (regex) {
              const matchResult = lineContent.match(regex);
              if (matchResult) {
                matches.push({
                  line: index + 1,
                  content: lineContent,
                  match: matchResult[0],
                });
              }
            } else if (lineContent.includes(text!)) {
              matches.push({
                line: index + 1,
                content: lineContent,
              });
            }
          });

          if (matches.length > 0) {
            result.push({ file, matches });
          }
        }
      }

      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  },
});
