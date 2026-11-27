import AsyncQueue, { QueueInputPausedError } from "@ai-zen/async-queue";
import EventBus from "@ai-zen/event-bus";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { AgentNS } from "./AgentNS.js";
import { AgentContext } from "./AgentContext.js";
import type { UnknownToolContext } from "./AgentContext.js";
import { AgentError } from "./AgentError.js";
import { PickRequired } from "./Common.js";
import { ToolCallContext } from "./ToolCallContext.js";
import { Message } from "./Message.js";
import { inboxEntryMessage } from "./Inbox.js";
import { reconcileAbortedToolRounds } from "./AbortedToolRounds.js";
import { reconcileAbortedMessages } from "./AbortedMessages.js";
import { applyChunk } from "./applyChunk.js";
import { formatContentSection } from "./formatContent.js";

// ---------------------------------------------------------------------------
// 钩子：缝在哪儿（说位置，不说发生了什么事 —— 后者归事件）
// ---------------------------------------------------------------------------

/** 钩子统一返回值：返回 string = 拒（这次请求/这次调用不跑），返回 undefined/void = 放行 */
export type HookResult = string | void | Promise<string | void>;

/** 外循环（本批 InboxEntry）的上下文 */
export interface OuterLoopContext {
  agent: Agent;
  /** 本批从队列取到的 InboxEntry（可能含只有钥匙、不带正文的那些） */
  entries: AgentNS.InboxEntry[];
}

/**
 * 内循环（这一次请求）的上下文。
 *
 * `body` 是**这次要发出去的请求体**，不是 `agent.messages` —— 它是按白名单重排的一份，
 * 一次性的。钩子可以直接改它（含 `messages`）：要发出去的那一份与活着的那一份不是同一个东西。
 */
export interface InnerLoopContext {
  agent: Agent;
  body: Record<string, unknown> & { messages: unknown[] };
}

/**
 * 生命周期与状态类钩子的上下文。
 *
 * 为什么它们也要带 `agent`：插件在这几个时刻通常正需要读/改它（例如「闲下来之后把会话
 * 重来一次」要先拿到 agent）。不带就得先去别的钩子里「认领」一个，那是多余的中间态。
 */
export interface LifecycleContext {
  agent: Agent;
}

/** 工具钩子的上下文（`toolCall` 就是交给 `Tool.exec` 的那个实例） */
export interface ToolHookContext {
  agent: Agent;
  toolCall: ToolCallContext;
}

/** 委派边界的上下文（`agent` 是发起委派的宿主，`subAgent` 是被委派的那个） */
export interface SubAgentHookContext {
  agent: Agent;
  subAgent: Agent;
  toolCallContext: ToolCallContext;
}

/**
 * 父 agent 名册上的一项：**一次委派的一笔账**（`CORE.md` §17）。
 *
 * 要查 subagent 说过的话就顺「名册 → `agent` → 它的 `messages`」取 —— 那些话只在**subagent
 * 自己那个对象**里。
 *
 * `agent` 是**活引用**（和事件里带出去的是同一个东西，不是拷贝）：它就是那一栏消息的唯一真相。
 * 于是这一项不能序列化、不能进库 —— 与 `source` 里不放 `Agent` 引用是同一条理由。
 */
export interface SubAgentEntry {
  /** 委派那次工具调用的 id：客户端据此把 subagent 的话分到那一栏（§10） */
  toolCallId: string;
  /** 被委派的那个 agent 本身（活引用） */
  agent: Agent;
  /**
   * 这次委派用的工具名（= 模型调用的那个委派工具的名字）。
   *
   * core 只认识这一个「名字」：subagent 的 AgentDefinition 名在 AgentDefinition 里，那是外部的财产（`buildAgent`
   * 交出来的），core 不读定义文件。所以这里报的是「谁被调用来干的这活」，不是「它是谁」。
   */
  name: string;
  /** 派遣时刻（ISO 8601） */
  startedAt: string;
  /** 结束时刻；`null` = 还在跑。结束时**只填这一格、不移除整项** */
  endedAt: string | null;
}

/**
 * 插件接口。
 *
 * | 钩子 | 能不能拒 | 说明 |
 * |---|---|---|
 * | `onInit` | 不能 | 注册后初始化（`init()`），与生命周期无关 |
 * | `onStart` / `onOutputPaused` / `onOutputResumed` / `onIdle` / `onStop` / `onKill` | 不能 | 生命周期与状态的边界 |
 * | `onAbort` | 不能 | 有人按了停（开关本来关着也照发） |
 * | `onOuterLoopStart` / `onOuterLoopEnd` | 不能 | 本批的开始 / 结束 |
 * | `onInnerLoopStart` | **能拒** | 排在造 assistant 占位**之前**，拒了历史里一个字都不多 |
 * | `onInnerLoopEnd` | 不能 | 这一次请求结束 |
 * | `onToolStart` | **能拒** | 工具**存在**，问「要不要开始跑」。拒了就是「这个工具没给出有效结果」，原因作为 tool 消息回给模型 |
 * | `onUnknownTool` | **能拒** | 工具**不存在**，问「怎么回应模型」。拒（返回 string）= 那条 tool 消息的正文；不管（`undefined`）= 走默认的「未知工具: X」 |
 * | `onToolEnd` | 不能 | 工具跑完了（**只对存在的工具**：未知工具没跑过，不发这一下） |
 * | `onSubAgentStart` | **能拒** | 拒了这次委派不跑 |
 * | `onSubAgentEnd` | 不能 | 委派结束（subagent 已经跑完，撤不回来了） |
 *
 * `onOuterLoopStart` 不能拒：钩子跑到这里时，本批已经从队列里取出，拒绝会让这批失去执行者。
 * 「要不要处理本批」的判断发生在投递之前 —— 一旦投递，就有人跑。
 *
 * `onToolStart` 与 `onUnknownTool` 是**两个正交的钩子**，按「工具存不存在」二选一派发，
 * 一次工具调用只发其中一个。并成一个的话，插件得自己判断「工具在不在」才知道这次钩子的含义。
 */
export interface AgentPlugin {
  onInit?(): HookResult;
  onStart?(ctx: LifecycleContext): HookResult;
  /** 不取走开关翻上（从此不取走，手上那批照跑） */
  onOutputPaused?(ctx: LifecycleContext): HookResult;
  /** 不取走开关翻回（又开始取走） */
  onOutputResumed?(ctx: LifecycleContext): HookResult;
  /** 有人按了停（`abort()`）；开关本来关着也照发 */
  onAbort?(ctx: LifecycleContext): HookResult;
  onIdle?(ctx: LifecycleContext): HookResult;
  onStop?(ctx: LifecycleContext): HookResult;
  onKill?(ctx: LifecycleContext): HookResult;
  onOuterLoopStart?(ctx: OuterLoopContext): HookResult;
  onOuterLoopEnd?(ctx: OuterLoopContext): HookResult;
  onInnerLoopStart?(ctx: InnerLoopContext): HookResult;
  onInnerLoopEnd?(ctx: InnerLoopContext): HookResult;
  onToolStart?(ctx: ToolHookContext): HookResult;
  /** 模型调了个**不存在**的工具（此时不派发 `onToolStart`）：返回 string 就是那条 tool 消息的正文 */
  onUnknownTool?(ctx: UnknownToolContext): HookResult;
  /** 工具跑完了 —— **只对存在的工具**发（与 `onToolStart` 成对；未知工具没跑过，不发） */
  onToolEnd?(ctx: ToolHookContext): HookResult;
  onSubAgentStart?(ctx: SubAgentHookContext): HookResult;
  onSubAgentEnd?(ctx: SubAgentHookContext): HookResult;
}

// ---------------------------------------------------------------------------
// 事件：说发生了什么
// ---------------------------------------------------------------------------

/**
 * 每条事件都带的三格：谁发的、这个 Agent 的第几条、什么时候。
 *
 * `seq` 是这个 Agent 自己的单调序号，从 1 开始，只增不减：订阅者靠它判重复与缺口，也靠它答
 * 「从哪接着写」。它是**这个 Agent**的序号，不是全局的 —— 委派时转发上来的那些事件记的是父
 * Agent 自己的号（转发是一次新的发出）。
 *
 * `at` 是发出这一刻的 ISO 8601 串。
 */
export interface EventBase {
  agent: Agent;
  seq: number;
  at: string;
}

export interface LifecycleEvent extends EventBase {}
export interface StateEvent extends EventBase {
  from: AgentNS.AgentState;
}

/**
 * 输出开关动了：翻上（`output:paused`）/ 翻回（`output:resumed`）。
 *
 * 载荷只带 agent 与每条的 `seq` / `at` —— 「此刻还取不取走」现读 `agent.isOutputPaused`，不在
 * 这里再报一份。
 * 它与「在干 / 闲」是两处状态，所以它的变化**不冒充**「到了哪一格」：它只说自己动了。
 */
export interface OutputEvent extends EventBase {}

/**
 * 输入开关动了：关上（`input:paused`）/ 打开（`input:resumed`）。
 *
 * 载荷同样只带 agent 与每条的 `seq` / `at`（现读 `agent.isInputPaused`）。它与输出开关是两道
 * 开关，两条事件不互相冒充。
 */
export interface InputEvent extends EventBase {}

/**
 * 有人按了停（`abort()`）。
 *
 * 它是**意图**，不是开关的副作用：开关可能本来就是关着的（那样 `output:paused` 一条都不发），
 * 但「这一下停」发生了。想读「有没有中断到在途的请求」，看那一条消息的 `status`（`aborted`）。
 */
export interface AbortedEvent extends EventBase {}

/**
 * 队列有三个时刻会说话：`inboxAdded` / `inboxTaken` / `inboxCleared`（`CORE.md` §3）。
 *
 * 持久化接在这三条上 —— **inbox 每有变化就入库**，不按批累积、不依赖定时快照。三条都是
 * 「通知」而不是唯一信息源：任何时候都能用 `agent.inboxPending` 重读真队列，与库里的那份对一遍
 * （只留事件、不留重读的话，事件就成了唯一信息源，而它必定漏项）。
 *
 * 进来一条。载荷是**那一条**（带 `messageId` / `createdAt` / `source` 与正文；钥匙没有正文）。
 */
export interface InboxAddedEvent extends EventBase {
  entry: AgentNS.InboxEntry;
}

/** 这些 InboxEntry**已经离开队列**（被取走了），并且它们该落的消息已经落好了。
 *
 * 为什么取走也要说一声：持久化要求「inbox 每有变化就入库」。只报进队、不报取走的话，
 * 宿主就得靠快照覆盖，也就不再实时；靠增量则必然对不上（钥匙被取走时没有任何事件 ——
 * 它不落消息，取走与从未存在过无法区分）。
 *
 * 为什么排在写进 messages**之后**（`CORE.md` §3、`PRD.md` 4.5）：崩溃点若落在两者之间，
 * - 「消息已落、InboxEntry 还在」→ 恢复时按 `messageId` 去重就能收拾（可救）；
 * - 反过来「InboxEntry 没了、消息没落」→ 那段内容无处可查（不可救）。
 */
