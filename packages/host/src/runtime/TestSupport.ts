/**
 * 运行层用例共用的脚手架：假时钟、记账式消息仓储、假 Scope 插件、假 agent。
 *
 * 这里**不调模型**，也不碰真实工作目录：假 agent 就是**真的 core `Agent`**（走 core 真的循环、
 * 真的 `push` 取件、真的 `messageAdded` / `delta` / `state` 事件），只有「流从哪来」换成了脚本
 * —— 于是用例验证的是本包接线是否正确，而不是 core 的算法。
 *
 * 本文件只被 `*.test.ts` import（`tsconfig.json` 把它排除在产物之外）。
 */

import {
  Agent,
  AgentNS,
  AgentToolLazy,
  CallbackTool,
  Message,
  Tool,
} from "@ai-zen/agents-core";
import type { AppConfig, ScopePlugin } from "@ai-zen/agents-sdk";
import { Scope } from "@ai-zen/agents-sdk";

import type { MessageUpsertInput, StoredMessage } from "../storage/types.js";
import type { MessageStore } from "./ChatRunner.js";
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

  /** 物理删一行（core 的 `messageRemoved` 事件的落点；与真仓储同一口径） */
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
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
    source: row.source ?? null,
    data: (row.data ?? null) as StoredMessage["data"],
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// 假 agent —— **真的 core `Agent`**，只有模型那一侧换成脚本
// ---------------------------------------------------------------------------

/** 造一片流（形状与 openai 的 chunk 一致，只填本包用得到的字段） */
function deltaChunk(delta: AgentNS.Delta): unknown {
  return { choices: [{ index: 0, delta, finish_reason: null }] };
}

/** 收尾片：只带 `finish_reason`，不带 `delta`（于是不会多出一条空增量） */
function finishChunk(finishReason: string): unknown {
  return { choices: [{ index: 0, finish_reason: finishReason }] };
}

/** 只带 usage 的收尾片（真流的形状：`choices` 为空） */
function usageChunk(usage: AgentNS.Usage): unknown {
  return { choices: [], usage };
}

/** 一轮「请求」要吐的东西（脚本） */
export interface FakeRound {
  /**
   * 请求已经发出、第一片还没来之前等这个 Promise。
   *
   * 用例借此在「等首字」那一刻插中止、或断言中间态 —— 那一刻是精确可到达的，不赌时间。
   */
  gate?: Promise<void>;
  /** 这一次请求直接失败（连不上 / 端点 500）：`create` 抛它，core 会把它收成 `AgentError` */
  fail?: Error;
  /** 依次吐出的增量（原样交给 core 的 `applyChunk`） */
  deltas?: AgentNS.Delta[];
  /** 收尾片带的用量（会经 `applyChunk` 钉到那条助手消息上） */
  usage?: AgentNS.Usage;
  /** 这一轮模型要求的工具调用；给了就进「等工具」并再开一轮 */
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>;
  /** 工具真正「跑」之前等这个（用例在「等工具」处插中止） */
  toolGate?: Promise<void>;
  /**
   * 这一轮的那个工具是一次**真委派**：core 的 `AgentToolLazy` 会造一个一次性子 agent、
   * 转发它的事件、把它的用量钉在工具消息上 —— 这里只给出那个子 agent 的脚本。
   */
  subAgent?: {
    name: string;
    /** 子 agent 开局手里就有的消息（末尾那条 user 就是这一趟要回答的问题） */
    messages: AgentNS.Message[];
    /** 子 agent 吐的正文片（每片一次 `delta`，由 core 转发到父身上） */
    stream?: string[];
    /** 子 agent 这一轮的请求直接失败（core 收成 `failed`，那条助手消息落成 `error`） */
    fail?: Error;
    /** 子 agent 这一轮的用量 */
    usage?: AgentNS.Usage;
  };
}

/** core 的 `Agent` 要的那个 client 形状（只用到 `chat.completions.create`） */
type AgentClient = ConstructorParameters<typeof Agent>[0]["client"];
type StreamResult = Awaited<ReturnType<AgentClient["chat"]["completions"]["create"]>>;

/** 把脚本里的一轮变成一片异步流 */
async function* streamOf(round: FakeRound, signal?: AbortSignal): AsyncGenerator<unknown> {
  if (round.gate) await round.gate;
  if (signal?.aborted) return;

  const calls = round.toolCalls ?? [];

  for (const delta of round.deltas ?? []) {
    if (signal?.aborted) return;
    // 脚本里手写的 tool_calls 片在给了 `toolCalls` 时忽略：那一份才是权威（否则会出现两份调用）
    if (delta.tool_calls?.length && calls.length > 0) continue;
    yield deltaChunk(delta);
  }

  // 工具调用：由 `toolCalls` 生成（一片一个，与厂商的真实形状一致：`applyChunk` 靠 `index` 归位）
  for (const [index, call] of calls.entries()) {
    yield deltaChunk({
      tool_calls: [
        {
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments ?? "{}" },
        },
      ],
    });
  }

  if (round.usage) yield usageChunk(round.usage);
  yield finishChunk(calls.length > 0 ? "tool_calls" : "stop");
}

/** 一个一次性子 agent（带 `definition.name`，宿主的快照要读它） */
class FakeSubAgent extends Agent {
  readonly definition: { name: string };

