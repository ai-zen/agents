/**
 * 运行层用例共用的脚手架：假时钟、记账式消息仓储、假 Scope 插件、假 agent。
 *
 * 这里**不调模型**，也不碰真实工作目录：一轮对话里真正属于 core 的那部分（`applyChunk`
 * 攒消息、`sumUsage` 求和、`reconcile*` 修复）在用例里都调用 core 本体，只有「流从哪来」
 * 换成了脚本 —— 于是用例验证的是本包接线是否正确，而不是 core 的算法。
 *
 * 本文件只被 `*.test.ts` import（`tsconfig.json` 把它排除在产物之外）。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import {
  AgentNS as AgentNSValue,
  applyChunk,
  generateMessageId,
  inboxEntryContent,
  Message,
  type SubAgentContext,
  type ToolCallEndContext,
} from "@ai-zen/agents-core";
import type { AppConfig, ScopePlugin } from "@ai-zen/agents-sdk";
import { Scope } from "@ai-zen/agents-sdk";

import type { MessageUpsertInput, StoredMessage } from "../storage/types.js";
import type { ChatAgent, MessageStore } from "./ChatRunner.js";
import type { Clock } from "./ScopeRegistry.js";

// ---------------------------------------------------------------------------
// 假时钟
// ---------------------------------------------------------------------------

/**
 * 手动推进的时钟：`advance(ms)` 依次执行到点的定时器。
 *
 * 时间可注入之后，「等十分钟」「等节流点」这些事在用例里都是一句 `advance(...)`。
 * 注意：Scope 的回收**不再**用它（空闲计时已撤），但 `RunRegistry`、写库节流与
 * 若干用例自己的计时期待仍然要一份可控时间。
 */
export class ManualClock implements Clock {
  private current: number;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; handler: () => void }>();

  constructor(start = Date.UTC(2026, 0, 1, 0, 0, 0)) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(handler: () => void, ms: number): () => void {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.current + Math.max(0, ms), handler });
    return () => {
      this.timers.delete(handle);
    };
  }

  /** 推进时间：到点的定时器按时间顺序执行（执行中新排的也一并考虑） */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      const next = due[0];
      if (!next) break;
      const [handle, timer] = next;
      this.timers.delete(handle);
      this.current = Math.max(this.current, timer.at);
      timer.handler();
    }
    this.current = target;
  }

  /** 挂着的定时器数量（断言「计时被取消了」用） */
  pending(): number {
    return this.timers.size;
  }
}

/** 让一轮「立刻返回的 Promise」都跑完（用例里等后台任务推进到下一个 await 点用） */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 一个可从外部结算的 Promise */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// 假 Scope（真 `Scope` + 记账式插件）
// ---------------------------------------------------------------------------

/** 能当 AppConfig 用的最小配置（Scope 只把它装进去，插件才发现能力） */
export function minimalConfig(): AppConfig {
  return { endpoints: [], models: [] };
}

/**
 * 记账式能力插件：`dispose()` 就是「MCP 关闭回调」的位置。
 *
 * 用真 `Scope` 装它，于是 `Scope.dispose()` → 各插件逆序 `dispose()` 这条链路是真的，
 * 只是最后一跳换成了计数器。
 */
export class RecordingScopePlugin implements ScopePlugin {
  readonly id = "recording";
  discoverCalls = 0;
  disposeCalls = 0;

  async discover(): Promise<void> {
    this.discoverCalls += 1;
  }

  candidates(): { tools: string[]; skills: string[]; mcps: string[]; subagents: string[] } {
    return { tools: [], skills: [], mcps: [], subagents: [] };
  }

