import * as fsp from "fs/promises";
import { createReadStream } from "fs";
import { StringDecoder } from "string_decoder";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT } from "./outputGuard.js";

/** 行尾类型 */
type LineEnding = "LF" | "CRLF" | "mixed";

/** 流式扫描结果 */
interface ScanResult {
  /** 总行数（0-based 行索引共 lines 个） */
  lines: number;
  /** 总字符数（不含换行符，与各行"列数"之和一致） */
  chars: number;
  /** 最长行的列数 */
  maxCol: number;
  /** 最长行的行索引（0-based） */
  lineIndexOfMaxCol: number;
  /** 行尾类型 */
  lineEnding: LineEnding;
  /** 每行列数映射（行索引 → 列数），仅在请求时构建 */
  colCountMap: Record<string, number>;
}

/**
 * 勘察文件结构概况（行数、每行列数等），不做内容读取。
 *
 * 定位与 readFile 的 range 配套：大文件先看结构（有多少行、每行多长），
 * 再决定 readFile 的读取范围。流式扫描，故不受 readFile 的 300KB 读取阈值限制。
 */
export class InspectFileTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "inspectFile",
    description:
      "勘察文件的结构概况：总行数、总字符数、最长行的列数及其行索引、平均列数、行尾类型（LF/CRLF）。可选返回每行的列数映射。适用于在 readFile 之前先了解文件规模，再决定用 range 读取哪一段。仅做流式扫描，不受 readFile 的 300KB 读取阈值限制。",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径",
        },
        withColCountMap: {
          type: "boolean",
          description:
            "是否返回每行列数映射（对象：行索引 → 列数，行索引从 0 开始）。默认 false。行数很多时该映射可能过大，此时将只返回概况字段。",
          default: false,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { path: string; withColCountMap?: boolean }): Promise<string> {
    try {
      const filePath = this.resolve(input.path);
      const stats = await fsp.stat(filePath);
      if (!stats.isFile()) {
        return `"${filePath}" 不是文件`;
      }

      const withColCountMap = input.withColCountMap ?? false;
      const result = await scan(filePath, withColCountMap);

      const summary = {
        path: filePath,
        bytes: stats.size,
        lines: result.lines,
        chars: result.chars,
        maxCol: result.maxCol,
        lineIndexOfMaxCol: result.lineIndexOfMaxCol,
        avgCol: result.lines === 0 ? 0 : Math.round(result.chars / result.lines),
        lineEnding: result.lineEnding,
      };

      if (!withColCountMap) return JSON.stringify(summary);

      // 明细超限时只返回概况 + 提示（不落盘）：文件规模已超出可处理范围
      const limit = this.env.config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT;
      const payload = JSON.stringify({ ...summary, colCountMap: result.colCountMap });
      if (payload.length > limit) {
        return JSON.stringify({
          ...summary,
          colCountMapOmitted: true,
          warning:
            `行长度明细过大：概况与 colCountMap 合计 ${payload.length} 字符，` +
            `超过上限 ${limit} 字符，未落盘返回。文件规模超出可处理范围，` +
            `建议改用 findText 定位后再按 range 分段读取。`,
        });
      }
      return payload;
    } catch (error: any) {
      return error?.message;
    }
  }
}

/**
 * 流式扫描文件，统计行数、字符数与每行列数。
 *
 * 口径：行索引 0-based；列数按字符数（UTF-16 长度）计、不含行尾换行符（CRLF 的 \r 不计）。
 */
async function scan(filePath: string, withColCountMap: boolean): Promise<ScanResult> {
  const decoder = new StringDecoder("utf8");
  const colCountMap: Record<string, number> = {};

  let lines = 0;
  let chars = 0;
  let col = 0;
  let maxCol = 0;
  let lineIndexOfMaxCol = 0;
  let sawLf = false;
  let sawCrlf = false;
  let lastWasNewline = false;
  let sawAnyChar = false;
  /** 上一个字符是 \r，等待判定它是否属于 CRLF */
  let pendingCr = false;

  const endLine = () => {
    if (withColCountMap) colCountMap[String(lines)] = col;
    if (col > maxCol) {
      maxCol = col;
      lineIndexOfMaxCol = lines;
    }
    chars += col;
    lines++;
    col = 0;
    lastWasNewline = true;
  };

  const processText = (text: string) => {
    // 按 code unit 遍历，与 String.length 口径一致
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      sawAnyChar = true;

      if (char === "\n") {
        if (pendingCr) {
          sawCrlf = true;
          pendingCr = false;
        } else {
          sawLf = true;
        }
        endLine();
        continue;
      }

      // 前一个字符是 \r 且其后不是 \n：属孤立的 \r，作为行内字符计入
      if (pendingCr) {
        col++;
        pendingCr = false;
      }

      if (char === "\r") {
        pendingCr = true;
        lastWasNewline = false;
        continue;
      }

      col++;
      lastWasNewline = false;
    }
  };

  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    processText(decoder.write(chunk as Buffer));
  }
  processText(decoder.end());

  // 文件末尾残留的孤立 \r
  if (pendingCr) col++;
  // 末行未以换行结束（空文件不计行）
  if (sawAnyChar && !lastWasNewline) endLine();

  const lineEnding: LineEnding = sawCrlf && sawLf ? "mixed" : sawCrlf ? "CRLF" : "LF";
  return { lines, chars, maxCol, lineIndexOfMaxCol, lineEnding, colCountMap };
}