export interface InboxTakenEvent extends EventBase {
  entries: AgentNS.InboxEntry[];
}

/** 队列被**清空**（作废，不是取走）：载荷是被丢掉的那些，原顺序。 */
export interface InboxClearedEvent extends EventBase {
  entries: AgentNS.InboxEntry[];
}

export interface MessageEvent extends EventBase {
  message: AgentNS.Message;
  /** 这条消息属于某个 subagent（委派工具转发上来时才有） */
  subAgent?: Agent;
  /** 是哪一次委派引起的（与 `subAgent` 同现） */
  via?: AgentNS.ToolCall;
}
/**
 * 原始片的来源。三格让接收方直接知道往哪儿放：
 * 自己的消息、某个 subagent 的、还是 subagent 某个工具调用里的。
 */
export type DeltaSource =
  { message: AgentNS.Message } | { subAgent: Agent; toolCall?: AgentNS.ToolCall };

export interface DeltaEvent extends EventBase {
  /** 原片本身，一个字节都不动 */
  chunk: unknown;
  source: DeltaSource;
}
/**
 * 一条消息**定稿**：这一版是终版，此后不再变。
 *
 * 与 `messageChanged` 的区别：那一条说的是「现在变成了这样」，这一条说的是「到此为止」。
 * 订阅者靠它做最后一次写、冲刷那一笔；流式期间它一次都不发。
 *
 * 每条消息**恰一条**：`completed` / `error` / `aborted` 三种落定都算，出生就是终版的
 * （用户说的话、系统注入的）在出现之后紧接着也算。被删掉的那条没有这一条 —— 消失是另一件事。
 */
export interface MessageFinishedEvent extends EventBase {
  message: AgentNS.Message;
}
export interface RequestSentEvent extends EventBase {
  /** 要发出去的那份请求体（一次性的，不是 `agent.messages`） */
  body: Record<string, unknown>;
}
export interface ResponseFinishedEvent extends EventBase {
  message: AgentNS.Message;
  /** 这条消息属于某个 subagent（委派工具转发上来时才有） */
  subAgent?: Agent;
  /** 是哪一次委派引起的（与 `subAgent` 同现） */
  via?: AgentNS.ToolCall;
}
/**
 * 一趟请求（向模型要一次答复 + 它引出的那些工具）的开始。
 *
 * `message` 是这一趟那条 assistant 占位 —— **活对象，不是拷贝**：这一刻它的 `status` 还是
 * `pending`，收完之后还是同一个实例。订阅者拿它开事务：这一趟里所有事实（`requestSent`、
 * `delta`、工具那两条、`responseFinished`）都落在这一对之间。
 *
 * 被 `onInnerLoopStart` 拒掉的那一趟**不算开始** —— 那时连 assistant 占位都没有，没有事实
 * 可说，所以这一条与 {@link TurnFinishedEvent} 都不发。
 */
export interface TurnStartedEvent extends EventBase {
  message: AgentNS.Message;
}
/**
 * 一趟请求的结束。`message` 与开始那一刻是**同一个实例**，此刻已经定型（`completed` /
 * `error` / `aborted`）—— 订阅者拿它结算用量、冲刷这一笔（见 `live-objects.md` 的
 * 「一趟请求：开始 / 结束」）。
 *
 * 中断与出错的那一趟**照样有这一条**：它说的是「这一趟到此为止」，不是「这一趟跑得很好」。
 */
export interface TurnFinishedEvent extends EventBase {
  message: AgentNS.Message;
}
export interface ToolStartedEvent extends EventBase {
  toolCall: AgentNS.ToolCall;
  /** 这个工具跑在某个 subagent 里（委派工具转发上来时才有） */
  subAgent?: Agent;
  /** 是哪一次委派引起的 */
  via?: AgentNS.ToolCall;
}
export interface ToolFinishedEvent extends EventBase {
  toolCall: AgentNS.ToolCall;
  result: AgentNS.Message;
  subAgent?: Agent;
  via?: AgentNS.ToolCall;
}
export interface SubAgentEvent extends EventBase {
  subAgent: Agent;
  toolCall?: AgentNS.ToolCall;
}
export interface DeniedEvent extends EventBase {
  hook: string;
  reason: string;
  /**
   * 结构性的事实，给宿主 / 插件用 —— core 自己发的是 `{ toolCall }` 与 `{ toolCall, subAgent }`。
   *
   * 为什么不放进 `reason`：那一格是给**模型或人**读的文案；想按结构化字段判断的调用方，
   * 会退化到解析字符串。
   */
  detail?: unknown;
}
export interface FailedEvent extends EventBase {
  error: AgentError | Error;
  /** 出错的那条消息（如果有）—— 与 `message.error` 是同一个实例 */
  message?: AgentNS.Message;
}

/**
 * 订阅者自身出错：{@link Agent.on} 注册的那一个订阅者抛了错。
 *
 * 它与 `failed` 的区别写清在这里，因为两条都在说「出错了」：
 * - `failed` 是**这次请求 / 这次工具失败了**，那是 Agent 自己的事，这条消息的 `status`、
 *   `error` 会跟着变；
 * - `observerFailed` 是**订阅者自身抛错**：订阅者只做观察，被观察的 Agent 照常运行，
 *   消息、状态、队列一处都不因此改变。
 *
 * 为什么需要这一条：观察是旁路，不是 Agent 的一部分。宿主写库、推送、运行时转发，任何一处
 * 抛错都只该记在它自己名下，不应顺着 `emit` 走进外循环 / 内循环 —— 磁盘写满不能连带中断推理。
 * 收成事件之后，这条事实仍然对外可见：其他订阅者同样能收到它，用于记录日志。
 */
export interface ObserverFailedEvent extends EventBase {
  /** 抛错的那一条事件的名字（即所订阅的事件） */
  event: keyof AgentEvents;
  /** 订阅者抛出来的那个错；不是 `Error` 的已经收成 `Error` */
  error: Error;
}

/**
 * 事件表。**带出去的是活对象本身，不是拷贝** —— 收到事件的一方持有的就是那条消息、
 * 那条 InboxEntry、那片原片。拷贝 = 第二份事实，交出去那一刻就开始过期。
 *
 * 事件只是通知，**不是唯一信息源**：晚到、重复、丢一条都不影响正确性，读活对象即可恢复一致。
 */
export interface AgentEvents {
  started: LifecycleEvent;
  stopped: LifecycleEvent;
  killed: LifecycleEvent;
  "state:idle": StateEvent;
  "state:working": StateEvent;
  "output:paused": OutputEvent;
  "output:resumed": OutputEvent;
  "input:paused": InputEvent;
  "input:resumed": InputEvent;
  aborted: AbortedEvent;
  inboxAdded: InboxAddedEvent;
  inboxTaken: InboxTakenEvent;
  inboxCleared: InboxClearedEvent;
  messageAdded: MessageEvent;
  messageChanged: MessageEvent;
  messageRemoved: MessageEvent;
  messageFinished: MessageFinishedEvent;
  delta: DeltaEvent;
  requestSent: RequestSentEvent;
  responseFinished: ResponseFinishedEvent;
  turnStarted: TurnStartedEvent;
  turnFinished: TurnFinishedEvent;
  toolStarted: ToolStartedEvent;
  toolFinished: ToolFinishedEvent;
  subAgentStarted: SubAgentEvent;
  subAgentFinished: SubAgentEvent;
  denied: DeniedEvent;
  failed: FailedEvent;
  /** 订阅者自己抛的错（报的是订阅者那一侧出错，不是 Agent 失败） */
  observerFailed: ObserverFailedEvent;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * InboxEntry 的**唯一形状**：`send()`（新投递）与 `restore()`（把旧 InboxEntry 放回队列）都从这里过。
 *
 * 一条概念一种形状 —— 两条路各写一套的话，迟早有一处少一格、或者多一格「反正也没人读」，
 * 而 InboxEntry 是要落库再读回来的东西：形状漂一次，库里存的和队列里的就不是同一件事了。
 *
 * 它**只摆字段、不造值**：`createdAt` 与 `messageId` 都由调用方给 —— 新投递给「现在」与一个
 * 新 mint 的 id，恢复给存下来的那两个。于是同一个形状承担两套语义，而代码只有这一份。
 *
 * 没有正文就是**钥匙**（`AgentNS.InboxKey`）：它不写进 messages 成消息，所以没有 `messageId`、
 * 没有 `source`，`priority` 固定为 `low`。
 */
function toInboxEntry(
  fields:
    | { createdAt: string; priority: "low"; content?: undefined }
    | {
        createdAt: string;
        priority: "high" | "low";
        messageId?: string;
        source: AgentNS.MessageSource;
        content: AgentNS.MessageContent;
      },
): AgentNS.InboxEntry {
  if (fields.content === undefined) {
    return { createdAt: fields.createdAt, priority: "low", content: undefined };
  }
  return {
    messageId: fields.messageId,
    createdAt: fields.createdAt,
    priority: fields.priority,
    source: fields.source,
    content: fields.content,
  };
}

/**
 * 投递入参 → `toInboxEntry` 要的那份字段。
 *
 * 三种写法走同一条路：一句话、一组内容块、一个信封（要指定优先级与来源时）。裸内容补的缺省是
 * 「有人现在说了一句」—— 优先级 `high`（内循环在工具跑完那个边界就能取走，不打断正在生成的
 * 回答），来源 `{ kind: "user" }`，与宿主把用户原话投进来时的取值逐格一致。
 *
 * 别的来源本来就得说清自己是谁（异步结果 `system` + `low`、另一段会话寄来的话 `agent` +
 * `low`），那些调用方继续给信封 —— 它们要的正是因为不是「有人现在说了一句」。
 */
function inboxFieldsOf(
  input: AgentNS.InboxInput | undefined,
  newMessageId: () => string,
): Parameters<typeof toInboxEntry>[0] {
  const createdAt = new Date().toISOString();

  // 什么都不给 = 拧钥匙
  if (input === undefined) return { createdAt, priority: "low" };

  // 裸内容：一句话，或者一组内容块
  if (typeof input === "string" || Array.isArray(input)) {
    return {
      messageId: newMessageId(),
      createdAt,
      priority: "high",
      source: { kind: "user" },
      content: input,
    };
  }

  // 信封（包括显式不给正文的拧钥匙写法）
  if (input.content === undefined) return { createdAt, priority: "low" };
  return {
    messageId: input.messageId ?? newMessageId(),
    createdAt,
    priority: input.priority,
    source: input.source,
    content: input.content,
  };
}

/**
 * 一条消息「会不会进上下文」的那两格（`status` / `omit`）。
 *
 * {@link Agent.repair} 靠它认出「这次修历史把哪几条改判了」：两条 reconcile 都是**就地**改
 * （`aborted` → `completed`、`omit` 抹掉），改完就分不出原样，所以修之前先记一份。
 */
function markOf(message: AgentNS.Message): string {
  return `${message.status ?? ""}|${message.omit === true ? "1" : "0"}`;
}

/**
 * 能拒的钩子：返回 string 就是判决（这次不跑），**只有它们短路**后面的插件。
 *
 * 它们抛错时按 **fail-closed** 处理 —— 出错的校验若放行，等于没有校验；
 * 其余位置抛错时按没有返回值处理（fail-open），目的是不终止 agent。
 */
const DENIABLE_HOOKS = new Set<string>([
  "onInnerLoopStart",
  "onToolStart",
  "onUnknownTool",
  "onSubAgentStart",
]);

/** 在途的那一次请求（含它引出的工具）：寿命**只到这一次**，下一次是全新的 */
interface Inflight {
  controller: AbortController;
  /** `Promise.race` 的伙伴：不管对方是否响应中断，`await` 立刻返回 */
  abortRx: Promise<void>;
}

export class Agent extends AgentContext {
  /**
   * 这一格的存储。**外面读不到它、也写不进来** —— 读写两个口在下面。
   *
   * 为什么不让它是个 public 字段：`state` 是「在干 / 闲」，它一旦与事实不符，没有任何地方会报错
   *（订阅方只会安静地按错的那一格做决定）。收成「私有存储 + 私有写入器」之后，「换格」
   * 只剩 {@link setState} 一条路 —— 它连事件与钩子一起发，不会有人只改值不发通知。
   */
  private _state: AgentNS.AgentState = "idle";

