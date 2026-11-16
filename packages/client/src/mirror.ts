/**
 * 一段对话的**镜像**：按到达的事件把 `messages` 重建出来，另外记住四格里的那一格。
 *
 * ## 为什么要镜像，以及它凭什么与宿主逐字一致
 *
 * 断线即作废、不重放、不 ack（`packages/host/src/wire/events.ts` 开头）：所以「现在有哪些消息、
 * 每条长什么样」只能由客户端拿**两样原料**自己攒出来：
 *
 *   · 一帧一帧的到达事件（`message.added` / `message.delta` / `message.changed` / `message.removed`）；
 *   · 打开或重连时 `message.list` 拉回来的那一份快照（全量，或从本地最后一条 id 起的增量）。
 *
 * 攒的规则里最容易出错的是「一片增量怎么折进一条消息」：正文拼串、内容段数组、工具参数串的
 * 两种厂商行为、流末的 `usage` 与 `finish_reason` —— 每条都有自己的边界情形。所以这里
 * **不自己写**这套规则，直接调 core 的 `applyChunk`：宿主跑 agent 时攒消息用的就是它，同一份
 * 函数在两边跑，攒出来的那条消息与宿主存下来的逐字一致。这就是「完美镜像」的全部保证。
 *
 * ## 只管两样东西
 *
 * ① `messages`：主线一栏 + 按 `toolCallId` 归好的子 Agent 各栏；
 * ② 四格 `status`（忙 / 闲 / 暂停 / 死），来自 `state` 事件；还没收到事件时用
 *    `conversation.state` 的现读值初始化。
 *
 * 用量**不在这里**：每条消息自带 `usage`，要显示就自己求和（core 的 `sumUsage`）——客户端不
 * 为了用量再养一条事件与一份汇总，那两份东西与消息上的事实迟早对不上。
 *
 * ## 就地改，不返回新对象
 *
 * `applyChunk` 的契约就是「就地攒进 `receiver`」。于是镜像里的消息对象是**活的**：读的人拿到
 * 的数组与对象会被后续增量就地更新。界面要重画，请按到达的事件重画，不要靠比较引用 ——
 * 引用一直是同一个。
 */

import { applyChunk } from "@ai-zen/agents-core";
import type { AgentNS, ConversationStatus, EventPayload } from "@ai-zen/agents-host";

/**
 * 与镜像有关的一条事件（事件名 + 载荷，判别结构）。
 *
 * 另外四个事件与镜像无关：`notice` / `question` / `error` / `conversation.changed` —— 它们说的
 * 不是「哪条消息怎么了」，也不是四格。
 */
export type MirrorEvent =
  | { kind: "message.added"; payload: EventPayload<"message.added"> }
  | { kind: "message.delta"; payload: EventPayload<"message.delta"> }
  | { kind: "message.changed"; payload: EventPayload<"message.changed"> }
  | { kind: "message.removed"; payload: EventPayload<"message.removed"> }
  | { kind: "state"; payload: EventPayload<"state"> };

/**
 * 一条事件折成 {@link MirrorEvent}；与镜像无关的事件返回 `null`。
 *
 * 判据是事件名（`EventMap` 里的名字），不是载荷长什么样：宿主加了新事件时，这里的行为是
 * 「不认识就交给别人」，不是猜一个含义。
 */
export function toMirrorEvent(event: string, payload: unknown): MirrorEvent | null {
  switch (event) {
    case "message.added":
      return { kind: "message.added", payload: payload as EventPayload<"message.added"> };
    case "message.delta":
      return { kind: "message.delta", payload: payload as EventPayload<"message.delta"> };
    case "message.changed":
      return { kind: "message.changed", payload: payload as EventPayload<"message.changed"> };
    case "message.removed":
      return { kind: "message.removed", payload: payload as EventPayload<"message.removed"> };
    case "state":
      return { kind: "state", payload: payload as EventPayload<"state"> };
    default:
      return null;
  }
}

/** 某一栏子 Agent 的消息（`toolCallId` = 那次委派的工具调用 id） */
export interface SubAgentColumn {
  toolCallId: string;
  messages: readonly AgentNS.Message[];
}

