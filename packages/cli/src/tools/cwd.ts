import { CallbackTool } from "@ai-zen/agents-core";

export const cwd = new CallbackTool({
  function: {
    name: "cwd",
    description: "获取当前工作目录 cwd",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  async callback(): Promise<string> {
    return process.cwd();
  },
});
