import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class ExistTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
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
      },
      env,
    });
  }

  async call(input: { path: string }): Promise<string> {
    return await fsp
      .access(this.resolve(input.path))
      .then(() => "true")
      .catch(() => "false");
  }
}
