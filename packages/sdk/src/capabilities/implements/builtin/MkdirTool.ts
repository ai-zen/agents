import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class MkdirTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "mkdir",
    description: "创建目录",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "目录路径",
        },
        recursive: {
          type: "boolean",
          description: "是否递归创建子目录",
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
      await fsp.mkdir(this.resolve(input.path), {
        recursive: input.recursive ?? false,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  }
}
