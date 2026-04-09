import { AsyncQueue } from "@ai-zen/async-queue";
import EventBus from "@ai-zen/event-bus";
import { AgentNS } from "./AgentNS.js";
import { AgentContext as AgentContext } from "./AgentContext.js";
import { PickRequired } from "./Common.js";
import { FunctionCallContext } from "./FunctionCallContext.js";
import { Message } from "./Message.js";
import { Tool } from "./Tool.js";

interface PendingTask {
  controller: AbortController;
  receiver: AgentNS.Message;
}

export class Agent extends AgentContext {
  events = new EventBus();

  constructor(options: PickRequired<AgentContext, "model">) {
    super(options);
  }

  /**
   * An array to record pending tasks, used to abort.
   */
  private pendingTasks: Set<PendingTask> = new Set();

  /**
   * Abort all pending tasks.
   */
  abort() {
    this.pendingTasks.forEach((task) => {
      task.controller.abort();
      task.receiver.status = AgentNS.MessageStatus.Aborted;
    });
  }

  /**
   * Run the conversation with the server.
   */
  async run() {
    const receiver = this.messages.at(-1) as Message;
    if (!receiver) {
      throw new Error(
        "You need to send at least one message as a receive message",
      );
    }
    if (receiver.role !== AgentNS.Role.Assistant) {
      throw new Error(
        "The last message will serve as the receiving message, and its role can only be assistant.",
      );
    }
    if (receiver.status !== AgentNS.MessageStatus.Pending) {
      throw new Error(
        "The last message will serve as the receiving message, and its status can only be pending.",
      );
    }

    const controller = new AbortController();

    const pendingTask: PendingTask = { controller, receiver };

    this.pendingTasks.add(pendingTask);

    this.events.emit("run");

    const stream = this.model.createStream({
      signal: controller.signal,
      messages: this.formatHistory(),
      tools: this.formatTools(),
      onOpen: () => {
        receiver.status = AgentNS.MessageStatus.Writing;
        this.events.emit("open");
      },
      onError: (error: any) => {
        receiver.status = AgentNS.MessageStatus.Error;
        receiver.content = error.message;
        this.events.emit("error", error);
      },
      onFinally: () => {
        this.events.emit("finally");
      },
    });

    abortBlock: {
      try {
        await this.parseStreamData(receiver, stream);

        if (
          (receiver.status as AgentNS.MessageStatus) ===
            AgentNS.MessageStatus.Aborted ||
          (receiver.status as AgentNS.MessageStatus) ===
            AgentNS.MessageStatus.Error
        ) {
          break abortBlock;
        }

        receiver.status = AgentNS.MessageStatus.Completed;

        if (await this.handleToolCall(receiver)) {
          if (
            (receiver.status as AgentNS.MessageStatus) ===
              AgentNS.MessageStatus.Aborted ||
            (receiver.status as AgentNS.MessageStatus) ===
              AgentNS.MessageStatus.Error
          ) {
            break abortBlock;
          }

          this.append(Message.Assistant());
          await this.run();
        }
      } catch (error: any) {
        receiver.status = AgentNS.MessageStatus.Error;
        receiver.content = error.message;
        this.events.emit("error", error);
      }
    }

    this.pendingTasks.delete(pendingTask);

    return this.messages;
  }

