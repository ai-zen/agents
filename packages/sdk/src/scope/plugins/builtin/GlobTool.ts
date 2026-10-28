import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headPreview } from "./outputGuard.js";

export class GlobTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "glob",
    description:
      "Recursively scan for and find files using a glob pattern. This is the preferred tool for file system searches, far better than a plain 'ls' listing. Prefer this tool when you need to find files of a specific type, walk a directory tree, or exclude specific files.",
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
            `Output too large: the matches total ${json.length} characters, exceeding the limit of ${limit} characters. ` +
            `The full result has been written to disk (result.json) and can be read in chunks with read; ` +
            `alternatively, narrow the scope with a more precise pattern or exclude and search again.`,
          files: ctx.files,
          chars: json.length,
          ...preview,
        });
      },
    });
  }
}