  instantiate(): [] {
    return [];
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

/** 造一个真 Scope（cwd 显式给，不读进程目录） */
export function createFakeScope(cwd = "/tmp/ai-zen-ws"): {
  scope: Scope;
  plugin: RecordingScopePlugin;
} {
  const plugin = new RecordingScopePlugin();
  const scope = new Scope({ getConfig: () => minimalConfig(), agentsDir: `${cwd}/agents`, cwd });
  scope.use(plugin);
  return { scope, plugin };
}

// ---------------------------------------------------------------------------
// 记账式消息仓储
// ---------------------------------------------------------------------------

/**
 * 内存里的消息仓储：每次 `upsert` 都留一份快照。
 *
 * 「边流边写」要看的是**写进去的行内容随流增长**，所以记的是每一笔写，而不是最后一笔。
 */
export class RecordingMessageStore implements MessageStore {
  private readonly rows = new Map<string, { row: MessageUpsertInput; order: number }>();
  private nextOrder = 1;
  /** 每一笔写（按发生顺序） */
  readonly writes: MessageUpsertInput[] = [];

  async upsert(input: MessageUpsertInput): Promise<void> {
    this.writes.push(cloneRow(input));
    const existing = this.rows.get(input.id);
    this.rows.set(input.id, { row: cloneRow(input), order: existing?.order ?? this.nextOrder++ });
  }

  async upsertMany(inputs: MessageUpsertInput[]): Promise<void> {
    for (const input of inputs) await this.upsert(input);
  }

  async listByConversation(
    conversationId: string,
    after?: string,
    options: { includeHidden?: boolean } = {},
  ): Promise<StoredMessage[]> {
    const ordered = [...this.rows.values()]
      .filter((entry) => entry.row.conversationId === conversationId)
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.row)
      // 与真仓储同一个口径：`data.hidden` 为真的消息默认不返回
      .filter((row) => options.includeHidden === true || row.data?.hidden !== true);
    const anchorIndex = after ? ordered.findIndex((row) => row.id === after) : -1;
    const visible = anchorIndex >= 0 ? ordered.slice(anchorIndex) : ordered;
    return visible.map((row, index) => toStored(row, index + 1));
  }

  /** 某条消息当前的库内样子 */
  peek(id: string): MessageUpsertInput | undefined {
    const entry = this.rows.get(id);
    return entry ? cloneRow(entry.row) : undefined;
  }

  /** 某条消息的全部写入快照（按顺序） */
  historyOf(id: string): MessageUpsertInput[] {
    return this.writes.filter((row) => row.id === id);
  }

  /** 直接落一行（模拟「上一次进程崩在写的时候」） */
  seed(row: MessageUpsertInput): void {
    void this.upsert(row);
  }
}

function cloneRow(row: MessageUpsertInput): MessageUpsertInput {
  return {
    ...row,
    content: row.content === undefined ? undefined : structuredClone(row.content),
    data: row.data === undefined ? undefined : structuredClone(row.data),
  };
}

function toStored(row: MessageUpsertInput, seq: number): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq,
    parentToolCallId: row.parentToolCallId ?? null,
    role: row.role,
    status: row.status,
    omit: row.omit === true,
    content: (row.content ?? null) as StoredMessage["content"],
    data: (row.data ?? null) as StoredMessage["data"],
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// 假 agent
// ---------------------------------------------------------------------------

/** core 广播的原始 chunk 的形状（`applyChunk` 的第二个参数） */
type StreamChunk = Parameters<typeof applyChunk>[1];

/** 造一片流（形状与 openai 的 chunk 一致，只填本包用得到的字段） */
function toChunk(delta: AgentNS.Delta, usage?: AgentNS.Usage): StreamChunk {
  return { choices: [{ index: 0, delta, finish_reason: null }], usage } as unknown as StreamChunk;
}

/** 只带 usage 的收尾片（真流的形状：`choices` 为空） */
function usageChunk(usage: AgentNS.Usage): StreamChunk {
  return { choices: [], usage } as unknown as StreamChunk;
}

/** 一轮内循环要吐的东西 */
export interface FakeRound {
  /** 请求「发出」后可等这个 Promise（用例借此在「等首字」处插中止、或断言中间态） */
  gate?: Promise<void>;
  /** 依次吐出的增量（每片一次 `chunk-parsed`） */
  deltas?: AgentNS.Delta[];
  /** 收尾片带的用量（会经 `applyChunk` 钉到消息上） */
  usage?: AgentNS.Usage;
  /** 这一轮模型要求的工具调用；给了就进「等工具」并再跑一轮 */
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>;
  /** 工具结果定型前等这个（用例在「等工具」处插中止） */
  toolGate?: Promise<void>;
  /** 工具结果消息上记的子 Agent 用量（模拟一次委派） */
  toolSubAgentUsage?: AgentNS.Usage;
  /** 这一轮的第一个工具是子 Agent 委派：给个名字与它的消息（`sub-agent-start/end` 两个钩子） */
  subAgent?: {
    name: string;
    messages: AgentNS.Message[];
    /**
     * 子 Agent 「说」的正文片（每片推一次 `chunk-parsed`）。
     *
     * 它是宿主把子 Agent 的话转给客户端的唯一来源：没有这一项，用例就只能看到
     * 「开始 / 结束」两个钩子，看不到任何内容。
     */
    stream?: string[];
  };
}

/** 最小事件总线（形状与 core 的 `EventBus` 一致，只用 on / emit） */
export class RecordingEventBus {
  private readonly handlers = new Map<string, Array<(...args: never[]) => void>>();

