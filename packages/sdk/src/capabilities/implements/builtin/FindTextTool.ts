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

/** 默认总匹配数上限 */
const DEFAULT_MAX_MATCHES = 200;
/** 默认文件大小上限（字节，与 ReadFileTool 的 300KB 口径一致） */
const DEFAULT_MAX_FILE_SIZE = 300 * 1024;
/** 默认行内容/匹配子串截断长度 */
const DEFAULT_MAX_LINE_LENGTH = 200;

export class FindTextTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "findText",
    description:
      "查找文本出现的位置，支持普通文本或正则匹配，返回文件名及具体行号、行内容。为避免结果撑爆上下文，默认限制总匹配数、单文件大小与行内容长度，超限会截断并标记 truncated。",
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
        maxMatches: {
          type: "number",
          description: "总匹配数上限，默认 200",
        },
        maxFileSize: {
          type: "number",
          description: "单文件大小上限（字节），超过则跳过该文件，默认 307200（300KB）",
        },
        maxLineLength: {
          type: "number",
          description: "行内容与匹配子串的截断长度，默认 200",
        },
      },
      required: ["path", "pattern"],
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(
    input: {
      path?: string;
      pattern: string;
      text?: string;
      regex?: string;
      exclude?: string[];
      maxMatches?: number;
      maxFileSize?: number;
      maxLineLength?: number;
    },
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

      const maxMatches = input.maxMatches ?? DEFAULT_MAX_MATCHES;
      const maxFileSize = input.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
      const maxLineLength = input.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;

      let totalMatches = 0;
      let truncated = false;

      for await (const file of fsp.glob(input.pattern, {
        cwd,
        exclude: input.exclude || ["**/node_modules/**"],
      })) {
        if (signal?.aborted) break; // 中断：停止继续遍历/消费
        if (totalMatches >= maxMatches) {
          truncated = true;
          break;
        }

        const fullPath = path.join(cwd, file);
        const stats = await fsp.stat(fullPath);
        if (signal?.aborted) break; // 中断：stat 后再次检查

        if (!stats.isFile()) continue;
        // 文件过大则跳过（避免撑爆上下文；与 ReadFileTool 300KB 口径一致，但此处为跳过而非报错）
        if (stats.size > maxFileSize) continue;

        const content = await fsp.readFile(fullPath, "utf-8");
        if (signal?.aborted) break; // 中断：readFile 后再次检查

        const lines = content.split("\n");
        const matches: MatchItem[] = [];

        for (let index = 0; index < lines.length; index++) {
          if (totalMatches >= maxMatches) {
            truncated = true;
            break;
          }

          const lineContent = lines[index];
          if (regex) {
            const matchResult = lineContent.match(regex);
            if (matchResult) {
              matches.push({
                line: index + 1,
                content: truncate(lineContent, maxLineLength),
                match: truncate(matchResult[0], maxLineLength),
              });
              totalMatches++;
            }
          } else if (lineContent.includes(text!)) {
            matches.push({
              line: index + 1,
              content: truncate(lineContent, maxLineLength),
            });
            totalMatches++;
          }
        }

        if (matches.length > 0) {
          result.push({ file, matches });
        }
      }

      if (signal?.aborted) {
        return JSON.stringify({ aborted: true, results: result });
      }
      if (truncated) {
        return JSON.stringify({ truncated: true, totalMatches, results: result });
      }
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  }
}

/** 截断字符串到指定长度，超出部分以 "…" 结尾标记 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}
