import EventBus from "@ai-zen/event-bus";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { AgentNS } from "./AgentNS.js";
import { AgentContext } from "./AgentContext.js";
import type { UnknownToolContext } from "./AgentContext.js";
import { PickRequired } from "./Common.js";
import { ToolCallContext } from "./ToolCallContext.js";
import { Message, generateMessageId } from "./Message.js";
import { inboxEntryMessage } from "./Inbox.js";
import { Tool } from "./Tool.js";
import { reconcileAbortedToolRounds } from "./AbortedToolRounds.js";
import { reconcileAbortedMessages } from "./AbortedMessages.js";
import { applyChunk } from "./applyChunk.js";
import { formatContentSection } from "./formatContent.js";

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
 * 子 Agent 委派上下文：一次「主 Agent 委派子 Agent」的边界。
 *
 * - `agent` 与其余各 ctx 约定一致，指**宿主（主）Agent**，即发起委派、分发本钩子的 Agent；
 * - `subAgent` 为**子 Agent**实例（onSubAgentStart 时已构建完成、尚未 run；onSubAgentEnd 时已运行结束）；
 * - `toolCallContext` 为触发本次委派的工具调用上下文（含 parsedArgs / signal / resultMessage）。
 */
export interface SubAgentContext {
  /** 宿主（主）Agent —— 发起委派者 */
  agent: Agent;
  /** 子 Agent 实例 */
  subAgent: Agent;
  /** 触发本次委派的工具调用上下文 */
  toolCallContext: ToolCallContext;
}

/**
 * 单个工具调用结束（结果已定型）的事件载荷 —— `tool-call-end`。
 *
 * 为何需要这个事件：一轮里的并行工具是 `Promise.all` 跑的，`finally` 只在**整轮**
 * 结束后发一次。于是「edit 已经回来了、只剩 exec 在跑」这个中间状态外界根本观测不到，
 * 任何按「正在等谁」展示的界面都只好把整轮的工具名一起报出来，在用户看来就是「明明
 * 在等 exec，却写着 edit」。本事件每个工具各发一次，谁先跑完谁先发。
 *
 * 与 `onToolCall`（事件名 `tool-call`，执行**前**的拦截点）成对，方向相反。
 */
export interface ToolCallEndContext {
  /** 宿主 Agent */
  agent: Agent;
  /** 本次调用（含 `index` / `id` / `function.name`） */
  toolCall: AgentNS.ToolCall;
  /**
   * 已定型的结果消息（`role: "tool"`）。
   *
   * `status` 是最终值：`completed` / `error` / `aborted`（被 `abort()` 中止的工具
   * 即使跑完也不算成功）。消费方直接读它，不必再回 `agent.messages` 里反查。
   */
  result: AgentNS.Message;
}

/**
 * 事件载荷 —— `inbox`：有人往 `agent.inbox` 里推了一条待发内容。
 *
 * 载荷带 `agent`（哪个 Agent 收的）与 `entry`（推的那条本身）：「推成功」这件事的发生
 * 时刻只有推的人自己知道，宿主/客户端据此点亮「已排队 N 条」，而不必轮询 `inbox`。
 */
