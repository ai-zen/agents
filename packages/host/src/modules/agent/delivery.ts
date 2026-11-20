import type { Agent, AgentNS } from "@ai-zen/agents-core";

import type { inboxTable } from "./inbox.js";

export interface DeliveryDeps {
  readonly inbox: ReturnType<typeof inboxTable>;
}

export interface DeliveryInput {
  readonly content: AgentNS.MessageContent;
  readonly source: AgentNS.MessageSource;
  readonly messageId: string;
}

/**
 * inbox 里的那一条：`messageId` 既是它落地成消息时用的 id，也是它在 inbox 表里的行 id ——
 * 所以这里比 core 的条目多要求一格：没有 id 就无从做那一行的身份，也就没法重启后放回队列。
 */
export type DeliveryEntry = AgentNS.InboxEntryWithContent & { messageId: string };

export class Delivery {
  /**
   * 装配还没完成、执行体还没有的那一段窗口里先收着的条目。
   *
   * 它们不进库：进库就是第二个队列，顺序、清理、与 `inbox.seq` 的关系都要再有一套规矩，
   * 而这一段窗口只有一次递话的时长。取走即忘 —— 留下副本同样等于第二个队列。
   */
  private readonly held = new Map<string, DeliveryEntry[]>();

  constructor(private readonly deps: DeliveryDeps) {}

  /**
   * 递一条话。调用方必须先有活着的执行体 —— 这个签名里没有「没有就造一个」的路，
   * 因为唤醒是另一个动作，不属于递话。
   */
  hand(sessionId: string, agent: Agent, input: DeliveryInput): DeliveryEntry {
    const entry: DeliveryEntry = {
      messageId: input.messageId,
      createdAt: new Date().toISOString(),
      // 高：内循环在工具跑完那个边界取一次件，所以它不必等到这一批彻底跑完；它也不打断
      // 正在吐的回答 —— 取件只发生在两次请求之间。
      priority: "high",
      source: input.source,
      content: input.content,
    };

    // 先落库再入队。反过来的话，崩在这两步之间时这一条只剩在内存里，进程一没就没发生过；
    // 而先落库最坏的代价是同一条被再取一次 —— 那一种重复认得出（它的 `messageId` 会在历史里）。
    this.deps.inbox.insert(sessionId, entry);
    agent.push(entry);

    return entry;
  }

  /** 装配还没完成时先收着的那几条 */
  hold(sessionId: string, entry: DeliveryEntry): void {
    const held = this.held.get(sessionId);
    if (held === undefined) this.held.set(sessionId, [entry]);
    else held.push(entry);
  }

  /** 取走收着的，按到达顺序 */
  takeHeld(sessionId: string): DeliveryEntry[] {
    const held = this.held.get(sessionId) ?? [];
    this.held.delete(sessionId);
    return held;
  }
}
