import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class ExistTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "exist",
    description: "Check whether a file or directory exists",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File or directory path",
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
