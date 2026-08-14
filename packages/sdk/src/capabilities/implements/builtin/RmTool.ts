import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class RmTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "rm",
    description: "删除文件或目录",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件或目录路径",
        },
        recursive: {
          type: "boolean",
          description: "是否递归删除子目录",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { path: string; recursive?: boolean }): Promise<string> {
    try {
      await fsp.rm(this.resolve(input.path), {
        recursive: input.recursive ?? false,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  }
}
