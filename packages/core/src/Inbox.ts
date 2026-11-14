import { AgentNS } from "./AgentNS.js";
import { Message } from "./Message.js";

/** 唯一一个不需要加来源注释的 source：它就是用户本人说的话 */
const SOURCE_USER = "user";

/**
 * inbox 条目落成消息内容的**唯一实现**：用户来源原样，其他来源在正文最前面加一行注释。
 *
 * ## 为什么来源只写进正文，不落成消息字段
 *
 * 库里每条消息的列是既有契约，为一条纯展示用的来源信息加列会连带改持久化、重读与两端
 * 客户端；而「谁推的这条」对模型与用户都只要**看得见**就够了 —— 一行注释两种读者都满足。
 *
 * ## 为什么分段内容不是「转成纯文本再拼」
 *
 * 条目内容可能是多模态数组（文本 + 图片 + 文件）。拼成字符串等于把图片段整段丢掉，
 * 模型看到的就是「一条只有注释的消息」。所以数组走「在最前面插一段 text 注释」：
 * 段序保持不变，往后排队的内容原封不动地留在后面。
 *
 * @returns 字符串内容返回 `注释\n\n正文`；数组内容返回「注释段 + 原有各段」
 */
export function inboxEntryContent(entry: AgentNS.InboxEntry): AgentNS.MessageContent {
  if (entry.source === SOURCE_USER) return entry.content;

  // 注释行 + 一个空行：与正文拉开，模型与终端里都不会把它读成正文的第一句
  const note = `// 这条消息来自 ${entry.source} 自动推送\n\n`;
  if (!Array.isArray(entry.content)) return `${note}${entry.content}`;

  const noteSection: AgentNS.TextContentSection = { type: "text", text: note };
  return [noteSection, ...entry.content];
}

/**
 * 把一条 inbox 条目落成待追加的 User 消息（id 用条目入队时定的那个）。
 *
 * 内容由 {@link inboxEntryContent} 决定；这里只负责「消息」这一层：角色、状态、id。
 * 状态给 `Completed`，与 `Message.User()` 一致 —— 它是用户已经说完的话，不是待写占位。
 */
export function inboxEntryMessage(entry: AgentNS.InboxEntry): AgentNS.Message {
  return new Message({
    id: entry.messageId,
    role: AgentNS.Role.User,
    status: AgentNS.MessageStatus.Completed,
    content: inboxEntryContent(entry),
  });
}