  on(name: string, handler: (...args: never[]) => void): () => void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
    return () => {
      this.handlers.set(
        name,
        (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler),
      );
    };
  }

  emit(name: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(name) ?? [])]) {
      handler(...(args as never[]));
    }
  }
}

/**
 * 假 agent：把 core 在 `send()` 里做的事按同一顺序演一遍（追加用户消息 → 追加助手占位 →
 * `open` → 每片 `chunk-parsed` → 工具消息 → `tool-call-end`），攒消息用的是 core 的
 * `applyChunk`，于是 ChatRunner 看到的事件序列与真 agent 一致。
 *
 * `inbox` 也按 core 的语义做（`deliver` 投、轮末 `drainInbox` 落成 `Message.User`）：
 * 宿主跑中发送那一半就是靠它验的。做成「记一笔就算收到」的假件，用例断的是假货。
 */
export class FakeAgent implements ChatAgent {
  messages: AgentNS.Message[] = [];
  readonly events = new RecordingEventBus();
  sendCalls = 0;
  abortCalls = 0;
  aborted = false;
  /**
   * core 的段状态（`AgentNS.RunStatus`），按同一套语义演练：
   *
   *   - `send()` 起一段 → `running`，跑完回 `idle`；
   *   - `abort()` 把状态推成 `stopping`（跑中）/ `terminated`（静止时按停是一跳）；
   *   - 被叫停的那一段收尾时落 `terminated`，下一次 `send()` 从 `terminated` 解冻。
   *
   * 宿主不看它（`ChatAgent` 上没有这个字段），用例看它 —— 「常驻之后 agent 的状态还对不对」
   * 只能落在这个字段上。
   */
  runStatus: AgentNS.RunStatus = "idle";
  /**
   * 排队待发的内容（core 的 `Agent.inbox` 同一份形状）。
   *
   * 宿主只读它（`RunState.inbox`），写入走 {@link deliver} —— 与真 Agent 一样。
   */
  inbox: AgentNS.InboxEntry[] = [];
  /**
   * 每一次「请求」发出前的消息列表快照。
   *
   * 模型看到的就是这个列表的前身（core 在 `formatHistory()` 之前手里那份），所以「下一次请求
   * 里带着那条排队的消息吗」这个断言只能落在它上面。
   */
  readonly requests: AgentNS.Message[][] = [];
  /** `send` 期间的一个钩子（用例在这里推进假时钟、或改脚本） */
  beforeSend?: () => void;

