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
  to: AgentNS.AgentState;
}
export interface InboxAddedEvent {
  agent: Agent;
  entry: AgentNS.InboxEntry;
}
export interface InboxClearedEvent {
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
  state: StateEvent;
  inboxAdded: InboxAddedEvent;
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
  /** 手上正干着活（一批的整个跨度） */
  private busy = false;
  /** 一次性 agent 已经吃过一次投递了（自此关收） */
  private fed = false;

  /** `start()` 的那句 promise：到死才 resolve，且不 reject */
  private runPromise?: Promise<void>;
  /** 当前这一圈的中断装置 */
  private currentTurn?: Turn;
  /** 所有 `waitUntil` 的唤醒器 */
  private waiters: Array<() => void> = [];

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
   * `onSubAgentStart` 拒了就不发 `subAgentStarted` —— 那一次委派本来就没开始。
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
      if (denied === undefined) this.emit("subAgentStarted", payload);
    } else {
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

    this.runPromise = this.loop()
      .catch((error: unknown) => {
        this.emit("failed", { agent: this, error: error as Error });
      })
      .finally(() => {
        this.busy = false;
        this.currentTurn = undefined;
        this.refreshState();
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
    this.notify();
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
    this.notify();
    void this.dispatchHook("onKill", { agent: this });
  }

  /**
   * 暂停：掐掉在途的网络请求与工具。agent 不死，接着等。
   *
   * 幂等；已经关了/死了就是空动作。
   */
  abort(): void {
    if (this.paused || this.killed || this.closed) return;
    this.paused = true;
    this.abortTurn();
    this.refreshState();
    this.notify();
    void this.dispatchHook("onPause", { agent: this });
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
    this.refreshState();
    this.notify();
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
    this.refreshState();
    this.notify();
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
      await this.waitUntil(() => this.state === "idle", options?.signal);
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
    this.refreshState();
    this.notify();
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

  /** 排队中还有几条（宿主显示「待发 N 条」用） */
  get inboxSize(): number {
    return this.inbox.size;
  }

  // -------------------------------------------------------------------------
  // 外循环
  // -------------------------------------------------------------------------

  /**
   * 外循环：等一批事件 → 修历史 → 落地 → 内循环。
   *
   * 用同步的 `takeAll()` 而不是 `asTakeAll()` 的迭代器：迭代器一旦挂起，到货的那批就被它
   * 吞下来了 —— 而暂停要求「不取件」，被吞下来的那一批要么丢了要么得再塞回去（塞回去就
   * 排到了暂停期间后来的条目后面）。同步取件没有这个窗口。
   */
  private async loop(): Promise<void> {
    while (true) {
      await this.waitUntil(() => !this.paused || this.closed || this.killed);
      if (this.shouldDie()) break;

      if (this.inbox.size === 0) {
        await this.waitUntil(() => this.inbox.size > 0 || this.closed || this.killed || this.paused);
        continue;
      }

      this.busy = true;
      this.refreshState();

      const entries = this.inbox.takeAll();
      try {
        await this.runBatch(entries);
      } finally {
        this.busy = false;
        this.refreshState();
      }
    }

    this.emit(this.killed ? "killed" : "stopped", { agent: this });
    this.refreshState();
  }

  /** 一批事件走完一圈 */
  private async runBatch(entries: AgentNS.InboxEntry[]): Promise<void> {
    const ctx: OuterLoopContext = { agent: this, entries };

    // ① 修一遍历史 —— **唯一一次**回头看历史的地方（`CORE.md` §6），在进圈之前
    this.repair();

    // ② 落地：带正文的落一条 user 消息，钥匙什么都不落
    for (const entry of entries) {
      const message = inboxEntryMessage(entry);
      if (message) this.append(message);
    }

    // ③ 内循环
    await this.dispatchHook("onOuterLoopStart", ctx);
    await this.innerLoops();
    await this.dispatchHook("onOuterLoopEnd", ctx);
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
   * 没有工具调用就是这一轮说完了。没有第二个判据。
   */
  private async innerLoops(): Promise<void> {
    while (true) {
      if (this.paused || this.killed) return;

      const ctx = this.buildInnerLoopContext();

      // 钩子排在造 assistant 占位**之前**：拒了就不会留下一条永远 Pending 的幽灵消息
      const denied = await this.dispatchHook("onInnerLoopStart", ctx);
      if (denied !== undefined) {
        this.emit("denied", { agent: this, hook: "onInnerLoopStart", reason: denied });
        return;
      }
      if (this.paused || this.killed) return;

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
   * 按「忙 / 闲 / 暂停」重算一次。
   *
   * **闲 = 队列空 且 不忙**。中间那一拍（手上没活、但队列里还压着）不报闲 —— 否则等在外面的
   * 子 agent 会在半截处收走结果。暂停压过一切：暂停时队列里有没有货都显示暂停。
   */
  private refreshState(): void {
    if (this.paused) return this.setState("paused");
    const working = this.runPromise !== undefined && (this.busy || this.inbox.size > 0);
    this.setState(working ? "busy" : "idle");
  }

  private setState(next: AgentNS.AgentState): void {
    const from = this.state;
    if (from === next) return;
    this.state = next;
    this.emit("state", { agent: this, from, to: next });
    if (next === "idle") void this.dispatchHook("onIdle", { agent: this });
    this.notify();
  }

  /** 死透了吗：被硬杀，或者关了门且排空了 */
  private shouldDie(): boolean {
    if (this.killed) return true;
    if (!this.closed) return false;
    // 暂停中 `stop`：不跑 + 关门，存量作废（`clearInbox` 已在 stop 里做过）
    return this.inbox.size === 0 || this.paused;
  }

  // -------------------------------------------------------------------------
  // 等待
  // -------------------------------------------------------------------------

  /** 等到 `predicate` 成立；`signal` 一响就立刻返回（不等对方听不听话） */
  private async waitUntil(predicate: () => boolean, signal?: AbortSignal): Promise<void> {
    while (!predicate()) {
      if (signal?.aborted) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          const i = this.waiters.indexOf(done);
          if (i >= 0) this.waiters.splice(i, 1);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        this.waiters.push(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  /** 把所有人的等待放行一次，让他们各自重算 `predicate` */
  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
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
    this.refreshState();
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
