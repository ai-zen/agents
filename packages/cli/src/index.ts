#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import { registerChatCommand } from "./commands/chat.js";
import { registerConversationsCommand } from "./commands/conversations.js";
import { registerAgentsCommand } from "./commands/agents.js";
import { registerConfigCommand } from "./commands/config.js";
import { getConversationsList, loadConversation } from "./conversations.js";
import { createAgent } from "./agent-creator.js";
import { runConversation } from "./conversation-runner.js";
import { ensureEndpointConfig } from "./config-wizard.js";
import pkg from "../package.json" with { type: "json" };

// ==================== 主程序 ====================

const program = new Command();

program
  .name("aiz")
  .description("🤖 AI Agent 命令行工具 - 支持 OpenAI、BigModelCN、DeepSeek")
  .version(pkg.version);

// 注册子命令
registerChatCommand(program);
registerConversationsCommand(program);
registerAgentsCommand(program);
registerConfigCommand(program);

// ==================== 顶级 load 命令 ====================
// 允许 aiz load [conv-name] 直接加载对话，无需 aiz conv load [conv-name]

program
  .command("load <id>")
  .description("从保存的对话继续（等效于 aiz conv load <id>）")
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

// ==================== 快速启动 ====================

// 如果没有参数，进入交互式菜单
async function showInteractiveMenu() {
  try {
    console.log(chalk.blue.bold("\n🤖 欢迎使用 AI-Zen CLI\n"));

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "请选择操作:",
        choices: [
          { name: "💬 开始新对话", value: "chat" },
          { name: "📋 查看已保存的对话", value: "list-conversations" },
          { name: "💾 继续已保存的对话", value: "load-conversation" },
          { name: "🤖 管理 Agents", value: "manage-agents" },
          { name: "⚙️  管理配置", value: "config" },
        ],
      },
    ]);

    switch (action) {
      case "chat":
        await program.parseAsync(["node", "aiz", "chat"]);
        break;
      case "list-conversations":
        const conversations = getConversationsList();
        if (conversations.length === 0) {
          console.log(chalk.yellow("\n📭 没有已保存的对话\n"));
        } else {
          console.log(chalk.blue.bold("\n📋 已保存的对话:\n"));
          const { selected } = await inquirer.prompt([
            {
              type: "list",
              name: "selected",
              message: "选择要加载的对话:",
              choices: [
                ...conversations.map((c) => ({
                  name: `${c.name} (${new Date(c.updatedAt).toLocaleString("zh-CN")})`,
                  value: c.id,
                })),
                { name: "返回", value: "" },
              ],
            },
          ]);
          if (selected) {
            await program.parseAsync([
              "node",
              "aiz",
              "conv",
              "load",
              selected,
            ]);
          }
        }
        break;
      case "load-conversation":
        const allConversations = getConversationsList();
        if (allConversations.length === 0) {
          console.log(chalk.yellow("\n📭 没有已保存的对话\n"));
        } else {
          const { convId } = await inquirer.prompt([
            {
              type: "list",
              name: "convId",
              message: "选择对话:",
              choices: allConversations.map((c) => ({
                name: `${c.name} (${c.messageCount} 条消息)`,
                value: c.id,
              })),
            },
          ]);
          await program.parseAsync(["node", "aiz", "conv", "load", convId]);
        }
        break;
      case "manage-agents":
        await program.parseAsync(["node", "aiz", "agents", "list"]);
        break;
      case "config":
        await program.parseAsync(["node", "aiz", "config", "show"]);
        break;
    }
  } catch (error: any) {
    console.error(chalk.red(`\n❌ 错误: ${error.message}\n`));
  }
  // 交互式菜单结束后退出
  process.exit(0);
}

// 如果没有参数，进入交互式菜单
if (process.argv.length <= 2) {
  showInteractiveMenu();
} else {
  // 解析命令行参数
  program.parse(process.argv);
}
