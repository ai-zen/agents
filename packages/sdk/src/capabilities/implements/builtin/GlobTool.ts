import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS, ToolCallContext } from "@ai-zen/agents-core";

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
        return JSON.stringify({ aborted: true, files: result });
      }
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  }
}
