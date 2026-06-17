#!/usr/bin/env node

import { createRequire } from "module";
import chalk from "chalk";
import { showMainMenu } from "./menus/index.js";
import { startNewChat } from "./menus/chat.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

/**
 * CLI 入口
 *
 * aiz              → 进入交互式主菜单
 * aiz <消息内容>    → 直接进入对话
 */

async function main(): Promise<void> {
  console.log(chalk.green.bold(`🧠 AI Agents CLI v${version}`));

  const args = process.argv.slice(2);

  if (args.length > 0) {
    // 有参数：直接进入对话（参数作为初始消息提示）
    const message = args.join(" ");
    console.log(chalk.blue.bold(`\n🤖 快速开始: "${message}"\n`));
    await startNewChat();
  } else {
    // 无参数：进入交互式主菜单（循环）
    while (true) {
      await showMainMenu();
    }
  }
}

main().catch((error) => {
  console.error(chalk.red(`\n❌ 意外错误: ${error.message}\n`));
  process.exit(1);
});