export interface InboxContext {
  /** 收下这条条目的 Agent */
  agent: Agent;
  /** 原样推入的那条条目（含已补齐的 `messageId` / `createdAt`） */
  entry: AgentNS.InboxEntry;
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
 * | `onSubAgentStart` | SubAgentContext | 拒绝本次委派（原因作为工具结果回给 LLM） |
 * | `onSubAgentEnd` | SubAgentContext | 仅短路后续插件 |
 */
export interface AgentPlugin {
  onInit?(): Promise<void>;
  onBeforeSend?(ctx: SendContext): HookResult;
  onAfterSend?(ctx: SendContext): HookResult;
  onInnerLoopStart?(ctx: SendContext): HookResult;
  onInnerLoopEnd?(ctx: SendContext): HookResult;
  onInnerLoopsStart?(ctx: SendContext): HookResult;
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
  /**
   * 子 Agent 委派开始前触发（子 Agent 已构建完成、尚未 run）。
   * 返回字符串 = 拒绝本次委派（子 Agent 不运行，原因作为工具结果回给 LLM，继续下一轮）；
   * 返回 undefined = 放行。多个插件按注册顺序调用，任一返回字符串即拒绝（短路）。
   */
  onSubAgentStart?(ctx: SubAgentContext): HookResult;
  /**
   * 子 Agent 结束后触发（子 Agent 所有轮次完成，含 tool_calls 多轮递归）。
   * 返回字符串 = 仅短路后续插件（子 Agent 已运行完成，无法撤销）；
   * 返回 undefined = 放行。
   */
  onSubAgentEnd?(ctx: SubAgentContext): HookResult;
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
  onSubAgentStart: "sub-agent-start",
  onSubAgentEnd: "sub-agent-end",
};

interface PendingTask {
  controller: AbortController;
  receiver: AgentNS.Message;
}

export class Agent extends AgentContext {
  events = new EventBus();

  /**
   * 运行中排队的待发内容：`pushInbox()` 推进来，`run()` 在对应的插入点取走并落成 User 消息。
   *
   * 公开可读（宿主据此展示「已排队 N 条」），写入走 `pushInbox` / `clearInbox`。
   * 数组实例自始至终是同一个（推进用 `push`、取走与清空用 `splice`），所以拿着它做快照
   * 的调用方不会抱到一份过期的副本。
   */
  inbox: AgentNS.InboxEntry[] = [];

  /** 已注册的插件列表 */
  private _plugins: AgentPlugin[] = [];

  constructor(options: PickRequired<AgentContext, "client" | "model">) {
    super(options);
  }