  constructor(private readonly rounds: FakeRound[] = [], options: { system?: string } = {}) {
    if (options.system !== undefined) this.messages.push(Message.System(options.system));
  }

  append(message: AgentNS.Message): AgentNS.Message {
    this.messages.push(message);
    // core 在唯一的追加口上广播 `message`（ChatRunner 靠它认领 id）
    this.events.emit("message", message);
    return message;
  }

  /**
   * core 的 `deliver`：缺 id / 时间就地补，入队，广播 `inbox`；两种入参都收（一条拿一个回执，
   * 一批拿等长的数组），与 core 同形。
   *
   * 回执的 `woke` 恒为 `false`：本假件不是真 Agent，没有「段」这回事（它的单飞由
   * {@link FakeAgent.aborted} 一个布尔量演着）。宿主不看这个字段，所以这里不假装。
   *
   * 一批形态也只是逐条入队：假件没有「段」，也就没有「全部入队之后只唤醒一次」里的那个唤醒；
   * 宿主侧要的只是「这一批条目进队列了」，那一条这里演得准。真 Agent 那一路由
   * `ChatRunner.selfStart.test.ts` / `ChatRunner.deliver.test.ts` 用真 core `Agent` 钉。
   */
  deliver(input: AgentNS.InboxInput): AgentNS.DeliveryReceipt;
  deliver(inputs: AgentNS.InboxInput[]): AgentNS.DeliveryReceipt[];
  deliver(
    input: AgentNS.InboxInput | AgentNS.InboxInput[],
  ): AgentNS.DeliveryReceipt | AgentNS.DeliveryReceipt[] {
    const inputs = Array.isArray(input) ? input : [input];
    const receipts = inputs.map((item) => {
      const pushed: AgentNS.InboxEntry = {
        messageId: item.messageId ?? generateMessageId(),
        source: item.source,
        priority: item.priority,
        content: item.content,
        createdAt: new Date().toISOString(),
      };
      this.inbox.push(pushed);
      this.events.emit("inbox", { agent: this, entry: pushed });
      return { messageId: pushed.messageId, accepted: true as const, woke: false as const };
    });
    return Array.isArray(input) ? receipts : receipts[0]!;
  }

  abort(): void {
    this.abortCalls += 1;
    this.aborted = true;
    // 与 core 同一口径：静止时按停是一跳（idle → terminated，不经 stopping）；跑中的那一段
    // 在自己的收尾里落 terminated（见 `send`）。
    if (this.runStatus === "idle") this.runStatus = "terminated";
    else if (this.runStatus === "running") this.runStatus = "stopping";
    // 与 core 同一口径：按停只停这一段，**不碰 inbox**（排队的那几句等下一次外部驱动）。
    // 旧版这里会 `splice(0)`，那是被推翻的旧语义。
    for (const message of this.messages) {
      if (
        message.status === AgentNSValue.MessageStatus.Pending ||
        message.status === AgentNSValue.MessageStatus.Writing
      ) {
        message.status = AgentNSValue.MessageStatus.Aborted;
      }
    }
  }

  async send(content: AgentNS.MessageContent): Promise<AgentNS.Message[]> {
    this.sendCalls += 1;
    // 与 core 同义：一次 `send` 就是「起一段」，静止态（包括上一段被叫停后的 `terminated`）
    // 都能被解冻 —— 常驻之后同一个实例会被一段一段地驱动，这一条必须演对。
    this.aborted = false;
    this.runStatus = "running";
    this.beforeSend?.();
    this.append(Message.User(content));
    await this.run();
    this.runStatus = this.aborted ? "terminated" : "idle";
    return this.messages;
  }