  /**
   * Get the available tool definitions.
   */
  formatTools() {
    return this.tools.map((tool) => ({
      type: tool.type,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
  }

  /**
   * Get the conversation history in a format suitable for the request.
   */
  formatHistory() {
    return this.messages
      .filter(
        (message) =>
          (message.status == undefined ||
            message.status == AgentNS.MessageStatus.Completed) &&
          !message.omit,
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
        function_call: message.function_call
          ? message.function_call
          : undefined,
        tool_calls: message.tool_calls?.length ? message.tool_calls : undefined,
        tool_call_id: message.tool_call_id ?? undefined,
        name: message.name ?? undefined,
      }));
  }

  /**
   * Parse the streamed response data.
   */
  async parseStreamData(
    receiver: AgentNS.Message,
    stream: AsyncQueue<AgentNS.StreamResponseData>,
  ) {
    for await (const chunk of stream) {
      this.events.emit("chunk", chunk);

      if (chunk?.error) {
        throw new Error(chunk.error.message);
      }

      if (chunk?.choices?.[0]) {
        const finishReason = chunk.choices[0].finish_reason;
        if (finishReason) {
          receiver.finish_reason = finishReason;
        }

        const delta = chunk.choices[0].delta;

        if (delta?.content) {
          if (delta.content instanceof Array) {
            if (delta.content[0]) {
              const deltaSection = delta.content[0];
              const index = deltaSection.index!;

              if (!(receiver.content instanceof Array)) {
                receiver.content = [];
              }

              if (!receiver.content[index]) {
                receiver.content[index] = {
                  index,
                  ...deltaSection,
                };
              }

              if ("image_url" in deltaSection) {
                const currentSection = receiver.content[
                  index
                ] as AgentNS.ImageUrlContentSection;
                currentSection["type"] = "image_url";
                currentSection["image_url"] ??= { url: "" };
                currentSection["image_url"].url += deltaSection.image_url;
              }

              if ("text" in deltaSection) {
                const currentSection = receiver.content[
                  index
                ] as AgentNS.TextContentSection;
                currentSection["type"] = "text";
                currentSection["text"] ??= "";
                currentSection["text"] += deltaSection.text;
              }
            }
          } else {
            if (typeof receiver.content != "string") {
              receiver.content = "";
            }

            receiver.content += delta.content;
          }
        }

        if (delta?.tool_calls) {
          if (delta.tool_calls[0]) {
            const deltaToolCall = delta.tool_calls[0];
            const index = deltaToolCall.index!;

            if (!receiver.tool_calls) {
              receiver.tool_calls = [];
            }

            if (!receiver.tool_calls[index]) {
              receiver.tool_calls[index] = {
                index,
                function: {
                  name: "",
                  arguments: "",
                  ...deltaToolCall.function,
                },
                ...deltaToolCall,
              };
            }

            if (deltaToolCall.id) {
              receiver.tool_calls[index]["id"] = deltaToolCall.id;
            }

            if (deltaToolCall.function?.name) {
              receiver.tool_calls[index]["function"]!["name"] =
                deltaToolCall.function.name;
            }

            if (deltaToolCall.function?.arguments) {
              if (
                deltaToolCall.function.arguments.startsWith(
                  receiver.tool_calls[index]["function"]!["arguments"]!,
                )
              ) {
                receiver.tool_calls[index]["function"]!["arguments"] =
                  deltaToolCall.function.arguments;
              } else {
                receiver.tool_calls[index]["function"]!["arguments"] +=
                  deltaToolCall.function.arguments;
              }
            }
          }
        }

        if (delta?.function_call) {
          if (!receiver.function_call) {
            receiver.function_call = {
              name: "",
              arguments: "",
              ...delta.function_call,
            };
          }

          if (delta.function_call.name) {
            receiver.function_call!.name = delta.function_call.name;
          }

          if (delta.function_call.arguments) {
            receiver.function_call!.arguments += delta.function_call.arguments;
          }
        }
      }

      this.events.emit("chunk-parsed", receiver, chunk);
    }

    this.events.emit("parsed", receiver);
  }

  /**
   * Handle the tool call.
   * @returns A boolean value indicating whether a new round of chat is needed.
   */
  async handleToolCall(receiver: AgentNS.Message): Promise<boolean> {
    const tasks: AgentNS.ToolCall[] = [];

    if (receiver.tool_calls?.length) {
      tasks.push(
        ...receiver.tool_calls.filter(
          (toolCall) => toolCall.type == "function" && toolCall.function,
        ),
      );
    }

    if (receiver.function_call) {
      tasks.push({ function: receiver.function_call });
    }

    const promises = tasks.map(async (task) => {
      const resultReceiver = this.append(
        task.id ? Message.Tool(task) : Message.Function(task.function!),
      );

      try {
        const matchTools: Tool | undefined = this.tools.find(
          (tool) =>
            tool.function.name == task.function!.name &&
            tool.type == "function",
        );

        const ctx = new FunctionCallContext({
          function_call: task.function!,
          agent: this,
          result_message: resultReceiver,
        });

        resultReceiver.content = await matchTools?.exec(ctx);
        resultReceiver.status = AgentNS.MessageStatus.Completed;

        return {
          is_prevent_default: ctx.is_prevent_default,
          status: resultReceiver.status,
        };
      } catch (error: any) {
        resultReceiver.content = error?.message;
        resultReceiver.status = AgentNS.MessageStatus.Error;

        return {
          is_prevent_default: true,
          status: resultReceiver.status,
        };
      }
    });

    const results = await Promise.all(promises);

    const isNeedNext = Boolean(
      results.length &&
      results.every(
        (result) =>
          !result.is_prevent_default &&
          result.status === AgentNS.MessageStatus.Completed,
      ),
    );

    return isNeedNext;
  }

  /**
   * Check if there is a pending message.
   */
  get isHasPendingMessage() {
    return (
      this.messages.some(
        (message) =>
          message.status === AgentNS.MessageStatus.Pending ||
          message.status == AgentNS.MessageStatus.Writing,
      ) ?? false
    );
  }

  /**
   * Send a user question.
   * @param content The user question.
   * @returns A promise that resolves to the conversation messages.
   */
  async send(content: AgentNS.MessageContentSection[] | string) {
    // Create a question message.
    const questionMessage = this.append(Message.User(content));

    // Create an assistant reply message.
    this.append(Message.Assistant());

    // Rewrite the user question.
    await this.rag?.rewrite(questionMessage, this.messages);

    // Run the chat.
    return this.run();
  }
}
