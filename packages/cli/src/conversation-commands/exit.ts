import chalk from "chalk";
import inquirer from "inquirer";
import { Agent } from "@ai-zen/agents-core";
import { saveConversation } from "../conversations.js";
import { clearDraft } from "../draft.js";
import { ConversationContext } from "./types.js";

export async function handleExit(agent: Agent, ctx: ConversationContext): Promise<void> {
  if (agent.messages.length > 1) {
    const { saveBeforeExit } = await inquirer.prompt([
      {
        type: "confirm",
        name: "saveBeforeExit",
        message: "退出前是否保存当前对话?",
        default: true,
      },
    ]);

    if (saveBeforeExit) {
      try {
        const id = saveConversation(
          ctx.currentName,
          agent.messages,
          ctx.modelId,
          ctx.currentId,
          ctx.agentId,
        );
        console.log(
          chalk.green(`\n✅ 对话已保存: ${ctx.currentName} (ID: ${id})\n`),
        );
        clearDraft();
      } catch (error) {
        console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
      }
    }
  }
  ctx.running = false;
}
