/**
 * 一段对话的**镜像**：按到达的事件把 `messages` 重建出来，另外记住四格里的那一格、
 * 子 agent 名册与交接态。
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
 * 两种厂商行为 —— 每条都有自己的边界情形。所以这里**不自己写**这套规则，直接调 core 的
 * `applyChunk`：宿主跑 agent 时攒消息用的就是它，同一份函数在两边跑，入参也是同一片东西
 * （`message.delta` 载荷里的 `AgentNS.Delta` 原样）—— 于是攒出来的那条消息与宿主存下来的
 * 逐字一致。这就是「完美镜像」的全部保证。
 *
 * 用量与结束原因**不在这片增量里**（它们是那次响应的外层字段，不进 `applyChunk`）：它们跟着
 * `message.changed` 整条回来。
 *
 * ## 只管这三样东西
 *
 * ① `messages`：主线一栏 + 按 `toolCallId` 归好的子 Agent 各栏；
 * ② 四格 `status`（忙 / 闲 / 暂停 / 死），来自 `state` 事件；还没读到时是 `null`
 *    （不是「死」—— 死是四格里带「发话前先复活」动作的那一格，拿它当「还没读到」的占位是借词），
 *    读到 `conversation.state` 的现读值之后才有一格；
 * ③ `conversation.state` 的另外两格：子 agent **名册**（只用来铺栏）与**交接态**
 *    （非空即「正在交接」）。
 *
 * 子 agent 那一栏的消息**一律来自事件**（每条消息事件都带 `toolCallId`）：子 agent 不入库，
 * 也就没有第二个地方可以补 —— 重连之后靠名册把栏铺回来，内容靠之后的事件继续长。
 *
 * 用量**不在这里**：每条消息自带 `usage`，要显示就把消息上的 `usage` 自己加起来（core 不管
 * 用量，没有求和函数）—— 客户端不为了用量再养一条事件与一份汇总，那两份东西与消息上的事实
 * 迟早对不上。
 *
 * ## 就地改，不返回新对象
 *
 * `applyChunk` 的契约就是「就地攒进 `receiver`」。于是镜像里的消息对象是**活的**：读的人拿到
 * 的数组与对象会被后续增量就地更新。界面要重画，请按到达的事件重画，不要靠比较引用 ——
 * 引用一直是同一个。
 */

import { applyChunk } from "@ai-zen/agents-core";
import type {
  AgentNS,
  ConversationState,
  ConversationStatus,
  EventPayload,
} from "@ai-zen/agents-host";

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

/**
 * 名册上的一行：哪一个子 agent、叫什么、跑到哪一格了（`conversation.state.subAgents` 原样）。
 *
 * 它只用来**铺栏**（重连之后一次问清有哪些栏），栏里的消息一律来自事件（`toolCallId`）——
 * 子 agent 的消息不入库，也就没有第二个地方可以补。
 */
export interface SubAgentFact {
  toolCallId: string;
  name: string;
  state: AgentNS.AgentState | "ended";
}

/** 镜像的一份只读样子（给界面与用例看，不是另一份数据） */
export interface MirrorSnapshot {
  conversationId: string;
  /**
   * 四格里那一格；`null` = **还没读到**。
   *
   * 镜像刚建出来时（打开对话的这一刻）还没读 `conversation.state`，所以它什么都还不是：
   * 不是「死」—— 死是四格里带「发话前先复活」动作的那一格，把「还没读到」报成死，界面就会
   * 去提示复活一段其实好端端的对话。拿到读数（`applyReadout`）之后才有一格。
   */
  status: ConversationStatus | null;
  /** 主线消息（不属于任何子 Agent 的那些），顺序即对话里的先后 */
  messages: readonly AgentNS.Message[];
  /** 按 `toolCallId` 归好的子 Agent 各栏 */
  subAgents: SubAgentColumn[];
  /** 名册（现读的那一份；没读过就是空） */
  roster: SubAgentFact[];
  /** 非空就是「正在交接」（与四格分开：交接期间这段照旧是忙 / 闲 / 暂停） */
  handoff: { since: string } | null;
}

