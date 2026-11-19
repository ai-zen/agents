import AsyncQueue, { QueueInputPausedError } from "@ai-zen/async-queue";
import EventBus from "@ai-zen/event-bus";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { AgentNS } from "./AgentNS.js";
import { AgentContext } from "./AgentContext.js";
import { AgentError } from "./AgentError.js";
import { PickRequired } from "./Common.js";
import { ToolCallContext } from "./ToolCallContext.js";
import { Message } from "./Message.js";
import { inboxEntryMessage } from "./Inbox.js";
import { Tool } from "./Tool.js";
import { reconcileAbortedToolRounds } from "./AbortedToolRounds.js";
import { reconcileAbortedMessages } from "./AbortedMessages.js";
import { applyChunk } from "./applyChunk.js";
import { formatContentSection } from "./formatContent.js";

// ---------------------------------------------------------------------------
// 钩子：缝在哪儿（说位置，不说发生了什么事 —— 后者归事件）
// ---------------------------------------------------------------------------

/** 钩子统一返回值：返回 string = 拒（这次请求/这次调用不跑），返回 undefined/void = 放行 */
export type HookResult = string | void | Promise<string | void>;

/** 外循环（这一批事件）的上下文 */
export interface OuterLoopContext {
  agent: Agent;
  /** 这一批取到的条目（可能含只拧钥匙不带正文的） */
  entries: AgentNS.InboxEntry[];
}

/**
 * 内循环（这一次请求）的上下文。
 *
 * `body` 是**这次要发出去的请求体**，不是 `agent.messages` —— 它是按白名单重排的一份快照，
 * 一次性的。钩子可以直接改它的 `messages`：素材还原（库里只存引用、发送时才变成真东西）
 * 走的就是这一缝。这条不成立，宿主就只能让 core 认识素材，而 core 不该认识。
 */
export interface InnerLoopContext {
  agent: Agent;
  body: Record<string, unknown> & { messages: unknown[] };
}

/**
 * 死活与状态类钩子的上下文。
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
 * subagent 不是一段会话、不入库，跑完就散；但「这段会话派过几个 subagent、它们各自说了什么」
 * 必须答得出来。所以派遣时在父身上留这一项，要查 subagent 说过的话就顺
 * 「父的名册 → `agent` → 它的 `messages`」取 —— 那些话只在**subagent 自己那个对象**里。
 *
 * `agent` 是**活引用**（和事件里带出去的是同一个东西，不是拷贝）：它就是那一栏消息的唯一真相。
 * 于是这一项不能序列化、不能进库 —— 与 `source` 里不许放 `Agent` 引用是同一条理由。
 */
