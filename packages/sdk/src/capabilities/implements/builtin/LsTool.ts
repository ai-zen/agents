import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class LsTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
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
      },
      env,
    });
  }

  async call(input: { path: string }): Promise<string> {
    try {
      const result = await fsp.readdir(this.resolve(input.path));
      return JSON.stringify(result);
    } catch (error: any) {
      return error?.message;
    }
  }
}
