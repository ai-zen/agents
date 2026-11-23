import { AgentNS } from "./AgentNS.js";
import type { AgentError } from "./AgentError.js";
import { PickRequired } from "./Common.js";

export class Message implements AgentNS.Message {
  id: string;
  createdAt: number;
  name?: string | undefined;
  content?: string | AgentNS.MessageContentSection[];
  function_call?: AgentNS.FunctionCall | undefined;
  tool_call_id?: string | undefined;
  tool_calls?: AgentNS.ToolCall[] | undefined;
  reasoning_content?: string | undefined;
  role: AgentNS.Role;
  status?: AgentNS.MessageStatus | undefined;
  finish_reason?: AgentNS.FinishReason | undefined;
  usage?: AgentNS.Usage | undefined;
  subAgentUsage?: AgentNS.Usage | undefined;
  hidden?: boolean | undefined;
  omit?: boolean | undefined;
  source?: AgentNS.MessageSource | undefined;
  error?: AgentError | undefined;

  constructor(options: PickRequired<Message | "role">) {
    if (!options.role) throw new Error("Message must have a role");
    this.id = options.id ?? generateMessageId();
    this.createdAt = options.createdAt ?? Date.now();
    this.name = options.name;
    this.content = options.content;
    this.function_call = options.function_call;
    this.tool_call_id = options.tool_call_id;
    this.tool_calls = options.tool_calls;
    this.reasoning_content = options.reasoning_content;
    this.role = options.role;
    this.status = options.status;
    this.finish_reason = options.finish_reason;
    this.usage = options.usage;
    this.subAgentUsage = options.subAgentUsage;
    this.hidden = options.hidden;
    this.omit = options.omit;
    this.source = options.source;
    this.error = options.error;
  }

  static System(content = "") {
    return new Message({
      role: AgentNS.Role.System,
      content,
      status: AgentNS.MessageStatus.Completed,
    });
  }

  static Assistant(content = "") {
    return new Message({
      role: AgentNS.Role.Assistant,
      content,
      status: AgentNS.MessageStatus.Pending,
    });
  }

  static User(content: AgentNS.MessageContentSection[] | string, source?: AgentNS.MessageSource) {
    return new Message({
      role: AgentNS.Role.User,
      content,
      status: AgentNS.MessageStatus.Completed,
      source,
    });
  }

  static Tool(tool_call: AgentNS.ToolCall, result = "") {
    return new Message({
      role: AgentNS.Role.Tool,
      tool_call_id: tool_call.id,
      name: tool_call.function!.name,
      content: result,
      status: AgentNS.MessageStatus.Pending,
    });
  }

  static Function(function_call: AgentNS.FunctionCall, result = "") {
    return new Message({
      role: AgentNS.Role.Function,
      name: function_call!.name,
      content: result,
      status: AgentNS.MessageStatus.Pending,
    });
  }
}

/**
 * 生成消息唯一 id。core 包需同时兼容 Node.js 与 Web：
 * - 优先使用全局 crypto.randomUUID（Node 19+ / 现代浏览器均可用）
 * - 无 crypto 的老环境降级为「时间戳 + 随机数」组合，保证会话内唯一即可
 *
 * 导出是因为 inbox InboxEntry 要在**入队时**就拿到写进 messages 那条消息的 id（`InboxEntry.messageId`）：
 * 同一套 id 规则只该有一份实现，否则「宿主给的 id」与「消息自己生成的 id」迟早长得不一样。
 */
export function generateMessageId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
