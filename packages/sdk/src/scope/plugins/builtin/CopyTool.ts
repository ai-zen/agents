import * as fsp from "fs/promises";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class CopyTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "copy",
    description: "Copy a file or directory (equivalent to the cp command)",
    parameters: {
      type: "object",
      properties: {
        src: {
          type: "string",
          description: "Source path",
        },
        dest: {
          type: "string",
          description: "Destination path",
        },
        recursive: {
          type: "boolean",
          description: "Whether to copy directories recursively; must be true when copying a directory",
        },
      },
      required: ["src", "dest"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  async call(input: { src: string; dest: string; recursive?: boolean }): Promise<string> {
    try {
      await fsp.cp(this.resolve(input.src), this.resolve(input.dest), {
        recursive: input.recursive ?? false,
      });
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  }
}
