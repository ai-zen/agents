import * as fsp from "fs/promises";
import * as path from "path";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class WriteTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "write",
    description: "Write a file",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path",
        },
        content: {
          type: "string",
          description: "File content",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
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
