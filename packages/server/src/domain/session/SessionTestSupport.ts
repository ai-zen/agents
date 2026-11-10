/**
 * `SessionManager` 那一组用例的共用脚手架（拆文件时提出来的，不是复制）。
 *
 * ## 为什么是一个模块而不是每个文件各带一份
 *
 * 假 Agent、按真件形状 fire 事件的那几个函数、假存档、假时钟，是**同一份知识**：
 * 「SDK 的时序长什么样」「`tool-call-end` 的载荷有几个字段」。抄成四份的那天，改一处
 * 假件形状就可能漏掉三处，而假件与真件不同形的代价是：一个「正文增量一条都推不出去」
 * 的真 bug 能躲过一整轮单测。
 *
 * ## 为什么用「活绑定」而不是工厂函数
 *
 * 160 条用例的写法都是「先 `await create()`，再断言 `events` / `agent`」。把它们改成
 * `kit.manager` / `kit.events` 是一次纯噪音的大改（也正是「搬用例」这件事最容易搬错
 * 的地方）。ESM 的 `export let` 是**活绑定**：本模块内部重新赋值，import 方读到的是新值
 * —— 于是用例正文一个字不用改，`beforeEach` 却只有一处。
 *
 * 唯一的例外是 `counter`：调用方要 `++` 它，而 import 进来的绑定是只读的，所以它装在
 * 一个可变对象里（`counter.value`）。
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type AgentLike, type CreateAgentInput } from "./SessionManager.js";
import { FileSessionStore } from "./store/FileSessionStore.js";
import type { SessionRecord, SessionStore } from "./store/SessionStore.js";
import type {
  HandoffMode,
  Message,
  ServerEvent,
  SessionListEntry,
  Usage,
} from "@ai-zen/agents-protocol";
import type { AutoTitleRequest } from "./AutoTitle.js";
import { EventHub } from "../../lib/events.js";
import { resolveModel } from "@ai-zen/agents-sdk";

/**
 * 等一轮真正收尾。
 *
 * 收尾是**异步**的：`settleTurn` 先落盘、再发 `session-turn-end`（顺序是那条需求的全部意义）。
 * 所以驱动完 `finally` 之后要等一拍再断言，否则测的是「还没写完」而不是「没发」
 * —— 这与本仓「等条件成立」的约定同一个意思，只是这里的条件就是「异步收尾跑完」。
 */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 假倒计时：把「到点」变成一个可以手动触发的动作。
 *
 * 回收判定是**时间**驱动的，而宽限期缺省 60 秒：真等它就只能 `sleep`，那是把「宽限期」
 * 测成「时钟」—— 断言的应该是「到点时怎么判」，不是「60 秒是不是 60 秒」。
 * 与 `ensure-server.ts` 注入 `waitBeforeRetry` 是同一个理由。
 */
export function fakeClock() {
  const entries: Array<{ run: () => void; cancelled: boolean }> = [];
  return {
    schedule: (_ms: number, run: () => void) => {
      const entry = { run, cancelled: false };
      entries.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** 还活着的倒计时（已取消 / 已到点过的不算） */
    pending: () => entries.filter((entry) => !entry.cancelled),
    /** 全部到点 */
    tick: () => {
      for (const entry of entries.filter((item) => !item.cancelled)) {
        entry.cancelled = true;
        entry.run();
      }
    },
  };
}

/**
 * 假 Agent —— 只实现会话管理器用到的那一小面（结构类型），
 * 事件由测试手动驱动，于是「SDK 的时序」在测试里是**可编程**的，不依赖网络与真实模型。
 */
export class FakeAgent implements AgentLike {
  messages: any[] = [];
  lastUsage: any = undefined;
  sent: string[] = [];
  aborted = 0;
  /** 让 `send()` 挂住：用来证明 manager.send 不等一轮跑完 */
  holdSend: Promise<void> | null = null;

  /**
   * 交接要用到的那几面（真件是 SDK 的 `SdkAgent`，声明见 `HandoffAgentLike`）。
   * 默认无 `write` 工具 → 交接走「独立摘要」，不触网。
   */
  definition = { messages: [{ role: "system", content: "模板" }] };
  /** 三级解析的档位（真件由 `createAgent` 给；假件手装配，等价于「写在定义上」那一档） */
  modelLevel: "agent" | "session" | "global" = "agent";
  tools: Array<{ function?: { name?: string } }> = [];
  model = "m";
  modelConfig: Record<string, unknown> = {};
  client: unknown = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: DOC } }] }) } },
  };
  scope = { cwd: "/work/proj" };
  use(_plugin: unknown): void {}

  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      this.handlers.get(event)?.delete(handler);
    },
  };

  send(input: string): Promise<void> {
    this.sent.push(input);
    return this.holdSend ?? Promise.resolve();
  }

  abort(): void {
    this.aborted++;
  }

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  handlerCount(): number {
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}

