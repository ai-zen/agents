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

  /** 最近一次 API 响应的 token 用量 */
  lastUsage?: AgentNS.Usage;

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
    // 验证初始 receiver 消息
    let receiver = this.messages.at(-1) as Message | undefined;
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

    const initialController = new AbortController();
    const initialPendingTask: PendingTask = { controller: initialController, receiver };
    this.pendingTasks.add(initialPendingTask);

    // 使用 while 循环替代递归
    let currentReceiver: Message = receiver;
    let currentController: AbortController = initialController;
    const allPendingTasks: PendingTask[] = [initialPendingTask];
    let needContinue = true;

    while (needContinue) {
      needContinue = false;

      // 每次请求前调用钩子，允许外部刷新工具定义等
      await this.onBeforeSend?.();

      const messages = this.formatHistory();
      const tools = this.formatTools();

      this.events.emit("run", messages, tools);

      const stream = this.model.createStream({
        signal: currentController.signal,
        messages,
        tools,
        onOpen: () => {
          currentReceiver.status = AgentNS.MessageStatus.Writing;
          this.events.emit("open");
        },
        onError: (error: any) => {
          currentReceiver.status = AgentNS.MessageStatus.Error;
          currentReceiver.content = error.message;
          this.events.emit("error", error);
        },
        onFinally: () => {
          this.events.emit("finally");
        },
      });

      try {
        await this.parseStreamData(currentReceiver, stream);

        if (
          currentReceiver.status === AgentNS.MessageStatus.Aborted ||
          currentReceiver.status === AgentNS.MessageStatus.Error
        ) {
          continue;
        }

        currentReceiver.status = AgentNS.MessageStatus.Completed;

        if (await this.handleToolCall(currentReceiver)) {
          if (
            (currentReceiver.status as AgentNS.MessageStatus | undefined) === AgentNS.MessageStatus.Aborted ||
            (currentReceiver.status as AgentNS.MessageStatus | undefined) === AgentNS.MessageStatus.Error
          ) {
            continue;
          }

          // 准备下一轮对话
          this.append(Message.Assistant());
          currentReceiver = this.messages.at(-1) as Message;
          currentController = new AbortController();
          const newPendingTask: PendingTask = { controller: currentController, receiver: currentReceiver };
          allPendingTasks.push(newPendingTask);
          this.pendingTasks.add(newPendingTask);
          needContinue = true;
        }

        // 每次 run 完成（一次 API 请求 + 可能的工具调用）
        this.events.emit("run-end");
      } catch (error: any) {
        currentReceiver.status = AgentNS.MessageStatus.Error;
        currentReceiver.content = error.message;
        this.events.emit("error", error);
      }
    }

    // 清理所有 pendingTasks
    for (const task of allPendingTasks) {
      this.pendingTasks.delete(task);
    }

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
        reasoning_content: message.reasoning_content ?? undefined,
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

      // 捕获流式最后一个 chunk 的 usage
      if (chunk?.usage) {
        this.lastUsage = chunk.usage;
      }

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

        if (delta?.reasoning_content) {
          if (typeof receiver.reasoning_content != "string") {
            receiver.reasoning_content = "";
          }

          receiver.reasoning_content += delta.reasoning_content;
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

    if (tasks.length === 0) return false;

    // 并行执行所有工具，每个工具独立处理结果，互不影响
    const results = await Promise.all(
      tasks.map(async (task) => {
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
            allowJsonParseError: this.allowJsonParseError,
          });

          // 如果 JSON 解析失败且允许容错，将错误信息作为结果返回给 AI
          if (ctx.parse_error) {
            resultReceiver.content = `参数解析错误: ${ctx.parse_error}\n请检查你提供的参数格式，确保是合法的 JSON。`;
            resultReceiver.status = AgentNS.MessageStatus.Completed;
            return { is_prevent_default: false, status: resultReceiver.status };
          }

          if (!matchTools) {
            resultReceiver.content = `未知工具: ${task.function!.name}，没有找到对应的工具实现。`;
          } else {
            resultReceiver.content = await matchTools.exec(ctx);
          }
          resultReceiver.status = AgentNS.MessageStatus.Completed;

          return {
            is_prevent_default: ctx.is_prevent_default,
            status: resultReceiver.status,
          };
        } catch (error: any) {
          if (this.allowJsonParseError) {
            // 工具执行异常时，将错误信息返回给 AI 继续
            resultReceiver.content = `执行工具 ${task.function!.name} 时出错: ${error?.message}`;
            resultReceiver.status = AgentNS.MessageStatus.Completed;
            return { is_prevent_default: false, status: resultReceiver.status };
          }

          // allowJsonParseError=false 时，标记为 Error
          resultReceiver.content = error?.message;
          resultReceiver.status = AgentNS.MessageStatus.Error;
          return { is_prevent_default: true, status: resultReceiver.status };
        }
      }),
    );

    // is_prevent_default: 工具主动要求停止（preventDefault）
    // status: 消息状态，Error 表示工具执行出错且不容错
    // 两者任一为 true，则不继续下一轮
    const shouldStop = results.some(
      (r) => r.is_prevent_default || r.status === AgentNS.MessageStatus.Error,
    );

    return !shouldStop;
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
