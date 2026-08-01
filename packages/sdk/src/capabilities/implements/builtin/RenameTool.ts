import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class RenameTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
        name: "rename",
        description: "重命名或移动文件/目录（相当于 mv 命令）",
        parameters: {
          type: "object",
          properties: {
            oldPath: {
              type: "string",
              description: "原路径",
            },
            newPath: {
              type: "string",
              description: "新路径",
            },
          },
          required: ["oldPath", "newPath"],
          additionalProperties: false,
        },
      },
      env,
    });
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
