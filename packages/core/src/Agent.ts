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
  /** 原样投递进来的那条条目（含已补齐的 `messageId` / `createdAt`） */
  entry: AgentNS.InboxEntry;
}

/**
 * 事件载荷 —— `status`：`runStatus` 真正变了一次（一段的边界）。
 *
 * ## 为什么单立一个事件，而不是拿 `finally` 冒充
 *
 * `finally`（每**次内循环**结束，一次 API 请求 + 它的工具调用）与 `status`（每**段**边界）
 * 是两个粒度：一段里可以有好几圈内循环，也可能一圈都没跑起来（`deliver` 叫醒时 inbox 里
 * 只有被 `abort` 冻住的条目）。拿 `finally` 推「跑不跑」，宿主就会在段中间收到一串假的
 * 「跑完了」；拿 `status` 推六态，界面又会在每一圈里跳一次。两者混用正是这里最容易出错的
 * 地方，所以分成两个事件，各自只说自己那一层。
 *
 * 载荷没有 `reason`：段边界只有四种转换（起段 / 自然收尾 / 按停 / 收尾完成），`from` 与 `to`
 * 已经把它们完全区分开了，再带一个 `reason` 就是第二份可能漂移的事实。
 */
export interface StatusContext {
  /** 状态变化的就是这个 Agent */
  agent: Agent;
  /** 变化前的段状态 */
  from: AgentNS.RunStatus;
  /** 变化后的段状态 */
  to: AgentNS.RunStatus;
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
   * 这一段跑不跑（四态，语义见 {@link AgentNS.RunStatus}）。
   *
   * ## 为什么它必须是一个显式字段
   *
   * 改动之前「在不在跑」没有权威字段，只有三个互相不说话的碎片：`innerLoopTasks`（两次
   * 内循环之间的空档里它是空的，但那一整段明明还在跑）、`innerLoopsTasks`（一段结束才清，
   * 与「在跑」不对应）、`runAborted`（在 `run()` 开头复位，说的是「这一段」不是状态）。
   * 于是 core 自己回答不了「能不能起新段」，只好由宿主代劳 —— 而宿主一漏，就是两段并跑。
   *
   * ## 谁写它
   *
   * 只有 `setRunStatus()`（`run()` 起段与收尾、`abort()`）；外部只读。置位与「起段」之间
   * **不许有 await** —— 这是「不会并跑」的全部秘密。
   */
  runStatus: AgentNS.RunStatus = "idle";

  /**
   * 这一次 `send()` 的受理流程走到哪（语义见 {@link AgentNS.SendStatus}）。
   *
   * 与 `runStatus` 是两个字段而不是一个，因为它们回答的是两个问题：`runStatus` 说「段在不在
   * 跑」，`sendStatus` 说「有没有一次受理正卡在段的前后」。`send()` 的范围比一段长（
   * `onBeforeSend` 在段前、`onAfterSend` 在段后，两头都是 await），只有两个都看，`deliver()`
   * 才能既不漏叫醒、也不多起一段（见 `deliver` 的注释）。
   */
  sendStatus: AgentNS.SendStatus = "idle";

  /**
   * 排队待发的内容：`deliver()` 投进来，段在取件点把它落成 User 消息。
   *
   * 公开可读（宿主据此展示「已排队 N 条」），写入走 `deliver()` / `clearInbox()`。
   * 数组实例自始至终是同一个（推进用 `push`、取走与清空用 `splice`），所以拿着它做快照
   * 的调用方不会抱到一份过期的副本。
   *
   * 它是**数据**，不是状态：`abort()` 不碰它（一条来自别的会话的投递不该被「用户按停」这个
   * 无关动作抹掉）；一条被中止的段没取走的条目留着，等下一次外部驱动时一起发出。
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
   * 当前内循环（单轮）进行中的消息任务：内循环开始时记录，完成时清除。
   * 只保留未完成任务；abort 统一遍历本集合：中止 controller + 标记 receiver 为 Aborted。
   *
   * 它**只做这件事**：不再兼任「在不在跑」（那是 `runStatus` 的活）。两次内循环之间的空档
   * （reconcile、收尾钩子）里它是空的，但那一整段明明还在跑 —— 这正是当初三个碎片里最会
   * 骗人的那一个。
   */
  private innerLoopTasks: Set<PendingTask> = new Set();

