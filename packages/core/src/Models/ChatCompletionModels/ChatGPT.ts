import {
  EventStreamContentType,
  fetchEventSource,
} from "@ai-zen/node-fetch-event-source";
import type { JSONSchema7 } from "json-schema";
import { AgentNS } from "../../AgentNS.js";
import {
  ChatCompletionModel,
  ChatCompletionModelCreateOptions,
  ChatCompletionModelCreateStreamOptions,
} from "../ChatCompletionModel.js";
import { AsyncQueue } from "@ai-zen/async-queue";
import { RequestConfig } from "../../Model.js";

export namespace ChatGPTTypes {
  export enum Role {
    System = "system",
    Assistant = "assistant",
    User = "user",
    Function = "function",
    Tool = "tool",
  }

  export enum FinishReason {
    Stop = "stop",
    Length = "length",
    ContentFilter = "content_filter",
    FunctionCall = "function_call",
    ToolCalls = "tool_calls",
  }

  export interface ToolDefine {
    type: "function";
    function: FunctionDefine;
  }

  export interface FunctionDefine {
    description: string;
    name: string;
    strict?: boolean;
    parameters: JSONSchema7;
  }

  export interface FunctionCall {
    name?: string;
    arguments?: any;
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

  export interface Message {
    role: Role;
    name?: string;
    content?: string | MessageContentSection[];
    function_call?: FunctionCall;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
  }

  export type ResponseMessage = Message;

  export type ResponseDelta = ResponseMessage;

  export interface RequestData {
    model?: string;
    stream?: boolean;
    messages: Message[];
    stop?: null;
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens?: number;
    response_format?: { type: "json_object" };

    tools?: ToolDefine[];
    tool_choice?: "auto" | "none";

    functions?: FunctionDefine[];
    function_call?: "auto" | "none";
  }

  export interface Choice {
    message?: ResponseMessage;
    index: number;
    finish_reason: FinishReason | null;
    finish_details?: any;
  }

  export interface StreamChoice {
    delta?: ResponseDelta;
    index: number;
    finish_reason: FinishReason | null;
    finish_details?: any;
  }

  export interface Usage {
    completion_tokens: number;
    prompt_tokens: number;
    total_tokens: number;
  }

  export interface ResponseData {
    error?: {
      code: string;
      message: string;
    };
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Choice[];
    usage: Usage;
    prompt_filter_results?: any;
  }

