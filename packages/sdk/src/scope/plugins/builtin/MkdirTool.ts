import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class MkdirTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "mkdir",
    description: "Create a directory",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path",
        },
        recursive: {
          type: "boolean",
          description: "Whether to create parent directories recursively",
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