  /**
   * 用户按停。**只改状态与在跑的任务，不碰 `inbox`。**
   *
   * ## 为什么按停要分两种情形
   *
   * - 有段在跑（`running`）：先落到 `stopping` —— 这是「已不接受工作」与「还没结束」同时
   *   成立的那个态。abort 之后那一段还要把 reconcile、`onInnerLoopsEnd`、写库收尾走完；
   *   这段时间里既不能回 `running`（外部一投递就能起新段，旧段还在写同一份 `messages`，
   *   就是两段并跑），也不能直接给 `terminated`（那等于谎称「已经停了」，而下一次投递会立刻
   *   起新段）。`stopping → terminated` 只由那一段自己的 `finally` 发出。
   * - 没有段在跑：直接 `terminated`（「空跑时按停也是停」）。若在这里用 `stopping`，没人会来
   *   收尾，状态就永远卡在那个中间态上。
   *
   * ## 为什么不 `clearInbox()`
   *
   * inbox 里可能是**别的会话**投递来的东西（父对话、异步工具的结论），「用户按了这一段的停」
   * 与「那些事实作废」是两件事。按停只停**这一段**；排队的条目留着，等下一次外部驱动时一起
   * 发出。真要作废排队，那是一个显式动作（调用方自己 `clearInbox()`），不该由 abort 替用户猜。
   */
  abort() {
    if (this.runStatus === "running") {
      this.setRunStatus("stopping");
      this.innerLoopTasks.forEach((task) => {
        task.controller.abort();
        task.receiver.status = AgentNS.MessageStatus.Aborted;
      });
      return;
    }
    // 已经在 stopping 时不再往前推一步：收尾归那一段自己（第二次按停是空动作）
    if (!this.isStopping) this.setRunStatus("terminated");
  }

  /**
   * 段在跑（接受工作、取件、续圈）。
   *
   * 为什么写成 getter 而不是每次就地比较：这两个判据在多处用（`run()` 的单飞早退与取件循环、
   * `runLoops()` 的高优先取件点），两处各写一遍 `=== "running"` 就是两份会漂的真相；且 `run()`
   * 里先早退、后置位，就地比较会让类型系统把字段收窄成早退后的那两个值，反而看不见后面
   * `setRunStatus("running")` 改出来的结果。
   */
  private get isRunning(): boolean {
    return this.runStatus === "running";
  }

  /** 段在收尾（被 `abort()` 按停，还没收完）：不接受新段，也不再取件 */
  private get isStopping(): boolean {
    return this.runStatus === "stopping";
  }

  /**
   * 改 `runStatus` 的唯一入口：**真正变了**才广播 `status`（载荷 `{ agent, from, to }`）。
   *
   * 未发生变化时一条事件都不发 —— 订阅方拿到 `status` 就可以当作「变了」用，不必自己比对；
   * 也避免「`abort()` 连按两下」在界面上刷出一串重复的「已停止」。
   */
  private setRunStatus(next: AgentNS.RunStatus): void {
    const from = this.runStatus;
    if (from === next) return;
    this.runStatus = next;
    this.events.emit("status", { agent: this, from, to: next } satisfies StatusContext);
  }

