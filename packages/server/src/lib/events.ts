/**
 * 事件出口 —— 服务端**唯一**一条「推给客户端」的线。
 *
 * 会话事件（阶段 / 增量 / 收尾 / 对话内通知）和全局通知都从这里出去。
 * 抽出来的理由：两类通知的来源不同（会话管理器 vs 服务本身），但**传输是同一条**——
 * 客户端不该为了收全局通知去开第二条订阅。
 *
 * 订阅方是连接，不是会话：一条连接可以同时看多个会话的事件，事件载荷里带 `sessionId`，
 * 由客户端决定贴在哪（对话内的贴会话，全局的贴状态栏）。
 *
 * ## 为什么它住在 `lib/`
 *
 * 它是“把一条事件扇出去”这件机理，没有任何业务判断 —— 唯一的“业务”是 `watcherCount()`
 * （没人看着就不提问），而那条判定的用户在 `QuestionBroker` 手里（见 `target-architecture.md`
 * 里“别合并 EventHub”那一条）。所以它与 `phase.ts` 同归 `lib/`，不进 `domain/`。
 */

import type { ServerEvent } from "@ai-zen/agents-protocol";

export class EventHub {
  private readonly listeners = new Set<(event: ServerEvent) => void>();

  /** 订阅；返回取消订阅的函数（连接断开时调用） */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 一个订阅方（某条连接）写失败不该影响别的客户端收到事件
      }
    }
  }

  /**
   * 当前有多少个订阅者（客户端连接）。
   *
   * 会话层用它判断「这个问题有没有人看得见」：会话活得比连接久（客户端退出后 Agent
   * 仍在服务端活着），此时发一条提问没有任何人能看见、更没人能答 —— 那只是把这一轮
   * 挂到超时才继续。见 `SessionManager.askHandoffMode`。
   */
  watcherCount(): number {
    return this.listeners.size;
  }

  /** 关停时用：断掉全部订阅 */
  clear(): void {
    this.listeners.clear();
  }
}