export interface SubAgentEntry {
  /** 委派那次工具调用的 id：客户端据此把 subagent 的话分到那一栏（§10） */
  toolCallId: string;
  /** 被委派的那个 agent 本身（活引用） */
  agent: Agent;
  /**
   * 这次委派用的工具名（= 模型调用的那个委派工具的名字）。
   *
   * core 只认识这一个「名字」：subagent 的助手名在助手定义里，那是外部的财产（`buildAgent`
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
 * | `onInit` | 不能 | 注册后初始化（`init()`），与死活无关 |
 * | `onStart` / `onOutputPaused` / `onOutputResumed` / `onIdle` / `onStop` / `onKill` | 不能 | 死活与状态的边 |
 * | `onAbort` | 不能 | 有人按了停（闸本来关着也照发） |
 * | `onOuterLoopStart` / `onOuterLoopEnd` | 不能 | 这一批的开始 / 结束 |
 * | `onInnerLoopStart` | **能拒** | 排在造 assistant 占位**之前**，拒了历史里一个字都不多 |
 * | `onInnerLoopEnd` | 不能 | 这一次请求结束 |
 * | `onToolStart` | **能拒** | 拒了就是「这个工具没给出有效结果」，原因作为 tool 消息回给模型 |
 * | `onToolEnd` | 不能 | 工具跑完了 |
 * | `onSubAgentStart` | **能拒** | 拒了这次委派不跑 |
 * | `onSubAgentEnd` | 不能 | 委派结束（subagent 已经跑完，撤不回来了） |
 *
 * `onOuterLoopStart` **不能拒**：此刻这一批已经从队列里取出来了，拒了这批就没主了。
 * 「要不要处理这一批」的判决应该发生在投递之前 —— 投了就得有人跑。
 */
export interface AgentPlugin {
  onInit?(): HookResult;
  onStart?(ctx: LifecycleContext): HookResult;
  /** 不取件开关翻上（从此不取件，手上那批照跑） */
  onOutputPaused?(ctx: LifecycleContext): HookResult;
  /** 不取件开关翻回（又开始取件） */
  onOutputResumed?(ctx: LifecycleContext): HookResult;
  /** 有人按了停（`abort()`）；闸本来关着也照发 */
  onAbort?(ctx: LifecycleContext): HookResult;
  onIdle?(ctx: LifecycleContext): HookResult;
  onStop?(ctx: LifecycleContext): HookResult;
  onKill?(ctx: LifecycleContext): HookResult;
  onOuterLoopStart?(ctx: OuterLoopContext): HookResult;
  onOuterLoopEnd?(ctx: OuterLoopContext): HookResult;
  onInnerLoopStart?(ctx: InnerLoopContext): HookResult;
  onInnerLoopEnd?(ctx: InnerLoopContext): HookResult;
  onToolStart?(ctx: ToolHookContext): HookResult;
  onToolEnd?(ctx: ToolHookContext): HookResult;
  onSubAgentStart?(ctx: SubAgentHookContext): HookResult;
  onSubAgentEnd?(ctx: SubAgentHookContext): HookResult;
}

// ---------------------------------------------------------------------------
// 事件：说发生了什么
// ---------------------------------------------------------------------------

export interface LifecycleEvent {
  agent: Agent;
}
export interface StateEvent {
  agent: Agent;
  from: AgentNS.AgentState;
}

/**
 * 输出闸动了：翻上（`output:paused`）/ 翻回（`output:resumed`）。
 *
 * 载荷只带 agent —— 「此刻还取不取件」现读 `agent.isOutputPaused`，不在这里再报一份。
 * 它与「在干 / 闲」是两处状态，所以它的变化**不冒充**「到了哪一格」：它只说自己动了。
 */
export interface OutputEvent {
  agent: Agent;
}

/**
 * 输入闸动了：关上（`input:paused`）/ 打开（`input:resumed`）。
 *
 * 载荷同样只带 agent（现读 `agent.isInputPaused`）。它与输出闸是两道闸，两条事件不互相冒充。
 */
export interface InputEvent {
  agent: Agent;
}

/**
 * 有人按了停（`abort()`）。
 *
 * 它是**意图**，不是闸的副作用：闸可能本来就是关着的（那样 `output:paused` 一条都不发），
 * 但「这一下停」发生了。想读「掐没掐到东西」看那一条消息的 `status`（`aborted`）。
 */
export interface AbortedEvent {
  agent: Agent;
}

/**
 * 队列有三个时刻会说话：`inboxAdded` / `inboxTaken` / `inboxCleared`（`CORE.md` §3）。
 *
 * 持久化就挂在这三条上 —— **inbox 一有变化就入库**，不攒批、不靠定时快照。三条都是
 * 「通知」而不是唯一信息源：任何时候都能用 `agent.inboxPending` 重读真队列，与库里的那份对一遍
 * （只留事件、不留重读，那半就是唯一信息源，而它必漏）。
 *
 * 进来一条。载荷是**那一条**（带 `messageId` / `createdAt` / `source` 与正文；钥匙没有正文）。
 */
export interface InboxAddedEvent {
  agent: Agent;
  entry: AgentNS.InboxEntry;
}

/** 这些条目**已经离开队列**（被取走了），并且它们该落的消息已经落好了。
 *
 * 为什么取走也要说一声：持久化要求「inbox 一有变化就入库」。只报进队不报取走的话，
 * 宿主只能靠快照覆盖，那就不再实时了；而靠增量又必然对不上（钥匙被取走完全无声 ——
 * 它不落消息，取走了就像没存在过）。
 *
 * 为什么排在落地**之后**（`CORE.md` §3、`PRD.md` 4.5）：崩溃点若落在两者之间，
 * - 「消息已落、条目还在」→ 恢复时按 `messageId` 去重就能收拾（可救）；
 * - 反过来「条目没了、消息没落」→ 那条话凭空消失（不可救）。
 */
export interface InboxTakenEvent {
  agent: Agent;
  entries: AgentNS.InboxEntry[];
}

/** 队列被**清空**（作废，不是取走）：载荷是被丢掉的那些，原顺序。 */
export interface InboxClearedEvent {
  agent: Agent;
  entries: AgentNS.InboxEntry[];
}

export interface MessageEvent {
  agent: Agent;
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
  | { message: AgentNS.Message }
  | { subAgent: Agent; toolCall?: AgentNS.ToolCall };

export interface DeltaEvent {
  agent: Agent;
  /** 原片本身，一个字节都不动 */
  chunk: unknown;
  source: DeltaSource;
}
export interface RequestSentEvent {
  agent: Agent;
  /** 要发出去的那份请求体（一次性的，不是 `agent.messages`） */
  body: Record<string, unknown>;
}
export interface ResponseFinishedEvent {
  agent: Agent;
  message: AgentNS.Message;
}
export interface ToolStartedEvent {
  agent: Agent;
  toolCall: AgentNS.ToolCall;
  /** 这个工具跑在某个 subagent 里（委派工具转发上来时才有） */
  subAgent?: Agent;
  /** 是哪一次委派引起的 */
  via?: AgentNS.ToolCall;
}
export interface ToolFinishedEvent {
  agent: Agent;
  toolCall: AgentNS.ToolCall;
  result: AgentNS.Message;
  subAgent?: Agent;
  via?: AgentNS.ToolCall;
}
export interface SubAgentEvent {
  agent: Agent;
  subAgent: Agent;
  toolCall?: AgentNS.ToolCall;
}
export interface DeniedEvent {
  agent: Agent;
  hook: string;
  reason: string;
  /**
   * 结构性的事实，给宿主/插件用（例如上下文护栏的 `promptTokens` / 阈值）。
   *
   * 为什么不塞进 `reason`：那一格是写给**模型或人**读的文案；一旦有人想按数字判断
   * （宿主现在就按「是不是上下文溢出」分流），就只能去 parse 字符串。
   */
  detail?: unknown;
}
export interface FailedEvent {
  agent: Agent;
  error: AgentError | Error;
  /** 出错的那条消息（如果有）—— 与 `message.error` 是同一个实例 */
  message?: AgentNS.Message;
}

/**
 * 事件表。**带出去的是活对象本身，不是拷贝** —— 收到事件的人手里攥着的就是那条消息、
 * 那条条目、那片原片。拷贝 = 第二份事实，交出去那一刻就开始过期。
 *
 * 事件只是通知，**不是唯一信息源**：晚到、重复、丢一条都不影响正确性，读活对象就自愈。
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
  delta: DeltaEvent;
  requestSent: RequestSentEvent;
  responseFinished: ResponseFinishedEvent;
  toolStarted: ToolStartedEvent;
  toolFinished: ToolFinishedEvent;
  subAgentStarted: SubAgentEvent;
  subAgentFinished: SubAgentEvent;
  denied: DeniedEvent;
  failed: FailedEvent;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * 条目的**唯一形状**：`push()`（新投递）与 `restore()`（把旧条目放回队列）都从这里过。
 *
 * 一条概念一种形状 —— 两条路各写一套的话，迟早有一处少一格、或者多一格「反正也没人读」，
 * 而条目是要落库再读回来的东西：形状漂一次，库里存的和队列里的就不是同一件事了。
 *
 * 它**只摆字段、不造值**：`createdAt` 与 `messageId` 都由调用方给 —— 新投递给「现在」与一个
 * 新 mint 的 id，恢复给存下来的那两个。于是同一个形状承担两套语义，而代码只有这一份。
 *
 * 没有正文就是**钥匙**（`InboxKey`）：它只负责把这一回叫起来，不落地成消息，所以没有
 * `messageId`、没有 `source`，`priority` 恒为 `low`（内循环只看 high，钥匙天然取不到）。
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
 * 能拒的钩子：返回 string 就是判决（这次不跑），**只有它们短路**后面的插件。
 *
 * 它们崩了还要**fail-closed** —— 坏的护栏放行等于没有护栏；
 * 其余位置崩了当没说话（fail-open），只为不把 agent 打死。
 */
const DENIABLE_HOOKS = new Set<string>(["onInnerLoopStart", "onToolStart", "onSubAgentStart"]);

/** 在途的那一次请求（含它引出的工具）：寿命**只到这一次**，下一次是全新的 */
interface Inflight {
  controller: AbortController;
  /** `Promise.race` 的伙伴：不管对方听不听话，`await` 立刻返回 */
  abortRx: Promise<void>;
}

export class Agent extends AgentContext {
  /**
   * 这一格的存储。**外面读不到它、也写不进来** —— 读写两个口在下面。
   *
   * 为什么不让它是个 public 字段：`state` 是「在干 / 闲」，它说谎的时候没有任何东西会报错
   *（订阅方只会安静地按错的那一格做决定）。收成「私有存储 + 私有写入器」之后，「换格」
   * 只剩 {@link setState} 一条路 —— 它连事件与钩子一起发，不会有人只改值不发通知。
   */
  private _state: AgentNS.AgentState = "idle";

