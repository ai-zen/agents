import AsyncQueue from "@ai-zen/async-queue";
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

/** 钩子统一返回值：返回 string = 拒（这一圈/这次调用不跑），返回 undefined/void = 放行 */
export type HookResult = string | void | Promise<string | void>;

/** 外循环一圈的上下文（这一批事件） */
export interface OuterLoopContext {
  agent: Agent;
  /** 这一圈取到的这批条目（可能含只拧钥匙不带正文的） */
  entries: AgentNS.InboxEntry[];
}

/**
 * 内循环一圈的上下文。
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
 * 重开一轮」要先拿到 agent）。不带就得先去别的钩子里「认领」一个，那是多余的中间态。
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
 * 子 agent 不是一段会话、不入库，跑完就散；但「这段对话派过几个子 agent、它们各自说了什么」
 * 必须答得出来。所以派遣时在父身上留这一项，要查子 agent 说过的话就顺
 * 「父的名册 → `agent` → 它的 `messages`」取 —— 那些话只在**子 agent 自己那个对象**里。
 *
 * `agent` 是**活引用**（和事件里带出去的是同一个东西，不是拷贝）：它就是那一栏消息的唯一真相。
 * 于是这一项不能序列化、不能进库 —— 与 `source` 里不许放 `Agent` 引用是同一条理由。
 */
export interface SubAgentEntry {
  /** 委派那次工具调用的 id：客户端据此把子 agent 的话分到那一栏（§10） */
  toolCallId: string;
  /** 被委派的那个 agent 本身（活引用） */
  agent: Agent;
  /**
   * 这次委派用的工具名（= 模型调用的那个委派工具的名字）。
   *
   * core 只认识这一个「名字」：子 agent 的助手名在助手定义里，那是外部的财产（`buildAgent`
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
 * | `onStart` / `onPause` / `onResume` / `onIdle` / `onStop` / `onKill` | 不能 | 死活与状态的边 |
 * | `onOuterLoopStart` / `onOuterLoopEnd` | 不能 | 一圈的开始 / 结束 |
 * | `onInnerLoopStart` | **能拒** | 排在造 assistant 占位**之前**，拒了历史里一个字都不多 |
 * | `onInnerLoopEnd` | 不能 | 一圈结束 |
 * | `onToolStart` | **能拒** | 拒了就是「这个工具没给出有效结果」，原因作为 tool 消息回给模型 |
 * | `onToolEnd` | 不能 | 工具跑完了 |
 * | `onSubAgentStart` | **能拒** | 拒了这次委派不跑 |
 * | `onSubAgentEnd` | 不能 | 委派结束（子 agent 已经跑完，撤不回来了） |
 *
 * `onOuterLoopStart` **不能拒**：此刻这一批已经从队列里取出来了，拒了这批就没主了。
 * 「要不要处理这一批」的判决应该发生在投递之前 —— 投了就得有人跑。
 */
export interface AgentPlugin {
  onInit?(): HookResult;
  onStart?(ctx: LifecycleContext): HookResult;
  onPause?(ctx: LifecycleContext): HookResult;
  onResume?(ctx: LifecycleContext): HookResult;
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
export interface InboxAddedEvent {
  agent: Agent;
  entry: AgentNS.InboxEntry;
}
export interface InboxClearedEvent {
  agent: Agent;
  entries: AgentNS.InboxEntry[];
}
/**
 * 这些条目**已经离开队列**（被取走了），并且它们该落的消息已经落好了。
 *
 * 为什么取走也要说一声：持久化要求「inbox 一有变化就入库」。只报进队不报取走的话，
 * 宿主只能靠快照覆盖，那就不再实时了；而靠增量又必然对不上（钥匙被取走完全无声）。
 *
 * 为什么排在落地**之后**：崩溃点若落在两者之间，
 * - 「消息已落、条目还在」→ 恢复时按 `messageId` 去重就能收拾（可救）；
 * - 反过来「条目没了、消息没落」→ 那条话凭空消失（不可救）。
 */
export interface InboxTakenEvent {
  agent: Agent;
  entries: AgentNS.InboxEntry[];
}
export interface MessageEvent {
  agent: Agent;
  message: AgentNS.Message;
  /** 这条消息属于某个子 agent（委派工具转发上来时才有） */
  subAgent?: Agent;
  /** 是哪一次委派引起的（与 `subAgent` 同现） */
  via?: AgentNS.ToolCall;
}
/**
 * 原始片的来源。三格让接收方直接知道往哪儿放：
 * 自己的消息、某个子 agent 的、还是子 agent 某个工具调用里的。
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
  /** 这个工具跑在某个子 agent 里（委派工具转发上来时才有） */
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
  "state:busy": StateEvent;
  "state:paused": StateEvent;
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
 * 能拒的钩子。它们崩了要**fail-closed** —— 坏的护栏放行等于没有护栏。
 * 其余位置崩了当没说话（fail-open），只为不把 agent 打死。
 */
const GATE_HOOKS = new Set<string>(["onInnerLoopStart", "onToolStart", "onSubAgentStart"]);

/** 当圈的中断装置：寿命**只到这一圈**，下一圈是全新的 */
interface Turn {
  controller: AbortController;
  /** `Promise.race` 的伙伴：不管对方听不听话，`await` 立刻返回 */
  abortRx: Promise<void>;
  aborted: boolean;
}

export class Agent extends AgentContext {
  /** 三格：忙 / 闲 / 暂停（语义见 `AgentNS.AgentState`） */
  state: AgentNS.AgentState = "idle";

