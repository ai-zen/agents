import EventBus from "@ai-zen/event-bus";
import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { AgentNS } from "./AgentNS.js";
import { AgentContext } from "./AgentContext.js";
import type { UnknownToolContext } from "./AgentContext.js";
import { PickRequired } from "./Common.js";
import { ToolCallContext } from "./ToolCallContext.js";
import { Message } from "./Message.js";
import { Tool } from "./Tool.js";

// ---------------------------------------------------------------------------
// 插件接口
// ---------------------------------------------------------------------------

/**
 * 插件钩子统一返回值：返回 string = 短路（拒绝/中断/提供结果），
 * 返回 undefined/void = 放行（继续后续插件或默认行为）。
 */
export type HookResult = string | void | Promise<string | void>;

/**
 * Agent 插件上下文：当前 Agent + 发送内容 + 消息列表快照。
 *
 * 注意：
 * - messages 是当前 agent 消息数组的**快照**（浅拷贝），插件不应直接修改它。
 *   所有消息变更应通过 agent 上的方法进行。
 */
export interface SendContext {
  agent: Agent;
  content: string;
  /** 当前 agent 消息数组的浅拷贝快照，仅供读取，不应直接修改 */
  messages: AgentNS.Message[];
}

/**
 * Agent 插件接口。每个插件单一职责，通过钩子介入 Agent 生命周期。
 *
 * 所有钩子统一「返回值可短路」：返回字符串时短路（各钩子语义见下表），
 * 返回 undefined/void 时放行。多个插件按注册顺序调用，任一返回字符串即短路。
 *
 * | 钩子 | 入参 | 返回 string 的语义 |
 * |------|------|---------------------|
 * | `onInit` | — | 初始化，不短路 |
 * | `onBeforeSend` | SendContext | 拒绝 send（抛错中断） |
 * | `onAfterSend` | SendContext | 仅短路后续插件 |
 * | `onInnerLoopStart` | SendContext | 中断本轮（抛错） |
 * | `onInnerLoopEnd` | SendContext | 仅短路后续插件 |
 * | `onInnerLoopsStart` | SendContext | 中断整组（抛错） |
 * | `onInnerLoopsEnd` | SendContext | 仅短路后续插件 |
 * | `onToolCall` | ToolCallContext | 拒绝该工具，原因作为工具结果回给 LLM |
 * | `onUnknownTool` | UnknownToolContext | 作为工具结果返回；undefined 走默认提示 |
 */
export interface AgentPlugin {
  /** Agent.init() 时调用，用于异步初始化 */
  onInit?(): Promise<void>;
  /** Agent.send() 调用前触发。返回 string 拒绝本次发送（抛错中断） */
  onBeforeSend?(ctx: SendContext): HookResult;
  /** Agent.send() 返回后调用 */
  onAfterSend?(ctx: SendContext): HookResult;
  /** Agent 内循环开始前触发（每次 API 请求前）。返回 string 中断本轮 */
  onInnerLoopStart?(ctx: SendContext): HookResult;
  /** Agent 内循环结束后触发（一次 API 请求 + 可能的工具调用后） */
  onInnerLoopEnd?(ctx: SendContext): HookResult;
  /** Agent 整组内循环开始前触发（一次 send 仅一次）。返回 string 中断整组 */
  onInnerLoopsStart?(ctx: SendContext): HookResult;
  /** Agent 整组内循环结束后触发（一次 send 仅一次） */
  onInnerLoopsEnd?(ctx: SendContext): HookResult;
  /**
   * 单个工具调用执行前触发（收同一个 ToolCallContext 实例）。
   * 返回字符串 = 拒绝该工具（不执行，原因作为工具结果回给 LLM，继续下一轮）；
   * 返回 undefined = 放行。多个插件按注册顺序调用，任一返回字符串即拒绝（短路）。
   */
  onToolCall?(ctx: ToolCallContext): HookResult;
  /**
   * LLM 调用未注册工具时触发。
   * 返回字符串 = 作为工具结果返回给 LLM；
   * 返回 undefined = 继续（最终使用 Agent 默认提示，或 SdkAgent 覆盖的智能提示）。
   */
  onUnknownTool?(ctx: UnknownToolContext): HookResult;
}

/** 钩子名 → kebab-case 事件名（dispatchHook 内 events.emit 使用） */
const HOOK_EVENTS: Record<string, string> = {
  onBeforeSend: "before-send",
  onAfterSend: "after-send",
  onInnerLoopStart: "inner-loop-start",
  onInnerLoopEnd: "inner-loop-end",
  onInnerLoopsStart: "inner-loops-start",
  onInnerLoopsEnd: "inner-loops-end",
  onToolCall: "tool-call",
  onUnknownTool: "unknown-tool",
};

interface PendingTask {
  controller: AbortController;
  receiver: AgentNS.Message;
}

export class Agent extends AgentContext {
  events = new EventBus();

  /** 最近一次 API 响应的 token 用量 */
  lastUsage?: AgentNS.Usage;

