import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";
import type { AgentNS } from "@ai-zen/agents-core";

export class CwdTool extends SdkCallbackTool {
  function: AgentNS.FunctionDefine = {
    name: "cwd",
    description: "获取当前工作目录 cwd",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  };

  constructor(env: ToolEnv) {
    super({ env });
  }

  call(): string {
    return this.env.cwd;
  }
}