  private _plugins: AgentPlugin[] = [];
  private bus = new EventBus();
  /** 唯一的一条队列。钥匙也在里面，只是它没有正文 */
  private inbox = new AsyncQueue<AgentNS.InboxEntry>();

  /** `stop()` 调过：关门，不再接输入，存量走完才死 */
  private closed = false;
  /** `kill()` 调过：硬着陆，存量作废 */
  private killed = false;
  /** 暂停中：不取件、不开新圈 */
  private paused = false;
  /** 暂停那道闸：`resume` 放行它，`stop` / `kill` 也放行它 */
  private resumeTx?: () => void = undefined;
  private resumeRx: Promise<void> = new Promise<void>((tx) => (this.resumeTx = tx));
  /** 一次性 agent 已经吃过一次投递了（自此关收） */
  private fed = false;

  /** `start()` 的那句 promise：到死才 resolve，且不 reject */
  private runPromise?: Promise<void>;
  /** 当前这一圈的中断装置 */
  private currentTurn?: Turn;

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
   * 公开是因为委派工具要把子 agent 的事件**按同一套名字**发到父身上（§9-3）：
   * 不为子 agent 另起一套平行名字，只多「哪个子 agent + 哪个工具调用」两格。
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
   * 按注册顺序跑钩子，任一返回 string 即短路并返回该字符串。
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
    const isGate = GATE_HOOKS.has(hook as string);

    for (const plugin of this._plugins) {
      const fn = (plugin as Record<string, unknown>)[hook as string];
      if (typeof fn !== "function") continue;

      try {
        const r = await (fn as (ctx?: unknown) => HookResult).call(plugin, ctx);
        if (r !== undefined) return r;
      } catch (error) {
        // 插件抛错**不许把 agent 打死**：异常会一路穿出 `start()`，循环就永久停在那儿，
        // 而且 `closed` / `killed` 都还是 false —— 一个看起来活着、塞进去也不动的僵尸。
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.emit("failed", { agent: this, error: wrapped });

        // 门（能拒的那三个）崩了就关上：坏的护栏不该放行。
        // 其余位置当它没说话，接着问下一个插件。
        if (isGate) return `插件 ${String(hook)} 抛错：${wrapped.message}`;
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
   * 幂等：重复调返回同一句 promise。失败不终结 agent —— 一轮请求挂了就是一轮挂了，
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
        this.currentTurn = undefined;
      });

    this.emit("started", { agent: this });
    void this.dispatchHook("onStart", { agent: this });
    return this.runPromise;
  }

  /**
   * 关门：不再接输入，**存量走完**，排空才死（血流干的死）。
   *
   * 暂停中调它就是「不跑 + 关门，存量作废」—— 暂停说的是「现在别跑」，stop 说的是
   * 「以后也别跑」，两句叠起来就是不跑。不解除暂停再跑一遍存量，因为那等于用户按了
   * 暂停却看见它又开口。
   */
  stop(): void {
    if (this.closed || this.killed) return;
    this.closed = true;
    if (this.paused) this.clearInbox();
    this.inbox.done();
    this.openGate(); // 关门就是「别再等了」：别把循环留在暂停闸上
    void this.dispatchHook("onStop", { agent: this });
  }

  /** 硬着陆：立刻死，存量作废 */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.closed = true;
    this.clearInbox();
    this.inbox.done();
    this.abortTurn();
    this.openGate();
    void this.dispatchHook("onKill", { agent: this });
  }

