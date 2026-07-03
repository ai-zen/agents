import chalk from "chalk";
import {
  getConversationsList,
  deleteConversation,
  loadConversation,
} from "../conversations.js";
import { formatRelativeTime, formatFileSize } from "../format-time.js";
import {
  selectItemAndAction,
  confirmAction,
  SEPARATOR_LONG,
} from "./common.js";

/**
 * 展现对话详情
 */
function formatConversationDetails(
  c: ReturnType<typeof getConversationsList>[0],
): string[] {
  return [
    chalk.white.bold(`  📝 ${c.name}`),
    chalk.gray(`     ID: ${c.id}`),
    chalk.gray(`     更新时间: ${formatRelativeTime(c.updatedAt)}`),
    SEPARATOR_LONG,
  ];
}

/**
 * 管理已保存的对话
 * 先选对话，然后选择操作（目前只有删除）
 */
export async function manageConversations(): Promise<void> {
  while (true) {
    console.log(chalk.blue.bold("\n📂 对话管理\n"));

    const conversations = getConversationsList();
    if (conversations.length === 0) {
      console.log(chalk.yellow("📭 没有已保存的对话\n"));
      return;
    }

    const result = await selectItemAndAction(conversations, {
      getName: (c) =>
        `${c.name} (${formatRelativeTime(c.updatedAt)}, ${formatFileSize(c.size || 0)})`,
      getValue: (c) => c.id,
      getDetails: (c) => formatConversationDetails(c),
      actions: [{ name: "🗑️  删除", value: "delete" }],
      emptyMessage: "📭 没有已保存的对话",
    });

    if (!result) continue; // 返回（选择列表中的"返回"）

    const { item: conversation, action } = result;

    if (action === "__exit__") return; // 用户选择退出管理，回到主菜单

    const confirmed = await confirmAction(
      `确定要删除对话 "${conversation.name}" 吗?`,
      false,
    );
    if (confirmed) {
      deleteConversation(conversation.id);
      console.log(chalk.green(`\n✅ 对话 "${conversation.name}" 已删除\n`));
    }
  }
}
