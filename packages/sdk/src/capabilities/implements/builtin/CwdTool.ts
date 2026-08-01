import { SdkCallbackTool } from "../../../runtime/SdkCallbackTool.js";
import type { ToolEnv } from "../../../types/index.js";

export class CwdTool extends SdkCallbackTool {
  constructor(env: ToolEnv) {
    super({
      function: {
        name: "cwd",
        description: "获取当前工作目录 cwd",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      env,
    });
  }

  call(): string {
    return this.env.cwd;
  }
}