  /**
   * **优雅暂停**：只挂闸，不掐在途。
   *
   * 手上这批算已经开始 —— 让它跑完，从下一批起不再取。要立刻停就用 `abort`。
   * 幂等；已经关了/死了就是空动作。
   */
  suspend(): void {
    if (this.killed || this.closed || this.paused) return;
    this.paused = true;
    this.setState("paused");
    void this.dispatchHook("onPause", { agent: this });
  }

  /**
   * **暴力中断**：掐掉在途的请求与工具，并且**必然伴随暂停**。
   *
   * 掐完不能再往下走，所以它顺带就是 `suspend()`；反过来暂停不必中断。
   */
  abort(): void {
    if (this.killed || this.closed) return;
    this.suspend();
    this.abortTurn();
  }

  /**
   * 解除暂停。**只置意愿、不立刻取件** —— 等这一圈收完，外循环自然回到顶部再看队列。
   *
   * 为什么不在这里顺手取件：用户手快连点 `abort`/`resume` 时这一圈还在收尸，
   * 此刻去取件就变成两个东西同时写 `messages`。
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.setState("idle");
    this.openGate();
    void this.dispatchHook("onResume", { agent: this });
  }

  // -------------------------------------------------------------------------
  // 投递：push / send / runOnce
  // -------------------------------------------------------------------------

  /**
   * 塞进 inbox，立刻返回。
   *
   * **关门之后抛 `AgentError("closed")`**，不静默丢：塞的人可能是另一个 agent，
   * 他得知道自己投失败了才能改投（宿主接住这个错，就去做「新装一个再投」）。
   *
   * 不给 `input`（或给一个没有正文的）= 拧钥匙：只把这一圈叫起来，不落地任何消息。
   */
  push(input?: AgentNS.InboxInput): void {
    if (this.closed || this.killed) {
      throw new AgentError("closed", `往已经关了的 agent(${this.id}) 投递`);
    }
    // 一次性 agent 只有一条因果链：发起它的那一次投递。之后关收，
    // 别人塞进来的东西会让「等闲」重新变成瞎等（`CORE.md` §1）。
    if (this.lifetime === "one-shot") {
      if (this.fed) {
        throw new AgentError("closed", `一次性 agent(${this.id}) 只接受第一次投递`);
      }
      this.fed = true;
    }

    const entry: AgentNS.InboxEntry =
      input?.content === undefined
        ? { createdAt: new Date().toISOString(), priority: "low", content: undefined }
        : {
            messageId: input.messageId ?? this.newMessageId(),
            createdAt: new Date().toISOString(),
            priority: input.priority,
            source: input.source,
            content: input.content,
          };

    this.inbox.push(entry);
    this.emit("inboxAdded", { agent: this, entry });
  }