  export interface StreamResponseData {
    error?: {
      code: string;
      message: string;
    };
    id: string;
    object: string;
    created: number;
    model: string;
    choices?: StreamChoice[];
    usage: null;
    prompt_filter_results?: any;
  }
}

export interface ChatGPT_ModelConfig {
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
}

class RetriableError extends Error {}
class FatalError extends Error {}

export class ChatGPT<
  M extends ChatGPT_ModelConfig = ChatGPT_ModelConfig,
> extends ChatCompletionModel<M> {
  static code = "chatgpt";
  static title = "ChatGPT";
  IS_SUPPORT_FUNCTION_CALL = true;
  IS_SUPPORT_TOOLS_CALL = true;
  IS_SUPPORT_IMAGE_CONTENT = true;

  async createCompletion(options: ChatCompletionModelCreateOptions) {
    if (!this.model_config) {
      throw new Error("ChatGPT config not set");
    }
    if (!this.request_config) {
      throw new Error("ChatGPT request not set");
    }

    const model_config = this.formatModelConfig(this.model_config);
    const request_config = this.formatRequestConfig(this.request_config);

    try {
      const res = await fetch(request_config.url, {
        signal: options.signal,
        method: "POST",
        headers: request_config.headers,
        body: JSON.stringify({
          ...request_config.body,
          ...model_config,
          ...this.formatTools(options.tools),
          messages: options.messages,
        }),
      });

      const data: ChatGPTTypes.ResponseData = await res.json();

      return this.formatData(data);
    } catch (error: any) {
      throw new FatalError(error?.message);
    }
  }

  createStream(options: ChatCompletionModelCreateStreamOptions) {
    if (!this.model_config) {
      throw new Error("ChatGPT config not set");
    }
    if (!this.request_config) {
      throw new Error("ChatGPT request not set");
    }

    const model_config = this.formatModelConfig(this.model_config);
    const request_config = this.formatRequestConfig(this.request_config);

    const stream = new AsyncQueue<AgentNS.StreamResponseData>();

    fetchEventSource(request_config.url, {
      signal: options.signal,
      method: "POST",
      headers: request_config.headers,
      body: JSON.stringify({
        ...request_config.body,
        ...model_config,
        ...this.formatTools(options.tools),
        stream: true,
        messages: options.messages,
      }),
      async onopen(response) {
        if (
          response.ok &&
          response.headers.get("content-type")?.includes(EventStreamContentType)
        ) {
          options.onOpen?.();
          return;
        }

        let message: string;
        try {
          message = await response.text();
        } catch {
          message = "Network Error";
        }
        throw new FatalError(message);
      },
      onerror(err) {
        if (err instanceof FatalError) throw err;
        if (err instanceof RetriableError) return;
        throw err;
      },
      onmessage: (msg) => {
        if (msg.data === "[DONE]") {
          stream.done();
          return;
        }

        try {
          const data = JSON.parse(msg.data) as ChatGPTTypes.StreamResponseData;
          stream.push(this.formatSteamData(data));
        } catch (error: any) {
          throw new FatalError(error?.message);
        }
      },
    })
      .catch((error) => {
        options.onError?.(error);
      })
      .finally(() => {
        stream.done();
        options.onFinally?.();
      });

    return stream;
  }

  formatModelConfig(model_config?: M): M {
    return { ...model_config } as M;
  }

  formatRequestConfig(request_config?: RequestConfig): RequestConfig {
    return { ...request_config } as RequestConfig;
  }

  formatTools(tools: AgentNS.ToolDefine[] | undefined) {
    if (!tools?.length) return {};
    if (this.IS_SUPPORT_TOOLS_CALL) {
      // 注入 strict: true，确保模型严格按照 JSON Schema 生成参数
      const strictTools = tools.map((tool) => ({
        ...tool,
        function: {
          ...tool.function,
          strict: true,
        },
      }));
      return {
        tools: strictTools,
        tool_choice: "auto",
      };
    } else if (this.IS_SUPPORT_FUNCTION_CALL) {
      return {
        functions: tools.map((tool) => tool.function),
        function_call: "auto",
      };
    }
    return {};
  }

  formatData(data: ChatGPTTypes.ResponseData): AgentNS.ResponseData {
    return {
      ...data,
      choices: data.choices?.map(this.formatChoice.bind(this)),
    };
  }

  formatChoice(choice: ChatGPTTypes.Choice): AgentNS.Choice {
    return {
      ...choice,
      message: this.formatMessage(choice.message),
      finish_reason: this.formatFinalResponse(choice.finish_reason),
    };
  }

  formatSteamData(
    data: ChatGPTTypes.StreamResponseData,
  ): AgentNS.StreamResponseData {
    return {
      ...data,
      choices: data.choices?.map(this.formatStreamChoice.bind(this)),
    };
  }

  formatStreamChoice(choice: ChatGPTTypes.StreamChoice): AgentNS.StreamChoice {
    return {
      ...choice,
      delta: this.formatDelta(choice.delta),
      finish_reason: this.formatFinalResponse(choice.finish_reason),
    };
  }

  formatDelta(
    delta: ChatGPTTypes.ResponseDelta | undefined,
  ): AgentNS.Delta | undefined {
    if (!delta) return undefined;
    return {
      ...delta,
      content: this.formatContent(delta.content),
      role: delta.role && this.formatRole(delta.role),
    };
  }

  formatMessage(
    message: ChatGPTTypes.Message | undefined,
  ): AgentNS.Message | undefined {
    if (!message) return undefined;
    return {
      ...message,
      content: this.formatContent(message.content),
      role: this.formatRole(message.role),
    };
  }

  formatContent(
    content: ChatGPTTypes.ResponseDelta["content"],
  ): AgentNS.Message["content"] {
    return content;
  }

  formatFinalResponse(
    finish_reason: ChatGPTTypes.FinishReason | null,
  ): AgentNS.FinishReason {
    switch (finish_reason) {
      case null:
        return AgentNS.FinishReason.Stop;
      case ChatGPTTypes.FinishReason.Stop:
        return AgentNS.FinishReason.Stop;
      case ChatGPTTypes.FinishReason.ContentFilter:
        return AgentNS.FinishReason.ContentFilter;
      case ChatGPTTypes.FinishReason.Length:
        return AgentNS.FinishReason.Length;
      case ChatGPTTypes.FinishReason.FunctionCall:
        return AgentNS.FinishReason.FunctionCall;
      case ChatGPTTypes.FinishReason.ToolCalls:
        return AgentNS.FinishReason.ToolCalls;
      default:
        // 穷举检查：如果 ChatGPTTypes.FinishReason 新增了枚举值但忘记在此处理，
        // 下一行的 never 赋值会导致 TypeScript 编译时报错（类型无法赋给 never）
        const _exhaustiveFR: never = finish_reason;
        return AgentNS.FinishReason.Unknown;
    }
  }

  formatRole(role: ChatGPTTypes.Role): AgentNS.Role {
    switch (role) {
      case ChatGPTTypes.Role.Assistant:
        return AgentNS.Role.Assistant;
      case ChatGPTTypes.Role.System:
        return AgentNS.Role.System;
      case ChatGPTTypes.Role.User:
        return AgentNS.Role.User;
      case ChatGPTTypes.Role.Function:
        return AgentNS.Role.Function;
      case ChatGPTTypes.Role.Tool:
        return AgentNS.Role.Tool;
      default:
        // 穷举检查：如果 ChatGPTTypes.Role 新增了枚举值但忘记在此处理，
        // 下一行的 never 赋值会导致 TypeScript 编译时报错（类型无法赋给 never）
        const _exhaustiveRole: never = role;
        return AgentNS.Role.Unknown;
    }
  }
}
