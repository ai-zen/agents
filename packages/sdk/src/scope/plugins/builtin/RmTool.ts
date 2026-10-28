import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class RmTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "rm",
    description: "Delete a file or directory",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File or directory path",
        },
        recursive: {
          type: "boolean",
          description: "Whether to delete subdirectories recursively",
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
