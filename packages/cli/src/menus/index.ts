import chalk from "chalk";
import inquirer from "inquirer";
import { startNewConversation, continueConversation, continueDraft } from "./start-conversation.js";
import { manageConversations } from "./conversations.js";
import { manageAgentsInteractive } from "./agents.js";
import { showInteractiveConfig } from "./config.js";
import { readDraft } from "../draft.js";

/**
 * 主菜单
 */
export async function showMainMenu(): Promise<void> {
  console.log(chalk.blue.bold("\n🤖 欢迎使用 AI-Zen CLI\n"));

  // 检测是否有未完成的草稿对话
  const draft = readDraft();

  const choices: { name: string; value: string }[] = [];

  // 如果有草稿，放在最前面作为首选
  if (draft) {
    const timeStr = new Date(draft.updatedAt).toLocaleString("zh-CN");
    choices.push(
      {
        name: `▶️  继续上次未完成的对话 (${draft.messageCount} 条消息, ${timeStr})`,
        value: "continue-draft",
      },
      { name: "💬 开始新对话（放弃草稿）", value: "chat" },
    );
  } else {
    choices.push({ name: "💬 开始新对话", value: "chat" });
  }

  choices.push(
    { name: "📂 继续已保存的对话", value: "continue" },
    { name: "📋 管理已保存的对话", value: "manage-convs" },
    { name: "🤖 管理 Agents", value: "manage-agents" },
    { name: "⚙️  配置管理", value: "config" },
    { name: "❌ 退出", value: "exit" },
  );

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "请选择操作:",
      choices,
    },
  ]);

  switch (action) {
    case "continue-draft":
      await continueDraft();
      break;
    case "chat":
      await startNewConversation();
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