  /**
   * 投递一条待发内容：**同步**入队，静止态顺手把段叫醒，立刻返回回执。
   *
   * ## 两个平级的输入口之一
   *
   * `send(content)` 是「我发起，等我跑完」；`deliver(entry)` 是「这条给你，有空就跑」。
   * 后者是 inbox 意义上的投递：调用方（别的会话、异步工具、宿主）不掌握 agent 的节奏，也就不该
   * 由它判断「该不该跑」—— 判断权在这里。
   *
   * ## 为什么判两个字段（`runStatus` 与 `sendStatus`）
   *
   * - `runStatus === "running" | "stopping"`：段在跑或在收尾 —— **不能起第二段**（那会两段并跑、
   *   写同一份 `messages`）。条目留在队列里，那一段自己的取件点会取走它（`running` 时）或者
   *   留给下一次驱动（`stopping` 时，见下面 `terminated` 那一行）。
   * - `runStatus === "idle" | "terminated"`：静止态，看起来可以叫醒 —— 但如果此刻 `sendStatus
   *   === "sending"`，说明正有一次受理卡在段的前后（`onBeforeSend` 还没走完，或者段已收尾、
   *   `onAfterSend` 还挂着）。这时候另起一段，就会与那次 send 的 `messages` 写入交错；而且
   *   那条 send 本来就会通知自己的 `run()`（段前）或 `finally`（段后）把这条带走。所以只叫醒
   *   静止态且没有受理在途的那一次投递。
   *
   * `woke` 只是观测（「这次是不是我把它叫醒的」）：调用方可以据此决定要不要等它跑；它不是
   * 投递方该拿来控制 agent 的开关，也不参与任何内部决策。
   *
   * ## 为什么「没有消息」时不叫醒
   *
   * 一条消息都没有的 agent 起段只会撞上 `run()` 的空消息校验；而 `deliver` 是 fire-and-forget，
   * 那个错没人接得住（未捕获的 rejection）。条目留在队列里不会丢 —— 等这个 agent 有了第一条
   * 消息（下一条投递 / `send`），它会被一起取走。
   */
  deliver(input: AgentNS.InboxInput): AgentNS.DeliveryReceipt {
    const stored = this.enqueueInbox(input);
    // 先算「能不能叫醒」，再叫醒：`run()` 会在同步段里把 `runStatus` 改成 running，
    // 晚了再算就永远是 false
    const parked = this.runStatus === "idle" || this.runStatus === "terminated";
    const woke = parked && this.sendStatus === "idle" && this.messages.length > 0;
    if (woke) void this.run();
    return { messageId: stored.messageId, accepted: true, woke };
  }

  /**
   * `deliver()` 的内部实现：补齐 id / 时间、推进数组、广播 `inbox`。
   *
   * 为什么它不对外：入队与「叫不叫醒」是同一件事的两半。拆成两个公开方法，调用方迟早只调
   * 一半 —— 推进去却不叫醒（条目滞留在队列里，直到下一次外部驱动）、或者叫醒却没推进去
   * （空跑一段）。`deliver` 是唯一入口，两半就永远成对。
   * `messageId` 允许由投递方在**入队时**定下（宿主先把它告诉客户端做乐观回显，落地那条消息
   * 用同一个 id，同一条内容才不会画两遍）。
   */
  private enqueueInbox(input: AgentNS.InboxInput): AgentNS.InboxEntry {
    const pushed: AgentNS.InboxEntry = {
      messageId: input.messageId ?? generateMessageId(),
      source: input.source,
      priority: input.priority,
      content: input.content,
      createdAt: new Date().toISOString(),
    };
    this.inbox.push(pushed);
    this.events.emit("inbox", { agent: this, entry: pushed } satisfies InboxContext);
    return pushed;
  }

