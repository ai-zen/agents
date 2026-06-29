import chalk from "chalk";
import inquirer from "inquirer";
import { Agent } from "@ai-zen/agents-core";
import { ConversationContext } from "../types.js";

export async function handleEditor(agent: Agent, ctx: ConversationContext): Promise<void> {
  const { content } = await inquirer.prompt([
    { type: "editor", name: "content", message: "编辑消息:" },
  ]);

  if (!content.trim()) {
    console.log(chalk.gray("已取消\n"));
    ctx.input = "";
    return;
  }

  ctx.input = content.trim();
}
