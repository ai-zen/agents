import { AgentNS } from "./AgentNS.js";
import { Message, generateMessageId } from "./Message.js";

/**
 * InboxEntry 落成消息内容的唯一实现：用户来源原样，其他来源在正文最前面加一行注释（来源 +
 * 创建时间）。
 *
 * 为什么除了 `source` 还要在正文里写一行：「谁推的这条」对模型与用户都只要看得见就够了，一行
 * 注释两种读者都满足。消息上那格 `source` 是给程序读的，这一行是给人读的。
 *
 * 为什么时间也写进这行注释：外部通知可能是很久以前发生的（排队、重试、别的会话遗留的结果）。
 * 模型拿到它要能判断时效性，否则会把一条陈年结果当成刚刚发生的事。时间用 InboxEntry 自己的
 * `createdAt`，不另算一份。
 *
 * 为什么分段内容不做「转成纯文本再拼」：InboxEntry 内容可能是多模态数组（文本 + 图片 + 文件）。
 * 拼成字符串等于把图片段整段丢掉，模型看到的就是「一条只有注释的消息」。所以数组走「在最前面插
 * 一段 text 注释」：段序保持不变，排队中的内容原封不动地留在后面。
 *
 * @returns 字符串内容返回 ` 注释\n\n 正文 `；数组内容返回「注释段 + 原有各段」
 */
export function inboxEntryContent(entry: AgentNS.InboxEntryWithContent): AgentNS.MessageContent {
  if (entry.source.kind === "user") return entry.content;

  // 注释行 + 一个空行：与正文隔开，模型与终端里都不会把它读成正文的第一句
  const note = `// 这条消息来自 ${entry.source.label} 自动推送（${entry.createdAt}）\n\n`;
  if (!Array.isArray(entry.content)) return `${note}${entry.content}`;

  const noteSection: AgentNS.TextContentSection = { type: "text", text: note };
  return [noteSection, ...entry.content];
}

/**
 * 把一条 InboxEntry 落成待追加的 User 消息。
 *
 * 内容由 {@link inboxEntryContent} 决定；这里只负责消息这一层：角色、状态、id、来源。状态给
 * `Completed`，与 `Message.User()` 一致：它是用户已经说完的话，不是待写占位。
 *
 * 不带正文的 InboxEntry（`InboxKey`）返回 `undefined`：它只负责唤醒 agent，历史里一个字都不多
 * 加。
 */
export function inboxEntryMessage(entry: AgentNS.InboxEntry): AgentNS.Message | undefined {
  if (entry.content === undefined) return undefined;

  return new Message({
    id: entry.messageId ?? generateMessageId(),
    role: AgentNS.Role.User,
    status: AgentNS.MessageStatus.Completed,
    source: entry.source,
    content: inboxEntryContent(entry),
  });
}