  /**
   * 对外那一格：在干 / 闲，**只由循环的位置决定**（语义见 `AgentNS.AgentState`）。
   *
   * 取不取件（{@link isOutputPaused}）不参与它的判断 —— 不取件中投进来的那批照跑，
   * 跑完照样报闲。
   */
  get state(): AgentNS.AgentState {
    return this._state;
  }

  /**
   * 写这一格：**私有**。唯一的合法写法是 {@link setState}（换值 + 发事件 + 跑 `onIdle`）；
   * 只有「死」那一处直接赋值（{@link markDead}），理由写在那里。
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
   * 迟早漂出一份「以为还在收件、其实闸早关了」）：
   * - 收不收件 = `isInputPaused` —— `stop()` / `kill()` 各自 `pauseInput()`；
   * - 以后还有没有新货 = `isDone` —— `stop()` / `kill()` 各自 `done()`（它取代了原来的
   *   `closed` 字段：**关门就是「不再有货」，不是另一处状态**）；
   * - 此刻取不取件 = `isOutputPaused` —— {@link isOutputPaused} 直接读它。
   */
  private inbox = new AsyncQueue<AgentNS.InboxEntry>();

  /** `kill()` 调过：硬着陆，存量作废。**只管「死没死」**（还收不收新货问队列的 `isInputPaused`） */
  private killed = false;
  /**
   * `stop()` 调过 —— **自己的判重**，不借队列的 `isDone`。
   *
   * 两者不是一回事：`isDone` 说的是「以后没有新货」，这里问的是「`stop()` 这个动作做过没有」。
   * 借 `isDone` 当判据的话，`kill()` 之后再 `stop()` 会因为「已经 done 了」提前返回，
   * `onStop` 钩子永不跑 —— 而它该跑（那是「有人要求关门」的那道缝）。
   */
  private stopRequested = false;
  /**
   * 「死」这件事实说过了 —— `stopped` / `killed` 加起来**只发一条**。
   *
   * 为什么还要一个布尔：这件事有两个说出口（{@link stop} / {@link kill} 本体 —— 没
   * `start()` 过时外循环永远跑不到出口；以及外循环出口 —— 那时存量才真的跑完），
   * 两个出口都得能说，就得有人保证不说第二遍。
   */
  private deathSaid = false;
  /** 一次性 agent 已经吃过一次投递了（自此关收） */
  private fed = false;

  /** `start()` 的那句 promise：到死才 resolve，且不 reject */
  private runPromise?: Promise<void>;
  /** 在途的那一次请求（没有正在发请求 / 跑工具时是 `undefined`） */
  private inflight?: Inflight;

  constructor(options: PickRequired<AgentContext, "client" | "model">) {
    super(options);
  }

  // -------------------------------------------------------------------------
  // 事件与插件
  // -------------------------------------------------------------------------

  /** 订阅一个事件，返回取消函数（订阅者自己管生命周期） */
  on<K extends keyof AgentEvents>(type: K, handler: (payload: AgentEvents[K]) => void): () => void {
    const subscription = this.bus.on(type as string, handler as (...args: any[]) => any);
    return () => subscription.dispose();
  }

