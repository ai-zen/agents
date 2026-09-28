import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";
import { DEFAULT_MAX_TOOL_OUTPUT, guardOutput, headPreview } from "./outputGuard.js";

export class LsTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "ls",
    description: "列出目录",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "目录路径",
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
              `输出过大：目录条目共 ${entries.length} 项、${json.length} 字符，超过上限 ${limit} 字符。` +
              `完整列表已落盘（result.json），可用 readFile 分批读取；` +
              `也可改用 glob 按模式筛选。`,
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
