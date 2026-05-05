import chalk from "chalk";
import inquirer from "inquirer";
import { Command } from "commander";
import {
  getConversationsList,
  loadConversation,
  deleteConversation,
} from "../conversations.js";
import { createAgent } from "../agent-creator.js";
import { runConversation } from "../conversation-runner.js";
import { ensureEndpointConfig } from "../config-wizard.js";
export function registerConversationsCommand(program: Command): void {
  const conversationsCommand = program
    .command("conversations")
    .alias("conv")
    .description("管理对话");

  conversationsCommand
    .command("list")
    .alias("ls")
    .description("列出所有已保存的对话")
    .option("-n, --number <number>", "显示最近 N 条对话")
    .action((options) => {
      let conversations = getConversationsList();

      if (options.number) {
        conversations = conversations.slice(0, parseInt(options.number));
      }

      if (conversations.length === 0) {
        console.log(chalk.yellow("\n📭 没有已保存的对话\n"));
        return;
      }

      console.log(chalk.blue.bold("\n📋 已保存的对话:\n"));
      console.log(chalk.gray("─".repeat(80)));

      for (const conversation of conversations) {
        const date = new Date(conversation.createdAt).toLocaleString("zh-CN");
        const updateDate = new Date(conversation.updatedAt).toLocaleString(
          "zh-CN",
        );

        console.log(chalk.white.bold(`  📝 ${conversation.name}`));
        console.log(chalk.gray(`     ID: ${conversation.id}`));
        console.log(chalk.gray(`     模型: ${conversation.modelId}`));
        console.log(chalk.gray(`     消息数: ${conversation.messageCount}`));
        console.log(chalk.gray(`     创建时间: ${date}`));
        console.log(chalk.gray(`     更新时间: ${updateDate}`));
        console.log(chalk.gray("─".repeat(80)));
      }
    });

  conversationsCommand
    .command("load <id>")
    .description("从保存的对话继续")
    .option("-m, --model <model-id>", "切换模型")
    .action(async (id, options) => {
      try {
        const conversation = loadConversation(id);
        console.log(chalk.green(`\n✅ 已加载对话: ${conversation.name}\n`));

        const modelId = options.model || conversation.modelId;
        const model = await ensureEndpointConfig(modelId);
        const agent = await createAgent(model.id, conversation.messages);

        await runConversation(
          agent,
          model.id,
          conversation.id,
          conversation.name,
          conversation.agentId,
        );
      } catch (error: any) {
        console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
        process.exit(1);
      }
    });

  conversationsCommand
    .command("delete <id>")
    .description("删除指定的对话")
    .action(async (id) => {
      try {
        const conversation = loadConversation(id);
        const { confirm } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirm",
            message: `确定要删除对话 "${conversation.name}" 吗?`,
            default: false,
          },
        ]);

        if (confirm) {
          deleteConversation(id);
          console.log(chalk.green(`\n✅ 对话 "${conversation.name}" 已删除\n`));
        }
      } catch (error: any) {
        console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
        process.exit(1);
      }
    });
}