/** 一段对话的镜像：主线一栏、子 Agent 各一栏、四格里那一格，外加名册与交接态 */
export class ConversationMirror {
  readonly conversationId: string;
  /** 四格里那一格；还没读到就是 `null`（见 {@link MirrorSnapshot.status}） */
  private statusValue: ConversationStatus | null;
  private main: AgentNS.Message[] = [];
  private readonly columns = new Map<string, AgentNS.Message[]>();
  private rosterValue: SubAgentFact[] = [];
  private handoffValue: { since: string } | null = null;
  /**
   * 「这一条是从快照里来的」—— 只在打开对话的那一小段时间有意义。
   *
   * 打开时先订阅、再拉快照，拉取期间到达的事件先攒着，快照落地之后按序补上。补的那一批里，
   * 属于快照已包含的那些消息的增量**不再折一遍**：快照里的内容已经是它的最新样子，再折一次
   * 就是同一段字写两遍。宁可少写（下一条 `message.changed` 会把整条带回来）也不写重。
   */
  private fromSnapshot = new Set<string>();

  /**
   * `status` 是**打开这一刻已知的那一格**：还没读过 `conversation.state` 就给 `null`（还没读到）。
   *
   * 不给它一个四格里的值去占位：死是带动作的一格（发话前先复活），借来当「还不知道」的占位，
   * 读的人就分不出「这段真的没驱动者」与「我还没读到」。
   */
  constructor(init: { conversationId: string; status: ConversationStatus | null }) {
    this.conversationId = init.conversationId;
    this.statusValue = init.status;
  }

  /** 四格里的那一格；还没读到就是 `null` */
  get status(): ConversationStatus | null {
    return this.statusValue;
  }

  /** 名册（现读的那一份；客户端只用它铺栏） */
  get roster(): readonly SubAgentFact[] {
    return this.rosterValue;
  }

  /** 正在交接就是它的开始时刻；不在交接就是 `null` */
  get handoff(): { since: string } | null {
    return this.handoffValue;
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
      roster: [...this.rosterValue],
      handoff: this.handoffValue,
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
   * 收下 `conversation.state` 的三格（四格里的那一格 + 名册 + 交接态）。
   *
   * 这也是 `status` 从 `null`（还没读到）**真正变成一格**的那一刻；之后由 `state` 事件一路换
   * 下去（`applyStatus`）。
   *
   * 名册只**加栏、不删栏**：它说的是「这一段此刻有哪几个子 agent」，而栏里的消息是事件一条
   * 一条攒起来的。名册被清空（下一批开始了）不等于那些话没说过 —— 所以已经攒下的栏原样留着。
   *
   * 交接态非空就是「正在交接」：界面要把它与四格分开显示（交接期间输入框拦住、只留中断）。
   * 它什么时候消失由 `memory_replaced` 那条事件带着重拉决定 —— 交接收尾时宿主会推它。
   */
  applyReadout(state: Pick<ConversationState, "status" | "subAgents" | "handoff">): void {
    this.statusValue = state.status;
    this.rosterValue = [...state.subAgents];
    this.handoffValue = state.handoff;
    // 名册上有的栏先摆出来（空栏也是一栏），之后到达的事件往里面长
    for (const fact of state.subAgents) this.columnOf(fact.toolCallId);
  }

  /**
   * 整段替换主线（`message.list` 的全量、重连时本地最后一条 id 已经不在、`memory_replaced`
   * 之后的重拉）。
   *
   * 子 Agent 那几栏**不动**：`message.list` 不带 `toolCallId` 时只回主线，把它们清掉等于把
   * 手里已有的那几栏凭空丢掉；而子 agent 的消息不入库，**没有**「再拉一次某一栏」这回事
   * （重连之后靠名册把栏铺回来，内容靠之后的事件继续长）。
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
    // 与宿主攒消息用的是同一个函数，入参也是同一片东西：`message.delta` 的载荷
    // 就是 core 的 `AgentNS.Delta`，原样交给 `applyChunk`，不必包成别的形状。
    // 用量与结束原因不在这里（它们不属于增量）：那条消息定下来时由 `message.changed` 整条带回来。
    applyChunk(message, payload.delta);
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