/**
 * 假的子 Agent —— 照 `FakeAgent` 的最小实现来：会话层只从它身上取两样，
 * 自己的 `messages`（快照用）与自己 `events`（挂监听用）。
 */
export class FakeSubAgent {
  messages: any[] = [];
  private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
  readonly events = {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(handler);
    },
  };

  /** 驱动一条子 Agent 自己的事件（`chunk-parsed` / `error`…） */
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

/**
 * 按 **core 的真实契约**发一片 chunk。
 *
 * 真件是**两条**事件、而且是这个顺序（`packages/core/src/Agent.ts` 的 `parseStreamData`）：
 *   1. `emit("chunk", chunk)` —— 原始片到建，早于解析；
 *   2. 解析完才 `emit("chunk-parsed", receiver, chunk)` —— 两参，第一个是那条正在拼的
 *      assistant 消息，第二个才是原始 chunk。
 *
 * 两件事都必须照抄。按单参发（`fire("chunk-parsed", chunk)`）恰好能满足服务端
 * “两种形状都认”的写法，于是一个「正文增量永远推不出去」的真 bug 躲过了一整轮单测（
 * 服务端读的是第一个参数，那个位置在本用例里拿到的是 chunk 而不是消息）；
 * 另外漏发 `chunk` 会让「原始事件照原时机上线」这件事在用例里凭空成立。假件的形状
 * 必须与真件一致。
 */
export function fireChunk(
  target: { fire: (event: string, ...args: unknown[]) => void },
  chunk: unknown,
): void {
  target.fire("chunk", chunk);
  target.fire("chunk-parsed", { role: "assistant" }, chunk);
}

/**
 * 造一条**存档里的**消息（`SessionRecord<Message>`）。
 *
 * 存档正文的形状现在是协议转出的 core `Message` —— `role` 是 core 的 `Role` 枚举，
 * 而用例只关心「这是一条 user 消息」。收窄只发生在这里（一处），
 * 免得每条用例都写一遍 `as`；运行期不校验（存档本来就是 JSON，读回来就是这个形状）。
 */
export function storedMessage(role: "user" | "assistant" | "system", content: string): Message {
  return { id: `m_${role}`, role: role as Message["role"], content };
}

export let agent: FakeAgent;
export let manager: SessionManager;
export let events: ServerEvent[];
/** 会话 id 序号。装在可变对象里：ESM 的 import 是只读视图，用例要 `++` 它 */
export const counter = { value: 0 };

/** 用例自己造的存档根：统一在 `afterEach` 收掉（漏一个就是一个跑不掉的 /tmp 目录） */
const tempRoots: string[] = [];

export function tempRoot(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random()}`);
  tempRoots.push(dir);
  return dir;
}

/** 交接文档正文：SDK 有 400 字节的有效性阈值（与 `SessionHandoff.test.ts` 同一个理由） */
export const DOC = `# 交接文档\n\n${"- 桩内容\n".repeat(80)}`;

export const create = () =>
  manager.create({ workspaceId: "ws-1", path: "/work/proj", agentId: "default" });

/** 取某个事件名下的全部事件 */
export const pick = <T extends ServerEvent["event"]>(name: T) =>
  events.filter((event) => event.event === name) as Extract<ServerEvent, { event: T }>[];

/** 模拟 OpenAI 风格的一个流式 chunk */
export const chunk = (delta: Record<string, unknown>) => ({ choices: [{ delta }] });