  /**
   * 发一个事件。
   *
   * 公开是因为委派工具要把 subagent 的事件**按同一套名字**发到父身上（§9-3）：
   * 不为 subagent 另起一套平行名字，只多「哪个 subagent + 哪个工具调用」两格。
   */
  emit<K extends keyof AgentEvents>(type: K, payload: AgentEvents[K]): void {
    this.bus.emit(type as string, payload);
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
   * 根本不看），让它们短路等于「一个顺手 `return "好"` 的插件把后面所有插件都跳过了」，
   * 而它自己还以为只是说了句话。非门钩子给了非 `undefined` 就当没给（丢掉，不抛）。
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
        // 插件抛错**不许把 agent 打死**：异常会一路穿出 `start()`，循环就永久停在那儿，
        // 而且 `killed` 还是 false、输入闸也还开着 —— 一个看起来活着、塞进去也不动的僵尸。
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.emit("failed", { agent: this, error: wrapped });

        // 门（能拒的那三个）崩了就关上：坏的护栏不该放行。
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
   * 没造出来的东西不该挂在世上（与血缘「拒了把关系撤回去」是同一件事）。
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
    const payload: SubAgentEvent = {
      agent: this,
      subAgent: ctx.subAgent,
      toolCall: ctx.toolCallContext.tool_call,
    };

    if (hook === "onSubAgentStart") {
      if (denied === undefined) {
        // 先记账、再发事件：订阅方在 `subAgentStarted` 那一刻就该能从名册里读到这一项
        //（和「先记血缘、再问钩子」同一条理由：发出去的事件里不许有摸不到的东西）。
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
  // 死活：五个动作
  // -------------------------------------------------------------------------

  /**
   * 起来等事件。返回一个**到死才 resolve** 的 promise，且**永不 reject**。
   *
   * 幂等：重复调返回同一句 promise。失败不终结 agent —— 一次请求挂了就是一次挂了，
   * 记在那条消息的 `error` 上、报一个 `failed` 事件，循环接着等下一个事件。
   * core 自己写崩了也走这条路（报 `failed` 再退出循环）：它不该让调用方在 `await` 上
   * 接到一个「框架 bug」形状的拒绝，那样调用方只能把 bug 当业务处理。
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
   * 关门：不再接输入，**存量走完**，排空才死（血流干的死）。
   *
   * 三件事全交给队列的三个口，core 自己不记状态：
   * - `pauseInput()`：此后 `push()` 由队列抛 `QueueInputPausedError`，core 翻成
   *   `AgentError("closed")`（这个 agent 已经终结）；
   * - `resumeOutput()`：**不能省**。`done()` 只是「以后没有新货」这个信号，它**不突破输出闸** ——
   *   不取件中调 stop 时消费者正挂在闸上，不翻回来它就永远挂在那儿：存量没人取，
   *   `stopped` 也发不出来（以前那道「等开关翻开」的等待就是以放行它来收尾的）；
   * - `done()`：宣告没有新货，迭代器取空存量后自己收尾。
   *
   * 不取件（{@link isOutputPaused}）中调它**不作废存量**：不取件说的是「现在别跑」，
   * stop 说的是「以后也别跑」，两句叠起来的正确读法是「把手上这些跑完为止」。
   *
   * **次序定死：先翻闸与关门 → 再跑钩子 → 最后才说「死」**（{@link markDead}）。
   * 「已经死了」这个事实最后落地：钩子那一刻还能读到一个「正在收尾」的 agent，而订阅方
   * 听到 `stopped` 时，闸、队列、`state` 三样都已经是死后该有的样子。起来了的 agent 由
   * 外循环出口说（存量真跑完了才算死），没 `start()` 过的只能由这里当场说 —— 那时外循环
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
   * 硬着陆：立刻死，存量作废。
   *
   * 与 `stop()` 只差两处：**存心作废存量**（`clearInbox()`）与**掐在途**（`abortTurn()`）。
   *
   * 翻输出闸（`resumeOutput()`）与清空是两件事，都要，但理由不同：
   * - 清空**不看那道闸** —— 它走的是队列的 `clear()`（作废，不是取件），闸关着也照样清得掉。
   *   以前用 `takeAll()` 当清空，就被闸挡住了（「暂停中清不掉」），那是把作废当成了取件；
   * - 翻闸是为**挂在闸上的循环**：不翻回来，迭代器永远停在闸上，收尾走不完、`killed` 发不出来。
   *   清空是同步的，消费者在微任务里才被唤到，所以队里的货一定是先被清掉、
   *   再轮到它看见空队列 + `isDone` 而收尾。
   *
   * **次序与 `stop()` 同一条**：翻闸与清空 → 钩子 → 事件。`kill()` 之后不会补发 `stopped`：
   * 死只有一条（{@link markDead}），而 `killed` 优先于 `stopped`。
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
   * 此刻**还接不接投递** —— 输入闸的现读（`inbox.isInputPaused`）。
   *
   * `true` 说的是「这个门关了」：此后 `push()` 抛 `AgentError("closed")`。
   * 与 {@link isOutputPaused} 是两道**互不相干**的闸：那道管「取不取」、这道管「收不收」。
   * 关门（`stop` / `kill`）是这道闸唯一的生产者。
   */
  get isInputPaused(): boolean {
    return this.inbox.isInputPaused;
  }

  /**
   * **关上输入闸**：此后投递进不来，手上的活与排队区一件不动。
   *
   * 与 {@link pauseOutput} 的区别只有一句话：这道闸拦的是**投递**，那道闸拦的是**取件**。
   * 事件 `input:paused` 由 agent 发（队列不认识事件），与 `output:paused` 对称。
   * 幂等；已经关了/死了就是空动作。
   */
  pauseInput(): void {
    if (this.inbox.isInputPaused) return;
    this.inbox.pauseInput();
    this.emit("input:paused", { agent: this });
  }

  /**
   * **打开输入闸**：又开始接投递。
   *
   * 关门之后（`stop` / `kill` 动过）不许再开：那时队列已经宣告没有新货，再放人进来等于把件
   * 投给一个永远不会再取件的队列。
   */
  resumeInput(): void {
    if (this.inbox.isDone || !this.inbox.isInputPaused) return;
    this.inbox.resumeInput();
    this.emit("input:resumed", { agent: this });
  }

  /**
   * 此刻还取不取件 —— **另一处状态**，与「在干 / 闲」互不影响。
   *
   * `true` 说的是「从下一批起不再取件」：批与批之间不取，手上那批照跑。
   * 想知道「它现在在不在干活」读 {@link state}，不要看这处开关。
   *
   * 它是队列那个**输出闸的现读**（`inbox.isOutputPaused`），core 不另存一份 ——
   * 本方法在 core 里没有对应的字段，权威在队列。
   */
  get isOutputPaused(): boolean {
    return this.inbox.isOutputPaused;
  }

  /**
   * **翻上不取件开关**：只是从此不取件，不掐在途。
   *
   * 手上这批算已经开始 —— 让它跑完，从下一批起不再取。要立刻停就用 `abort`。
   * 它**只关队列的输出闸**：{@link state} 一个字节都不变（跑完该报闲就报闲，闸仍是关着）。
   * 事件 `output:paused` 仍由 agent 发 —— 那是给**外面**的通知，队列不认识事件。
   * 幂等；已经关了/死了就是空动作。
   */
  pauseOutput(): void {
    // `isDone` = 已经在收尾路上了（stop / kill 动过）。那时再关输出闸会把「把血放干」
    // 挂在一个再没人翻回来的闸上（`done()` 不突破输出闸），所以门口就拦住。
    if (this.inbox.isDone || this.inbox.isOutputPaused) return;
    this.inbox.pauseOutput();
    this.emit("output:paused", { agent: this });
    void this.dispatchHook("onOutputPaused", { agent: this });
  }

  /**
   * **暴力中断**：掐掉在途的请求与工具。
   *
   * 它就是「掐在途 + {@link pauseOutput}」：这一批掐完不能再往下走，所以**必然**把不取件
   * 开关一并翻上。反过来不成立 —— `pauseOutput()` 只翻开关、不碰在途的那批：
   * 掐在途一定伴随不取件，不取件不必掐在途。
   */
  abort(): void {
    if (this.inbox.isDone) return;
    // 先掐在途，再翻闸（翻闸那一步会发 `output:paused`），最后才报「有人按了停」——
    // 三件的顺序就是因果顺序：掐断 → 从此不取 → 这个事实
    this.abortTurn();
    this.pauseOutput();
    this.emit("aborted", { agent: this });
    void this.dispatchHook("onAbort", { agent: this });
  }

  /**
   * **翻回不取件开关**：又开始取件，**只翻开关、不碰 {@link state}**。
   *
   * 开的是队列的输出闸：挂在闸上的消费者被**一次性全部放行**，按原顺序接着取 ——
   * 队列里有货的话，外循环一被放行就自己取走、自己报 `working`，那件事归它报，这里不替它说。
   * 也不在这里顺手取件：用户手快连点 `abort` / `resumeOutput` 时这一次请求还在收尸，
   * 此刻去取件就变成两个东西同时写 `messages`。
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
   * 塞进 inbox，立刻返回。
   *
   * **投不进去就抛 `AgentError`**，不静默丢：塞的人可能是另一个 agent，他得知道自己投失败了
   * 才能改投（宿主接住这个错，就去做「新装一个再投」）。而「投不进去」有两种，**调用方必须能
   * 分开**（它们要做的事完全不同）：
   * - `closed`：这个 agent 已经终结（`stop()` / `kill()` 动过），再等也不会有人来取；
   * - `input_paused`：只是输入闸暂时关着（有人 `pauseInput()`），`resumeInput()` 之后还能投。
   *
   * 两个码都由 core 定，判断依据是队列自己的两格（`QueueInputPausedError` 只说「不收」，
   * `isDone` 才分得出是哪一种）。队列不认识 agent 的码，这边也不去猜队列的内部状态。
   *
   * 不给 `input`（或给一个没有正文的）= 拧钥匙：只把它叫起来，不落地任何消息。
   */
  push(input?: AgentNS.InboxInput): void {
    // 一次性 agent 只有一条因果链：发起它的那一次投递。之后关收，
    // 别人塞进来的东西会让「等闲」重新变成瞎等（`CORE.md` §1）。
    if (this.lifetime === "one-shot") {
      if (this.fed) {
        throw new AgentError("closed", `一次性 agent(${this.id}) 只接受第一次投递`);
      }
      this.fed = true;
    }

    const entry: AgentNS.InboxEntry = toInboxEntry(
      input?.content === undefined
        ? { createdAt: new Date().toISOString(), priority: "low" }
        : {
            messageId: input.messageId ?? this.newMessageId(),
            createdAt: new Date().toISOString(),
            priority: input.priority,
            source: input.source,
            content: input.content,
          },
    );

    try {
      this.inbox.push(entry);
    } catch (error) {
      // 不收是**队列判的**（`pauseInput()` 之后它一个都不收），但那一个错误码盖着两件事：
      // 这个 agent 已经终结（`isDone`）还是只是输入闸暂时关着。别的异常原样往上抛 ——
      // 那不是「不收」，不该冒充一个业务码。
      if (error instanceof QueueInputPausedError) {
        if (this.inbox.isDone) {
          throw new AgentError("closed", `往已经关了的 agent(${this.id}) 投递`);
        }
        throw new AgentError("input_paused", `agent(${this.id}) 的输入闸暂时关着`);
      }
      throw error;
    }

    // 进队就是一次变化：持久化挂在 `inboxAdded` 上（`CORE.md` §3）。抛出去的那两种不是变化
    this.emit("inboxAdded", { agent: this, entry });
  }

  /**
   * 把**旧的条目原样放回队列**（PRD 4.12：关掉再打开，没被处理的那几句还在等）。
   *
   * 与 {@link push} 只差一件事 —— 这些条目**不是新的**，而这一件事决定三处：
   *
   * 1. **不走 `push()`**。`push()` 会重新盖 `createdAt`（于是一重启，所有排着的条目都变成
   *    「刚刚」），还会再发一条 `inboxAdded`。前者比丢了这个字段更坏：`createdAt` 存在的唯一
   *    理由就是让模型判断时效（`CORE.md` §3），改掉它会让模型**确信**一条陈年通知是刚发生的，
   *    顺序也会跟着错；后者会让订阅方再插一行（库里那一条就变成两条）。
   * 2. **不发 `inboxAdded`**。库里的行已经在（恢复读的就是它），恢复不是新变化 —— 三条事件
   *    说的是「有了变化」，不是「队列里现在有这些」。
   * 3. **`createdAt` / `source` / `content` / `messageId` 一个字段都不重算**：形状由
   *    {@link toInboxEntry} 摆（与 `push()` 同一份），值全部由调用方给 —— 存下来是什么就是
   *    什么，这里不生成任何缺省值（生成一个就等于把事实换成了猜的）。
   *
   * 该拒的三种（`CORE.md` §3）：
   * - **一次性 agent**：它只吃一次投递，寿命在调用栈里，恢复它没有任何去处（写错代码，抛裸
   *   `Error`，与「在活着的 agent 上调 `runOnce()`」同一类）；
   * - **已经关门 / 已经死了**：队列不会再有取件人，放回去只是喂给一个没人取的队列
   *   （`AgentError("closed")`，与 `push()` 同一个码）；
   * - **形状不全的条目**：宁可当场炸，也不要把半截数据装进队列 —— 半截条目会一路走到落地，
   *   到那时错的地方已经离这里很远了。全部条目先全部校验，一条不合格就一条都不放回去。
   */
  restore(entries: readonly AgentNS.InboxEntry[]): void {
    if (this.lifetime === "one-shot") {
      throw new Error(
        `restore() 不能用在一次性 agent(${this.id}) 上：它的寿命在调用栈里，没有「重启之后接着等」这回事`,
      );
    }
    if (this.inbox.isDone) {
      throw new AgentError("closed", `往已经关了的 agent(${this.id}) 恢复条目`);
    }

    for (const entry of entries) {
      if (typeof entry.createdAt !== "string" || entry.createdAt === "") {
        throw new Error("restore() 收到形状不全的条目：createdAt 必须是被存下来的那个时刻串");
      }
      if (entry.priority !== "high" && entry.priority !== "low") {
        throw new Error("restore() 收到形状不全的条目：priority 只能是 high / low");
      }
      if (entry.content !== undefined && entry.source === undefined) {
        throw new Error("restore() 收到形状不全的条目：带正文的条目必须带 source");
      }
    }
    if (entries.length === 0) return;

    // 形状走 `push()` 那一份（一条概念一种形状），值一个都不动
    const restored = entries.map((entry) => toInboxEntry(entry));
    try {
      this.inbox.push(...restored);
    } catch (error) {
      // 关门那一种上面已经拦过了，这里只剩「输入闸暂时关着」：与 `push()` 同一个码
      if (error instanceof QueueInputPausedError) {
        throw new AgentError("input_paused", `agent(${this.id}) 的输入闸暂时关着`);
      }
      throw error;
    }
  }

  /**
   * 投递并**等到空闲**再返回 —— **不关门**。
   *
   * 它是「能等」那个形状本身，只给**一次性会话**（走一条因果链、没有第二个触发方）：常驻会话
   * 随时可能被任意触发方从闲推到忙，「我等它跑完」在那个形状里根本不成立，所以那边只有
   * {@link push}（`CORE.md` §1 / PRD 4.3）。
   *
   * 「等到空闲」= {@link waitForState} 那一格：`state` 到了 `idle` **且**队列真空 —— 只看
   * `state` 的话，`push()` 之后、外循环取到那批之前它还是 `idle`，那等于没等。
   *
   * 没起来就先起来（一次性会话的寿命在调用栈里，没有人会替它 `start()`）。返回的 `messages`
   * 就是 `this.messages` 本身，不拷贝。
   *
   * {@link runOnce} 就是它 + `stop()`：本方法不做任何收尾动作 —— 关不关门、什么时候关，是调用方
   * 那一层的事（`send` 交给下面，`runOnce` 自己关）。
   */
  async send(
    input?: AgentNS.InboxInput,
    options?: { signal?: AbortSignal },
  ): Promise<AgentNS.Message[]> {
    if (this.lifetime !== "one-shot") {
      throw new Error(
        `send() 只能用在 lifetime 为 "one-shot" 的 agent 上：常驻会话没有「等到跑完」这回事，那边只有 push()`,
      );
    }
    if (input?.content === undefined && this.messages.length === 0) {
      throw new Error("send() 时 messages 是空的：没有燃料，拧钥匙只会发一个空请求");
    }

    this.start();
    this.push(input);
    await this.waitForState("idle", options?.signal);
    return this.messages;
  }

  /**
   * 跑一次到死：起 → **`send`** → 关门 → 死透 → 交回消息。
   *
   * **不是第六个死活动作**：它就是 {@link send} 外面套一层收尾，而 `send` 自己又是
   * `start` + `push` + 等闲 的复合。一次性会话那几步由它收成一句。跑完之后这个 agent 就没了
   * （死了就死透，复活 = 新建）。
   *
   * 返回的 `messages` 就是 `agent.messages` 本身，不拷贝。
   */
  async runOnce(
    input?: AgentNS.InboxInput,
    options?: { signal?: AbortSignal },
  ): Promise<AgentNS.Message[]> {
    if (this.lifetime !== "one-shot") {
      throw new Error("runOnce() 只能用在 lifetime 为 \"one-shot\" 的 agent 上：它会把这个 agent 关掉");
    }
    if (this.runPromise) {
      throw new Error("runOnce() 只能用在还没 start() 的 agent 上：它会把这个 agent 关掉");
    }

    const death = this.start();

    // 前端掉线 / 父 agent 被 abort：掐在途、关门、死透，然后把已经跑出来的那部分交回去
    const onAbort = () => {
      this.abort();
      this.stop();
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      // 一次性 agent 只有一条因果链（就是我自己），所以这里的「等闲」是有归属的 ——
      // 共享会话上做同一件事毫无意义，见 `CORE.md` §1。
      await this.send(input, options);
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
   * 清空 inbox（作废排队）并返回被丢掉的条目。core 自己从不主动调它 ——「作废排队」是调用方的
   * 显式决定，不该由「用户按了停」替它猜（唯一例外：`kill()` —— 硬着陆就是「这些永远不跑了」）。
   *
   * 走的是队列的 `clear()`，**不是 `takeAll()`**：清空是「作废」，不是「取件」。
   * 取件要看输出闸（不取件时一件都不给，那是暂时的、货还排着队），作废不看 —— 所以
   * {@link pauseOutput} 期间调它照样清得掉，宿主那条 `/clear` 才不会在暂停中失效。
   *
   * 清空也是变化，所以报 `inboxCleared`（持久化挂在它上面，`CORE.md` §3）。事件仍由 agent 发:
   * 队列不认识事件。空队列清一次什么都不发 —— 没变化就没有「一有变化就入库」。
   */
  clearInbox(): AgentNS.InboxEntry[] {
    const entries = this.inbox.clear();
    if (entries.length) this.emit("inboxCleared", { agent: this, entries });
    return entries;
  }

  /**
   * 起来了吗（`start()` 调过没有）。
   *
   * 与 `state` 是两件事：没起来的 agent 也是 `idle`，光看 `state` 分不出「在等事件」
   * 和「压根没开始等」。
   */
  get started(): boolean {
    return this.runPromise !== undefined;
  }

  /**
   * subagent 的名册：**只给外面读**（`CORE.md` §17）。
   *
   * 三个时刻：派遣时加一项、结束时把 `endedAt` 填上（不移除）、外循环每一批的开头清空上一批。
   *
   * 三条纪律：
   * - **它不参与任何内部判断**：内循环、取件、续下一次请求、`state` 那一格、中断都不看它。清空点选在哪儿
   *   因此不影响正确性，只影响「外面什么时候读到空」；
   * - **它是名册，不是消息的唯一真相**：subagent 说过的话在 `entry.agent.messages` 里，
   *   这里只存指针；所以它跟着 agent 活在内存里，一死、一重启就一起没了（不入库）；
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
   * 看一眼排队区：按入队顺序给出此刻还没被取走的条目，**一个都不取走**。
   *
   * 三个时刻的事件（`inboxAdded` / `inboxTaken` / `inboxCleared`）是**通知**，不是唯一信息源：
   * 宿主 subscribe 它们做持久化，同时用这里**现读**真队列与库里的那份对一遍 —— 事件丢一条、
   * 重复一条都不致命（`CORE.md` §3、§10）。所以这里给的是「重读的那一半」，不是镜像。
   *
   * 返回的数组是拷贝，**条目本身还是那一个**（不会给出过期副本）。
   */
  get inboxPending(): readonly AgentNS.InboxEntry[] {
    return this.inbox.snapshot();
  }

  // -------------------------------------------------------------------------
  // 外循环
  // -------------------------------------------------------------------------

  /**
   * 外循环：等一批事件 → 修历史 → 落地 → 内循环。
   *
   * 一句 `for await` 就够 —— **队列自己就是 inbox，也是那根唤醒信号**：空着时它挂在自己的
   * `pushRx` 上，不需要 core 再维护第二套唤醒器。
   *
   * 不取件的等待有两处（进来之前一次、每批尾部一次）：于是批与批之间不取件，不取件期间
   * 到达的货就躺在队列里 —— 界面看得见条数、能持久化、恢复能捞回来。
   *
   * 这两处等待**不用 core 自己写**：不取件就是把队列的输出闸关上（`pauseOutput()`），
   * `asTakeAll()` 自己会停在闸上 —— 一件不取、不退出，闸一开就按原顺序接着取。
   * core 只负责翻闸（{@link pauseOutput} / {@link resumeOutput}），不养第二个唤醒器。
   *
   * `state` 那一格**不由 `isOutputPaused` 决定**：取到一批就是 `working`，这批跑完且队列
   * 真空就是 `idle` —— 哪怕那个开关还开着。两处状态各报各的，于是「不取件期间投进来的那批
   * 跑完了」和「仍旧不取件」两件事都报得出来。
   *
   * **手上已取出的那批算已经开始**：`pauseOutput()` 从下一批生效，不把它收回 —— 它可能已经落了
   * 消息、跑了一半工具，塞回队头只会造成重复落地。要立刻停就用 `abort`。
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

      // ② 落地：带正文的落一条 user 消息，钥匙什么都不落
      for (const entry of entries) {
        const message = inboxEntryMessage(entry);
        if (message) this.append(message);
      }
      // 落地完了才报「这些已经离开队列」（理由见 `InboxTakenEvent`：宁可重，不可丢）
      this.emit("inboxTaken", { agent: this, entries });

      // ③ 内循环
      const ctx: OuterLoopContext = { agent: this, entries };
      await this.dispatchHook("onOuterLoopStart", ctx);
      await this.innerLoops();
      await this.dispatchHook("onOuterLoopEnd", ctx);

      // 只有真的空了才叫「闲」—— 手上没活但队列还压着不算。
      // isOutputPaused 不参与这一判：不取件中跑完这批就是闲，那个闸该关着还关着。
      // `isDone`（stop / kill 动过）也不报闲：这已经在收尾路上了，报闲等于告诉外面「还能接着投」。
      if (this.inbox.size === 0 && !this.inbox.isDone) {
        this.setState("idle");
      }
    }

    // 走到这儿就是「死透了」：不再有货，这一批也都跑完了。
    // 只走 {@link markDead}：它先把 `state` 直接置成 `idle`（不发 `state:idle`）再报事件 ——
    // 死后的 agent 不该再冒出一格状态，而订阅方在 `stopped` / `killed` 那一刻就该读到 `idle`。
    this.markDead();
  }

  /**
   * 修一遍历史：把遗留的 `writing` / `pending` 定型、按「丢」删掉残局、按「填」补上
   * 未配对的工具结果。
   *
   * 判定依据只有两样：消息的 `status`，以及 `tool_calls` 与 tool 消息的配对关系。
   * **不需要知道原因** —— 中断、出错、崩溃三种来路，落到这一步看到的是同一份脏数据。
   */
  private repair(): void {
    const removed = [
      ...reconcileAbortedToolRounds(
        this.messages,
        this.abortedToolRoundStrategy,
        this.abortedToolRoundReason,
      ),
      ...reconcileAbortedMessages(this.messages, this.abortedMessageStrategy),
    ];
    for (const message of removed) this.emit("messageRemoved", { agent: this, message });
  }

  // -------------------------------------------------------------------------
  // 内循环
  // -------------------------------------------------------------------------

  /**
   * 一次请求 + 它引出的工具，循环到「刚才没有工具调用」为止。
   *
   * 续行条件只有一条：**刚才有工具调用**。工具是模型要的，跑完必须把结果再喂回去问一次；
   * 没有工具调用就是这一次说完了。没有第二个判据。
   *
   * **这一次请求不看那个闸**：不取件是队列输出闸的事（`inbox.isOutputPaused`），而闸只在**取件**
   * 那一刻起作用；手上已经取出来的那批算已经开始 —— 它要把这一批跑完，从下一批起才不再取
   * （`CORE.md` §2）。所以下面只判 `killed`：死了才不发请求。要立刻停用 `abort`。
   */
  private async innerLoops(): Promise<void> {
    while (true) {
      if (this.killed) return;

      const ctx = this.buildInnerLoopContext();

      // 钩子排在造 assistant 占位**之前**：拒了就不会留下一条永远 Pending 的幽灵消息
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

      const hadTools = await this.runTurn(assistant, ctx);

      await this.dispatchHook("onInnerLoopEnd", ctx);

      if (!hadTools) return;
      // 唯一的取件点：这一次请求刚收尾（工具结果已进 messages）、下一次还没开始。
      // 内循环只看 high —— 低优先级与钥匙它连看都不看。
      this.landHigh();
    }
  }

  private buildInnerLoopContext(): InnerLoopContext {
    const body = {
      // 先铺模型参数（temperature 等；可含厂商特有字段），再写框架契约 —— **顺序不能反**：
      // model / messages / tools / stream / stream_options 是框架自己保证的，
      // 配置里写同名键也不能把它们改掉（否则 `stream: false` 会直接把流式解析打崩）。
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

      // 厂商的 chunk 类型只描述这层**外壳**：真正被攒进消息的是它里面的那一片增量
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
          // 流式最后一个 chunk 才带 usage：钉到这次回答的 assistant 消息上（与 finish_reason 同处），
          // 使用量随消息持久化，从而可按消息求和统计累计消耗（计费口径）与审计。
          // core 不另存「上一次回答的用量」的快照：要读就读最后一条带 `usage` 的 assistant 消息。
          if (chunk.usage) {
            assistant.usage = chunk.usage as unknown as AgentNS.Usage;
          }

          const choice = chunk.choices?.[0];

          if (choice?.finish_reason) {
            assistant.finish_reason = choice.finish_reason as AgentNS.FinishReason;
          }

          // 只带 usage / finish_reason 的收尾片没有增量可攒（形状比 `AgentNS.Delta` 更宽：
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
        return false;
      }

      assistant.status = AgentNS.MessageStatus.Completed;
      this.emit("responseFinished", { agent: this, message: assistant });

      const hadTools = await this.runTools(assistant, inflight);
      // 跑工具的时候按了中断：这一批到此为止 —— 再向模型要一次，它就会把整段话接着说完，
      // 用户按的那一下等于没按（`abortRx` 只让正在跑的工具立刻返回，不知道之后该不该续）
      return inflight.controller.signal.aborted ? false : hadTools;
    } catch (error) {
      // 被掐断的那一次回答不是「出错」：它有自己的状态，也不报 `failed`
      if (inflight.controller.signal.aborted) {
        assistant.status = AgentNS.MessageStatus.Aborted;
        this.touch(assistant);
        return false;
      }

      const agentError = error instanceof AgentError ? error : new AgentError("stream-failed", String(error));
      assistant.status = AgentNS.MessageStatus.Error;
      // 同一个实例：既挂在这条消息上，也进 `failed` 事件
      assistant.error = agentError;
      this.touch(assistant);
      this.emit("failed", { agent: this, error: agentError, message: assistant });
      return false;
    } finally {
      this.inflight = undefined;
    }
  }

  /** 把任意来路的错误收成 `AgentError`；被掐断的走 `aborted`，不收 */
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
   * 掐在途：`abort()` 与 `kill()` 都走它。
   *
   * 名字留着 —— 它说的是**动作**。而「这一次请求被掐过没有」**不另存一格**：
   * `controller.signal.aborted` 就是那一格，多存一份 `aborted` 迟早会与 controller 不同步。
   */
  private abortTurn(): void {
    this.inflight?.controller.abort();
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  /**
   * 并行跑同一次请求里的多个工具，**按调用顺序落地** tool 消息（不按完成顺序）。
   *
   * 失败即「没给出有效结果」：参数烂、执行挂、工具不存在、钩子拒 —— 同一件事，
   * 一条 tool 消息回给模型，引擎不中断、不重试。
   */
  private async runTools(assistant: Message, inflight: Inflight): Promise<boolean> {
    const calls = (assistant.tool_calls ?? []).filter((tc) => tc.type === "function" && tc.function);
    if (calls.length === 0) return false;

    // 先按调用顺序把 tool 消息建好（Pending）：落地顺序由这里定死，与谁先跑完无关
    const jobs = calls.map((call) => ({ call, result: this.append(Message.Tool(call)) }));

    await Promise.all(jobs.map(({ call, result }) => this.runOneTool(call, result, inflight)));

    return true;
  }

  private async runOneTool(
    call: AgentNS.ToolCall,
    result: Message,
    inflight: Inflight,
  ): Promise<void> {
    this.emit("toolStarted", { agent: this, toolCall: call });

    const matched = this.tools.find(
      (tool) => tool.function.name === call.function?.name && tool.type === "function",
    );

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
    };

    try {
      // ① 钩子拒 —— 停止的两条路之一。
      //    返回的字符串**就是**这条 tool 消息的正文：拒绝理由与「未知工具提示」都要能
      //    直接写给模型读，core 不再在前面加自己的前缀话术。
      const denied = await this.dispatchHook("onToolStart", { agent: this, toolCall: ctx });
      if (denied !== undefined) {
        result.content = denied;
        finalize(AgentNS.MessageStatus.Completed);
        this.emit("denied", {
          agent: this,
          hook: "onToolStart",
          reason: denied,
          detail: { toolCall: call },
        });
      } else if (ctx.parseError) {
        // ② 参数烂 = 没给出有效结果
        result.content = `参数解析错误: ${ctx.parseError}\n请检查你提供的参数格式，确保是合法的 JSON。`;
        finalize(AgentNS.MessageStatus.Completed);
      } else if (!matched) {
        // ③ 工具不存在 = 同一件事。钩子（如果有话要说）已经在上一步给出文案了
        result.content = `未知工具: ${call.function?.name}，没有找到对应的工具实现。`;
        finalize(AgentNS.MessageStatus.Completed);
      } else {
        // ④ 真跑：与 `abortRx` 赛跑 —— 不管工具听不听话，`await` 立刻能返回
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

    // 同位置：钩子在前（还能看一眼结果），事件在后（已经定了）
    await this.dispatchHook("onToolEnd", { agent: this, toolCall: ctx });
    this.emit("toolFinished", { agent: this, toolCall: call, result });
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  /**
   * 换一格（只换 `state` 这一处；取不取件走 `output:paused` / `output:resumed`，
   * 不从这里过）。
   *
   * **没有「重算状态」这一步**，三处置位就够了：`start()` 是 `idle`、外循环头（取到一批）
   * 是 `working`、外循环尾（队列真空了）是 `idle`。`pauseOutput` / `resumeOutput` /
   * `abort` 一格都不置
   * —— 它们只翻那个开关。
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
   * 说「死了」—— `stopped` / `killed` 的**唯一出口**，一个 agent 只说一条。
   *
   * 两处会走到这里：{@link stop} / {@link kill} 本体（没 `start()` 过，外循环永远跑不到出口），
   * 以及外循环出口（存量真的跑完了）。谁先到谁说，第二个到的一声不响。
   *
   * **先把 `state` 直接置成 `idle`，再发事件**：订阅方在 `stopped` / `killed` 回调里读到的
   * `state` 必须已经是死后那一格。反过来的话，它读到的是 `working` —— 会有东西对着一个已经
   * 死透的 agent 去做「等它闲下来」这类决定，而那个闲永远不来。
   *
   * 这里**绕开 `setState`** 是有意的：`setState` 会再发一条 `state:idle`，而「死了」已经由
   * 下面那条事件说了 —— 一个已经不在了的 agent 不该在死后又冒出一格状态。
   *
   * 「事件只发一条」与「状态必须落到 `idle`」是两件事：门关在 `start()` 之前、后来才
   * `start()` 的那种情形（存量还要跑完）走到这里时，事件早发过了，但这一批的尾部仍要
   * 把状态拉回 `idle` —— 否则一个已经死透的 agent 会永远停在 `working` 上。
   */
  private markDead(): void {
    this.state = "idle";
    if (this.deathSaid) return;
    this.deathSaid = true;
    this.emit(this.killed ? "killed" : "stopped", { agent: this });
  }

  // -------------------------------------------------------------------------
  // 等待
  // -------------------------------------------------------------------------

  /**
   * 等到某一格，且（目标为 `idle` 时）**这一批真的跑完了**（`runOnce` 的「等闲」用它）。
   *
   * 为什么「到了那一格」不够：`state` 是循环的位置，`push()` 之后、外循环取到那批之前它
   * **还是 `idle`** —— 只看 `state === "idle"`，`runOnce` 的等待会在这一批还没开始时一步通过，
   * 那就等于没等。所以判据是「`state` 到了目标 **且** 队列里没有压着的条目」：前者说循环停在
   * 那一格，后者说没有还没被取走的货；两条同时成立才是「真的闲下来了」。
   *
   * 什么时候重新判：只有「换格」与「死」这几个时机 —— 批的边界恰好就在它们身上
   *（取到一批 → `working`；这批跑完 → `idle`；死 → `stopped` / `killed`）。排队区自己的变化
   * 不发事件（它是现读的，{@link inboxPending}），所以这里也不订它。
   *
   * 先看当前值再等事件：`once` 型等待在「注册前已经满足」时会永远等不到。
   * `signal` 一响立刻返回 —— 取消不该被一个可能永远不变的状态卡住。
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

  /** 追加一条消息并广播 `messageAdded` —— 广播点放在唯一的追加口上 */
  append(message: AgentNS.Message): AgentNS.Message {
    const appended = super.append(message);
    this.emit("messageAdded", { agent: this, message: appended });
    return appended;
  }

  /** 就地改完之后重发同一条（同 id）：只靠「新增」事件，订阅方会永远停在 `pending` 上 */
  private touch(message: AgentNS.Message): void {
    this.emit("messageChanged", { agent: this, message });
  }

  /** 取走 inbox 里的 high 条目并落成 user 消息（内循环唯一的取件点） */
  private landHigh(): void {
    const entries = this.inbox.takeAll((entry) => entry.priority === "high");
    if (entries.length === 0) return;
    for (const entry of entries) {
      const message = inboxEntryMessage(entry);
      if (message) this.append(message);
    }
    // 与外循环那处同一口径：**落地之后**才报「这些被取走了」
    this.emit("inboxTaken", { agent: this, entries });
  }

  // -------------------------------------------------------------------------
  // 请求体
  // -------------------------------------------------------------------------

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

  /** 一条消息内容发给模型的那一份：字符串原样，数组逐段交给 `formatContentSection` */
  formatContent(content: AgentNS.MessageContent): AgentNS.MessageContent {
    if (!Array.isArray(content)) return content;
    return content.map((section) => this.formatContentSection(section));
  }

  /** 一段内容发给模型的那一份：按段类型取认识的字段重建（内容字段的扩展点） */
  formatContentSection(section: AgentNS.MessageContentSection): AgentNS.MessageContentSection {
    return formatContentSection(section);
  }

  /** 按白名单重排一份历史（只留模型认识的字段，`__` 开头的键一律剥掉） */
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
        name: message.name ?? undefined,
      }));
  }
}
