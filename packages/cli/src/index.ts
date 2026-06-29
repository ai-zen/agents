#!/usr/bin/env node

import { createRequire } from "module";
import chalk from "chalk";
import { showMainMenu } from "./menus/index.js";
import { startNewConversation } from "./menus/start-conversation.js";
import { installHook, uninstallHook } from "./hook.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

/**
 * CLI 入口
 *
 * aiz              → 进入交互式主菜单
 * aiz <消息内容>    → 直接进入对话
 * aiz hook install  → 安装 shell 兜底钩子
 * aiz hook uninstall → 卸载 shell 兜底钩子
 */

async function main(): Promise<void> {
  console.log(chalk.green.bold(`🧠 AI Agents CLI v${version}`));

  const args = process.argv.slice(2);

  if (args.length === 0) {
    // 无参数：进入交互式主菜单（循环）
    while (true) {
      await showMainMenu();
    }
    return;
  }

  // 处理 hook 命令
  if (args[0] === "hook") {
    const action = args[1];
    if (action === "install") {
      installHook();
    } else if (action === "uninstall") {
      uninstallHook();
    } else {
      console.error("❌ 用法: aiz hook install|uninstall");
      process.exit(1);
    }
    return;
  }

  // 有参数且不是 hook 命令：直接进入对话（参数作为初始消息）
  const message = args.join(" ");
  console.log(chalk.blue.bold(`\n🤖 快速开始: "${message}"\n`));
  await startNewConversation(message);
}

main().catch((error) => {
  console.error(chalk.red(`\n❌ 意外错误: ${error.message}\n`));
  process.exit(1);
});