/**
 * 按**真件的两层**驱动一片工具调用 chunk。
 *
 * 真件（`packages/core/src/Agent.ts` 的 `parseStreamData`）做三件事，缺一不可：
 *   1. `emit("chunk", chunk)` —— 原始片到建；
 *   2. 就地把它拼进 `receiver.tool_calls[index]`（名字只在本下标的第一片里给，参数逐片
 *      `+=`）；
 *   3. 然后才 `emit("chunk-parsed", receiver, chunk)` —— **第一个参数是那条正在拼的消息**，
 *      第二个才是这一片原始 chunk。
 *
 * 所以这里也让同一个 `receiver` 逐片累积：每片手搓一个「已经拼好」的消息喂进去，测出来的
 * 就只是「测试自己拼得对」，而服务端真去读 `receiver` 还是真去解析 chunk 都分辨不出来
 * （`onChunk` 上方那段注释记的就是这么躲过一整轮单测的 bug）。
 */
export function fireToolCall(
  target: { fire: (event: string, ...args: unknown[]) => void },
  receiver: any,
  index: number,
  fragment: { id?: string; name?: string; arguments: string },
): void {
  const deltaCall: Record<string, unknown> = {
    index,
    type: "function",
    ...(fragment.id === undefined ? {} : { id: fragment.id }),
    function: {
      ...(fragment.name === undefined ? {} : { name: fragment.name }),
      arguments: fragment.arguments,
    },
  };

  // —— 第 1 步：原始片先上线（core `chunk`，早于解析）
  const raw = chunk({ tool_calls: [deltaCall] });
  target.fire("chunk", raw);

  // —— 第 2 步：照 core 的样子拼进 receiver
  receiver.tool_calls ??= [];
  const call = (receiver.tool_calls[index] ??= { index, function: { name: "", arguments: "" } });
  if (fragment.id !== undefined) call.id = fragment.id;
  if (fragment.name !== undefined) call.function.name = fragment.name;
  call.function.arguments += fragment.arguments;

  // —— 第 3 步：两参 fire（receiver, chunk）
  target.fire("chunk-parsed", receiver, raw);
}

/** 一条正在拼的 assistant 消息（真件里就是 `AgentNS.Message`） */
export const assembling = () => ({ role: "assistant" as const });

/**
 * 一条工具结果消息 —— 照**真件**（`packages/core/src/Message.ts` 的 `Message.Tool`）：
 *
 *     new Message({ role: "tool", tool_call_id, name, content, status: Pending })
 *
 * 关键在于它在工具**执行前**就被 `append` 进 `agent.messages`（`Agent.handleToolCall` 的
 * `Promise.all` 里，每个任务的第一个动作就是 `this.append(Message.Tool(task))`），那一刻
 * 正文还没有、`status` 是 `pending`；跑完才由 `markResult` 就地翻成终态。
 */
export const toolResult = (toolCallId: string, name: string, content = "") => ({
  // 真件每条消息都有 id（`Message` 构造时生成）：线上按 id 覆盖，假件必须同形
  id: `m-${toolCallId}`,
  role: "tool" as const,
  tool_call_id: toolCallId,
  name,
  content,
  status: "pending",
});

/**
 * 按 **core 的真实契约**驱动一次「某个工具跑完了」：`message` → `tool-call-end`。
 *
 * 真件是 `Agent.handleToolCall` 里的 `markResult`（`packages/core/src/Agent.ts`），它做三件事：
 *   1. 把 `resultReceiver.status` 翻成终态（被 abort 的一律 clamp 成 `aborted`）；
 *   2. `this.emitMessage(resultReceiver)` —— 按新状态重发**同一条**消息（`message` 事件）；
 *   3. `this.events.emit("tool-call-end", { agent, toolCall, result })` —— **三个字段**，
 *      `result` 就是刚定型的那条消息本身（`ToolCallEndContext`）。
 *
 * 两步都要照抄：只 fire `tool-call-end` 的话，`message` 那条通道在用例里永远收不到东西，
 * 而它正是「服务端不必再扫 `agent.messages` 做差集」的全部依据。
 */