  /**
   * 跑一次到死：起 → 塞 → 等闲 → 关门 → 死透 → 交回消息。
   *
   * **不是第六个死活动作**，是 `start` / `send` / `stop` 的复合，只是把一次性会话那几步
   * 收成一句。跑完之后这个 agent 就没了（死了就死透，复活 = 新建）。
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
    if (input?.content === undefined && this.messages.length === 0) {
      throw new Error("runOnce() 时 messages 是空的：没有燃料，拧钥匙只会发一个空请求");
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
      this.push(input);
      await this.waitForState("idle", options?.signal);
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
   * 清空 inbox 并返回被丢掉的条目。core 自己从不主动调它 ——「作废排队」是调用方的
   * 显式决定，不该由「用户按了停」替它猜（唯一例外：暂停中 `stop` / `kill`）。
   */
  clearInbox(): AgentNS.InboxEntry[] {
    const entries = this.inbox.takeAll();
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

  /** 谁在调我。只有委派造出来的子 agent 有；活引用，不许进 `source`（§3） */
  parent?: Agent;

  /** 我造出来、还活着的子 agent（收尸时摘掉） */
  readonly children = new Set<Agent>();

  /**
   * 子 agent 的名册：**只给外面读**（`CORE.md` §17）。
   *
   * 三个时刻：派遣时加一项、结束时把 `endedAt` 填上（不移除）、外循环每一批的开头清空上一批。
   *
   * 三条纪律：
   * - **它不参与任何内部判断**：内循环、取件、续圈、状态三格、中断都不看它。清空点选在哪儿
   *   因此不影响正确性，只影响「外面什么时候读到空」；
   * - **它是名册，不是消息的唯一真相**：子 agent 说过的话在 `entry.agent.messages` 里，
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
   * 为什么要有它：`inboxAdded` / `inboxCleared` 是「通知」，不是唯一信息源。宿主只靠
   * 通知自建镜像的话，丢一条就与真队列永久分叉 —— 而它又没法重读自愈。有了这个，
   * §10 那句「事件只是通知」才真的成立。
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
   * 暂停那道闸等两处（进来之前一次、每批尾部一次）：于是批与批之间不取件，暂停期间到达的
   * 货就躺在队列里 —— 界面看得见条数、能持久化、恢复能捞回来。
   *
   * **手上已取出的那批算已经开始**：优雅暂停从下一批生效，不把它收回 —— 它可能已经落了
   * 消息、跑了一半工具，塞回队头只会造成重复落地。要立刻停就用 `abort`。
   */
  private async outerLoop(): Promise<void> {
    await this.pauseGate();

    for await (const entries of this.inbox.asTakeAll()) {
      // 名册的清空点：外循环每一批的开头（上一批的子 agent 到这儿就不再登记，`CORE.md` §17）。
      // 放在这里是因为它是**这批活的开头**，而且是唯一一个「上一批已经彻底跑完、这批还没动」
      // 的时刻。它只是给外面读的便利 —— 下面没有任何一行代码回头看这份名册。
      this.subAgentRegistry.length = 0;

      this.setState("busy");

      // ① 修一遍历史 —— **唯一一次**回头看历史的地方（`CORE.md` §6），在进圈之前
      this.repair();

      // ② 落地：带正文的落一条 user 消息，钥匙什么都不落
      for (const entry of entries) {
        const message = inboxEntryMessage(entry);
        if (message) this.append(message);
      }
      // 落地完了才报「这些已经离开队列」（理由见 `InboxTakenEvent`）
      this.emit("inboxTaken", { agent: this, entries });

      // ③ 内循环
      const ctx: OuterLoopContext = { agent: this, entries };
      await this.dispatchHook("onOuterLoopStart", ctx);
      await this.innerLoops();
      await this.dispatchHook("onOuterLoopEnd", ctx);

      // 只有真的空了才叫「闲」—— 手上没活但队列还压着不算
      if (this.inbox.size === 0 && !this.paused && !this.closed && !this.killed) {
        this.setState("idle");
      }

      await this.pauseGate();
    }

    this.emit(this.killed ? "killed" : "stopped", { agent: this });
    this.setState(this.paused ? "paused" : "idle");
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
   * **这一圈不看暂停**：暂停只在批边界生效（`outerLoop` 那两处 `pauseGate`），而手上已经
   * 取出来的那批算已经开始 —— 它要把这一批跑完，从下一批起才不再取（`CORE.md` §2）。
   * 所以下面只判 `killed`：死了才不发请求。要立刻停用 `abort`。
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
      // 唯一的取件点：这一圈刚收尾（工具结果已进 messages）、下一圈还没开始。
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

  /** 这一圈：发请求 → 收流 → 跑工具。返回「刚才有没有工具调用」 */
  private async runTurn(assistant: Message, ctx: InnerLoopContext): Promise<boolean> {
    const turn = this.newTurn();
    this.currentTurn = turn;

    try {
      this.emit("requestSent", { agent: this, body: ctx.body });

      let stream: AsyncIterable<ChatCompletionChunk>;
      try {
        stream = (await this.client.chat.completions.create(ctx.body as any, {
          signal: turn.controller.signal,
        })) as unknown as AsyncIterable<ChatCompletionChunk>;
      } catch (error) {
        throw this.toAgentError(error, "request-failed", turn);
      }

      assistant.status = AgentNS.MessageStatus.Writing;

      try {
        for await (const chunk of stream) {
          this.emit("delta", { agent: this, chunk, source: { message: assistant } });
          applyChunk(assistant, chunk);
        }
      } catch (error) {
        throw this.toAgentError(error, "stream-failed", turn);
      }

      if (turn.aborted) {
        assistant.status = AgentNS.MessageStatus.Aborted;
        return false;
      }

      assistant.status = AgentNS.MessageStatus.Completed;
      this.emit("responseFinished", { agent: this, message: assistant });

      return await this.runTools(assistant, turn);
    } catch (error) {
      // 被掐断的那一轮不是「出错」：它有自己的状态，也不报 `failed`
      if (turn.aborted) {
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
      this.currentTurn = undefined;
    }
  }

  /** 把任意来路的错误收成 `AgentError`；被掐断的走 `aborted`，不收 */
  private toAgentError(error: unknown, code: "request-failed" | "stream-failed", turn: Turn): unknown {
    if (turn.aborted) return error;
    if (error instanceof AgentError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new AgentError(code, message, { cause: error });
  }

  /** 这一圈的中断装置：全新的 controller + `abortRx`，寿命只到这一圈 */
  private newTurn(): Turn {
    const controller = new AbortController();
    const turn: Turn = {
      controller,
      aborted: false,
      abortRx: new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    };
    return turn;
  }

  private abortTurn(): void {
    const turn = this.currentTurn;
    if (!turn) return;
    turn.aborted = true;
    turn.controller.abort();
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  /**
   * 并行跑同一圈里的多个工具，**按调用顺序落地** tool 消息（不按完成顺序）。
   *
   * 失败即「没给出有效结果」：参数烂、执行挂、工具不存在、钩子拒 —— 同一件事，
   * 一条 tool 消息回给模型，引擎不停圈、不重试。
   */
  private async runTools(assistant: Message, turn: Turn): Promise<boolean> {
    const calls = (assistant.tool_calls ?? []).filter((tc) => tc.type === "function" && tc.function);
    if (calls.length === 0) return false;

    // 先按调用顺序把 tool 消息建好（Pending）：落地顺序由这里定死，与谁先跑完无关
    const jobs = calls.map((call) => ({ call, result: this.append(Message.Tool(call)) }));

    await Promise.all(jobs.map(({ call, result }) => this.runOneTool(call, result, turn)));

    return true;
  }

  private async runOneTool(call: AgentNS.ToolCall, result: Message, turn: Turn): Promise<void> {
    this.emit("toolStarted", { agent: this, toolCall: call });

    const matched = this.tools.find(
      (tool) => tool.function.name === call.function?.name && tool.type === "function",
    );

    const ctx = new ToolCallContext({
      agent: this,
      tool_call: call,
      tool: matched,
      resultMessage: result,
      signal: turn.controller.signal,
    });

    /** 定型：先改状态并重发这条消息。`toolFinished` 要等到 `onToolEnd` **之后**才发（钩子在前） */
    const finalize = (status: AgentNS.MessageStatus) => {
      result.status = turn.aborted ? AgentNS.MessageStatus.Aborted : status;
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
          turn.abortRx.then(() => undefined),
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
   * 换一格。
   *
   * **没有「重算状态」这一步**，五处置位就够了：`start()` 是闲、投递（有货就是忙）与外循环头
   * 是忙、外循环尾（队列真空了且没暂停）是闲、`suspend` / `abort` 是暂停、`resume` 还给闲。
   *
   * 事件按到达值分名（`state:idle` / `state:busy` / `state:paused`）—— 于是「等到某一格」
   * 就是 `events.promise("state:idle")`，不需要再维护一套条件变量。
   */
  private setState(next: AgentNS.AgentState): void {
    const from = this.state;
    if (from === next) return;
    this.state = next;
    this.emit(`state:${next}` as const, { agent: this, from });
    if (next === "idle") void this.dispatchHook("onIdle", { agent: this });
  }

  // -------------------------------------------------------------------------
  // 等待
  // -------------------------------------------------------------------------

  /**
   * 暂停那道闸：暂停中就挂在这儿，`resume` / `stop` / `kill` 都能放行它。
   *
   * 只认 `resume` 会在「暂停中 stop」时死锁 —— 循环挂在一个永远不来的恢复上。
   */
  private pauseGate(): Promise<void> {
    return this.paused ? this.resumeRx : Promise.resolve();
  }

  /** 放行闸，并换上一条新的（下一轮暂停才有得挂） */
  private openGate(): void {
    this.resumeTx?.();
    this.resumeRx = new Promise<void>((tx) => (this.resumeTx = tx));
  }

  /**
   * 等到某一格（`runOnce` 的「等闲」用它）。
   *
   * 先看当前值再等事件：`once` 型等待在「注册前已经满足」时会永远等不到。
   * `signal` 一响立刻返回 —— 取消不该被一个可能永远不变的状态卡住。
   */
  private waitForState(target: AgentNS.AgentState, signal?: AbortSignal): Promise<void> {
    if (this.state === target) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        subscription.dispose();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const subscription = this.bus.once(`state:${target}`, finish);

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
  private landHigh(): boolean {
    const entries = this.inbox.takeAll((entry) => entry.priority === "high");
    if (entries.length === 0) return false;
    for (const entry of entries) {
      const message = inboxEntryMessage(entry);
      if (message) this.append(message);
    }
    this.emit("inboxTaken", { agent: this, entries });
    return true;
  }

  /**
   * 最近一次 API 响应的 token 用量。
   *
   * **派生值，不是独立状态**：取 `messages` 中最近一条未 `omit`、带 `usage` 的 assistant
   * 消息。用量本就随消息持久化，此处只是读最后一条。
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