/** 镜像的一份只读样子（给界面与用例看，不是另一份数据） */
export interface MirrorSnapshot {
  conversationId: string;
  status: ConversationStatus;
  /** 主线消息（不属于任何子 Agent 的那些），顺序即对话里的先后 */
  messages: readonly AgentNS.Message[];
  /** 按 `toolCallId` 归好的子 Agent 各栏 */
  subAgents: SubAgentColumn[];
}

/**
 * `applyChunk` 吃的片类型。
 *
 * 它是厂商的 `ChatCompletionChunk`，客户端不为它去依赖 `openai`：类型从函数签名推出来，
 * 构造时转一下（下面 {@link chunkOf} 有说明）。
 */
type Chunk = Parameters<typeof applyChunk>[1];

/**
 * 一条 `AgentNS.Delta` → `applyChunk` 能吃的那一片。
 *
 * 事件载荷里的增量是 core 的 `AgentNS.Delta`（描述「这一片带来了什么」），而 `applyChunk`
 * 的入参是厂商 chunk（`choices[0].delta` 装同一份东西，另外可能带 `usage` / `finish_reason`）。
 * 这里只做形状搬运：包一层 `choices[0]`，`finish_reason` 给 `null`（增量片本来没有它；流末的
 * 结束原因由 `message.changed` 整条带回来）。
 */
function chunkOf(delta: AgentNS.Delta): Chunk {
  return { choices: [{ index: 0, delta, finish_reason: null }] } as unknown as Chunk;
}

/** 一段对话的镜像：主线一栏、子 Agent 各一栏、四格里那一格 */
export class ConversationMirror {
  readonly conversationId: string;
  private statusValue: ConversationStatus;
  private main: AgentNS.Message[] = [];
  private readonly columns = new Map<string, AgentNS.Message[]>();
  /**
   * 「这一条是从快照里来的」—— 只在打开对话的那一小段时间有意义。
   *
   * 打开时先订阅、再拉快照，拉取期间到达的事件先攒着，快照落地之后按序补上。补的那一批里，
   * 属于快照已包含的那些消息的增量**不再折一遍**：快照里的内容已经是它的最新样子，再折一次
   * 就是同一段字写两遍。宁可少写（下一条 `message.changed` 会把整条带回来）也不写重。
   */
  private fromSnapshot = new Set<string>();

  constructor(init: { conversationId: string; status: ConversationStatus }) {
    this.conversationId = init.conversationId;
    this.statusValue = init.status;
  }

  /** 四格里的那一格 */
  get status(): ConversationStatus {
    return this.statusValue;
  }

  /** 主线消息 */
  get messages(): readonly AgentNS.Message[] {
    return this.main;
  }

  /** 某一栏子 Agent 的消息（没有那一栏就是空数组） */
  subAgent(toolCallId: string): readonly AgentNS.Message[] {
    return this.columns.get(toolCallId) ?? [];
  }

  /** 一份只读样子 */
  snapshot(): MirrorSnapshot {
    return {
      conversationId: this.conversationId,
      status: this.statusValue,
      messages: [...this.main],
      subAgents: [...this.columns.entries()].map(([toolCallId, messages]) => ({
        toolCallId,
        messages: [...messages],
      })),
    };
  }

  /** 主线最后一条的 id —— 重连时 `message.list` 的 `after` 就是它 */
  lastMessageId(): string | undefined {
    return this.main.at(-1)?.id;
  }

  /** 换一格（`state` 事件的载荷，或 `conversation.state` 的现读值） */
  applyStatus(status: ConversationStatus): void {
    this.statusValue = status;
  }

  /**
   * 整段替换主线（`message.list` 的全量，或重连时本地最后一条 id 已经不在）。
   *
   * 子 Agent 那几栏**不动**：`message.list` 不带 `toolCallId` 时只回主线，把它们清掉等于把
   * 手里已有的那几栏凭空丢掉；真要重取某一栏，单独 `message.list { toolCallId }` 走一次。
   */
  replaceAll(messages: readonly AgentNS.Message[]): void {
    this.main = [...messages];
    this.noteSnapshot(messages);
  }

