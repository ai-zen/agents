import { AgentNS } from "./AgentNS.js";
import { PickRequired } from "./Common.js";

/**
 * Represents a message in a AI chat conversation.
 */
export class Message implements AgentNS.Message {
  name?: string | undefined;
  raw_content?: string | AgentNS.MessageContentSection[];
  content?: string | AgentNS.MessageContentSection[];
  function_call?: AgentNS.FunctionCall | undefined;
  tool_call_id?: number | undefined;
  tool_calls?: AgentNS.ToolCall[] | undefined;
  reasoning_content?: string | undefined;
  role: AgentNS.Role;
  status?: AgentNS.MessageStatus | undefined;
  finish_reason?: AgentNS.FinishReason | undefined;
  hidden?: boolean | undefined;
  omit?: boolean | undefined;

  /**
   * Creates an instance of the Message class.
   */
  constructor(options: PickRequired<Message | "role">) {
    if (!options.role) throw new Error("Message must have a role");
    this.name = options.name;
    this.raw_content = options.raw_content;
    this.content = options.content;
    this.function_call = options.function_call;
    this.tool_call_id = options.tool_call_id;
    this.tool_calls = options.tool_calls;
    this.reasoning_content = options.reasoning_content;
    this.role = options.role;
    this.status = options.status;
    this.finish_reason = options.finish_reason;
    this.hidden = options.hidden;
    this.omit = options.omit;
  }

  /**
   * Rewrite the message. The original content will be stored in `raw_content`.
   */
  static rewrite(
    message: Message,
    newContent: string | AgentNS.MessageContentSection[]
  ) {
    message.raw_content = message.raw_content || message.content;
    message.content = newContent;
  }

  /**
   * Creates a system message.
   */
  static System(content = "") {
    return new Message({
      role: AgentNS.Role.System,
      content,
      status: AgentNS.MessageStatus.Completed,
    });
  }

  /**
   * Creates an assistant message with a default pending status.
   */
  static Assistant(content = "") {
    return new Message({
      role: AgentNS.Role.Assistant,
      content,
      status: AgentNS.MessageStatus.Pending,
    });
  }

  /**
   * Creates a user message.
   */
  static User(content: AgentNS.MessageContentSection[] | string) {
    return new Message({
      role: AgentNS.Role.User,
      content,
      status: AgentNS.MessageStatus.Completed,
    });
  }

  /**
   * Creates a tool result message.
   */
  static Tool(tool_call: AgentNS.ToolCall, result = "") {
    return new Message({
      role: AgentNS.Role.Tool,
      tool_call_id: tool_call.id,
      name: tool_call.function!.name,
      content: result,
      status: AgentNS.MessageStatus.Pending,
    });
  }

  /**
   * Creates a function result message.
   */
  static Function(function_call: AgentNS.FunctionCall, result = "") {
    return new Message({
      role: AgentNS.Role.Function,
      name: function_call!.name,
      content: result,
      status: AgentNS.MessageStatus.Pending,
    });
  }
}
