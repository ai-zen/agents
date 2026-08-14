import * as fsp from "fs/promises";
import * as path from "path";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";

interface MatchItem {
  line: number;
  content: string;
  match?: string;
}

interface MatchResult {
  file: string;
  matches: MatchItem[];
}

export class FindTextTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
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
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(
    input: { path?: string; pattern: string; text?: string; regex?: string; exclude?: string[] },
    ctx?: ToolCallContext,
  ): Promise<string> {
    const signal = ctx?.signal;
    try {
      const cwd = input.path ? this.resolve(input.path) : this.env.cwd;
      const result: MatchResult[] = [];
      const text = input.text;
      const regexStr = input.regex;

      if (!text && !regexStr) {
        return "请提供 text 或 regex 参数";
      }

      const regex = regexStr ? new RegExp(regexStr) : null;

      for await (const file of fsp.glob(input.pattern, {
        cwd,
        exclude: input.exclude || ["**/node_modules/**"],
      })) {
        if (signal?.aborted) break; // 中断：停止继续遍历/消费

        const fullPath = path.join(cwd, file);
        const stats = await fsp.stat(fullPath);
        if (signal?.aborted) break; // 中断：stat 后再次检查

        if (stats.isFile()) {
          const content = await fsp.readFile(fullPath, "utf-8");
          if (signal?.aborted) break; // 中断：readFile 后再次检查

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

      if (signal?.aborted) {
        return JSON.stringify({ aborted: true, results: result });
      }
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  }
}