  /**
   * 对外那一格：在干 / 闲，**只由循环的位置决定**（语义见 `AgentNS.AgentState`）。
   *
   * 取不取走（{@link isOutputPaused}）不参与它的判断 —— 暂停取走期间投进来的那批照跑，
   * 跑完照样报闲。
   */
  get state(): AgentNS.AgentState {
    return this._state;
  }

  /**
   * 写这一格：**私有**。唯一的合法写法是 {@link setState}（换值 + 发事件 + 跑 `onIdle`）；
   * 只有终结那一处直接赋值（{@link markDead}），理由写在那里。
   */
  private set state(next: AgentNS.AgentState) {
    this._state = next;
  }

  private _plugins: AgentPlugin[] = [];
  private bus = new EventBus();
  /**
   * 唯一的一条队列。钥匙也在里面，只是它没有正文。
   *
   * **它的三个开关就是 core 的那三处状态，core 不另存一份**（存两份就得在两处同时改，
   * 迟早漂出一份「以为还在收件、其实开关早关了」）：
   * - 收不收件 = `isInputPaused` —— `stop()` / `kill()` 各自 `pauseInput()`；
   * - 以后还有没有新条目 = `isDone` —— `stop()` / `kill()` 各自 `done()`（关门就是「不再有条目」，
   *   不是另一处状态）；
   * - 此刻取不取走 = `isOutputPaused` —— {@link isOutputPaused} 直接读它。
   */
  private inbox = new AsyncQueue<AgentNS.InboxEntry>();

  /** `kill()` 调过：硬着陆，存量作废。**只管 `kill()` 这个动作做过没有**（还收不收新条目问队列的 `isInputPaused`） */
  private killed = false;
  /**
   * `stop()` 调过 —— **自己的判重**，不借队列的 `isDone`。
   *
   * 两者不是一回事：`isDone` 说的是「以后没有新条目」，这里问的是「`stop()` 这个动作做过没有」。
   * 借 `isDone` 当判据的话，`kill()` 之后再 `stop()` 会因为「已经 done 了」提前返回，
   * `onStop` 钩子不会跑 —— 而它该跑（它对应「有人要求关门」这个时刻）。
   */
  private stopRequested = false;
  /**
   * 「已终结」这件事实已经报过 —— `stopped` / `killed` 加起来**只发一条**。
   *
   * 为什么还要一个布尔值：这件事有两个出口（{@link stop} / {@link kill} 本体 —— 没
   * `start()` 过时外循环永远跑不到出口；以及外循环出口 —— 那时存量才真的跑完），
   * 两个出口都可能触发，因此需要一个布尔值保证同一事实不重复发出。
   */
  private deathSaid = false;
  /**
   * 终结之后不再变化：它为 `true` 之后，这个 Agent 不再发任何事件（`live-objects.md` 判据四）。
   *
   * 置位的地方只有 {@link markDead}，而且排在「已终结」那一条事件之后 —— 顺序反过来的话，
   * 连那一条都发不出去。
   */
  private gone = false;
  /** 一次性 agent 已经接收过一次投递（此后关闭输入开关） */
  private fed = false;
  /**
   * 正在报一条 `observerFailed` —— **防递归**的那一格。
   *
   * 为什么需要它：订阅 `observerFailed` 的那个订阅者，本身也可能是出错的那一个。不置这个标志，
   * 「报失败」这一步自身失败就会再去报一次失败，一路递归到栈溢出；而那次栈溢出又会穿过
   * `emit` 打进循环里 —— 恰好是这里要挡住的那件事。置位期间再次抛错就不再报。
   */
  private reportingObserverFailure = false;
  /**
   * 「这条消息的定稿报过没有」—— {@link settle} 的判重那一格。
   *
   * 为什么非要它：会把状态推到终版的地方有好几个（正常收尾、中断、出错、工具定型、装载时的
   * 修尾），而「这条定稿了」只该报一次。把判重放在一个地方，好过每个调用点各判一次。
   *
   * 用 WeakSet 而不是加一格字段：消息本身是可被外部丢掉的对象，记在它旁边的表按它自己算数，
   * 消息没了这一项也跟着没了（不占着不放）。
   */
  private readonly settled = new WeakSet<AgentNS.Message>();
  /**
   * 这个 Agent 发出的**第几条**事件：{@link emit} 每发一条加一，从 1 开始，只增不减。
   *
   * 它是「一次发出」的属性，不是载荷的属性：载荷里没有它，只有事件出口填它（理由见 `emit`）。
   * 终结之后号不再增加 —— 门先关、号后加，所以「号 = 收到的条数」（`live-objects.md` 判据四）。
   */
  private seq = 0;

  /** `start()` 的那句 promise：直到终结才 resolve，且不 reject */
  private runPromise?: Promise<void>;
  /** 在途的那一次请求（没有正在发请求 / 跑工具时是 `undefined`） */
  private inflight?: Inflight;

  constructor(options: PickRequired<AgentContext, "client" | "model">) {
    super(options);
  }

  // -------------------------------------------------------------------------
  // 事件与插件
  // -------------------------------------------------------------------------

  /**
   * 订阅一个事件，返回取消函数（订阅者自己管生命周期）。
   *
   * **观察是旁路**：订阅者抛错就地接住，转成 `observerFailed` 报出去，不打断被观察的 Agent。
   * 底下的 `EventBus.emit` 只是一路 `forEach` 过去，没有 try/catch（它是外部包，不在这里改），
   * 所以隔离落在这一侧：注册到 bus 上的是下面这层包装函数，而**退订仍按它解** ——
   * 订阅与退订一一对应。
   *
   * 抛过一次**不移除订阅者**：下一次也许就正常了（磁盘写满是一阵一阵的），移除等于替它做了决定。
   * 同一事件上的其他订阅者照常收到 —— 一个订阅者抛错不该影响其他订阅者的观察。
   */
  on<K extends keyof AgentEvents>(type: K, handler: (payload: AgentEvents[K]) => void): () => void {
    const wrapped = (payload: AgentEvents[K]) => {
      try {
        handler(payload);
      } catch (error) {
        this.reportObserverFailure(type, error);
      }
    };
    const subscription = this.bus.on(type as string, wrapped as (...args: any[]) => any);
    return () => subscription.dispose();
  }

  /**
   * 一条订阅者抛错的事实：收成 `Error` 之后当 `observerFailed` 发出去。
   *
   * 非 `Error` 的抛出物收成 `Error`，与 {@link dispatchHook} 里那一处同一个口径 ——
   * 拿到事件的人不必再分「这次是 Error 还是一个字符串」。
   *
   * 走 `this.emit` 而不是直接写 `bus`：这条事实其他订阅者同样应当收到（宿主以后拿它记日志），
   * 而且它自身也要过一遍同样的包装函数，于是出错的那一个即使订的正是它，也只在
   * `reportingObserverFailure` 那一道上被忽略一次。
   */
  private reportObserverFailure(event: keyof AgentEvents, thrown: unknown): void {
    if (this.reportingObserverFailure) return;

    this.reportingObserverFailure = true;
    try {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      this.emit("observerFailed", { agent: this, event, error });
    } finally {
      this.reportingObserverFailure = false;
    }
  }

  /**
   * 发一个事件。
   *
   * 公开是因为委派工具要把 subagent 的事件**按同一套名字**发到父身上（§9-3）：
   * 不为 subagent 另起一套平行名字，只多「哪个 subagent + 哪个工具调用」两格。
   *
   * 序号与时刻**由这一个出口填**（`seq` / `at`，见 {@link EventBase}）：它们是「一次发出」的
   * 属性，不是载荷的属性 —— 调用点照旧只给「谁 + 载荷」。让每个调用点各填一次就是同一件事写
   * 五遍，而五个调用点里的号迟早重复；号一旦重复，订阅者判断缺口时就没有可靠依据，
   * 那正是这一格要消掉的东西。
   * 委派转发上来那一份带着子 Agent 的 `seq` / `at`，到这里被**父自己的**覆盖掉 —— 这正是要的：
   * 转发是一次新的发出。
   */
  emit<K extends keyof AgentEvents>(type: K, payload: Omit<AgentEvents[K], "seq" | "at">): void {
    // 终结之后不再变化：这一条之后不再有任何事实（见 `live-objects.md` 判据四）。
    //
    // 这道门拦住的是：`kill()` 之后仍在收流的那一次请求，它的收尾会再走一遍
    // `messageChanged`（`touch`），甚至再冒一个 `failed` —— 而「订阅者在此之后拿不到任何
    // 事实」是这一层的承诺。丢掉的那几条不必补：重启装配时 `AgentRuntime` 会把 `pending` /
    // `writing` 归成 `aborted`，历史不会因此缺一块。
    //
    // 门在**号前面**：终结之后号不再增加，于是「最后一条的 `seq` = 收到的条数」。
    if (this.gone) return;
    this.bus.emit(type as string, {
      ...payload,
      seq: ++this.seq,
      at: new Date().toISOString(),
    });
  }

  /** 注册一个插件 */
  use(plugin: AgentPlugin): void {
    this._plugins.push(plugin);
  }

  /** 初始化所有已注册插件 */
  async init(): Promise<void> {
    for (const plugin of this._plugins) {
      await plugin.onInit?.();
    }
  }