  /**
   * 清空 inbox，返回被丢掉的那些条目（按入队顺序）。
   *
   * **core 自己不再调它**：`abort()` 已经不碰 inbox 了（见 `abort` 的注释）。留着它是给「作废
   * 排队」这个**显式动作**用的 —— 那是一个决定，得由调用方（客户端 / 宿主）自己下，不能由
   * 「用户按了停」替它猜。
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
   * 跑**一段**：单飞 + 整组钩子 + 取件循环。
   *
   * 这是「什么时候跑」的唯一实现。两个入口都走它：
   * - `send()`：自己 append 了 User 消息，等这一段跑完；
   * - `deliver()`：在静止态把自己叫醒（不等）。
   *
   * ## 单飞是结构性的
   *
   * 已经在跑（`running`）或在收尾（`stopping`）就直接返回，绝不开第二段 —— 并发两次 `send`
   * 出两个段的旧口子就此关上（以前靠宿主的 `RunRegistry` 挡，core 自己不挡）。
   * "直接返回" 的语义是「这种事已经有别人在做」，不是失败，也不抛错。
   *
   * ## 为什么 "置位" 与 "起段" 之间不许有 await
   *
   * `setRunStatus("running")` 之后紧接着就是同步的 try，中间没有让出执行权的地方 —— 于是
   * 两个几乎同时进来的调用里，后一个必然看到 `running` 而返回。中间一旦 await（比如先读库、
   * 先算历史），两个调用就都能看到 `idle`，两段并跑。
   *
   * ## `stopping` 不可逆
   *
   * `stopping` 时本方法直接返回，**不会把状态拉回 `running`**：那一段的收尾还没完，谁都不能
   * 插进去。它只能由自己的 `finally` 推到 `terminated`。
   *
   * @param ctx 插件上下文（由 send() 传入；直接调用 run() 时构造默认上下文）
   * @returns 本段结束时的消息数组；没起段（已有一段在跑）时返回 `undefined`
   */
  async run(ctx?: SendContext): Promise<AgentNS.Message[] | undefined> {
    // 单飞：已有段（running）或在收尾（stopping）就不起第二段
    if (this.isRunning || this.isStopping) return;

    // 空消息校验：至少需要一条消息（如 send 追加的 User 消息）。
    // 校验排在 `setRunStatus("running")` **之前**：起一段却一行都发不出去，没必要先在
    // `status` 事件里宣告一次「跑起来了」。
    if (!this.messages.length) {
      throw new Error("You need to send at least one message as a receive message");
    }

    // 直接 run() 时的兜底上下文
    const sendCtx: SendContext = ctx ?? {
      agent: this,
      content: "",
      messages: [...this.messages],
    };

    // 起段：同步置位，中间没有 await（见方法头）
    this.setRunStatus("running");
    try {
      // 整组内循环开始（一次 send 仅一次）；Assistant 占位由每次内循环开头统一追加
      const loopsDenied = await this.dispatchHook("onInnerLoopsStart", sendCtx);
      if (loopsDenied !== undefined) {
        throw new Error(`inner-loops-start 被插件拒绝: ${loopsDenied}`);
      }

      // 段的第一件事：把已经排队的条目落成 User 消息（可能一条都没有）。
      // 两种情形靠它：`deliver()` 叫醒的段（条目就是它被叫醒的理由，不先落下来，第一轮请求
      // 就白发了）、`onBeforeSend` 里投进来的条目（那一段时间 `sendStatus === "sending"`，
      // `deliver` 刻意没起段，留给了这里的 `send`）。
      this.insertInbox();

      // 取件兜底①：一组内循环跑完（模型不再续、reconcile* 已收尾）时若 inbox 又有条目，
      // **留在同一段里继续**（不退出、也不重发整组首尾钩子）。
      //
      // 这是「低优先」与「段末缝隙」两个旧取件点合流后的唯一归宿：
      // - 低优先条目（整组停下之后才该插入的）本来就在这一刻落地 —— 位置与改动前一致；
      // - 「段末缝隙」指的是「最后一次取件之后才到的条目」：以前靠 `run()` 末尾与 `send()`
      //   末尾各自再取一次，现在由这个循环与 `send()` 的 `finally` 兜（前者管内循环跑完那一刻，
      //   后者管整次受理结束那一刻）。
      //
      // 进出条件都是 `runStatus`：`stopping` / `terminated` / `idle` 一律不取件、不续圈
      // （旧口径是「这一段被叫停就不取」，新口径是「只有跑着才取」）。
      while (this.isRunning) {
        await this.runLoops(sendCtx);
        if (!this.isRunning) break;
        if (!this.insertInbox()) break;
      }

      // 整组内循环结束：含多轮工具调用，messages 为完整结果（正常/error/abort 均到达此处）。
      // 排在取件循环**之后**：到这里这一组真的不跑了（若被 `abort` 按停，这里也不再取件）。
      await this.dispatchHook("onInnerLoopsEnd", sendCtx);
    } finally {
      // 收工：清空整组与当前段的任务记录（不清的话，下一次 `abort()` 会翻到这些已经结束的
      // 任务，把它们的状态改成 `Aborted` —— `abort()` 只遍历活跃集合，那正是它唯一的信息来源）
      this.clearPendingTasks();
      // 段结束：正常收尾回 `idle`；被叫停的（`stopping`）落到 `terminated` —— 后者是
      // 「收尾真的做完了」，不是「按下停的那一瞬」。
      this.setRunStatus(this.isStopping ? "terminated" : "idle");
    }

    return this.messages;
  }