  /**
   * 替换 + 追加（重连时本地最后一条 id 还在）。
   *
   * 宿主回的**第一条就是 `anchor` 那条**，内容是它最新样子（上次拿到的可能正是流式中那一条，
   * 这段时间里它的内容变了）。所以从 `anchor` 起整段换成宿主给的：本地在它之前的部分原样留着，
   * 它自己与它之后的全部按宿主的来 —— 这叫替换，不是又追加一条（追加会在屏幕上留一段过期正文）。
   *
   * 本地找不到 `anchor`（被撤回 / 换过库）时按全量整段替换（那种情形宿主回的也是全量）。
   */
  mergeFrom(anchor: string | null, messages: readonly AgentNS.Message[]): void {
    const index = anchor === null ? -1 : this.main.findIndex((message) => message.id === anchor);
    if (index < 0) {
      this.replaceAll(messages);
      return;
    }
    this.main = [...this.main.slice(0, index), ...messages];
    this.noteSnapshot(messages);
  }

  /**
   * 折一条事件进来。
   *
   * `replay: true` 表示这是「打开对话期间攒下、快照落地之后补上」的那一批（见
   * {@link ConversationMirror.fromSnapshot} 的说明）。
   */
  apply(event: MirrorEvent, options: { replay?: boolean } = {}): void {
    switch (event.kind) {
      case "state":
        this.applyStatus(event.payload.status);
        return;
      case "message.added":
        this.added(event.payload.message, event.payload.toolCallId, options.replay === true);
        return;
      case "message.changed":
        this.changed(event.payload.message, event.payload.toolCallId);
        return;
      case "message.removed":
        this.removed(event.payload.messageId, event.payload.toolCallId);
        return;
      case "message.delta":
        this.delta(event.payload, options.replay === true);
        return;
    }
  }

  /** 一批补完：之后到达的增量不再受「快照已包含」这条限制 */
  endReplay(): void {
    this.fromSnapshot.clear();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private added(message: AgentNS.Message, toolCallId: string | undefined, replay: boolean): void {
    const column = this.columnOf(toolCallId);
    const index = column.findIndex((existing) => existing.id === message.id);
    if (index < 0) {
      column.push(message);
      return;
    }
    // 已经有了这一条：补的那一批里以快照为准（快照比它新），实时到达的直接整条换掉
    if (!replay) column[index] = message;
  }

  private changed(message: AgentNS.Message, toolCallId: string | undefined): void {
    const column = this.columnOf(toolCallId);
    const index = column.findIndex((existing) => existing.id === message.id);
    // 整条替换，不做字段级合并：消息上的字段一律整条带
    if (index < 0) column.push(message);
    else column[index] = message;
    this.fromSnapshot.delete(message.id);
  }

  private removed(messageId: string, toolCallId: string | undefined): void {
    const column = this.columnOf(toolCallId);
    const index = column.findIndex((existing) => existing.id === messageId);
    if (index >= 0) column.splice(index, 1);
    this.fromSnapshot.delete(messageId);
  }

  private delta(payload: EventPayload<"message.delta">, replay: boolean): void {
    const column = this.columnOf(payload.toolCallId);
    const message = column.find((existing) => existing.id === payload.messageId);
    // 认不出是哪条：它属于打开之前的那一段（快照里已经有它），这一片没有可折的地方
    if (!message) return;
    // 快照里已经有它，补的那一批再折一遍就是同一段字写两遍
    if (replay && this.fromSnapshot.has(payload.messageId)) return;
    // 与宿主攒消息用的是同一个函数：正文、内容段、工具参数串、流末用量都按同一套规则
    applyChunk(message, chunkOf(payload.delta));
  }

  /** 一条消息该放进哪一栏：给了 `toolCallId` 就是那一栏，没给就是主线 */
  private columnOf(toolCallId: string | undefined): AgentNS.Message[] {
    if (toolCallId === undefined) return this.main;
    const existing = this.columns.get(toolCallId);
    if (existing) return existing;
    const created: AgentNS.Message[] = [];
    this.columns.set(toolCallId, created);
    return created;
  }

  private noteSnapshot(messages: readonly AgentNS.Message[]): void {
    this.fromSnapshot = new Set(messages.map((message) => message.id));
  }
}