export function fireToolCallEnd(
  agent_: FakeAgent,
  result: any,
  status: "completed" | "error" | "aborted" = "completed",
): void {
  result.status = status;
  agent_.fire("message", result);
  agent_.fire("tool-call-end", {
    agent: agent_,
    toolCall: { id: result.tool_call_id, type: "function", function: { name: result.name } },
    result,
  });
}

/**
 * 挂住的摘要请求（只认取消）：用来把会话停在「交接进行中」那个状态。
 *
 * 必须响应 `signal`：不响应的话 `cancel()` 掐不断它，用例只能干等到超时。
 */
export const hangingSummary = () => ({
  chat: {
    completions: {
      create: (_body: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("Request was aborted"), { name: "AbortError" })),
          );
        }),
    },
  },
});

/** 内存存档：续接与 save 的用例不需要碰磁盘 */
export class MemoryStore implements SessionStore<Message> {
  readonly records: Map<string, SessionRecord<Message>> = new Map();
  pointer: string | null = null;
  /** 每个 id 的最后写入时刻（真件把这个落在清单里，见 `FileSessionStore`） */
  private readonly written = new Map<string, string>();

  async list() {
    return [...this.records.keys()]
      .map((id) => {
        const record = this.records.get(id)!;
        return {
          id,
          agentId: record.agentId,
          ...(record.title !== undefined ? { title: record.title } : {}),
          ...(record.modelId !== undefined ? { modelId: record.modelId } : {}),
          messageCount: record.messages.length,
          updatedAt: this.written.get(id) ?? "",
        };
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  /**
   * 单条清单 —— 行为照抄真件（`FileSessionStore.entry`）：`list()` 里没有这一条就 `null`，
   * `write()` 之后能读到同一条。假件只存一份内存表，从 `list()` 里取那一条就是同一个语义
   * —— 关键是别在这里造出与 `list()` 不一致的第二个值。
   */
  async entry(id: string) {
    const listed = await this.list();
    return listed.find((item) => item.id === id) ?? null;
  }
  async read(id: string): Promise<SessionRecord<Message> | null> {
    return this.records.get(id) ?? null;
  }
  /**
   * 直接摆一段存档（`updatedAt` 由调用方指定）。
   *
   * 真件里这个时间来自写入那一刻维护的清单（`<id>.meta.json`），假件照同一件事给一个
   * 缝：需要「最后一次活动是很久以前」的用例，不能靠 `write()` 之后再等 —— 那测到的是
   * 时钟，不是「续接有没有改写它」。
   */
  seed(record: SessionRecord<Message>, updatedAt: string) {
    this.records.set(record.id, record);
    this.written.set(record.id, updatedAt);
  }
  async write(record: SessionRecord<Message>) {
    this.records.set(record.id, record);
    this.written.set(record.id, new Date(Date.now() + this.written.size).toISOString());
  }
  async remove(id: string) {
    this.records.delete(id);
    this.written.delete(id);
  }
  async exists(id: string) {
    return this.records.has(id);
  }
  async lastSession() {
    return this.pointer ? { id: this.pointer, updatedAt: "" } : null;
  }
  async setLastSession(id: string) {
    this.pointer = id;
  }
}

/**
 * 录事件的 hub：即使**一个订阅者都没有**也把事件记下来。
 *
 * 为什么非得要它：「没人在看时不提问」这条靠普通订阅是测不出来的 —— 一订上，
 * `watcherCount()` 就不是 0 了。本类只多记一份，**不改** `watcherCount()` 的语义
 * （那正是被测的东西）。
 */
export class RecordingHub extends EventHub {
  readonly published: ServerEvent[] = [];

  publish(event: ServerEvent): void {
    this.published.push(event);
    super.publish(event);
  }
}

export function resetEvents(): void {
  events = [];
}

/** 注册这一组用例共用的 beforeEach / afterEach（每个用例文件在顶层调一次） */
export function useSessionKit(): void {
  afterEach(async () => {
    for (const dir of tempRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agent = new FakeAgent();
    manager = new SessionManager({
      createAgent: async () => agent,
      // 确定性 id：用例断言的是“哪个是哪个”，不是时间戳本身
      nextSessionId: () => `chat_${++counter.value}`,
    });
    events = [];
    counter.value = 0;
    manager.subscribe((event) => events.push(event));
  });
}