  /**
   * 跑一组内循环：一圈接一圈，直到模型不再要求继续；然后 reconcile* 收尾。
   *
   * ## 为什么它从 `run()` 里拆出来
   *
   * 整组首尾的两个钩子（`onInnerLoopsStart` / `onInnerLoopsEnd`）是「一段各一次」的硬契约，
   * 而一组内循环需要被跑**不止一次**：段末若 inbox 又来了条目，`run()` 会再叫它一遭。循环
   * 留在 `run()` 里就只能在「再转一圈」与「不重发钩子」之间二选一 —— 拆出来之后，钩子各发
   * 一次归 `run()` 管，这一组跑几圈归本方法管，两件事互不牵制。
   *
   * `sendCtx` 一路透传：同一次 send 里各圈拿到的是同一个上下文实例（与改动前一致）。
   */
  private async runLoops(sendCtx: SendContext): Promise<void> {
    // 内循环（一次 API 请求 + 它引发的工具调用）：语义与改动前逐字一致，
    // 只是从「唯一的循环」变成了段里的一圈。
    //
    // 需要继续的条件只有一个：模型要下一轮（`needContinue`）。高优先条目也可能把已经停下
    // 的内循环重新点亮（见轮末那个插入点）。
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

        // 高优先级插入点（**唯一显式取件点**）：这一圈内循环刚收尾（工具结果已 append 进
        // messages）、下一次内循环开头的 Assistant 占位还没补。此刻插进来的 User 消息排在
        // 工具结果之后，模型下一次请求天然看得见。插进去了就得再转一圈，否则这份内容只是躺
        // 在 messages 里没人回。
        //
        // 判据从 `!runAborted`（这一段被叫停就不取）换成了 `runStatus === "running"`（只有跑着
        // 才取）：`stopping` / `terminated` / `idle` 都不取 —— 与旧口径相比多盖住了「已经收完尾
        // 的段」不该再出手的情形，少掉了「叫停之后还要看一个临时标志」这条隐式约定。
        if (this.isRunning && this.insertInbox("high")) {
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

    // 本方法到此结束：
    //
    // - **低优先级取件点已经不在这里**（它原来就排在这一行之下）。它的位置要求是「整组内循环
    //   停下、reconcile* 收完尾之后」，而本方法的返回点正好就是那一刻 —— `run()` 的取件循环
    //   在紧接着的下一行就按整个队列（不分优先级）取一次。把它留在本方法里，就等于同一个
    //   时刻有两处取件，判据还得各写一遍。
    // - **被叫停时不再需要 `break`**：本方法本身就不具备「续圈」能力了，要不要再跑一组由
    //   `run()` 的循环按 `runStatus` 决定。
  }

  /**
   * 收工：清空整组与当前段的任务记录。
   *
   * `run()` 的 `finally` 调它（每段一次）—— 段内可能跑了好几组内循环，任务记录一直攒到
   * 段尾；不清的话，下一次 `abort()` 会翻到这些已经结束的任务，把它们的状态改成 `Aborted`
   * （`abort()` 只遍历活跃集合，那正是它唯一的信息来源）。
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
   * 发一条用户消息，等**包含它的那一段**跑完。
   *
   * ## 两个入口之一：这个等，那个不等
   *
   * `send(content)` 是「我发起，等我跑完」；`deliver(entry)` 是「这条给你，有空就跑」。
   * 差别不在入队（两者都把内容交给同一个 inbox / 同一个段），而在**节奏归谁**：前者归调用方
   * （await），后者归 agent（fire-and-forget）。
   *
   * ## 钩子为什么在 `send()` 里、而不在 `run()` 里
   *
   * `onBeforeSend` / `onAfterSend` 是「一次**受理**」的边界（权限、保存、迁移），而一个段可以
   * 不是受理起的（`deliver` 也会起段）。把这两个钩子搬进 `run()`，被投递叫醒的段就会跑保存 /
   * 迁移钩子，语义就错了（一次投递被当成一次发送）。所以它们留在这里，且一头一尾各一次。
   *
   * ## 返回口很谨慎地说「我这一段跑完了」
   *
   * 返回值在 `onAfterSend` 之后取（插件可以整体替换 `messages`）。
   * `finally` 里可能又起一段（受理期间投进来的条目）：那一段不等 —— 不等它才能不被
   * 一个无界的钩子/投递挂死，代价是「返回 = 所有排队条目都已落地」这个旧口径不再成立，
   * 收窄成「返回 = 我这一段跑完了，剩下的由下一段带走」。
   *
   * ## `stopping` 时的已知行为
   *
   * 若调用时 `runStatus === "stopping"`（用户刚按停、上一段还在收尾），`run()` 会立即返回：
   * 这条 User 消息已经 append 进 `messages`，但这一遭不会跑。这是已知且照实的 —— 它不是
   * 错误，而是「用户在按停的同一瞬又发了一句」的真实后果；下一段会把它一起发出。
   */
  async send(content: AgentNS.MessageContentSection[] | string): Promise<AgentNS.Message[]> {
    // 插件上下文（消息快照仅供读取）
    const ctx: SendContext = {
      agent: this,
      content: typeof content === "string" ? content : "",
      messages: [...this.messages],
    };

    // 受理开始：从这一刻到 finally，`deliver()` 不会另起段（见 deliver 的注释）。
    // 置位与下面的钩子之间没有 await 以外的东西：先置位再进钩子，钩子里的投递就不会被
    // 当成「静止态的投递」而另起一段。
    this.sendStatus = "sending";
    try {
      // onBeforeSend 钩子：可刷新工具等；返回 string 则拒绝本次发送
      const denied = await this.dispatchHook("onBeforeSend", ctx);
      if (denied !== undefined) {
        throw new Error(`send 被插件拒绝: ${denied}`);
      }

      this.append(Message.User(content));

      // 跑一整段（Assistant 占位由内循环开头统一追加）。
      // `stopping` / `running` 时它是空动作（单飞）：User 消息已 append，这一遭不跑。
      await this.run(ctx);

      // onAfterSend 钩子：可做迁移、保存等后处理（如替换 this.messages 重开会话），
      // 故返回值必须在钩子之后取，不能用 run() 的快照。
      await this.dispatchHook("onAfterSend", ctx);
    } finally {
      this.sendStatus = "idle";
      // 取件兜底②：受理期间（尤其两个收尾钩子里）投进来的条目。那一段时间 `sendStatus`
      // 是 `sending`，`deliver()` 刻意没起段 —— 不能让它白等，也不能在钩子里与本次受理
      // 抢着写 `messages`。到了这一跳（受理真的结束了），把段叫起来由它带走。
      //
      // 用 `run()`（不是 `runLoops()`）：这是新的一段，整组首尾钩子该各发一次。
      if (this.inbox.length > 0) void this.run();
    }

    return this.messages;
  }
}
