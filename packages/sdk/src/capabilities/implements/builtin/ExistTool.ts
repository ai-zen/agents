import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class ExistTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "exist",
    description: "检查文件或目录是否存在",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件或目录路径",
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
    return await fsp
      .access(this.resolve(input.path))
      .then(() => "true")
      .catch(() => "false");
  }
}