  constructor(options: {
    name: string;
    messages: AgentNS.Message[];
    stream?: string[];
    fail?: Error;
    usage?: AgentNS.Usage;
  }) {
    super({
      client: {
        chat: {
          completions: {
            create: async () => {
              // 这一趟办不成（端点挂了 / 连不上）：由 core 收成 `failed` + 那条消息的 `error`
              if (options.fail) throw options.fail;
              async function* gen(): AsyncGenerator<unknown> {
                for (const text of options.stream ?? []) {
                  yield deltaChunk({ content: text });
                }
                if (options.usage) yield usageChunk(options.usage);
                yield finishChunk("stop");
              }
              return { [Symbol.asyncIterator]: () => gen() } as unknown as StreamResult;
            },
          },
        },
      } as unknown as AgentClient,
      model: "fake-sub-model",
      messages: [...options.messages],
      lifetime: "one-shot",
    });
    this.definition = { name: options.name };
  }
}

/**
 * 假 agent —— **就是 core 的 `Agent`**，只是把模型那一侧换成脚本。
 *
 * ## 为什么必须是真 `Agent`
 *
 * 从前这里是一份宿主自己写的窄接口假件：它自己实现了一遍 `send()` / 轮末取件 / 事件广播。
 * 后果是「假件与真件的形状不一致」—— 宿主对着假件的形状写对了，真 core 上却是另一回事，
 * 而类型检查根本不看 core（`ChatAgent` 那层挡板）。现在假件直接 `extends Agent`，走 core 真的
 * 循环、真的 `push` 取件、真的 `messageAdded` / `delta` / `state` 事件。宿主的接线于是验的是
 * **真语义**。
 *
 * ## 脚本能控什么
 *
 * 每一轮一次 `chat.completions.create`：`gate`（等首字前）、`deltas`、`usage`、`toolCalls`
 * （真的去查 `tools` 并 `exec`）、`subAgent`（走 core 的 `AgentToolLazy`，血缘 / 事件转发 /
 * 用量都在 core 里发生）。脚本用完之后的请求回一句「（脚本用完了）」，于是这一轮自然结束。
 */
export class FakeAgent extends Agent {
  /** 每一次请求发出那一刻的 `messages` 快照（模型看到的就是它的前身） */
  readonly requests: AgentNS.Message[][] = [];
  /** 发过几次请求（= 几次模型调用） */
  sendCalls = 0;
  /** 被按过几次「停」（`abort()`） */
  abortCalls = 0;

  constructor(rounds: FakeRound[] = [], options: { system?: string } = {}) {
    const box: { agent?: FakeAgent } = {};
    const script = { cursor: 0 };

    const create = async (body: unknown, requestOptions?: { signal?: AbortSignal }) => {
      const agent = box.agent!;
      agent.sendCalls += 1;
      // 快照「模型这一次看到的那一份」：与 core 的 `formatHistory` 同一个筛法（定型且未 omit）。
      // 不整份拷 `messages`：那里面还有此刻正在写的助手占位（它不在请求体里）。
      agent.requests.push(
        agent.messages.filter(
          (message) =>
            (message.status === undefined ||
              message.status === AgentNS.MessageStatus.Completed) &&
            !message.omit,
        ),
      );
      void body;
      const round: FakeRound = rounds[script.cursor] ?? { deltas: [{ content: "（脚本用完了）" }] };
      script.cursor += 1;
      if (round.fail) throw round.fail;
      const iterator = streamOf(round, requestOptions?.signal);
      return { [Symbol.asyncIterator]: () => iterator } as unknown as StreamResult;
    };

    super({
      client: { chat: { completions: { create } } } as unknown as AgentClient,
      model: "fake-model",
      messages: options.system === undefined ? [] : [Message.System(options.system)],
      tools: toolsOf(rounds),
    });
    box.agent = this;
    // 脚本是「一轮一段」的：每一批（`state → busy`）都从第一轮重新演。
    // 不重置的话，第二次发话就没有脚本可放（拿到的只会是「脚本用完了」那一句）。
    this.on("state:busy", () => {
      script.cursor = 0;
    });
  }

  /** 与 core 同一口径地数一次「停」（用例断言「结算之后过期句柄按不到 agent」靠它） */
  override abort(): void {
    this.abortCalls += 1;
    super.abort();
  }
}

/**
 * 脚本里出现过的工具 → 真的工具实现。
 *
 * - 某一轮带了 `subAgent` 时，那一轮的**第一个**工具是委派：走 core 的 `AgentToolLazy`
 *   （血缘、事件转发、用量汇总都在 core 里发生，这里只给子 agent 的脚本）；
 * - 其余工具是回声（`ok:<名字>`），`toolGate` 时把它按在「跑着」那一刻。
 */
function toolsOf(rounds: FakeRound[]): Tool[] {
  const tools: Tool[] = [];
  const seen = new Set<string>();
  for (const round of rounds) {
    const calls = round.toolCalls ?? [];
    for (const [index, call] of calls.entries()) {
      if (seen.has(call.name)) continue;
      seen.add(call.name);
      const spec = round.subAgent;
      if (spec && index === 0) {
        tools.push(
          new AgentToolLazy({
            function: {
              name: call.name,
              description: "委派给一个子 agent（用例脚本）",
              parameters: { type: "object", properties: {} },
            },
            buildAgent: () =>
              new FakeSubAgent({
                name: spec.name,
                messages: spec.messages,
                ...(spec.stream === undefined ? {} : { stream: spec.stream }),
                ...(spec.fail === undefined ? {} : { fail: spec.fail }),
                ...(spec.usage === undefined ? {} : { usage: spec.usage }),
              }),
          }),
        );
        continue;
      }
      tools.push(
        new CallbackTool({
          function: {
            name: call.name,
            description: "回声工具（用例脚本）",
            parameters: { type: "object", properties: {} },
          },
          callback: async () => {
            if (round.toolGate) await round.toolGate;
            return `ok:${call.name}`;
          },
        }),
      );
    }
  }
  return tools;
}

/** 子 agent 的名字：宿主的 `subAgentName` 读的就是它（真 core 的 `Agent` 上没有这一格） */
export type { FakeSubAgent };
