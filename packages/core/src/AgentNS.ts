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
    id?: number;
    type?: string;
    function?: FunctionCall;
  }

  export interface ImageUrlContentSection {
    index?: number;
    type: "image_url";
    image_url: {
      url: string;
    };
  }

  export interface TextContentSection {
    index?: number;
    type: "text";
    text: string;
  }

  export type MessageContentSection =
    | ImageUrlContentSection
    | TextContentSection;

  export type MessageContent = string | MessageContentSection[];

  export interface Message {
    name?: string;
    raw_content?: MessageContent;
    content?: MessageContent;
    function_call?: FunctionCall;
    tool_call_id?: number;
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
    tool_call_id?: number;
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
