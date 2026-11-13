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
 * 空闲回收要等 10 分钟，用例不可能真等；把时间做成可注入的之后，回收逻辑照原样跑，
 * 只是「十分钟」变成了 `advance(10 * 60 * 1000)`。
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
  const scope = new Scope({ config: minimalConfig(), agentsDir: `${cwd}/agents`, cwd });
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
  subAgent?: { name: string; messages: AgentNS.Message[] };
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
 */
export class FakeAgent implements ChatAgent {
  messages: AgentNS.Message[] = [];
  readonly events = new RecordingEventBus();
  sendCalls = 0;
  abortCalls = 0;
  aborted = false;
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

  abort(): void {
    this.abortCalls += 1;
    this.aborted = true;
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
    this.beforeSend?.();
    this.append(Message.User(content));
    await this.run();
    return this.messages;
  }

  private async run(): Promise<void> {
    for (const round of this.rounds) {
      if (this.aborted) return;
      const receiver = this.append(Message.Assistant());
      receiver.status = AgentNSValue.MessageStatus.Writing;
      this.events.emit("open");

      if (round.gate) await round.gate;
      if (this.aborted) return;

      for (const delta of round.deltas ?? []) {
        if (this.aborted) return;
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
      if (this.aborted) return;
      receiver.status = AgentNSValue.MessageStatus.Completed;

      if (!round.toolCalls?.length) return;

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
        this.events.emit("sub-agent-start", subAgentContext(this, calls[0], round.subAgent));
      }
      if (round.toolGate) await round.toolGate;

      for (const [index, result] of results.entries()) {
        if (this.aborted) return;
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
    }
  }
}

/**
 * 子 Agent 委派边界的钩子载荷。
 *
 * 形状按 core 的 `SubAgentContext` 给（本包只用 `toolCallContext.tool_call` 与 `subAgent`），
 * 假 agent 不是真的 core `Agent`，所以这里显式声明成钩子要的形状后再断言过去。
 */
function subAgentContext(
  host: FakeAgent,
  toolCall: AgentNS.ToolCall,
  subAgent: { name: string; messages: AgentNS.Message[] },
): SubAgentContext {
  return {
    agent: host,
    subAgent: { messages: subAgent.messages, definition: { name: subAgent.name } },
    toolCallContext: { tool_call: toolCall },
  } as unknown as SubAgentContext;
}
