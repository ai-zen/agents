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
 * （没人看着就不提问），而那条判定的用户在 `QuestionBroker` 手里（见
 * `docs/zh/architecture.md` 的「`server` 包的目录」）。所以它与 `phase.ts` 同归 `lib/`，不进 `domain/`。
 */

import type { ServerEvent } from "../protocol/index.js";

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
   * 本版**没有**任何判定挂在它上面：提问曾经靠它判「没人看就不问」，而题目变成槽位之后那条
   * 判定退场了（没人看也登记，后来的人从快照里补看 —— 见 `QuestionBroker` 文件头）。留着它
   * 是因为「此刻有没有人在看」是排查时最直接的一个数，也是「槽位与订阅解耦」这件事的唯一
   * 可观测点（用例用它证明“一个订阅者都没有时槽位照样存在”）。
   */
  watcherCount(): number {
    return this.listeners.size;
  }

  /** 关停时用：断掉全部订阅 */
  clear(): void {
    this.listeners.clear();
  }
}