  /**
   * 一轮的骨架：外循环 + 内循环，与 core 的 `run()` 同一个形状（D2 的两个插入点都在这里）。
   *
   * 低优先插入点在「内循环全停下之后」：插进去了才再开一圈 —— 这是外循环唯一的正常出口。
   */
  private async run(): Promise<void> {
    let cursor = 0;
    for (;;) {
      // 内循环：脚本里带 toolCalls 的一轮要求继续（工具结果还得回给模型），其余是停下
      let needContinue = false;
      do {
        if (this.aborted) return;
        const round = this.rounds[cursor];
        // 脚本跑完 = 模型没有下一轮要说（与 core 的「needContinue 停下」同义）
        if (!round) break;
        cursor += 1;
        needContinue = await this.runRound(round);
        if (this.aborted) return;
        // 高优先级插入点：与 core 同一处 —— 这一圈内循环刚收尾（工具结果已 append、下一次
        // 请求的占位还没补）。插进去了就得再转一圈，否则那几条只是躺在 messages 里没人回。
        if (this.drainInbox("high")) needContinue = true;
      } while (needContinue);

      if (this.aborted) return;
      // 低优先级插入点：内循环全停下、 reconcile* 之后（假件里没有 reconcile 这一步）
      if (!this.drainInbox("low")) return;
    }
  }

  /** 跑一轮（= core 的一次请求 + 它引发的工具调用）；返回「模型是否还要求继续」 */
  private async runRound(round: FakeRound): Promise<boolean> {
    // 请求体就是「此刻的 messages」：先快照一份，用例才能问「下一次请求里带着它吗」
    this.requests.push([...this.messages]);

    const receiver = this.append(Message.Assistant());
    receiver.status = AgentNSValue.MessageStatus.Writing;
    this.events.emit("open");

    if (round.gate) await round.gate;
    if (this.aborted) return false;

    for (const delta of round.deltas ?? []) {
      if (this.aborted) return false;
      const chunk = toChunk(delta);
      // 攒消息用 core 的同一份实现：宿主存下来的那条与客户端攒出来的逐字一致
      applyChunk(receiver, chunk);
      this.events.emit("chunk-parsed", receiver, chunk);
    }

    if (round.usage) {
      const tail = usageChunk(round.usage);
      applyChunk(receiver, tail);
      this.events.emit("chunk-parsed", receiver, tail);
    }
    if (this.aborted) return false;
    receiver.status = AgentNSValue.MessageStatus.Completed;

    if (!round.toolCalls?.length) return false;

    const calls: AgentNS.ToolCall[] = round.toolCalls.map((call, index) => ({
      index,
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments ?? "{}" },
    }));
    receiver.tool_calls = calls;

    // 并行工具：先把结果消息都追加出来（于是「在等哪几个」是全的），再逐个定型
    const results = calls.map((call) => this.append(Message.Tool(call)));
    if (round.subAgent && calls[0]) {
      const started = subAgentContext(this, calls[0], round.subAgent);
      this.events.emit("sub-agent-start", started);
      // 子 Agent 跑起来了：先把它已有的消息报一遍（客户端据此算「它说了几句」），
      // 再逐片推正文 —— 这两件都是子 Agent **自己**的事件，宿主只是转发
      const inner = started.subAgent as unknown as FakeSubAgent;
      for (const message of inner.messages) inner.events.emit("message", message);
      const receiver = inner.messages[inner.messages.length - 1];
      for (const text of round.subAgent.stream ?? []) {
        if (receiver) {
          const chunk = {
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          };
          // 与 core 的 `parseStreamData` 同一个顺序：先攒进消息，再广播
          // （不先攒的话，假件里那条消息永远是空的，而真 core 里它已经长了）
          applyChunk(receiver, chunk as Parameters<typeof applyChunk>[1]);
          inner.events.emit("chunk-parsed", receiver, chunk);
        }
      }
    }
    if (round.toolGate) await round.toolGate;