  /** 已注册的插件列表 */
  private _plugins: AgentPlugin[] = [];

  constructor(options: PickRequired<AgentContext, "client" | "model">) {
    super(options);
  }

  /**
   * 注册一个插件。
   * 可以在 init() 之前或之后调用，但生命周期钩子仅在 send/run 时生效。
   */
  use(plugin: AgentPlugin): void {
    this._plugins.push(plugin);
  }

  /**
   * 初始化所有已注册插件（执行各插件 onInit）。
   */
  async init(): Promise<void> {
    for (const plugin of this._plugins) {
      await plugin.onInit?.();
    }
  }

  /**
   * 统一钩子分发：先发出**非阻塞**的 kebab-case 事件（events.emit，同步广播、不短路），
   * 再按注册顺序**阻塞**调用插件钩子，任一返回字符串即短路并返回该字符串。
   *
   * 事件与插件收口在同一个入口：
   * - 事件监听器（agent.events.on）获得的是非阻塞通知（不影响流程）
   * - 插件钩子（agent.use）获得的是阻塞的可短路回调（可干预流程）
   *
   * @returns 短路字符串（undefined 表示全部放行）
   */
  private async dispatchHook(
    hook: keyof AgentPlugin,
    ctx: SendContext | ToolCallContext | UnknownToolContext,
  ): Promise<string | undefined> {
    // 非阻塞事件广播（不 await、不短路）
    this.events.emit(HOOK_EVENTS[hook as string], ctx);

    // 阻塞插件分发（短路）
    let result: string | undefined;
    for (const plugin of this._plugins) {
      const fn = plugin[hook];
      if (typeof fn !== "function") continue;
      const r = await (fn as (ctx: any) => HookResult).call(plugin, ctx);
      if (r !== undefined) {
        result = r;
        break;
      }
    }
    return result;
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
   * @param ctx 插件上下文（由 send() 传入；直接调用 run() 时构造默认上下文）
   */
  async run(ctx?: SendContext) {
    // 空消息校验：至少需要一条消息（如 send 追加的 User 消息）
    if (!this.messages.length) {
      throw new Error(
        "You need to send at least one message as a receive message",
      );
    }

    // 直接 run() 时的兜底上下文
    const sendCtx: SendContext = ctx ?? {
      agent: this,
      content: "",
      messages: [...this.messages],
    };

    // 整组内循环开始（一次 send 仅一次）；Assistant 占位由每次内循环开头统一追加
    const loopsDenied = await this.dispatchHook("onInnerLoopsStart", sendCtx);
    if (loopsDenied !== undefined) {
      throw new Error(`inner-loops-start 被插件拒绝: ${loopsDenied}`);
    }

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

      // 每次请求前分发钩子（可刷新工具定义、安全护栏等）
      const loopDenied = await this.dispatchHook("onInnerLoopStart", sendCtx);
      if (loopDenied !== undefined) {
        throw new Error(`inner-loop-start 被插件拒绝: ${loopDenied}`);
      }

      const messages = this.formatHistory();
      const tools = this.formatTools();

      try {
        // 通过官方 SDK 发起流式对话请求（连接建立后即进入 Writing）
        const stream = (await this.client.chat.completions.create(
          {
            model: this.model,
            messages,
            tools,
            stream: true,
            stream_options: { include_usage: true },
            // 透传模型参数（temperature 等；可含厂商特有字段，如 DeepSeek thinking）
            ...this.modelConfig,
          } as any,
          { signal: currentController.signal },
        )) as unknown as AsyncIterable<ChatCompletionChunk>;

        (currentReceiver as AgentNS.Message).status =
          AgentNS.MessageStatus.Writing;
        this.events.emit("open");

        await this.parseStreamData(currentReceiver, stream);

        const receiverStatus = currentReceiver.status as
          | AgentNS.MessageStatus
          | undefined;
        if (
          receiverStatus === AgentNS.MessageStatus.Aborted ||
          receiverStatus === AgentNS.MessageStatus.Error
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
        await this.dispatchHook("onInnerLoopEnd", sendCtx);
      } catch (error: any) {
        currentReceiver.status = AgentNS.MessageStatus.Error;
        currentReceiver.content = error.message;
        this.events.emit("error", error);
      } finally {
        // 每轮结束统一触发（无论正常/continue/异常）
        this.events.emit("finally");
        // 本轮 assistant 任务已完成，从活跃集合移除；
        // 整组记录（innerLoopsTasks）保留至 run 结束统一清空
        this.innerLoopTasks.delete(pendingTask);
      }
    }

    // 整组内循环结束：含多轮工具调用，messages 为完整结果（正常/error/abort 均到达此处）
    await this.dispatchHook("onInnerLoopsEnd", sendCtx);

    // 清空整组 + 当前轮活跃任务记录
    this.innerLoopsTasks.clear();
    this.innerLoopTasks.clear();

    return this.messages;
  }

  /**
   * Get the available tool definitions.
   */
  formatTools() {
    if (!this.tools?.length) return undefined;
    return this.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        // 注入 strict: true，确保模型严格按照 JSON Schema 生成参数
        strict: true,
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
   *
   * 消费 openai 官方 SDK 的流式 chunk（ChatCompletionChunk）。
   * 注意：SDK 类型未声明 DeepSeek 等厂商特有的 reasoning_content 字段，
   * 此处按 any 处理以兼容思维链增量。
   */
  async parseStreamData(
    receiver: AgentNS.Message,
    stream: AsyncIterable<ChatCompletionChunk>,
  ) {
    for await (const chunk of stream) {
      this.events.emit("chunk", chunk);

      // 捕获流式最后一个 chunk 的 usage
      if (chunk?.usage) {
        this.lastUsage = chunk.usage as unknown as AgentNS.Usage;
      }

      if (chunk?.choices?.[0]) {
        const finishReason = chunk.choices[0].finish_reason;
        if (finishReason) {
          receiver.finish_reason = finishReason as AgentNS.FinishReason;
        }

        const delta = chunk.choices[0].delta as any;

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
            resultMessage: resultReceiver,
            allowJsonParseError: this.allowJsonParseError,
            // 注入工具执行的中止信号：abort() 会中止 toolTask.controller →
            // signal 触发 → 工具实现可监听 signal 真正中断执行
            signal: toolTask.controller.signal,
          });

          // 工具拦截钩子：返回字符串 = 拒绝（原因作为工具结果返回给 LLM，继续下一轮）
          const denied = await this.dispatchHook("onToolCall", ctx);
          if (denied !== undefined) {
            resultReceiver.content = `工具 ${task.function!.name} 被拒绝：${denied}`;
            markResult(AgentNS.MessageStatus.Completed);
            return { isPreventDefault: false, status: resultReceiver.status };
          }

          // 如果 JSON 解析失败且允许容错，将错误信息作为结果返回给 AI
          if (ctx.parseError) {
            resultReceiver.content = `参数解析错误: ${ctx.parseError}\n请检查你提供的参数格式，确保是合法的 JSON。`;
            markResult(AgentNS.MessageStatus.Completed);
            return { isPreventDefault: false, status: resultReceiver.status };
          }

          if (!matchedTool) {
            const hint = await this.dispatchHook("onUnknownTool", {
              toolCall: task,
              availableTools: [...this.tools],
            });
            resultReceiver.content =
              hint !== undefined
                ? hint
                : this.defaultUnknownTool(task);
          } else {
            resultReceiver.content = await matchedTool.exec(ctx);
          }
          markResult(AgentNS.MessageStatus.Completed);

          return {
            isPreventDefault: ctx.isPreventDefault,
            status: resultReceiver.status,
          };
        } catch (error: any) {
          if (this.allowJsonParseError) {
            // 工具执行异常时，将错误信息返回给 AI 继续
            resultReceiver.content = `执行工具 ${task.function!.name} 时出错: ${error?.message}`;
            markResult(AgentNS.MessageStatus.Completed);
            return { isPreventDefault: false, status: resultReceiver.status };
          }

          // allowJsonParseError=false 时，标记为 Error（已被 abort 则保持 Aborted）
          resultReceiver.content = error?.message;
          markResult(AgentNS.MessageStatus.Error);
          return { isPreventDefault: true, status: resultReceiver.status };
        }
      }),
    );

    // isPreventDefault: 工具主动要求停止（preventDefault）
    // status: 消息状态，Error 表示工具执行出错且不容错
    // 两者任一为 true，则不继续下一轮
    const shouldStop = results.some(
      (r) => r.isPreventDefault || r.status === AgentNS.MessageStatus.Error,
    );

    return !shouldStop;
  }

  /**
   * 未知工具默认提示（简单文本兜底）。
   * 需要更智能的提示（如根据上下文引导）时，请通过 `onUnknownTool` 插件提供，
   * 插件返回 undefined 时最终回落到此默认提示。
   */
  private defaultUnknownTool(toolCall: AgentNS.ToolCall): string {
    return `未知工具: ${toolCall.function?.name}，没有找到对应的工具实现。`;
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
    // 插件上下文（消息快照仅供读取）
    const ctx: SendContext = {
      agent: this,
      content: typeof content === "string" ? content : "",
      messages: [...this.messages],
    };

    // onBeforeSend 钩子：可刷新工具等；返回 string 则拒绝本次发送
    const denied = await this.dispatchHook("onBeforeSend", ctx);
    if (denied !== undefined) {
      throw new Error(`send 被插件拒绝: ${denied}`);
    }

    // Create a question message.
    this.append(Message.User(content));

    // Run the chat：Assistant 占位由 run 内循环开头统一追加。
    const result = await this.run(ctx);

    // onAfterSend 钩子：可做迁移、保存等后处理
    await this.dispatchHook("onAfterSend", ctx);

    return result;
  }
}
