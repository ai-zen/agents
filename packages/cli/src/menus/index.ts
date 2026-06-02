import chalk from "chalk";
import inquirer from "inquirer";
import { startNewChat, continueConversation } from "./chat.js";
import { manageConversations } from "./conversations.js";
import { manageAgentsInteractive } from "./agents.js";
import { showInteractiveConfig } from "./config.js";

/**
 * 主菜单
 */
export async function showMainMenu(): Promise<void> {
  console.log(chalk.blue.bold("\n🤖 欢迎使用 AI-Zen CLI\n"));

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "请选择操作:",
      choices: [
        { name: "💬 开始新对话", value: "chat" },
        { name: "📂 继续已保存的对话", value: "continue" },
        { name: "📋 管理已保存的对话", value: "manage-convs" },
        { name: "🤖 管理 Agents", value: "manage-agents" },
        { name: "⚙️  配置管理", value: "config" },
        { name: "❌ 退出", value: "exit" },
      ],
    },
  ]);

  switch (action) {
    case "chat":
      await startNewChat();
      break;
    case "continue":
      await continueConversation();
      break;
    case "manage-convs":
      await manageConversations();
      break;
    case "manage-agents":
      await manageAgentsInteractive();
      break;
    case "config":
      await showInteractiveConfig();
      break;
    case "exit":
      console.log(chalk.blue("\n👋 再见！\n"));
      process.exit(0);
  }
}