  /**
   * 最近一次 API 响应的 token 用量。
   *
   * **派生值，不是独立状态**：取 `messages` 中最近一条未 `omit`、带 `usage` 的 assistant 消息。
   * 用量本就随消息持久化，此处只是读最后一条，故迁移 / 替换 `messages` 后自动跟随，
   * 不会出现「字段与消息各存一份、改了一处另一处过期」的问题。只读，无 setter。
   */
  get lastUsage(): AgentNS.Usage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i]!;
      if (message.role === AgentNS.Role.Assistant && !message.omit && message.usage) {
        return message.usage;
      }
    }
    return undefined;
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
   * 公开可见：子 Agent 委派边界（`onSubAgentStart` / `onSubAgentEnd`）由发起委派的工具
   * （`AgentTool` / `AgentToolLazy`）在宿主 Agent 上分发，故此处不设 private。
   *
   * @returns 短路字符串（undefined 表示全部放行）
   */
  async dispatchHook(
    hook: keyof AgentPlugin,
    ctx: SendContext | ToolCallContext | UnknownToolContext | SubAgentContext,
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
   * 本轮（这一次 `run`）是否已经被 `abort()` 叫停。
   *
   * ## 为什么另立一个标志，而不是沿用「receiverStatus === Aborted」
   *
   * 那个值说的是「**某条消息**被标了中止」，而且只在「内循环刚跑完、还没 reconcile」那一
   * 刻可读：`reconcileAbortedToolRounds`（fill 策略）与 `reconcileAbortedMessages`（keep
   * 策略）会把被中止的消息改回 `Completed`。而 inbox 的两个插入点里，低优先那个恰恰排在
   * 两个 reconcile **之后**，高优先那个也可能已经跨过了好几条消息 —— 到那儿再去翻消息，
   * 已经看不出「这一轮还要不要继续」了。所以要判断的是**这一轮**的状态，就直记在轮上。
   *
   * ## 何时置起 / 何时复位
   *
   * `abort()` 置 true、`run()` 每次开头复位：与今天一致 —— 没在跑的时候调 `abort()`，
   * 不影响下一次 `send` 的正常运行（本次只清空 inbox，不带脾气到下一轮）。
   */
  private runAborted = false;

  /**
   * 当前内循环（单轮）进行中的消息任务：内循环开始时记录，完成时清除。
   * 只保留未完成任务；abort 统一遍历本集合：中止 controller + 标记 receiver 为 Aborted。
   */
  private innerLoopTasks: Set<PendingTask> = new Set();

  abort() {
    // 这一轮已被叫停：`run()` 的两个插入点都不再取条目，也不再开新圈（见 runAborted）
    this.runAborted = true;
    // 用户按停 = 排队的内容不发了：丢掉并清空（宿主据此收起「已排队 N 条」）
    this.clearInbox();
    this.innerLoopTasks.forEach((task) => {
      task.controller.abort();
      task.receiver.status = AgentNS.MessageStatus.Aborted;
    });
  }

  /**
   * 推一条内容进 `inbox`，等 `run()` 在对应插入点把它落成一条 User 消息。
   *
   * 缺 `messageId` / `createdAt` 就地补：`messageId` 允许由调用方在**入队时**定下 —— 宿主
   * 先把它告诉客户端（乐观回显），落地那条消息用同一个 id，同一条内容才不会画两遍。
   *
   * 推完立即广播事件 `inbox`（非阻塞）：载荷是 `{ agent, entry }`，与「推成功」这个时刻一一
   * 对应，订阅方不必轮询数组。
   *
   * @returns 实际入队的那条（补齐后的完整条目）
   */
  pushInbox(
    entry: Omit<AgentNS.InboxEntry, "messageId" | "createdAt"> & { messageId?: string },
  ): AgentNS.InboxEntry {
    const pushed: AgentNS.InboxEntry = {
      messageId: entry.messageId ?? generateMessageId(),
      source: entry.source,
      priority: entry.priority,
      content: entry.content,
      createdAt: new Date().toISOString(),
    };
    this.inbox.push(pushed);
    this.events.emit("inbox", { agent: this, entry: pushed } satisfies InboxContext);
    return pushed;
  }

  /**
   * 清空 inbox，返回被丢掉的那些条目（按入队顺序）。
   *
   * `abort()` 调它：用户按停就是这个意思 —— 排着队的东西一句也不发了。
   */
  clearInbox(): AgentNS.InboxEntry[] {
    return this.inbox.splice(0, this.inbox.length);
  }

  /**
   * 追加一条消息，并**立刻**广播出去（事件名 `message`）。
   *
   * ## 为什么覆写（而不是让调用方各自广播）
   *
   * 三处 append 都在 core 内部：用户消息（`send`）、占位 assistant（内循环开头）、工具结果
   * （`handleToolCall`，执行前）。外部想「知道多了哪一条」只有扫 `messages` 做差集一条路 ——
   * 那需要自己记住推过哪些，而这份记忆与数组本身是两个会漂的事实。广播点放在唯一的追加口上，
   * 订阅方就只需要「按 id 覆盖」这一条规则。
   *
   * ## 载荷是消息本身
   *
   * 不是 `{ agent, message, index }`：订阅方要的就是「哪一条」，`message.id` 唯一标识它，
   * 位置由接收方按自己的列表算（线上的那条事件同样只带消息，见协议 `session-message`）。
   */
  append(message: AgentNS.Message): AgentNS.Message {
    const appended = super.append(message);
    this.emitMessage(appended);
    return appended;
  }

  /**
   * 就地改完之后重发一次**同一条**消息（同 id，订阅方按 id 覆盖）。
   *
   * 两处调用：工具结果定型（`markResult` 把 `pending` 翻成终态）、一轮出错（`run` 的 catch
   * 把错误正文写进 assistant）。它们都不追加新消息，但「那条消息」变了 —— 只靠追加事件，
   * 订阅方会永远停在 `pending` 上。
   */
  private emitMessage(message: AgentNS.Message): void {
    this.events.emit("message", message);
  }

  /**
   * 把某一档优先级的条目**按入队顺序**全部从 `inbox` 里取走；不传 `priority` 就是全取。
   *
   * 用 `splice` 逐个摘而不是重建数组：`inbox` 是公开字段，外部可能拿着它做快照，
   * 换掉数组实例等于让那些引用指向一份不存在的排队队列。
   */
  private drainInbox(priority?: AgentNS.InboxPriority): AgentNS.InboxEntry[] {
    const taken: AgentNS.InboxEntry[] = [];
    for (let i = 0; i < this.inbox.length;) {
      const entry = this.inbox[i]!;
      if (priority !== undefined && entry.priority !== priority) {
        i++;
        continue;
      }
      taken.push(entry);
      this.inbox.splice(i, 1);
    }
    return taken;
  }

  /**
   * 取走某一档优先级的条目（不传 `priority` 就是全取），逐条落成 User 消息；返回「是否真的
   * 插进了东西」。
   *
   * 走 `append`（而不是 `messages.push`）：落地的那条也得广播 `message`，否则订阅方永远
   * 不知道屏幕上该多一条（宿主正是按这条事件落库的）。
   *
   * 返回值是各处防死循环的唯一判据：一条都没插就说明这一档（或整个队列）已经空了，再转一圈
   * 只会拿到一模一样的请求。
   */
  private insertInbox(priority?: AgentNS.InboxPriority): boolean {
    const entries = this.drainInbox(priority);
    for (const entry of entries) {
      this.append(inboxEntryMessage(entry));
    }
    return entries.length > 0;
  }

  /**
   * Run the conversation with the server.
   * @param ctx 插件上下文（由 send() 传入；直接调用 run() 时构造默认上下文）
   */
  async run(ctx?: SendContext) {
    // 新的一轮开工：上一轮若被 abort 过，那一笔在这里结清 —— 与今天一致，没在跑的时候
    // 调 abort() 不影响下一次 send（见 runAborted）
    this.runAborted = false;

    // 空消息校验：至少需要一条消息（如 send 追加的 User 消息）
    if (!this.messages.length) {
      throw new Error("You need to send at least one message as a receive message");
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

    // 内循环组（内循环 + 外循环）：一路跑到 inbox 里再没有低优先条目为止。
    await this.runLoops(sendCtx);

    // 整组内循环结束：含多轮工具调用，messages 为完整结果（正常/error/abort 均到达此处）
    await this.dispatchHook("onInnerLoopsEnd", sendCtx);

    // ★ 整组的最后一个取件点：收尾钩子之后**再判一次** inbox。
    //
    // ## 为什么取件点必须排在钩子之后
    //
    // `onInnerLoopsEnd` 是「这一组已经跑完」的唯一通知点，而插件在这一跳里做的事可能
    // 很慢、也可能顺手入队（SDK 的 `AutoMigratePlugin` 正是在这个钩子里问用户要不要迁移
    // —— 「用户在这一段时间里说的话」与「agent 刚停下」本来就是同一件事）。取件点若排在
    // 钩子**之前**，这一段推进来的条目就再也等不到取件者：调用方（宿主）已经回了
    // `queued` 并让客户端乐观画了一条，可这一轮不会再取 —— 那条内容既不落成消息、也不进
    // 任何一次请求，屏幕上就是这么凭空少一句。窗口跨度是「最后一次取件 → `send()` 返回」，
    // 宿主那边整个可入队区间都压在它上面，所以它必须由这一层兜住，不能留给调用方自律。
    //
    // ## 语义没有变
    //
    // 低优先级仍然是「agent 停下之后插入」：只是把「停下」的判定点挪到收尾钩子之后，
    // 让钩子里的入队也算这一轮。到这一步已经没有「内循环轮末」可等了，再等就是下一次
    // `send()`（那时候这一条已经不属于这一轮），所以这里**不分优先级**，按入队顺序一起落。
    //
    // ## 中止与死循环
    //
    // 中止（`runAborted`）时不再取件、也不再续圈：`abort()` 已经把 inbox 清空，清空之后
    // 才到的条目留给下一轮 —— 与改动前一致。循环只在**真的插进了条目**时才多跑一趟，于是
    // 「插件不在钩子里入队」的常态下这一次判空就退出，一次请求都不多发。
    while (!this.runAborted && this.insertInbox()) {
      await this.runLoops(sendCtx);
    }

    // 清空整组 + 当前轮活跃任务记录
    this.clearPendingTasks();

    return this.messages;
  }

  /**
   * 内循环组：一圈接一圈地跑，直到 inbox 里再没有低优先条目。
   *
   * ## 为什么它从 `run()` 里拆出来
   *
   * 整组首尾的两个钩子（`onInnerLoopsStart` / `onInnerLoopsEnd`）是「一次 send 各一次」的
   * 硬契约，而同一组内循环需要被跑**不止一趟**：`onInnerLoopsEnd` 与 `onAfterSend` 这两个
   * 收尾钩子里推进来的条目也算这一轮（见 `run()` 末尾、`send()` 末尾那两个取件点）。循环
   * 留在 `run()` 里，就只能在「再转一圈」与「不重发钩子」之间二选一 —— 拆出来之后，钩子
   * 各发一次归 `run()` 管，循环跑几趟归本方法管，两件事互不牵制。
   *
   * `sendCtx` 一路透传：同一次 send 里各圈拿到的是同一个上下文实例（与改动前一致）。
   */
  private async runLoops(sendCtx: SendContext): Promise<void> {
    // 外循环：一次 send 里，内循环可能被 inbox 反复续起来 —— 高优先条目把已经停下的内循环
    // 重新点亮，低优先条目则让整组内循环（连同末尾的 reconcile*）再跑一遍。
    let needContinue = true;
    while (true) {
      // 内循环（一次 API 请求 + 它引发的工具调用）：语义与改动前逐字一致，
      // 只是从「唯一的循环」变成了外循环里的一圈
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
              // 先铺模型参数（temperature 等；可含厂商特有字段，如 DeepSeek thinking），
              // 再写框架契约 —— **顺序不能反**：model / messages / tools / stream /
              // stream_options 是框架自己保证的，配置里写同名键也不能把它们改掉
              // （否则 `stream: false` 之类会直接把流式解析打崩）。
              ...this.modelConfig,
              model: this.model,
              messages,
              tools,
              stream: true,
              stream_options: { include_usage: true },
            } as any,
            { signal: currentController.signal },
          )) as unknown as AsyncIterable<ChatCompletionChunk>;

          (currentReceiver as AgentNS.Message).status = AgentNS.MessageStatus.Writing;
          this.events.emit("open");

          await this.parseStreamData(currentReceiver, stream);

          const receiverStatus = currentReceiver.status as AgentNS.MessageStatus | undefined;
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

          // 高优先级插入点：这一圈内循环刚收尾（工具结果已 append 进 messages）、下一次
          // 内循环开头的 Assistant 占位还没补。此刻插进来的 User 消息排在工具结果之后，
          // 模型下一次请求天然看得见。插进去了就得再转一圈，否则这份内容只是躺在
          // messages 里没人回。
          if (!this.runAborted && this.insertInbox("high")) {
            needContinue = true;
          }
        } catch (error: any) {
          currentReceiver.status = AgentNS.MessageStatus.Error;
          currentReceiver.content = error.message;
          // 错误正文落在消息上：先让订阅方看到这条消息的新样子，再报「这一轮出错了」
          this.emitMessage(currentReceiver);
          this.events.emit("error", error);
        } finally {
          // 每轮结束统一触发（无论正常/continue/异常）
          this.events.emit("finally");
          // 本轮 assistant 任务已完成，从活跃集合移除；
          // 整组记录（innerLoopsTasks）保留至 run 结束统一清空
          this.innerLoopTasks.delete(pendingTask);
        }
      }

      // 归一化工具调用轮次：中断/不完整的轮次按策略统一为「整轮进出」，
      // 保证 assistant（含 tool_calls）与其结果一一配对，避免服务端报错。
      // 此处所有工具任务已 settled（handleToolCall 内 await Promise.all），无竞态。
      reconcileAbortedToolRounds(
        this.messages,
        this.abortedToolRoundStrategy,
        this.abortedToolRoundReason,
      );

      // 被中断的 assistant（不带工具调用）按策略决定去留：`keep` 时保留已输出的内容/思考，
      // 让模型下一轮能接着半截往下说（`drop` 时 Aborted 消息不进历史）。
      // 必须排在工具轮次归一之后：带 `tool_calls` 的消息已由上一个函数处理，此处只收尾纯内容消息。
      reconcileAbortedMessages(this.messages, this.abortedMessageStrategy);

      // 被叫停的这一轮到此收工：abort() 已经把 inbox 清空，所以这里既不再取条目，
      // 也不再开新的一圈 —— 与改动前一致，abort 之后 run 只把 reconcile* 与
      // onInnerLoopsEnd 走完就返回（`onInnerLoopsEnd` 之后那个取件点也被 `runAborted` 挡着）。
      if (this.runAborted) break;

      // 低优先级插入点：内循环全部停下、reconcile* 也收完尾之后。插进去了才开下一圈；
      // 一条都没插就退出 —— 这是外循环唯一的正常出口（needContinue 由下一圈开头复位）。
      if (!this.insertInbox("low")) break;
      needContinue = true;
    }
  }

  /**
   * 收工：清空整组与当前轮的任务记录。
   *
   * `run()` 的正常出口调一次；`send()` 在收尾钩子之后又续了圈的情况下**要再调一次** ——
   * 那几圈是在 `run()` 清过之后跑的，记录留着不清，下一次 `abort()` 会翻到这些已经结束的
   * 任务，把它们的状态改成 `Aborted`（`abort()` 只遍历活跃集合，那正是它唯一的信息来源）。
   */
  private clearPendingTasks(): void {
    this.innerLoopsTasks.clear();
    this.innerLoopTasks.clear();
  }

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
   * 一条消息内容发给模型的那一份：字符串原样返回，数组逐段交给 {@link Agent.formatContentSection}。
   *
   * 委派与不委派由它自己判：字符串上没有段，也就没有段级字段可认。
   */
  formatContent(content: AgentNS.MessageContent): AgentNS.MessageContent {
    if (!Array.isArray(content)) return content;
    return content.map((section) => this.formatContentSection(section));
  }

  /**
   * 一段内容发给模型的那一份：按段类型取认识的字段重建（默认口径见 core 的
   * `formatContentSection`）。
   *
   * 它是内容字段的扩展点：覆写本方法就换掉逐段的规则，`formatContent` 与 `formatHistory`
   * 都会跟着走这条路。
   */
  formatContentSection(section: AgentNS.MessageContentSection): AgentNS.MessageContentSection {
    return formatContentSection(section);
  }

  formatHistory() {
    return this.messages
      .filter(
        (message) =>
          (message.status == undefined || message.status == AgentNS.MessageStatus.Completed) &&
          !message.omit,
      )
      .map((message) => ({
        role: message.role,
        content:
          message.content === undefined ? undefined : this.formatContent(message.content),
        function_call: message.function_call ? message.function_call : undefined,
        tool_calls: message.tool_calls?.length ? message.tool_calls : undefined,
        tool_call_id: message.tool_call_id ?? undefined,
        reasoning_content: message.reasoning_content ?? undefined,
        name: message.name ?? undefined,
      }));
  }

  /**
   * 消费一条流：每片广播两条事件，攒消息的规则在 {@link applyChunk}。
   *
   * 顺序是硬契约：`chunk`（原始片，**解析之前**）→ `applyChunk` → `chunk-parsed`
   * （两参：正在拼的 assistant 消息 + 那片原始 chunk）。解析抛错的那一片照样留下 `chunk`
   * ——「这片到了」与「这片解出来了」是两件事。
   *
   * 攒消息本身**不在这里写**：见 `applyChunk.ts` 的文件头（第二份实现 = 漂移起点）。
   */
  async parseStreamData(receiver: AgentNS.Message, stream: AsyncIterable<ChatCompletionChunk>) {
    for await (const chunk of stream) {
      this.events.emit("chunk", chunk);
      applyChunk(receiver, chunk);
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
         *  任务完成即从当前轮活跃集合移除。
         *
         *  发射 `tool-call-end` 放在这里（而不是各个 return 前）：它既是**唯一**的结果定型点
         *  （`status` 在这里才被 clamp 成 Aborted），又躺在每个工具自己的闭包里，天然
         *  per-tool —— 并行时谁先跑完谁先发，不必等 `Promise.all` 收齐。 */
        const markResult = (status: AgentNS.MessageStatus) => {
          resultReceiver.status = toolTask.controller.signal.aborted
            ? AgentNS.MessageStatus.Aborted
            : status;
          this.innerLoopTasks.delete(toolTask);
          // 定型就是「这条消息变了」：先按新状态重发它，再报「这个工具跑完了」这个时刻
          this.emitMessage(resultReceiver);
          // 载荷里的状态取**已 clamp** 的 `resultReceiver.status`：被中止的工具不能报成 completed
          this.events.emit("tool-call-end", {
            agent: this,
            toolCall: task,
            result: resultReceiver,
          } satisfies ToolCallEndContext);
        };

        try {
          const matchedTool: Tool | undefined = this.tools.find(
            (tool) => tool.function.name == task.function!.name && tool.type == "function",
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
            resultReceiver.content = hint !== undefined ? hint : this.defaultUnknownTool(task);
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

    // 任一工具要求停止（preventDefault）或标记为 Error，就不再开下一轮
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
   * 发一条用户消息，等整组内循环跑完。
   *
   * ## 「返回 = 这一轮真的结束了」
   *
   * 钩子里推进 `inbox` 的那些条目也算这一轮：`onInnerLoopsEnd` 之后由 `run()` 兜一次、
   * `onAfterSend` 之后由本方法兜一次（见末尾那个 while）。所以返回时 inbox 里不该再有
   * 「这一轮该处理却没处理」的条目 —— 宿主的「已排队」承诺靠的就是这一条。
   *
   * 返回 this.messages，且是**在 onAfterSend 之后**取的：插件可以整体替换消息列表（迁移 / 保存）。
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

    this.append(Message.User(content));

    // 跑一整组内循环（Assistant 占位由 run 内循环开头统一追加）。
    await this.run(ctx);

    // onAfterSend 钩子：可做迁移、保存等后处理（如替换 this.messages 重开会话），
    // 故返回值必须在钩子之后取，不能用 run() 的快照。
    await this.dispatchHook("onAfterSend", ctx);

    // ★ `send()` 这一侧的最后一个取件点：钩子里推进来的条目也必须落地。
    //
    // 与 `run()` 末尾那个取件点同一个理由：收尾钩子等用户、等 IO 时是**无界**的，而入队的人
    // 已经拿到了「排队了」的回执（宿主回 `queued: true`、客户端画了一条）。差别只在于这里
    // 连 `onInnerLoopsEnd` 都走完了 —— 要再跑的是完整的内循环组，且 **不能**重发整组首尾
    // 钩子（一次 send 各一次）：所以调 `runLoops()`，不是 `run()`。
    //
    // `send()` 的对外语义因此仍然是「返回时这一轮真的结束了」：只要 inbox 里还有条目，就不会
    // 带着它们交还。中止路径照旧 —— `runAborted` 时不再取件、不再续圈（`abort()` 已清空 inbox）。
    while (!this.runAborted && this.insertInbox()) {
      await this.runLoops(ctx);
    }

    // 上面续的圈是在 `run()` 清过任务记录之后跑的，这里再清一遍（见 clearPendingTasks）
    this.clearPendingTasks();

    return this.messages;
  }
}