    for (const [index, result] of results.entries()) {
      if (this.aborted) return false;
      const call = calls[index]!;
      result.content = `ok:${call.function?.name ?? ""}`;
      result.status = AgentNSValue.MessageStatus.Completed;
      if (round.toolSubAgentUsage) result.subAgentUsage = round.toolSubAgentUsage;
      this.events.emit("message", result);
      // 钩子载荷的形状按 core 的 `ToolCallEndContext` 给；假 agent 不是真的 core `Agent`
      this.events.emit("tool-call-end", {
        agent: this,
        toolCall: call,
        result,
      } as unknown as ToolCallEndContext);
    }

    if (round.subAgent && calls[0]) {
      this.events.emit("sub-agent-end", subAgentContext(this, calls[0], round.subAgent));
    }

    return true;
  }

  /**
   * 取走某一档优先级的条目，按入队顺序落成 `Message.User`（core 的 `insertInbox` 同一份语义）。
   *
   * 走 `append()`（不是 `messages.push`）：落地的那条同样要广播 `message`，宿主正是按这条事件
   * 把它记进本轮产出并落库的 —— 少了它，「排队的消息」在宿主眼里等于没发生。
   *
   * 摘除用 `splice` 逐个摘（不重建数组）：`inbox` 是公开字段，换掉数组实例会让外部快照
   * 指向一份死队列，与 core 的处理一致。
   *
   * @returns 有没有真的插进去（外循环靠它判断要不要再转一圈）
   */
  private drainInbox(priority: AgentNS.InboxPriority): boolean {
    const taken: AgentNS.InboxEntry[] = [];
    for (let index = 0; index < this.inbox.length; ) {
      const entry = this.inbox[index]!;
      if (entry.priority !== priority) {
        index += 1;
        continue;
      }
      taken.push(entry);
      this.inbox.splice(index, 1);
    }
    for (const entry of taken) {
      // 正文的取舍（非 user 来源加一行来源注释）用 core 同一个纯函数，不在这里再造一份
      const message = Message.User(inboxEntryContent(entry));
      // id 用入队时定的那个（D5）：另生成一个，客户端就会把同一条画两遍
      message.id = entry.messageId;
      this.append(message);
    }
    return taken.length > 0;
  }
}

/**
 * 子 Agent 委派边界的钩子载荷。
 *
 * 形状按 core 的 `SubAgentContext` 给（本包只用 `toolCallContext.tool_call` 与 `subAgent`），
 * 假 agent 不是真的 core `Agent`，所以这里显式声明成钩子要的形状后再断言过去。
 *
 * 子 Agent 带的 `events` 是**同一个**：`sub-agent-start` 时宿主订上它，之后用例（或假 Agent）
 * 往它上面 `emit("chunk-parsed")`，正是真 core `Agent` 的用法。
 */
function subAgentContext(
  host: FakeAgent,
  toolCall: AgentNS.ToolCall,
  spec: { name: string; messages: AgentNS.Message[]; stream?: string[] },
): SubAgentContext {
  const events = (spec as { __events?: FakeEmitter }).__events ?? createEmitter();
  (spec as { __events?: FakeEmitter }).__events = events;
  const subAgent: FakeSubAgent = {
    messages: spec.messages,
    definition: { name: spec.name },
    events,
  };
  return {
    agent: host,
    subAgent: subAgent as unknown as SubAgentContext["subAgent"],
    toolCallContext: { tool_call: toolCall },
  } as unknown as SubAgentContext;
}

/** 假子 Agent：宿主只摸它的 `messages` 与 `events` */
interface FakeSubAgent {
  messages: AgentNS.Message[];
  definition: { name: string };
  events: FakeEmitter;
}

/** 够用的最小事件出口（`on` 订阅、`emit` 广播） */
interface FakeEmitter {
  on(event: string, handler: (...args: never[]) => void): () => void;
  emit(event: string, ...args: unknown[]): void;
}

function createEmitter(): FakeEmitter {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler as (...args: unknown[]) => void);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(
          event,
          current.filter((item) => item !== handler),
        );
      };
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}
