import { CallbackTool } from "@ai-zen/agents-core";
import { exec } from "child_process";

export const execTool = new CallbackTool({
  function: {
    name: "exec",
    description: "执行命令",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的命令",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  async callback(input): Promise<string> {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
      exec(input.command as string, (error, stdout, stderr) => {
        resolve({ stdout, stderr });
      });
    });
    return JSON.stringify(result);
  },
});
