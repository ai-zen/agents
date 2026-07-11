import { ConversationContext, CommandHandler } from "../types.js";
import { handleExit } from "./exit.js";
import { handleSave } from "./save.js";
import { handleNew } from "./new.js";
import { handleBack } from "./back.js";
import { handleEditor } from "./editor.js";
import { handleClear } from "./clear.js";
import { handleHelp } from "./help.js";

/**
 * 命令注册表
 * key 为命令名称（不含 / 前缀），value 为处理函数
 */
const commands: Record<string, CommandHandler> = {
  exit: handleExit,
  quit: handleExit,
  save: handleSave,
  new: handleNew,
  back: handleBack,
  editor: handleEditor,
  clear: handleClear,
  help: handleHelp,
};

/**
 * 判断输入是否为命令（以 / 开头）
 */
export function isCommand(input: string): boolean {
  return input.startsWith("/");
}

/**
 * 分发命令
 * @returns true 表示是命令且已处理，false 表示不是命令
 */
export async function dispatchCommand(
  ctx: ConversationContext,
): Promise<boolean> {
  const input = ctx.input;

  if (!isCommand(input)) return false;

  // 去掉 / 前缀，取命令名
  const cmdName = input.slice(1).toLowerCase().trim();
  const handler = commands[cmdName];

  if (!handler) {
    console.log(`\n❌ 未知命令: ${input}  (输入 /help 查看可用命令)\n`);
    ctx.input = "";
    return true;
  }

  await handler(ctx);
  return true;
}

/**
 * 获取所有命令名称列表（用于提示信息）
 */
export function getCommandNames(): string[] {
  // 去重（exit 和 quit 指向同一处理函数）
  const names = new Set<string>();
  names.add("exit");
  names.add("quit");
  names.add("save");
  names.add("new");
  names.add("back");
  names.add("editor");
  names.add("clear");
  names.add("help");
  return Array.from(names).sort();
}
