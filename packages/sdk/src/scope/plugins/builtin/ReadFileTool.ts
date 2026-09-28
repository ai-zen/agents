import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput } from "./outputGuard.js";

export class ReadFileTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "readFile",
    description: "读取文件",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径",
        },
        range: {
          type: "array",
          description:
            "读取范围 [起始行, 起始列, 结束行, 结束列]，行列均从 0 开始，-1 表示末位；" +
            "例如 [0, 0, 100, -1] 表示从第 0 行第 0 列读到第 100 行最后一列。省略则读取整个文件。",
          items: {
            type: "number",
          },
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { path: string; range?: number[] }): Promise<string> {
    try {
      const filePath = this.resolve(input.path);
      const stats = await fsp.stat(filePath);
      // 读取阈值：文件过大时拒绝读取（与输出阈值 maxToolOutput 无关）
      if (stats.size > 300 * 1024) {
        throw new Error(`文件过大，无法读取，当前文件大小 ${stats.size} 字节`);
      }
      const content = await fsp.readFile(filePath, "utf-8");
      const output = input.range ? sliceByRange(content, input.range) : content;

      // 输出保护：本次返回内容超过上限时只警告、不落盘，并提示用 range 分批读取
      const limit = this.env.config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT;
      return await guardOutput({
        tool: "readFile",
        content: output,
        isOverLimit: (text) => text.length > limit,
        buildWarning: () =>
          `读取内容过大：本次输出 ${output.length} 字符，超过上限 ${limit} 字符，未落盘。` +
          `文件共 ${countLines(content)} 行、${content.length} 字符，` +
          `请用 range 参数分范围读取（形如 [起始行, 起始列, 结束行, 结束列]，行列从 0 开始，-1 表示末位）。`,
      });
    } catch (error: any) {
      return error?.message;
    }
  }
}

/**
 * 按 [起始行, 起始列, 结束行, 结束列] 切片（0-based，-1 表末位）。
 *
 * - 起始行至结束行逐行取出；起始行从起始列起截取，结束行截取到结束列（含）；
 * - 结束列为 -1 时取到行末，故 [0, 0, 100, -1] 即"第 0 行第 0 列到第 100 行末"；
 * - 越界索引自动夹取到有效范围。
 */
function sliceByRange(content: string, range: number[]): string {
  const lines = content.split("\n");
  const [rawStartLine = 0, rawStartCol = 0, rawEndLine = -1, rawEndCol = -1] = range;

  const startLine = resolveIndex(rawStartLine, lines.length);
  const endLine = resolveIndex(rawEndLine, lines.length);
  if (endLine < startLine) return "";

  const selected: string[] = [];
  for (let index = startLine; index <= endLine; index++) {
    const line = lines[index] ?? "";
    const from = index === startLine ? resolveIndex(rawStartCol, line.length) : 0;
    const to = index === endLine ? resolveIndex(rawEndCol, line.length) : line.length - 1;
    selected.push(line.slice(from, to + 1));
  }
  return selected.join("\n");
}

/** 解析行列索引：-1 表末位，其余负值自末尾倒数，越界夹取到有效范围 */
function resolveIndex(index: number, length: number): number {
  if (!Number.isFinite(index) || length === 0) return 0;
  const normalized = index < 0 ? length + index : index;
  if (normalized < 0) return 0;
  if (normalized > length - 1) return length - 1;
  return normalized;
}

/** 统计文本行数（空文本记 0 行） */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}
