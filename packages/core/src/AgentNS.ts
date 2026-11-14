import type { JSONSchema7 } from "json-schema";

/**
 * Agent Abstraction Layer
 */
export namespace AgentNS {
  export enum Role {
    Unknown = "unknown",
    System = "system",
    User = "user",
    Assistant = "assistant",
    Function = "function",
    Tool = "tool",
  }

  export enum MessageStatus {
    Unknown = "unknown",
    Pending = "pending",
    Completed = "completed",
    Error = "error",
    Aborted = "aborted",
    Writing = "writing",
  }

  export enum FinishReason {
    Unknown = "unknown",
    Stop = "stop",
    Length = "length",
    ContentFilter = "content_filter",
    FunctionCall = "function_call",
    ToolCalls = "tool_calls",
  }

  export interface FunctionCall {
    arguments?: string;
    name?: string;
  }

  export interface ToolCall {
    index?: number;
    id?: string;
    type?: string;
    function?: FunctionCall;
  }

  export interface ImageUrlContentSection {
    index?: number;
    type: "image_url";
    image_url: {
      url: string;
      /** 图片处理细节级别（如 DeepSeek 视觉模型）：
       *  low 推理前缩放至 512×512，更省 token；high / original 保留原图；auto 自动（当前等价 original） */
      detail?: "low" | "high" | "original" | "auto";
    };
  }

  export interface TextContentSection {
    index?: number;
    type: "text";
    text: string;
  }

  /** Files API 引用内容块（如 DeepSeek Files API）：
   *  file_id 引用已上传文件；file_data 以 base64 data URL 内联（与 file_id 互斥）；
   *  filename 仅 file_data 时可带，不能与 file_id 同现 */
  export interface FileContentSection {
    index?: number;
    type: "file";
    file_id?: string;
    file_data?: string;
    filename?: string;
  }

  export type MessageContentSection =
    ImageUrlContentSection | TextContentSection | FileContentSection;

  export type MessageContent = string | MessageContentSection[];

  export interface Message {
    /** 消息唯一标识，强制必填。Message 实例构造时自动生成、保证有值；
     *  （formatHistory 发给模型的精简格式为独立白名单对象，不含内部字段，故不影响本类型） */
    id: string;
    name?: string;
    content?: MessageContent;
    function_call?: FunctionCall;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
    role: Role;
    status?: MessageStatus;
    finish_reason?: FinishReason;
    /**
     * 产生本条 assistant 消息的那次 API 响应的 token 用量。
     * 由流式响应的最后一个 chunk 写入；仅 assistant 消息会有值。
     * `Agent.lastUsage`（最近一次用量）即由本字段派生，不存在第二份拷贝。
     * 将本会话全部 assistant 消息的 `usage` 求和，即计费口径的累计消耗
     * （每轮请求都会重发完整历史，故求和 = 实际消耗）。
     */
    usage?: Usage;
    /**
     * 本条**工具消息**内「内部委派」产生的累计 token 用量（如子 Agent 委派）。
     * 由委派路径（`AgentTool` / `AgentToolLazy`）在子 Agent 结束后写入，随消息持久化；
     * 与 `usage`（本条消息自身那次响应）互斥出现。求和请用 `sumUsage()`。
     */
    subAgentUsage?: Usage;
    hidden?: boolean;
    omit?: boolean;
  }

  /**
   * inbox 条目的优先级，决定它落成 User 消息的时机：
   * - `high`：一轮**内**循环（一次请求 + 它引发的工具调用）结束后立即插入；
   * - `low`：整组内循环停下（agent 这一轮不再继续）之后才插入。
   */
  export type InboxPriority = "high" | "low";

  /**
   * 排进 Agent inbox 的一条待发内容。
   *
   * 它**不是**消息：落地那一刻才变成一条 `Message`（`role: "user"`），来源信息不落到
   * 消息字段上（见 `inboxEntryContent`）。
   */
  export interface InboxEntry {
    /**
     * 落成那条 User 消息时用的 id。
     *
     * 之所以在**入队时**就定下来：宿主把它先告诉客户端（乐观回显），落地时用同一个 id，
     * 同一条内容才不会显示两遍（客户端按 id 去重/覆盖）。
     */
    messageId: string;
    /** `"user"` | `"tool"` | 其他人类可读来源名（只作展示与正文注释用） */
    source: string;
    priority: InboxPriority;
    content: MessageContent;
    /** 入队时刻（ISO 字符串） */
    createdAt: string;
  }

  export interface Delta {
    name?: string;
    content?: MessageContent;
    function_call?: FunctionCall;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
    role?: Role;
    status?: MessageStatus;
    finish_reason?: FinishReason;
    hidden?: boolean;
    omit?: boolean;
  }

  export interface StreamChoice {
    delta?: Delta;
    index: number;
    finish_reason: FinishReason | null;
    finish_details?: any;
  }

  export interface StreamResponseData {
    error?: { code: string; message: string };
    choices?: StreamChoice[];
    usage?: Usage;
  }

  export interface Choice {
    message?: Message;
    index: number;
    finish_reason: FinishReason | null;
    finish_details?: any;
  }

  export interface ResponseData {
    error?: { code: string; message: string };
    choices?: Choice[];
    usage?: Usage;
  }

  export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }

  export interface FunctionDefine {
    name: string;
    description: string;
    strict?: boolean;
    parameters: JSONSchema7;
  }

  export interface ToolDefine {
    type: "function";
    function: FunctionDefine;
  }
}
