import { AsyncQueue } from "@ai-zen/async-queue";
import { AgentNS } from "../AgentNS.js";
import { Model, ModelType } from "../Model.js";

export interface ChatCompletionModelCreateStreamOptions {
  signal?: AbortSignal;
  messages: AgentNS.Message[];
  tools: AgentNS.ToolDefine[];
  onOpen?(): void;
  onError?(error: Error): void;
  onFinally?(): void;
}

export interface ChatCompletionModelCreateOptions {
  signal?: AbortSignal;
  messages: AgentNS.Message[];
  tools: AgentNS.ToolDefine[];
}

export abstract class ChatCompletionModel<C = {}> extends Model<C> {
  static type = ModelType.ChatCompletion;
  INPUT_MAX_TOKENS?: number;
  OUTPUT_MAX_TOKENS_LOWER_LIMIT?: number;
  OUTPUT_MAX_TOKENS?: number;
  IS_SUPPORT_FUNCTION_CALL?: boolean;
  IS_SUPPORT_TOOLS_CALL?: boolean;
  IS_SUPPORT_IMAGE_CONTENT?: boolean;
  abstract createStream(
    options: ChatCompletionModelCreateStreamOptions,
  ): AsyncQueue<AgentNS.StreamResponseData>;
  abstract createCompletion(
    options: ChatCompletionModelCreateOptions,
  ): Promise<AgentNS.ResponseData>;
}
