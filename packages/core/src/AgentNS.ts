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
    | ImageUrlContentSection
    | TextContentSection
    | FileContentSection;

  export type MessageContent = string | MessageContentSection[];

  export interface Message {
    /** 消息唯一标识。Message 实例构造时自动生成、保证有值；
     *  可选类型是为了兼容「发给模型的精简格式」（formatHistory 白名单对象不含内部字段）。 */
    id?: string;
    name?: string;
    raw_content?: MessageContent;
    content?: MessageContent;
    function_call?: FunctionCall;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
    role: Role;
    status?: MessageStatus;
    finish_reason?: FinishReason;
    hidden?: boolean;
    omit?: boolean;
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
