import chalk from "chalk";
import { ConversationContext } from "../types.js";

export async function handleHelp(ctx: ConversationContext): Promise<void> {
  console.log(chalk.blue.bold("\n📖 可用命令:\n"));
  console.log(`  ${chalk.cyan("/exit")}   ${chalk.gray("/quit")}   退出对话`);
  console.log(`  ${chalk.cyan("/save")}           保存当前对话`);
  console.log(`  ${chalk.cyan("/new")}            重置会话（清空历史）`);
  console.log(`  ${chalk.cyan("/back")}           撤回消息（可修改后重发）`);
  console.log(`  ${chalk.cyan("/editor")}         使用系统编辑器输入长消息`);
  console.log(`  ${chalk.cyan("/clear")}          清屏`);
  console.log(`  ${chalk.cyan("/help")}           显示此帮助\n`);
}
