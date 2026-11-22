import * as fsp from "fs/promises";
import * as path from "path";
import { SdkCallbackTool } from "./SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

/**
 * `write` 这个工具名只在这里命名一次。
 *
 * 别处（交接守卫的门、「这一段有没有 write 工具」的判据）都引它 —— 一个工具名散成四处
 * 字面量，改一处漏三处的时候不会报错，只会默默失效。
 */
export const WRITE_TOOL_NAME = "write";

export class WriteTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: WRITE_TOOL_NAME,
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
