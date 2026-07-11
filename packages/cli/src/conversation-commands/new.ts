import chalk from "chalk";
import inquirer from "inquirer";
import { Message } from "@ai-zen/agents-core";
import { formatShortTime } from "../format-time.js";
import { ConversationContext } from "../types.js";

export async function handleNew(ctx: ConversationContext): Promise<void> {
  const agent = ctx.agent;
  const { confirmNew } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmNew",
      message: "确定要开始新对话吗？当前对话将丢失。",
      default: false,
    },
  ]);

  if (!confirmNew) {
    console.log(chalk.gray("已取消\n"));
    return;
  }

  // 清空消息，只保留 system messages
  agent.messages = ctx.systemMessages.map((m) => new Message(m));

  // 更新上下文状态
  ctx.currentName = `对话_${formatShortTime(new Date().toISOString())}`;
  ctx.currentId = undefined;
  ctx.input = "";

  console.log(chalk.blue.bold("\n🆕 新会话已开始\n"));
}
