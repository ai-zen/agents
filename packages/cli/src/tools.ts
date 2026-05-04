import { CallbackTool } from "@ai-zen/agents-core";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const shellTool = new CallbackTool({
  function: {
    name: "shell",
    description: "执行 Shell 命令",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令" },
      },
      required: ["command"],
    },
  },
  async callback({ command }) {
    try {
      const { stdout, stderr } = await execAsync(command);
      return stdout + stderr;
    } catch (error: any) {
      return error.stdout + error.stderr || error.message;
    }
  },
});
