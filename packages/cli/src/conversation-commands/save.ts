import chalk from "chalk";
import inquirer from "inquirer";
import { saveConversation } from "../conversations.js";
import { ConversationContext } from "../types.js";

export async function handleSave(ctx: ConversationContext): Promise<void> {
  const agent = ctx.agent;
  const { name } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "对话名称:",
      default: ctx.currentName,
    },
  ]);

  try {
    const id = saveConversation(
      name,
      agent.messages,
      ctx.modelId,
      ctx.currentId,
      ctx.agentId,
    );
    console.log(chalk.green(`\n✅ 对话已保存: ${name} (ID: ${id})\n`));
    ctx.currentName = name;
    ctx.currentId = id;
  } catch (error) {
    console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
  }
}