  /**
   * 按注册顺序跑钩子。
   *
   * **只有能拒的钩子（{@link DENIABLE_HOOKS}）才短路**：它返回 string 就是「这次不跑」，
   * 后面的插件不必再问。其余钩子的返回值**没有读者**（`setState` / `stop` / `kill` 那些位置
   * 根本不看），让它们短路等于「一个只是返回了 `"好"` 的插件把后面所有插件都跳过了」，
   * 而插件本身只是返回了一句无关的话。非门钩子给了非 `undefined` 就当没给（丢掉，不抛）。
   *
   * 钩子只管插件；**事件不从这里发**（事件说「发生了什么事」，钩子说「缝在哪儿」）。
   */
  async dispatchHook(
    hook: keyof AgentPlugin,
    ctx?:
      | LifecycleContext
      | OuterLoopContext
      | InnerLoopContext
      | ToolHookContext
      | UnknownToolContext
      | SubAgentHookContext,
  ): Promise<string | undefined> {
    const deniable = DENIABLE_HOOKS.has(hook as string);

    for (const plugin of this._plugins) {
      const fn = (plugin as Record<string, unknown>)[hook as string];
      if (typeof fn !== "function") continue;

      try {
        const r = await (fn as (ctx?: unknown) => HookResult).call(plugin, ctx);
        // 门：一个字就是判决。非门：返回值没人读，丢掉，接着问下一个插件。
        if (deniable && r !== undefined) return r;
      } catch (error) {
        // 插件抛错**不终止 agent**：异常会一路穿出 `start()`，循环就此永久停住，
        // 而且 `killed` 还是 false、输入开关也还开着 —— 这样的 agent 看起来仍在运行，投递进去却不会有进展。
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.emit("failed", { agent: this, error: wrapped });

        // 门（能拒的那几个，见 {@link DENIABLE_HOOKS}）抛错时按拒绝处理：出错的校验不该放行。
        // 其余位置当它没说话，接着问下一个插件。
        if (deniable) return `插件 ${String(hook)} 抛错：${wrapped.message}`;
      }
    }
    return undefined;
  }

  /**
   * 委派边界：先跑钩子（能改、能拒），再发事件（已定）。
   *
   * `onSubAgentStart` 拒了就不发 `subAgentStarted` —— 那一次委派本来就没开始，也不上名册：
   * 没有造出来的对象不该留下登记（与血缘「拒了把关系撤回去」是同一件事）。
   *
   * 名册的两个时刻都在这里（`CORE.md` §17）：派遣时加一项，结束时只把 `endedAt` 填上 ——
   * 写在这一处是因为 `subAgentStarted` / `subAgentFinished` 这两拍本来就只在这里发，
   * 名册与事件于是永远同步，不存在「事件发了、账没记」的中间态。
   */
  async dispatchSubAgentHook(
    hook: "onSubAgentStart" | "onSubAgentEnd",
    ctx: SubAgentHookContext,
  ): Promise<string | undefined> {
    const denied = await this.dispatchHook(hook, ctx);
    const payload: Omit<SubAgentEvent, "seq" | "at"> = {
      agent: this,
      subAgent: ctx.subAgent,
      toolCall: ctx.toolCallContext.tool_call,
    };

    if (hook === "onSubAgentStart") {
      if (denied === undefined) {
        // 先记账、再发事件：订阅方在 `subAgentStarted` 那一刻就该能从名册里读到这一项
        //（发出去的事件里不该有摸不到的东西）。被拒的另走一支，名册里什么都不留。
        this.subAgentRegistry.push({
          toolCallId: ctx.toolCallContext.tool_call.id ?? "",
          agent: ctx.subAgent,
          name:
            ctx.toolCallContext.tool_call.function?.name ??
            ctx.toolCallContext.tool?.function.name ??
            "",
          startedAt: new Date().toISOString(),
          endedAt: null,
        });
        this.emit("subAgentStarted", payload);
      } else {
        // 另外两道门（`onInnerLoopStart` / `onToolStart`）被拒时都发 `denied`，这里也发 ——
        // 「这次委派没跑」是订阅方听得见的一格事实，而理由（那个字符串）也正是那条工具消息的正文。
        this.emit("denied", {
          agent: this,
          hook: "onSubAgentStart",
          reason: denied,
          detail: { toolCall: ctx.toolCallContext.tool_call, subAgent: ctx.subAgent },
        });
      }
    } else {
      // 结束只是**标注**，不是移除：父照样答得出它跑过什么、最后说了什么（§17）。
      // 找不到对应的那一项说明派遣那一拍压根没记（被拒了），没什么可标的。
      const entry = this.findSubAgentEntry(ctx.toolCallContext.tool_call.id ?? "", ctx.subAgent);
      if (entry && entry.endedAt === null) entry.endedAt = new Date().toISOString();
      this.emit("subAgentFinished", payload);
    }

    return denied;
  }

  // -------------------------------------------------------------------------
  // 生命周期：关门与两道开关
  // -------------------------------------------------------------------------

  /**
   * 启动并持续等事件。返回值是一个**直到终结才 resolve** 的 promise，且不会 reject。
   *
   * 幂等：重复调用返回同一句 promise。失败不终结 agent —— 一次请求失败只是一次请求失败，
   * 记在那条消息的 `error` 上、报一个 `failed` 事件，循环接着等下一个事件。
   * core 自身抛错也走这条路（报 `failed` 再退出循环）：调用方不该在 `await` 上
   * 收到一个「框架 bug」形状的拒绝，否则调用方会把 bug 当业务错误处理。
   */
  start(): Promise<void> {
    if (this.runPromise) return this.runPromise;

    this.runPromise = this.outerLoop()
      .catch((error: unknown) => {
        this.emit("failed", { agent: this, error: error as Error });
      })
      .finally(() => {
        this.inflight = undefined;
      });

    this.emit("started", { agent: this });
    void this.dispatchHook("onStart", { agent: this });
    return this.runPromise;
  }

  /**
   * 关门：不再接输入，**存量走完**，排空之后才终结。
   *
   * 三件事全交给队列的三个口，core 自己不记状态：
   * - `pauseInput()`：此后 `send()` 由队列抛 `QueueInputPausedError`，core 翻成
   *   `AgentError("closed")`（这个 agent 已经终结）；
   * - `resumeOutput()`：这一句省不掉。`done()` 只是「以后没有新条目」这个信号，它**不突破输出开关** ——
   *   暂停取走期间调 `stop()` 时，消费者正等在该开关上，不翻回来它就永久停在那里：存量没有人取，
   *   `stopped` 也发不出来；
   * - `done()`：宣告没有新条目，迭代器取空存量后自行收尾。
   *
   * 暂停取走（{@link isOutputPaused}）期间调它**不作废存量**：暂停取走说的是「现在别跑」，
   * stop 说的是「以后也别跑」，两句叠加的含义是「把手上的跑完为止」。
   *
   * **次序固定：先翻开关与关门 → 再跑钩子 → 最后才报「已终结」**（{@link markDead}）。
   * 「已经终结」这个事实最后发出：钩子那一刻还能读到一个「正在收尾」的 agent，而订阅方
   * 听到 `stopped` 时，开关、队列、`state` 三样都已经是终结之后的取值。已启动的 agent 由
   * 外循环出口报（存量真的跑完才算终结），未 `start()` 过的由这里当场报 —— 那种情形外循环
   * 永远不会跑到出口。
   *
   * 幂等判据是 {@link stopRequested}（**不是**队列的 `isDone`）：见那个字段的注释。
   */
  stop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.pauseInput();
    this.inbox.resumeOutput();
    this.inbox.done();
    void this.dispatchHook("onStop", { agent: this });
    if (!this.started) this.markDead();
  }

