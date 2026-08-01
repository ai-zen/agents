import * as fsp from "fs/promises";
import * as path from "path";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class WriteFileTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
        name: "writeFile",
        description: "写入文件",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "文件路径",
            },
            content: {
              type: "string",
              description: "文件内容",
            },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      env,
    });
  }

  async call(input: { path: string; content: string }): Promise<string> {
    try {
      const filePath = this.resolve(input.path);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, input.content);
      return "success";
    } catch (error: any) {
      return error?.message;
    }
  }
}
