import * as fsp from "fs/promises";
import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class ReadFileTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "readFile",
    description: "读取文件",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径",
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
    try {
      const filePath = this.resolve(input.path);
      const stats = await fsp.stat(filePath);
      if (stats.size > 300 * 1024) {
        throw new Error(`文件过大，无法读取，当前文件大小 ${stats.size} 字节`);
      }
      return await fsp.readFile(filePath, "utf-8");
    } catch (error: any) {
      return error?.message;
    }
  }
}
