import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headPreview } from "./outputGuard.js";

export class GlobTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
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
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(
    input: { path?: string; pattern: string; exclude?: string[] },
    ctx?: ToolCallContext,
  ): Promise<string> {
    const signal = ctx?.signal;
    try {
      const cwd = input.path ? this.resolve(input.path) : this.env.cwd;
      const result: string[] = [];
      for await (const file of fsp.glob(input.pattern, {
        exclude: input.exclude || ["**/node_modules/**"],
        cwd,
      })) {
        if (signal?.aborted) break; // 中断：停止继续遍历/消费
        result.push(file);
      }
      if (signal?.aborted) {
        return await this.protect(JSON.stringify({ aborted: true, files: result }));
      }
      return await this.protect(JSON.stringify(result));
    } catch (error: any) {
      return error?.message;
    }
  }

  /**
   * 输出保护：结果 JSON 超过 maxToolOutput 时落盘为 result.json，
   * 返回警告 + 头部预览；未超限则原样返回。
   */
  private async protect(json: string): Promise<string> {
    const limit = this.env.config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT;
    return await guardOutput({
      tool: "glob",
      content: json,
      isOverLimit: (text) => text.length > limit,
      dump: (_dir, text) => [{ name: "result.json", content: text }],
      buildWarning: (ctx) => {
        const preview = headPreview(json);
        return JSON.stringify({
          outputTooLarge: true,
          warning:
            `输出过大：匹配结果共 ${json.length} 字符，超过上限 ${limit} 字符。` +
            `完整结果已落盘（result.json），可用 readFile 分批读取；` +
            `也可用更精确的 pattern 或 exclude 缩小范围后重新查找。`,
          files: ctx.files,
          chars: json.length,
          ...preview,
        });
      },
    });
  }
}
