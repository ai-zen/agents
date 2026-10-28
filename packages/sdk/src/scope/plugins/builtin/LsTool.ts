import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headPreview } from "./outputGuard.js";

export class LsTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "ls",
    description: "List a directory",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { path: string }): Promise<string> {
    try {
      const entries = await fsp.readdir(this.resolve(input.path));
      const json = JSON.stringify(entries);

      // 输出保护：结果超过 maxToolOutput 时落盘为 result.json，返回警告 + 头部预览
      const limit = this.env.config.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT;
      return await guardOutput({
        tool: "ls",
        content: json,
        isOverLimit: (text) => text.length > limit,
        dump: (_dir, text) => [{ name: "result.json", content: text }],
        buildWarning: (ctx) => {
          const preview = headPreview(json);
          return JSON.stringify({
            outputTooLarge: true,
            warning:
              `Output too large: ${entries.length} directory entries, ${json.length} characters in total, exceeding the limit of ${limit} characters. ` +
              `The full list has been written to disk (result.json) and can be read in chunks with read; ` +
              `alternatively, use glob to filter by pattern.`,
            files: ctx.files,
            chars: json.length,
            ...preview,
          });
        },
      });
    } catch (error: any) {
      return error?.message;
    }
  }
}
