import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class RenameTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "rename",
    description: "Rename or move a file/directory (equivalent to the mv command)",
    parameters: {
      type: "object",
      properties: {
        oldPath: {
          type: "string",
          description: "Original path",
        },
        newPath: {
          type: "string",
          description: "New path",
        },
      },
      required: ["oldPath", "newPath"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { oldPath: string; newPath: string }): Promise<string> {
    try {
      await fsp.rename(this.resolve(input.oldPath), this.resolve(input.newPath));
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  }
}