  /**
   * 硬着陆：立刻终结，存量作废。
   *
   * 与 `stop()` 只差两处：**主动作废存量**（`clearInbox()`）与**中断在途**（`abortTurn()`）。
   *
   * 翻输出开关（`resumeOutput()`）与清空是两件事，都要，但理由不同：
   * - 清空不走取走口（作废与取走是两个口，见 {@link clearInbox}）：开关关着也照样清得掉；
   * - 翻开关是为**等在该开关上的循环**：不翻回来，迭代器永远停在开关上，收尾走不完、`killed` 发不出来。
   *   清空是同步的，消费者在微任务里才被唤到，所以队列里的内容一定是先被清掉、
   *   再轮到它看见空队列 + `isDone` 而收尾。
   *
   * **次序与 `stop()` 同一条**：翻开关与清空 → 钩子 → 事件。`kill()` 之后不会补发 `stopped`：
   * 终结事件只有一条（{@link markDead}），而 `killed` 优先于 `stopped`。
   */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.pauseInput();
    this.inbox.resumeOutput();
    this.clearInbox();
    this.inbox.done();
    this.abortTurn();
    void this.dispatchHook("onKill", { agent: this });
    if (!this.started) this.markDead();
  }

  /**
   * 此刻**还接不接投递** —— 输入开关的现读（`inbox.isInputPaused`）。
   *
   * `true` 说的是「这个门关了」：此后 `send()` 抛 `AgentError("closed")`。
   * 与 {@link isOutputPaused} 是两道**互不相干**的开关：那道管「取不取」、这道管「收不收」。
   * 关门（`stop` / `kill`）是这道开关唯一的生产者。
   */
  get isInputPaused(): boolean {
    return this.inbox.isInputPaused;
  }

  /**
   * **关上输入开关**：此后投递进不来，手上的活与排队区一件不动。
   *
   * 与 {@link pauseOutput} 的区别只有一句话：这道开关拦的是**投递**，那道开关拦的是**取走**。
   * 事件 `input:paused` 由 agent 发（队列不认识事件），与 `output:paused` 对称。
   * 幂等；已经关门或已经终结时是空动作。
   */
  pauseInput(): void {
    if (this.inbox.isInputPaused) return;
    this.inbox.pauseInput();
    this.emit("input:paused", { agent: this });
  }

  /**
   * **打开输入开关**：又开始接投递。
   *
   * 关门之后（`stop` / `kill` 动过）它不再开（代码里就拦在那里）：那时队列已经宣告不再有新条目，
   * 再打开等于把 InboxEntry 投给一个不会再有人取走的队列。
   */
  resumeInput(): void {
    if (this.inbox.isDone || !this.inbox.isInputPaused) return;
    this.inbox.resumeInput();
    this.emit("input:resumed", { agent: this });
  }

  /**
   * 此刻还取不取走 —— **另一处状态**，与「在干 / 闲」互不影响。
   *
   * `true` 说的是「从下一批起不再取走」：批与批之间不取，手上那批照跑。
   * 想知道「它现在在不在干活」读 {@link state}，不要看这处开关。
   *
   * 它是队列那个**输出开关的现读**（`inbox.isOutputPaused`），core 不另存一份 ——
   * 本方法在 core 里没有对应的字段，权威在队列。
   */
  get isOutputPaused(): boolean {
    return this.inbox.isOutputPaused;
  }

  /**
   * **翻上不取走开关**：只是从此不取走，不中断在途的请求。
   *
   * 手上的本批算已经开始 —— 让它跑完，从下一批起不再取。要立刻停就用 `abort`。
   * 它**只关队列的输出开关**：{@link state} 一个字节都不变（跑完该报闲就报闲，开关仍是关着）。
   * 事件 `output:paused` 仍由 agent 发 —— 那是给**外面**的通知，队列不认识事件。
   * 幂等；已经关门或已经终结时是空动作。
   */
  pauseOutput(): void {
    // `isDone` = 已经在收尾路上了（stop / kill 动过）。那时再关输出开关，收尾就要等一个
    // 没有人翻回来的开关（`done()` 不突破输出开关），所以在这里拦住。
    if (this.inbox.isDone || this.inbox.isOutputPaused) return;
    this.inbox.pauseOutput();
    this.emit("output:paused", { agent: this });
    void this.dispatchHook("onOutputPaused", { agent: this });
  }

  /**
   * **强制中断**：中断在途的请求与工具。
   *
   * 它就是「中断在途 + {@link pauseOutput}」：本批中断之后不能再往下走，所以**同时**把不取走
   * 开关一并翻上。反过来不成立 —— `pauseOutput()` 只翻开关、不碰在途的那批：
   * 中断在途一定伴随不取走，不取走不必中断在途。
   */
  abort(): void {
    if (this.inbox.isDone) return;
    // 先中断在途，再翻开关（翻开关那一步会发 `output:paused`），最后才报「有人按了停」——
    // 三件的顺序就是因果顺序：中断 → 从此不取 → 这个事实
    this.abortTurn();
    this.pauseOutput();
    this.emit("aborted", { agent: this });
    void this.dispatchHook("onAbort", { agent: this });
  }

  /**
   * **翻回不取走开关**：又开始取走，**只翻开关、不碰 {@link state}**。
   *
   * 开的是队列的输出开关：等在该开关上的消费者被**一次性全部放行**，按原顺序接着取 ——
   * 队列里有条目的话，外循环一被放行就自己取走、自己报 `working`，那件事归它报，这里不替它说。
   * 这里也不取走：用户连续快速调用 `abort` / `resumeOutput` 时，这一次请求还没收尾完，
   * 此刻去取走会让两处同时写 `messages`。
   */
  resumeOutput(): void {
    if (!this.inbox.isOutputPaused) return;
    this.inbox.resumeOutput();
    this.emit("output:resumed", { agent: this });
    void this.dispatchHook("onOutputResumed", { agent: this });
  }

  // -------------------------------------------------------------------------
  // 投递：push / send / runOnce ／ 恢复：restore
  // -------------------------------------------------------------------------

  /**
   * 投进 inbox，立刻返回。
   *
   * **投不进去就抛 `AgentError`**，不静默丢弃：投递方可能是另一个 agent，它需要知道自己投递失败
   * 才能改投（宿主接住这个错，就去执行「新建一个再投」）。而「投不进去」有两种，**调用方要能
   * 分开**（它们要做的事完全不同）：
   * - `closed`：这个 agent 已经终结（`stop()` / `kill()` 动过），再等也不会有人来取；
   * - `input_paused`：只是输入开关暂时关着（有人 `pauseInput()`），`resumeInput()` 之后还能投。
   *
   * 两个码都由 core 定，判断依据是队列自己的两格（`QueueInputPausedError` 只说「不收」，
   * `isDone` 才分得出是哪一种）。队列不认识 agent 的码，这边也不去猜队列的内部状态。
   *
   * 不给 `input`（或给一个没有正文的）= 拧钥匙：只唤醒 agent，不写进 messages 任何消息。
   *
   * `input` 可以是一句话、一组内容块，或者一个完整信封（`{ content, priority, source }`）：
   * 前两种是「有人现在说了一句」，优先级与来源用缺省（`high` + `user`）；要别的取值就给信封。
   */
  send(input?: AgentNS.InboxInput): void {
    // 一次性 agent 只有一条因果链：发起它的那一次投递。此后再投递会被拒绝，
    // 别人投进来的内容会让「等空闲」重新变成无意义的等待（`CORE.md` §1）。
    if (this.lifetime === "one-shot") {
      if (this.fed) {
        throw new AgentError("closed", `一次性 agent(${this.id}) 只接受第一次投递`);
      }
      this.fed = true;
    }

    const entry: AgentNS.InboxEntry = toInboxEntry(inboxFieldsOf(input, () => this.newMessageId()));

    try {
      this.inbox.push(entry);
    } catch (error) {
      // 不收是**队列判的**（`pauseInput()` 之后它一个都不收），但那一个错误码盖着两件事：
      // 这个 agent 已经终结（`isDone`）还是只是输入开关暂时关着。别的异常原样往上抛 ——
      // 那不是「不收」，不该冒充一个业务码。
      if (error instanceof QueueInputPausedError) {
        if (this.inbox.isDone) {
          throw new AgentError("closed", `往已经关了的 agent(${this.id}) 投递`);
        }
        throw new AgentError("input_paused", `agent(${this.id}) 的输入开关暂时关着`);
      }
      throw error;
    }

    // 进队就是一次变化：持久化接在 `inboxAdded` 上（`CORE.md` §3）。抛出去的那两种不是变化
    this.emit("inboxAdded", { agent: this, entry });
  }

  /**
   * 把**旧的 InboxEntry 原样放回队列**（PRD 4.12：关掉再打开，没被处理的那几句还在等）。
   *
   * 与 {@link send} 只差一件事：这些 InboxEntry**不是新的**。所以不走 `send()` —— 它会重盖
   * `createdAt`（一重启，排着的 InboxEntry 全变成「刚刚」，而那个时刻存在的唯一理由就是让模型判断
   * 时效），还会再发一条 `inboxAdded`（库里那一条就变成两条）。值全部由调用方给：形状由
   * {@link toInboxEntry} 摆（与 `send()` 同一份），存下来是什么就是什么，这里不生成任何缺省值。
   *
   * 该拒的三种（`CORE.md` §3）：
   * - **一次性 agent**：它只接受一次投递，寿命在调用栈里，恢复它没有任何去处（写错代码，抛裸
   *   `Error`，与「在活着的 agent 上调 `runOnce()`」同一类）；
   * - **已经关门 / 已经终结**：队列不会再有人取走，放回去只是把 InboxEntry 交给一个没有人取的队列
   *   （`AgentError("closed")`，与 `send()` 同一个码）；
   * - **形状不全的 InboxEntry**：当场抛错优于把不完整的 InboxEntry 放进队列 —— 半截 InboxEntry 会一路走到写进 messages，
   *   到那时出错的位置已经离这里很远。所有 InboxEntry 先全部校验，有一条不合格就一条都不放回去。
   */
  restore(entries: readonly AgentNS.InboxEntry[]): void {
    if (this.lifetime === "one-shot") {
      throw new Error(
        `restore() 不能用在一次性 agent(${this.id}) 上：它的寿命在调用栈里，没有「重启之后接着等」这回事`,
      );
    }
    if (this.inbox.isDone) {
      throw new AgentError("closed", `往已经关了的 agent(${this.id}) 恢复InboxEntry`);
    }

    for (const entry of entries) {
      if (typeof entry.createdAt !== "string" || entry.createdAt === "") {
        throw new Error("restore() 收到形状不全的InboxEntry：createdAt 必须是被存下来的那个时刻串");
      }
      if (entry.priority !== "high" && entry.priority !== "low") {
        throw new Error("restore() 收到形状不全的InboxEntry：priority 只能是 high / low");
      }
      if (entry.content !== undefined && entry.source === undefined) {
        throw new Error("restore() 收到形状不全的InboxEntry：带正文的InboxEntry必须带 source");
      }
    }
    if (entries.length === 0) return;

    // 形状走 `send()` 那一份（一条概念一种形状），值一个都不动
    const restored = entries.map((entry) => toInboxEntry(entry));
    try {
      this.inbox.push(...restored);
    } catch (error) {
      // 关门那一种上面已经拦过了，这里只剩「输入开关暂时关着」：与 `send()` 同一个码
      if (error instanceof QueueInputPausedError) {
        throw new AgentError("input_paused", `agent(${this.id}) 的输入开关暂时关着`);
      }
      throw error;
    }
  }

  /**
   * 投递并**等到空闲**再返回 —— **不关门**。
   *
   * 它是「能等」那个形状本身，只给**一次性会话**（走一条因果链、没有第二个触发方）：常驻会话
   * 随时可能被任意触发方从闲推到忙，「我等它跑完」在那个形状里根本不成立，所以那边只有
   * {@link send}（`CORE.md` §1 / PRD 4.3）。
   *
   * 「等到空闲」= {@link waitForState} 那一格：`state` 到了 `idle` **且**队列真空 —— 只看
   * `state` 的话，`sendAndWait()` 之后、外循环取到本批之前它还是 `idle`，那等于没等。
   *
   * 没起来就先起来（一次性会话的寿命在调用栈里，没有人会替它 `start()`）。返回的 `messages`
   * 就是 `this.messages` 本身，不拷贝。
   *
   * {@link runOnce} 就是它 + `stop()`：本方法不做任何收尾动作 —— 关不关门、什么时候关，是调用方
   * 那一层的事（`send` 交给下面，`runOnce` 自己关）。
   */
  async sendAndWait(
    input?: AgentNS.InboxInput,
    options?: { signal?: AbortSignal },
  ): Promise<AgentNS.Message[]> {
    if (this.lifetime !== "one-shot") {
      throw new Error(
        `sendAndWait() 只能用在 lifetime 为 "one-shot" 的 agent 上：常驻会话没有「等到跑完」这回事，那边只有 send()`,
      );
    }
    // 有没有燃料：裸内容（一句话 / 一组内容块）算有，信封则看它的 `content`
    const hasContent =
      typeof input === "string" || Array.isArray(input) || input?.content !== undefined;
    if (!hasContent && this.messages.length === 0) {
      throw new Error("sendAndWait() 时 messages 是空的：没有燃料，拧钥匙只会发一个空请求");
    }

    this.start();
    this.send(input);
    await this.waitForState("idle", options?.signal);
    return this.messages;
  }

  /**
   * 跑一次直到终结：起 → **`sendAndWait`** → 关门 → 终结完成 → 交回消息。
   *
   * **不是又一个空动作**：它就是 {@link sendAndWait} 外面套一层收尾，而 `sendAndWait` 自己又是
   * `start` + `push` + 等空闲 的复合。一次性会话那几步由它收成一句。跑完之后这个 agent 就终结了
   * （终结不可逆，再要一个就新建）。
   *
   * 返回的 `messages` 就是 `agent.messages` 本身，不拷贝。
   */
  async runOnce(
    input?: AgentNS.InboxInput,
    options?: { signal?: AbortSignal },
  ): Promise<AgentNS.Message[]> {
    if (this.lifetime !== "one-shot") {
      throw new Error(
        'runOnce() 只能用在 lifetime 为 "one-shot" 的 agent 上：它会把这个 agent 关掉',
      );
    }
    if (this.runPromise) {
      throw new Error("runOnce() 只能用在还没 start() 的 agent 上：它会把这个 agent 关掉");
    }

    const death = this.start();

    // 前端掉线 / 父 agent 被 abort：中断在途、关门、终结，然后把已经跑出来的那部分交回去
    const onAbort = () => {
      this.abort();
      this.stop();
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      // 一次性 agent 只有一条因果链（就是我自己），所以这里的「等空闲」是有归属的 ——
      // 共享会话上做同一件事毫无意义，见 `CORE.md` §1。
      await this.sendAndWait(input, options);
      this.stop();
      await death;
      return this.messages;
    } catch (error) {
      this.kill();
      await death;
      throw error;
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 清空 inbox（作废排队）并返回被丢掉的 InboxEntry。core 自己从不主动调它 ——「作废排队」是调用方的
   * 显式决定，不该由「用户按了停」替它猜（唯一例外是 `kill()` —— 硬着陆的含义就是这些 InboxEntry 不再执行）。
   *
   * 走的是队列的 `clear()`，**不是 `takeAll()`**：清空是「作废」，不是「取走」。
   * 取走要看输出开关（暂停取走时一件都不给，那是暂时的、InboxEntry 还在排队），作废不看 —— 所以
   * {@link pauseOutput} 期间调它照样清得掉，宿主那条 `/free` 才不会在暂停中失效。
   *
   * 清空也是变化，所以报 `inboxCleared`（持久化接在它上面，`CORE.md` §3）。事件仍由 agent 发：
   * 队列不认识事件。空队列清一次什么都不发 —— 没变化就没有「有变化就入库」。
   */
  clearInbox(): AgentNS.InboxEntry[] {
    const entries = this.inbox.clear();
    if (entries.length) this.emit("inboxCleared", { agent: this, entries });
    return entries;
  }

  /**
   * 起来了吗（`start()` 调过没有）。
   *
   * 与 `state` 是两件事：没启动的 agent 也是 `idle`，光看 `state` 分不出「在等事件」
   * 和「根本没有开始等」。
   */
  get started(): boolean {
    return this.runPromise !== undefined;
  }

  /**
   * subagent 的名册：**只给外面读**（`CORE.md` §17）。
   *
   * 三个时刻：派遣时加一项、结束时把 `endedAt` 填上（不移除）、外循环每一批的开头清空上一批。
   *
   * 三点：
   * - **它不参与任何内部判断**：内循环、取走、续下一次请求、`state` 那一格、中断都不看它。清空点选在哪儿
   *   因此不影响正确性，只影响「外面什么时候读到空」；
   * - **它是名册，不是消息的唯一真相**：subagent 说过的话在 `entry.agent.messages` 里，
   *   这里只存指针；所以它随着 agent 存在于内存中，agent 终结或重启之后一并消失（不入库）；
   * - **给出去的是拷贝的数组 + 活的项**：读到的是一份临时数组，`push` / `splice` 它改不到名册
   *   本身；而读到的项就是内部那一项（`endedAt` 什么时候填上，读到就是什么）。
   */
  get subAgents(): readonly SubAgentEntry[] {
    return [...this.subAgentRegistry];
  }

  /** 名册本体（`subAgents` 的只读视图就是它的一份拷贝） */
  private readonly subAgentRegistry: SubAgentEntry[] = [];

  /** 按「工具调用 + 那个 agent」找一项：同一 id 不可能派两次，但两项都对上才算数 */
  private findSubAgentEntry(toolCallId: string, agent: Agent): SubAgentEntry | undefined {
    return this.subAgentRegistry.find(
      (entry) => entry.toolCallId === toolCallId && entry.agent === agent,
    );
  }

  /** 排队中还有几条（宿主显示「待发 N 条」用） */
  get inboxSize(): number {
    return this.inbox.size;
  }

  /**
   * 看一眼排队区：按入队顺序给出此刻还没被取走的 InboxEntry，**一个都不取走**。
   *
   * 它是「重读的那一半」：事件丢一条、重复一条都不致命，宿主拿它与库里的那份对一遍
   *（`CORE.md` §3、§10）。
   *
   * 返回的数组是拷贝，**InboxEntry 本身还是那一个**（不会给出过期副本）。
   */
  get inboxPending(): readonly AgentNS.InboxEntry[] {
    return this.inbox.snapshot();
  }

  // -------------------------------------------------------------------------
  // 外循环
  // -------------------------------------------------------------------------

  /**
   * 外循环：等一批事件 → 修历史 → 写进 messages → 内循环。
   *
   * 一句 `for await` 就够 —— **队列自己就是 inbox，也是那根唤醒信号**：空着时它等在自己的
   * `pushRx` 上，不需要 core 再维护第二套唤醒器。
   *
   * 暂停取走的等待有两处（进来之前一次、每批尾部一次）：于是批与批之间不取走，暂停取走期间
   * 到达的 InboxEntry 就留在队列里 —— 界面看得见条数、能持久化、恢复时能取回。
   *
   * 这两处等待**不用 core 自己写**：暂停取走就是把队列的输出开关关上（`pauseOutput()`），
   * `asTakeAll()` 自己会停在开关上 —— 一件不取、不退出，开关一开就按原顺序接着取。
   * core 只负责翻开关（{@link pauseOutput} / {@link resumeOutput}），不养第二个唤醒器。
   *
   * `state` 那一格**不由 `isOutputPaused` 决定**：取到一批就是 `working`，本批跑完且队列
   * 真空就是 `idle` —— 哪怕那个开关还开着。两处状态各报各的，于是「暂停取走期间投进来的那批
   * 跑完了」和「仍旧暂停取走」两件事都报得出来。
   *
   * **手上已取出的那批算已经开始**：`pauseOutput()` 从下一批生效，不把它收回 —— 它可能已经落了
   * 消息、跑了一半工具，放回队头只会造成重复写进 messages。要立刻停就用 `abort`。
   */
  private async outerLoop(): Promise<void> {
    for await (const entries of this.inbox.asTakeAll()) {
      // 名册的清空点：外循环每一批的开头（上一批的 subagent 到这儿就不再登记，`CORE.md` §17）。
      // 放在这里是因为它是**这批活的开头**，而且是唯一一个「上一批已经彻底跑完、这批还没动」
      // 的时刻。它只是给外面读的便利 —— 下面没有任何一行代码回头看这份名册。
      this.subAgentRegistry.length = 0;

      this.setState("working");

      // ① 修一遍历史 —— **唯一一次**回头看历史的地方（`CORE.md` §6），在发请求之前
      this.repair();

      // ② 写进 messages：带正文的落一条 user 消息，钥匙什么都不落
      for (const entry of entries) {
        const message = inboxEntryMessage(entry);
        if (message) this.append(message);
      }
      // 写进 messages 完了才报「这些已经离开队列」（理由见 `InboxTakenEvent`：宁可重，不可丢）
      this.emit("inboxTaken", { agent: this, entries });

      // ③ 内循环
      const ctx: OuterLoopContext = { agent: this, entries };
      await this.dispatchHook("onOuterLoopStart", ctx);
      await this.innerLoops();
      await this.dispatchHook("onOuterLoopEnd", ctx);

      // 只有真的空了才叫「闲」—— 手上没活但队列里还压着不算。
      // isOutputPaused 不参与这一判：暂停取走期间跑完本批就是闲，那个开关该关着还关着。
      // `isDone`（stop / kill 动过）也不报闲：这已经在收尾路上了，报闲等于告诉外面「还能接着投」。
      if (this.inbox.size === 0 && !this.inbox.isDone) {
        this.setState("idle");
      }
    }

    // 走到这儿就是终结完成：不再有 InboxEntry，本批也都跑完了。
    // 只走 {@link markDead}：它先把 `state` 直接置成 `idle`（不发 `state:idle`）再报事件 ——
    // 终结之后的 agent 不该再发出状态变化，而订阅方在 `stopped` / `killed` 那一刻就该读到 `idle`。
    this.markDead();
  }

  /**
   * 修一遍历史：把遗留的 `writing` / `pending` 定型、按「丢」删掉残局、按「填」补上
   * 未配对的工具结果。
   *
   * 判定依据只有两样：消息的 `status`，以及 `tool_calls` 与 tool 消息的配对关系。
   * **不需要知道原因** —— 中断、出错、崩溃三种来路，落到这一步看到的是同一份脏数据。
   *
   * ## 改了状态的那几条要报 `messageChanged`
   *
   * `keep` / `fill` 两条策略都是**就地改状态**（`aborted` → `completed`、`omit` 抹掉）：
   * 一条事件都不发的话，客户端手上还是装载时那一版（`writing` → 归一后的 `aborted`），于是
   * 「进程崩了、重启后发一句」这条路上，界面上那半截回答会一直挂着「不进上下文」的标记，而库里
   * 与内存里它已经是 `completed` —— 三处各说各话。删掉的那几条本来就有 `messageRemoved`，
   * 只有「留下但要改判」这一种从前是无声的。
   *
   * 报的是 `messageChanged`（客户端整条替换），不是 `messageFinished`：后者只落库、不推事件
   * （见宿主的观察者那一格）。
   */
  private repair(): void {
    // 只为了回答「哪几条被改判了」：reconcile 那两条是就地改，改完就分不出原样
    const before = new Map(this.messages.map((m) => [m, markOf(m)]));

    const removed = [
      ...reconcileAbortedToolRounds(
        this.messages,
        this.abortedToolRoundStrategy,
        this.abortedToolRoundReason,
      ),
      ...reconcileAbortedMessages(this.messages, this.abortedMessageStrategy),
    ];
    for (const message of removed) this.emit("messageRemoved", { agent: this, message });

    for (const message of this.messages) {
      if (before.get(message) !== undefined && before.get(message) !== markOf(message)) {
        this.touch(message);
      }
    }

    // 修完再**整段扫一遍**：`keep` 策略是就地改状态（`aborted` → `completed`）、不经过上面任何
    // 一条正常路 —— 这里是那个唯一的例外口。已经报过的由 {@link settle} 的 WeakSet 挡掉，
    // 所以扫一遍是幂等的（被删掉的那几条已经不在 `this.messages` 里，它们没有「定稿」）。
    for (const message of this.messages) this.settle(message);
  }

  // -------------------------------------------------------------------------
  // 内循环
  // -------------------------------------------------------------------------

  /**
   * 一次请求 + 它引出的工具，循环到「刚才没有工具调用」为止。
   *
   * 续行条件只有一条：**刚才有工具调用**。工具是模型请求的，跑完要把结果送回模型再问一次；
   * 没有工具调用就说明这一次已经说完。没有第二个判据。
   *
   * **这一次请求不看那个开关**：暂停取走是队列输出开关的事（`inbox.isOutputPaused`），而开关只在**取走**
   * 那一刻起作用；手上已经取出来的那批算已经开始 —— 它要把本批跑完，从下一批起才不再取
   * （`CORE.md` §2）。所以下面只判 `killed`：已终结就不发请求。要立刻停用 `abort`。
   */
  private async innerLoops(): Promise<void> {
    while (true) {
      if (this.killed) return;

      const ctx = this.buildInnerLoopContext();

      // 钩子排在造 assistant 占位**之前**：拒了就不会留下一条永远停在 Pending 的消息
      const denied = await this.dispatchHook("onInnerLoopStart", ctx);
      if (denied !== undefined) {
        this.emit("denied", { agent: this, hook: "onInnerLoopStart", reason: denied });
        return;
      }
      if (this.killed) return;

      const assistant = new Message({
        id: this.newMessageId(),
        role: AgentNS.Role.Assistant,
        status: AgentNS.MessageStatus.Pending,
      });
      this.append(assistant);

      // 这一趟从这儿算起：`turnStarted` 排在 `runTurn` **之前**，于是这一趟里所有事实
      //（`requestSent`、`delta`、工具的、`responseFinished`）都落在这一对之间。
      //
      // 被 `onInnerLoopStart` 拒掉的那一趟**不算开始**：上面已经 `return` 了，那时还没有
      // assistant 占位，没有事实可说，所以一对事件都不发。
      this.emit("turnStarted", { agent: this, message: assistant });

      const hadTools = await this.runTurn(assistant, ctx);

      await this.dispatchHook("onInnerLoopEnd", ctx);

      // `turnFinished` 排在 `onInnerLoopEnd` **之后**（与 `toolFinished` 排在 `onToolEnd` 之后
      // 同一个口径：钩子在前、事件在后），并排在 `landHigh()` **之前** —— 下一次取走不属于
      // 这一趟。
      //
      // 中断与出错的那一趟照样走到这里：`runTurn` 自己接住一切（错误落到那条消息上再返回）、
      // `dispatchHook` 自己接住一切，两个都不抛，所以这一条一定发得出去 —— 订阅者靠它结算
      // 用量、冲刷那一笔。也正因为如此，这里没有 try/finally：为一个不会发生的路径加 finally，
      // 是给不存在的处境兜底。
      this.emit("turnFinished", { agent: this, message: assistant });

      if (!hadTools) return;
      // 唯一的取走点：这一次请求刚收尾（工具结果已进 messages）、下一次还没开始。
      // 内循环只看 high —— 低优先级与钥匙它连看都不看。
      this.landHigh();
    }
  }

  private buildInnerLoopContext(): InnerLoopContext {
    const body = {
      // 先铺模型参数（temperature 等；可含厂商特有字段），再写框架契约 —— **顺序不能反**：
      // model / messages / tools / stream / stream_options 是框架自己保证的，
      // 配置里写同名键也不会改变它们（否则 `stream: false` 会直接让流式解析失败）。
      ...this.modelConfig,
      model: this.model,
      messages: this.formatHistory() as unknown[],
      tools: this.formatTools(),
      stream: true,
      stream_options: { include_usage: true },
    } as Record<string, unknown> & { messages: unknown[] };

    return { agent: this, body };
  }

  /** 这一次请求：发请求 → 收流 → 跑工具。返回「刚才有没有工具调用」 */
  private async runTurn(assistant: Message, ctx: InnerLoopContext): Promise<boolean> {
    const inflight = this.newTurn();
    this.inflight = inflight;

    try {
      this.emit("requestSent", { agent: this, body: ctx.body });

      // 厂商的 chunk 类型只描述这层**外壳**：真正被拼进消息的是它里面的那一片增量
      // （`choices[0].delta`，形状就是 core 的 `AgentNS.Delta`）。
      let stream: AsyncIterable<ChatCompletionChunk>;
      try {
        stream = (await this.client.chat.completions.create(ctx.body as any, {
          signal: inflight.controller.signal,
        })) as unknown as AsyncIterable<ChatCompletionChunk>;
      } catch (error) {
        throw this.toAgentError(error, "request-failed", inflight);
      }

      assistant.status = AgentNS.MessageStatus.Writing;

      try {
        for await (const chunk of stream) {
          this.emit("delta", { agent: this, chunk, source: { message: assistant } });

          // `usage` 与 `finish_reason` 不是「这一片带来了什么」，它们是这次响应的外层字段：
          // 不属于增量，也就不进 `applyChunk`，在调用方这一侧钉到消息上。
          //
          // 流式最后一个 chunk 才带 usage：钉在 assistant 消息上随消息持久化 ——「上一次回答
          // 花了多少」就是最后一条带 `usage` 的 assistant 消息。
          if (chunk.usage) {
            assistant.usage = chunk.usage as unknown as AgentNS.Usage;
          }

          const choice = chunk.choices?.[0];

          if (choice?.finish_reason) {
            assistant.finish_reason = choice.finish_reason as AgentNS.FinishReason;
          }

          // 只带 usage / finish_reason 的收尾片没有增量可拼（形状比 `AgentNS.Delta` 更宽：
          // 厂商那边 `content` 可以是 `null`、`role` 多一个 `developer`，这里是同一个概念的
          // 同一个位置，按 `Delta` 收）
          if (choice?.delta) {
            applyChunk(assistant, choice.delta as unknown as AgentNS.Delta);
          }
        }
      } catch (error) {
        throw this.toAgentError(error, "stream-failed", inflight);
      }

      if (inflight.controller.signal.aborted) {
        assistant.status = AgentNS.MessageStatus.Aborted;
        this.settle(assistant);
        return false;
      }

      assistant.status = AgentNS.MessageStatus.Completed;
      this.emit("responseFinished", { agent: this, message: assistant });
      this.settle(assistant);

      const hadTools = await this.runTools(assistant, inflight);
      // 跑工具的时候按了中断：本批到此为止 —— 再向模型要一次，它就会把整段话接着说完，
      // 用户按的那一下等于没按（`abortRx` 只让正在跑的工具立刻返回，不知道之后该不该续）
      return inflight.controller.signal.aborted ? false : hadTools;
    } catch (error) {
      // 被中断的那一次回答不是「出错」：它有自己的状态，也不报 `failed`
      if (inflight.controller.signal.aborted) {
        assistant.status = AgentNS.MessageStatus.Aborted;
        this.touch(assistant);
        this.settle(assistant);
        return false;
      }

      const agentError =
        error instanceof AgentError ? error : new AgentError("stream-failed", String(error));
      assistant.status = AgentNS.MessageStatus.Error;
      // 同一个实例：既挂在这条消息上，也进 `failed` 事件
      assistant.error = agentError;
      this.touch(assistant);
      this.emit("failed", { agent: this, error: agentError, message: assistant });
      this.settle(assistant);
      return false;
    } finally {
      this.inflight = undefined;
    }
  }

  /** 把任意来路的错误收成 `AgentError`；被中断的走 `aborted`，不做转换 */
  private toAgentError(
    error: unknown,
    code: "request-failed" | "stream-failed",
    inflight: Inflight,
  ): unknown {
    if (inflight.controller.signal.aborted) return error;
    if (error instanceof AgentError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new AgentError(code, message, { cause: error });
  }

  /** 这一次请求的中断装置：全新的 controller + `abortRx`，寿命只到这一次 */
  private newTurn(): Inflight {
    const controller = new AbortController();
    return {
      controller,
      abortRx: new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    };
  }

  /**
   * 中断在途：`abort()` 与 `kill()` 都走它。
   *
   * 「这一次请求是否被中断过」**不另存一格**：`controller.signal.aborted` 就是那一格，
   * 多存一份迟早会与 controller 不同步。
   */
  private abortTurn(): void {
    this.inflight?.controller.abort();
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  /**
   * 并行跑同一次请求里的多个工具，**按调用顺序写进 messages** tool 消息（不按完成顺序）。
   *
   * 失败即「没给出有效结果」：参数无效、执行抛错、工具不存在、钩子拒 —— 同一件事，
   * 一条 tool 消息回给模型，引擎不中断、不重试。
   */
  private async runTools(assistant: Message, inflight: Inflight): Promise<boolean> {
    const calls = (assistant.tool_calls ?? []).filter(
      (tc) => tc.type === "function" && tc.function,
    );
    if (calls.length === 0) return false;

    // 先按调用顺序把 tool 消息建好（Pending）：写进 messages 的顺序在这里固定，与谁先跑完无关
    const jobs = calls.map((call) => ({ call, result: this.append(Message.Tool(call)) }));

    await Promise.all(jobs.map(({ call, result }) => this.runOneTool(call, result, inflight)));

    return true;
  }

  private async runOneTool(
    call: AgentNS.ToolCall,
    result: Message,
    inflight: Inflight,
  ): Promise<void> {
    const matched = this.tools.find(
      (tool) => tool.function.name === call.function?.name && tool.type === "function",
    );

    // 事件侧与 `onToolStart` 同一道门：**只有存在的工具才有「开跑」可言**。
    // 未知工具从来没有执行过（它连实现都没有），为它发这一条等于让订阅方多出一张「工具调用卡片」
    // ——而且那张卡片永远等不到对应的 `toolFinished`。
    if (matched) this.emit("toolStarted", { agent: this, toolCall: call });

    const ctx = new ToolCallContext({
      agent: this,
      tool_call: call,
      tool: matched,
      resultMessage: result,
      signal: inflight.controller.signal,
    });

    /** 定型：先改状态并重发这条消息。`toolFinished` 要等到 `onToolEnd` **之后**才发（钩子在前） */
    const finalize = (status: AgentNS.MessageStatus) => {
      result.status = inflight.controller.signal.aborted ? AgentNS.MessageStatus.Aborted : status;
      this.touch(result);
      // 工具消息定型也是「定稿」的一种来路（它不经过 `runTurn` 那几支）
      this.settle(result);
    };

    try {
      // ① 门 —— **按工具在不在二选一**，一次调用只发一个钩子：
      //    - 有实现 → `onToolStart`：问「这个工具要不要开始跑」；
      //    - 没实现 → `onUnknownTool`：问「模型调了个不存在的工具，怎么回应它」。
      //    两个问题不该由一个钩子回答 —— 合成一个的话，插件得自己判断「工具在不在」
      //    才知道这次钩子的含义（`onToolStart` 也就成了「未知时照样发」）。
      //
      //    返回的字符串**就是**这条 tool 消息的正文：拒绝理由与「未知工具提示」都要能
      //    直接写给模型读，core 不再在前面加自己的前缀话术。
      const gate: "onToolStart" | "onUnknownTool" = matched ? "onToolStart" : "onUnknownTool";
      const denied = matched
        ? await this.dispatchHook("onToolStart", { agent: this, toolCall: ctx })
        : await this.dispatchHook("onUnknownTool", {
            toolCall: call,
            availableTools: this.tools,
          });
      if (denied !== undefined) {
        result.content = denied;
        finalize(AgentNS.MessageStatus.Completed);
        // 如实报是**哪一道门**拒的：下游可能按这个字段统计（「未知工具被接管了几次」），
        // 报错钩子名会把排查引到另一边。
        this.emit("denied", {
          agent: this,
          hook: gate,
          reason: denied,
          detail: { toolCall: call },
        });
      } else if (!matched) {
        // ② 工具不存在 = 没给出有效结果。`onUnknownTool` 若没接管（返回 undefined），走这条默认文案。
        //    **判在参数之前**：参数解析只对存在的工具有意义 —— 未知工具连实现都没有，
        //    告诉模型「参数格式不对，改改」它会去修一个根本不存在的工具的参数，永远修不好。
        result.content = `未知工具: ${call.function?.name}，没有找到对应的工具实现。`;
        finalize(AgentNS.MessageStatus.Completed);
      } else if (ctx.parseError) {
        // ③ 参数无效 = 同一件事（只对**存在**的工具才有这一说）
        result.content = `参数解析错误: ${ctx.parseError}\n请检查你提供的参数格式，确保是合法的 JSON。`;
        finalize(AgentNS.MessageStatus.Completed);
      } else {
        // ④ 真跑：与 `abortRx` 赛跑 —— 不管工具是否响应中断，`await` 立刻能返回
        result.content = (await Promise.race([
          matched.exec(ctx),
          inflight.abortRx.then(() => undefined),
        ])) as AgentNS.MessageContent | undefined;
        finalize(AgentNS.MessageStatus.Completed);
      }
    } catch (error: any) {
      // 工具消息是**例外**：它的 `content` 本来就是给模型读的结果，错误文本就该在里面
      result.content = `执行工具 ${call.function?.name} 时出错: ${error?.message ?? String(error)}`;
      finalize(AgentNS.MessageStatus.Completed);
    }

    // 同位置：钩子在前（还能看一眼结果），事件在后（已经定了）。
    // **`onToolEnd` 只对存在的工具发** —— 它的语义是「工具跑完了」，未知工具没有跑过（连实现
    // 都没有），给成对注册 `onToolStart` / `onToolEnd` 的插件（计时、配对计数、工具卡片）
    // 发一个「没有 start 的 end」，等于让它拿 `ctx.tool === undefined` 去收尾一件没开始的事。
    if (matched) await this.dispatchHook("onToolEnd", { agent: this, toolCall: ctx });
    this.emit("toolFinished", { agent: this, toolCall: call, result });
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  /**
   * 换一格（只换 `state` 这一处；取不取走走 `output:paused` / `output:resumed`，
   * 不从这里过）。
   *
   * **没有「重算状态」这一步**，置位只有三处：字段初值就是 `idle`、外循环头（取到一批）
   * 是 `working`、外循环尾（队列真空了）是 `idle`。`pauseOutput` / `resumeOutput` / `abort`
   * 一格都不置 —— 它们只翻那个开关。
   *
   * 事件按到达值分名（`state:idle` / `state:working`）—— 于是「等到某一格」
   * 就是订 `state:idle` 那一类事件，不需要再维护一套条件变量。
   */
  private setState(next: AgentNS.AgentState): void {
    const from = this.state;
    if (from === next) return;
    this.state = next;
    this.emit(`state:${next}` as const, { agent: this, from });
    if (next === "idle") void this.dispatchHook("onIdle", { agent: this });
  }

  /**
   * 报「已终结」—— `stopped` / `killed` 的**唯一出口**，一个 agent 只说一条。
   *
   * 两处会走到这里：{@link stop} / {@link kill} 本体（没 `start()` 过，外循环永远跑不到出口），
   * 以及外循环出口（存量真的跑完了）。谁先到谁报，第二个到的不报。
   *
   * **先把 `state` 直接置成 `idle`，再发事件**：订阅方在 `stopped` / `killed` 回调里读到的
   * `state` 应当已经是终结之后的取值。反过来的话，它读到的是 `working` —— 会有调用方对一个
   * 已经终结的 agent 去做「等它闲下来」这类决定，而那个空闲永远不会到来。
   *
   * 这里**绕开 `setState`** 是有意的：`setState` 会再发一条 `state:idle`，而「已终结」已经由
   * 下面那条事件说了 —— 一个已经终结的 agent 不该再发出状态变化。
   *
   * 「事件只发一条」与「状态落到 `idle`」是两件事：门关在 `start()` 之前、后来才
   * `start()` 的那种情形（存量还要跑完）走到这里时，事件早发过了，但本批的尾部仍要
   * 把状态改回 `idle` —— 否则一个已经终结的 agent 会永久停在 `working` 上。
   *
   * 这一条发完就把 {@link gone} 置位：此后这个 Agent 不再发出任何事实
   *（`live-objects.md` 判据四的「之后不再发出任何事件」）。
   */
  private markDead(): void {
    this.state = "idle";
    if (this.deathSaid) return;
    this.deathSaid = true;
    this.emit(this.killed ? "killed" : "stopped", { agent: this });
    // 顺序不能反：先发出「已终结」这一条，再把门关上。反过来连那一条都发不出去。
    this.gone = true;
  }

  // -------------------------------------------------------------------------
  // 等待
  // -------------------------------------------------------------------------

  /**
   * 等到某一格，且（目标为 `idle` 时）**本批真的跑完了**（`runOnce` 的「等空闲」用它）。
   *
   * 为什么「到了那一格」不够：`state` 是循环的位置，`send()` 之后、外循环取到那批之前它
   * **还是 `idle`** —— 只看 `state === "idle"`，`runOnce` 的等待会在本批还没开始时一步通过，
   * 那就等于没等。所以判据是「`state` 到了目标 **且** 队列里没有压着的 InboxEntry」：前者说循环停在
   * 那一格，后者说没有尚未取走的 InboxEntry；两条同时成立才是「真的闲下来了」。
   *
   * 什么时候重新判：只有「换格」与「终结」这几个时机 —— 批的边界恰好就在它们身上
   *（取到一批 → `working`；本批跑完 → `idle`；终结 → `stopped` / `killed`）。排队区自己的变化
   * 不发事件（它是现读的，{@link inboxPending}），所以这里也不订它。
   *
   * 先看当前值再等事件：`once` 型等待在「注册前已经满足」时会永远等不到。
   * `signal` 一响立刻返回 —— 取消不该被一个可能永远不变的状态卡住。
   *
   * 下面这几个订阅直接接在 `this.bus` 上、**不走 {@link on}**：它们是内核自己的（只做 resolve），
   * 不会抛错；隔离只落在公开的订阅口上，是给外面的观察者用的。
   */
  private waitForState(target: AgentNS.AgentState, signal?: AbortSignal): Promise<void> {
    const reached = () => this.state === target && (target !== "idle" || this.inbox.size === 0);

    if (reached()) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let fired = false;
      const disposables: Array<{ dispose: () => void }> = [];
      const finish = () => {
        if (fired) return;
        fired = true;
        for (const disposable of disposables) disposable.dispose();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const check = () => {
        if (reached()) finish();
      };

      for (const type of ["state:working", "state:idle", "stopped", "killed"] as const) {
        disposables.push(this.bus.on(type, check));
      }

      if (signal?.aborted) return finish();
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  // -------------------------------------------------------------------------
  // 消息
  // -------------------------------------------------------------------------

  /**
   * 说一条消息**定稿**了（{@link MessageFinishedEvent}）：这一版是终版，此后不再变。
   *
   * 两件都做才发：状态是终版（`completed` / `error` / `aborted`），且这一条**没报过**。
   * 判重集中在这里、而不是每个调用点各判一次 —— 理由见 {@link settled}。
   */
  private settle(message: AgentNS.Message): void {
    if (
      message.status !== AgentNS.MessageStatus.Completed &&
      message.status !== AgentNS.MessageStatus.Error &&
      message.status !== AgentNS.MessageStatus.Aborted
    ) {
      return;
    }
    if (this.settled.has(message)) return;
    this.settled.add(message);
    this.emit("messageFinished", { agent: this, message });
  }

  /** 追加一条消息并广播 `messageAdded` —— 广播点放在唯一的追加口上 */
  append(message: AgentNS.Message): AgentNS.Message {
    const appended = super.append(message);
    this.emit("messageAdded", { agent: this, message: appended });
    // 出生就是终版的那几条（用户说的话、系统注入的）从这儿走：出现之后紧接着就是「定稿」
    this.settle(appended);
    return appended;
  }

  /** 就地改完之后重发同一条（同 id）：只靠「新增」事件，订阅方会永远停在 `pending` 上 */
  private touch(message: AgentNS.Message): void {
    this.emit("messageChanged", { agent: this, message });
  }

  /** 取走 inbox 里的 high InboxEntry 并落成 user 消息（内循环唯一的取走点） */
  private landHigh(): void {
    const entries = this.inbox.takeAll((entry) => entry.priority === "high");
    if (entries.length === 0) return;
    for (const entry of entries) {
      const message = inboxEntryMessage(entry);
      if (message) this.append(message);
    }
    // 与外循环那处同一口径：**写进 messages 之后**才报「这些被取走了」
    this.emit("inboxTaken", { agent: this, entries });
  }

  // -------------------------------------------------------------------------
  // 请求体
  // -------------------------------------------------------------------------

  formatTools() {
    // `tools` 不是可选的（`AgentContext` 构造时 `?? []`），没有「可能没有它」这条路
    if (this.tools.length === 0) return undefined;
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

  /** 一条消息内容发给模型的那一份：字符串原样，数组逐段交给 `formatContentSection` */
  formatContent(content: AgentNS.MessageContent): AgentNS.MessageContent {
    if (!Array.isArray(content)) return content;
    return content.map((section) => this.formatContentSection(section));
  }

  /** 一段内容发给模型的那一份：按段类型取认识的字段重建（内容字段的扩展点） */
  formatContentSection(section: AgentNS.MessageContentSection): AgentNS.MessageContentSection {
    return formatContentSection(section);
  }

  /**
   * 按白名单重排一份历史（只留模型认识的字段，`__` 开头的键不在白名单里，跟着一起没了）。
   *
   * `name` 不在白名单里：工具结果靠 `tool_call_id` 指明是哪一条，名字是多余的；而有些服务方
   * （anthropic、google 的翻译层）见到工具消息带 `name` 直接 400
   *（“cannot preserve named conversation participants”）。
   */
  formatHistory() {
    return this.messages
      .filter(
        (message) =>
          (message.status === undefined || message.status === AgentNS.MessageStatus.Completed) &&
          !message.omit,
      )
      .map((message) => ({
        role: message.role,
        content: message.content === undefined ? undefined : this.formatContent(message.content),
        function_call: message.function_call ? message.function_call : undefined,
        tool_calls: message.tool_calls?.length ? message.tool_calls : undefined,
        tool_call_id: message.tool_call_id ?? undefined,
        reasoning_content: message.reasoning_content ?? undefined,
      }));
  }
}
