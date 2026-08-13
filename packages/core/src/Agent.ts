import { AsyncQueue } from "@ai-zen/async-queue";
import EventBus from "@ai-zen/event-bus";
import { AgentNS } from "./AgentNS.js";
import { AgentContext as AgentContext } from "./AgentContext.js";
import { PickRequired } from "./Common.js";
import { ToolCallContext } from "./ToolCallContext.js";
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
   * 整组内循环（一次 send）产生的所有消息任务：每轮 assistant + 每个工具结果，
   * 各带 AbortController（中止其产生）。全程保留（不随完成移出），run 结束统一清空；
   * 供整组追踪/审计使用（abort 不遍历本集合，见 innerLoopTasks）。
   */
  private innerLoopsTasks: Set<PendingTask> = new Set();

  /**
   * 当前内循环（单轮）进行中的消息任务：内循环开始时记录，完成时清除。
   * 只保留未完成任务；abort 统一遍历本集合：中止 controller + 标记 receiver 为 Aborted。
   */
  private innerLoopTasks: Set<PendingTask> = new Set();

  /**
   * Abort current in-flight inner-loop tasks.
   */
  abort() {
    this.innerLoopTasks.forEach((task) => {
      task.controller.abort();
      task.receiver.status = AgentNS.MessageStatus.Aborted;
    });
  }

  /**
   * Run the conversation with the server.
   */
  async run() {
    // 空消息校验：至少需要一条消息（如 send 追加的 User 消息）
    if (!this.messages.length) {
      throw new Error(
        "You need to send at least one message as a receive message",
      );
    }

    // 整组内循环开始：user 消息已就绪（一次 send 仅一次）；
    // Assistant 占位由每次内循环开头统一追加
    await this.onInnerLoopsStart?.();

    this.events.emit("inner-loops-start", this.messages);

    // 内循环
    let needContinue = true;
    while (needContinue) {
      needContinue = false;

      // 内循环开头统一添加 Assistant 占位：若最后一条不是 Pending 的 Assistant 则追加，
      // 使 run 无论从 send（末尾 User）还是手动追加（末尾任意）都能自洽启动
      const last = this.messages.at(-1) as Message | undefined;
      if (
        !last ||
        last.role !== AgentNS.Role.Assistant ||
        last.status !== AgentNS.MessageStatus.Pending
      ) {
        this.append(Message.Assistant());
      }

      const currentReceiver = this.messages.at(-1) as Message;
      const currentController = new AbortController();
      const pendingTask: PendingTask = {
        controller: currentController,
        receiver: currentReceiver,
      };
      // 整组记录 + 当前轮活跃任务
      this.innerLoopsTasks.add(pendingTask);
      this.innerLoopTasks.add(pendingTask);

      // 每次请求前调用钩子，允许外部刷新工具定义等
      await this.onInnerLoopStart?.();

      const messages = this.formatHistory();
      const tools = this.formatTools();

      this.events.emit("inner-loop-start", messages, tools);

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
          // 本轮 assistant 已中止/出错：任务完成，finally 统一移除
          continue;
        }

        currentReceiver.status = AgentNS.MessageStatus.Completed;

        if (await this.handleToolCall(currentReceiver)) {
          if (
            (currentReceiver.status as AgentNS.MessageStatus | undefined) ===
              AgentNS.MessageStatus.Aborted ||
            (currentReceiver.status as AgentNS.MessageStatus | undefined) ===
              AgentNS.MessageStatus.Error
          ) {
            // 本轮 assistant 被中止/出错：任务完成，finally 统一移除
            continue;
          }

          // 需要继续下一轮：下一轮内循环开头统一追加 Assistant 占位
          needContinue = true;
        }

        // 每次 内循环 完成（一次 API 请求 + 可能的工具调用）
        this.events.emit("inner-loop-end");

        // 每次 内循环 完成，允许外面做一些后处理再进行下次循环
        await this.onInnerLoopEnd?.();
      } catch (error: any) {
        currentReceiver.status = AgentNS.MessageStatus.Error;
        currentReceiver.content = error.message;
        this.events.emit("error", error);
      } finally {
        // 本轮 assistant 任务已完成（无论正常/continue/异常），从活跃集合移除；
        // 整组记录（innerLoopsTasks）保留至 run 结束统一清空
        this.innerLoopTasks.delete(pendingTask);
      }
    }

    // 整组内循环结束：含多轮工具调用，messages 为完整结果（正常/error/abort 均到达此处）
    this.events.emit("inner-loops-end", this.messages);

    await this.onInnerLoopsEnd?.();

    // 清空整组 + 当前轮活跃任务记录
    this.innerLoopsTasks.clear();
    this.innerLoopTasks.clear();

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

        // 工具执行前就记录（整组 + 当前轮活跃任务），abort 可统一中止/标记；
        // 完成后从活跃集合移除，整组保留至 run 结束统一清空
        const toolTask: PendingTask = {
          controller: new AbortController(),
          receiver: resultReceiver,
        };
        this.innerLoopsTasks.add(toolTask);
        this.innerLoopTasks.add(toolTask);

        /** 工具执行完成：若该任务已被 abort（abort 后工具仍会跑完），保持 Aborted 不被覆盖；
         *  任务完成即从当前轮活跃集合移除 */
        const markResult = (status: AgentNS.MessageStatus) => {
          resultReceiver.status = toolTask.controller.signal.aborted
            ? AgentNS.MessageStatus.Aborted
            : status;
          this.innerLoopTasks.delete(toolTask);
        };

        try {
          const matchedTool: Tool | undefined = this.tools.find(
            (tool) =>
              tool.function.name == task.function!.name &&
              tool.type == "function",
          );

          // 统一上下文：一个类贯穿「拦截决策 → 执行」，onToolCall 与 Tool.exec 收同一实例。
          // 参数解析（JSON.parse）在构造函数中完成；allowJsonParseError=false 且非法时
          // 构造函数抛错 → 走下方 catch（标记 Error，不过拦截钩子）。
          const ctx = new ToolCallContext({
            agent: this,
            tool_call: task,
            tool: matchedTool,
            result_message: resultReceiver,
            allowJsonParseError: this.allowJsonParseError,
            // 注入工具执行的中止信号：abort() 会中止 toolTask.controller →
            // signal 触发 → 工具实现可监听 signal 真正中断执行
            signal: toolTask.controller.signal,
          });

          // 阻塞式钩子：可拒绝单个工具调用（返回字符串 = 拒绝原因，作为工具结果返回给 LLM，
          // 工具不执行、继续下一轮让 LLM 调整）
          const denied = await this.onToolCall?.(ctx);
          if (denied) {
            resultReceiver.content = `工具 ${task.function!.name} 被拒绝：${denied}`;
            markResult(AgentNS.MessageStatus.Completed);
            return { is_prevent_default: false, status: resultReceiver.status };
          }

          // 如果 JSON 解析失败且允许容错，将错误信息作为结果返回给 AI
          if (ctx.parse_error) {
            resultReceiver.content = `参数解析错误: ${ctx.parse_error}\n请检查你提供的参数格式，确保是合法的 JSON。`;
            markResult(AgentNS.MessageStatus.Completed);
            return { is_prevent_default: false, status: resultReceiver.status };
          }

          if (!matchedTool) {
            if (this.onUnknownTool) {
              resultReceiver.content = await this.onUnknownTool({
                toolCall: task,
                availableTools: [...this.tools],
              });
            } else {
              resultReceiver.content = `未知工具: ${task.function!.name}，没有找到对应的工具实现。`;
            }
          } else {
            resultReceiver.content = await matchedTool.exec(ctx);
          }
          markResult(AgentNS.MessageStatus.Completed);

          return {
            is_prevent_default: ctx.is_prevent_default,
            status: resultReceiver.status,
          };
        } catch (error: any) {
          if (this.allowJsonParseError) {
            // 工具执行异常时，将错误信息返回给 AI 继续
            resultReceiver.content = `执行工具 ${task.function!.name} 时出错: ${error?.message}`;
            markResult(AgentNS.MessageStatus.Completed);
            return { is_prevent_default: false, status: resultReceiver.status };
          }

          // allowJsonParseError=false 时，标记为 Error（已被 abort 则保持 Aborted）
          resultReceiver.content = error?.message;
          markResult(AgentNS.MessageStatus.Error);
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

    // Rewrite the user question.
    await this.rag?.rewrite(questionMessage, this.messages);

    // Run the chat：Assistant 占位由 run 内循环开头统一追加。
    return this.run();
  }
}
