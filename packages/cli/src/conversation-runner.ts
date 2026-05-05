import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { Agent, AgentNS } from "@ai-zen/agents-core";
import { saveConversation } from "./conversations.js";

// ==================== 对话交互 ====================

export async function runConversation(
  agent: Agent,
  modelId: string,
  conversationId?: string,
  conversationName?: string,
  agentId?: string,
): Promise<void> {
  console.log(chalk.blue.bold("\n" + "=".repeat(60)));
  console.log(
    chalk.blue.bold(
      "  对话已开始 (输入 'exit' 退出, 'save' 保存, 'clear' 清屏)",
    ),
  );
  console.log(chalk.blue.bold("=".repeat(60) + "\n"));

  let shouldContinue = true;
  let currentName =
    conversationName || `对话_${new Date().toLocaleDateString()}`;
  let currentId = conversationId;

  while (shouldContinue) {
    const { question } = await inquirer.prompt([
      {
        type: "input",
        name: "question",
        message: chalk.cyan("你:"),
        prefix: "💬",
      },
    ]);

    const trimmedQuestion = question.trim();

    // 处理命令
    if (
      trimmedQuestion.toLowerCase() === "exit" ||
      trimmedQuestion.toLowerCase() === "quit"
    ) {
      // 询问是否保存
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
            currentId = saveConversation(
              currentName,
              agent.messages,
              modelId,
              currentId,
              agentId,
            );
            console.log(
              chalk.green(
                `\n✅ 对话已保存: ${currentName} (ID: ${currentId})\n`,
              ),
            );
          } catch (error) {
            console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
          }
        }
      }
      shouldContinue = false;
      break;
    }

    if (trimmedQuestion.toLowerCase() === "save") {
      const { name } = await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "对话名称:",
          default: currentName,
        },
      ]);

      try {
        currentName = name;
        currentId = saveConversation(
          currentName,
          agent.messages,
          modelId,
          currentId,
          agentId,
        );
        console.log(
          chalk.green(`\n✅ 对话已保存: ${currentName} (ID: ${currentId})\n`),
        );
      } catch (error) {
        console.error(chalk.red(`\n❌ 保存失败: ${error}\n`));
      }
      continue;
    }

    if (trimmedQuestion.toLowerCase() === "clear") {
      console.clear();
      console.log(chalk.blue.bold("\n" + "=".repeat(60)));
      console.log(chalk.blue.bold("  屏幕已清空"));
      console.log(chalk.blue.bold("=".repeat(60) + "\n"));
      continue;
    }

    if (trimmedQuestion.toLowerCase() === "history") {
      console.log(chalk.yellow.bold("\n📋 对话历史:"));
      for (let i = 0; i < agent.messages.length; i++) {
        const msg = agent.messages[i];
        if (msg.role === AgentNS.Role.User) {
          console.log(chalk.cyan(`👤 你: ${msg.content}`));
        } else if (msg.role === AgentNS.Role.Assistant) {
          const content =
            typeof msg.content === "string"
              ? msg.content.substring(0, 100) +
                (msg.content.length > 100 ? "..." : "")
              : "[复杂内容]";
          console.log(chalk.green(`🤖 AI: ${content}`));
        }
      }
      console.log();
      continue;
    }

    if (!trimmedQuestion) continue;

    // 发送问题并获取回答
    const spinner = ora({
      text: chalk.yellow("AI 正在思考..."),
      spinner: "dots",
    }).start();

    try {
      const messages = await agent.send(trimmedQuestion);
      spinner.stop();

      const lastMessage = messages.at(-1);

      if (lastMessage?.status === "error") {
        console.error(chalk.red(`\n❌ 发生错误: \n`), lastMessage);
        return;
      }

      if (lastMessage?.role === AgentNS.Role.Assistant) {
        console.log(chalk.green.bold("\n🤖 AI:"));
        if (typeof lastMessage.reasoning_content === "string") {
          console.log(chalk.blue.bold("\n" + "=".repeat(60)));
          console.log(chalk.blue.bold("  AI 思考过程:"));
          console.log(formatMessage(lastMessage.reasoning_content));
          console.log(chalk.blue.bold("=".repeat(60) + "\n"));
        }

        if (typeof lastMessage.content === "string") {
          // 格式化输出，支持代码块
          console.log(formatMessage(lastMessage.content));
        } else if (Array.isArray(lastMessage.content)) {
          for (const section of lastMessage.content) {
            if (section.type === "text") {
              console.log(formatMessage(section.text));
            } else if (section.type === "image_url") {
              console.log(chalk.yellow(`[图片: ${section.image_url.url}]`));
            }
          }
        }
      }

      console.log();
    } catch (error: any) {
      spinner.stop();
      console.error(chalk.red(`\n❌ 发生错误: ${error.message || error}\n`));

      // 如果是 API Key 的问题，提示用户设置
      if (
        error.message?.includes("API Key") ||
        error.message?.includes("401") ||
        error.message?.includes("403")
      ) {
        console.log(
          chalk.yellow(
            "💡 提示: 请使用 'aiz config set-key' 设置正确的 API Key\n",
          ),
        );
      }
    }
  }

  console.log(chalk.blue.bold("\n👋 再见！\n"));
}

function formatMessage(content: string): string {
  // 简单的格式化，高亮代码块
  const lines = content.split("\n");
  let inCodeBlock = false;
  let formatted = "";

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      formatted += chalk.gray(line) + "\n";
    } else if (inCodeBlock) {
      formatted += chalk.yellow(line) + "\n";
    } else {
      formatted += line + "\n";
    }
  }

  return formatted;
}
