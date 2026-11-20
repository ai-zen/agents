/**
 * 会话草稿：`session.create` 发出去的那段会话，在第一条用户消息之前只活在这里（R56）。
 *
 * PRD F-C2 的原话是「没有用户消息就不写」，所以创建时不落 `sessions` 行：这里只记住
 * **id 与已经定死的身份**（项目 / 助手，PRD L7；模型与思考档位也在这份行里，只是它们可以改）。
 * 第一次真正用到它时（`session.start` 或 `session.send`，谁先到谁写，PLAN §4）由会话服务把
 * 这一份原样写进库，之后这段会话就与「创建即落库」的会话没有区别。
 *
 * 两处刻意的选择：
 *
 * 1. **存的是存储层的行形状**（`Session`），不是另造一份 DTO：草稿与真行在服务层走同一批
 *    代码路径（视图拼装、换模型、写思考档位），差别只在「有没有写进库」。
 * 2. **不持久化、不共享**：进程没了草稿就没了，这是预期结果（没发过消息的会话重连后消失）。
 *    所以这里没有计时器，也没有落盘。
 */

import type { Session } from "../storage/types.js";

/**
 * 会话服务要用到的草稿读写口（结构上 {@link SessionDrafts} 满足，用例可给替身）。
 *
 * 只暴露服务层真正需要的三个动作：取出、放进、扔掉；「换成一个真行」是服务层自己做的事。
 */
export interface SessionDraftStore {
  get(sessionId: string): Session | undefined;
  /** 取出并摘掉（落库那一刻用：先摘再写，并发的第二次就抢不到同一份草稿） */
  take(sessionId: string): Session | undefined;
  put(draft: Session): void;
  forget(sessionId: string): void;
}

export class SessionDrafts implements SessionDraftStore {
  private readonly drafts = new Map<string, Session>();

  get(sessionId: string): Session | undefined {
    return this.drafts.get(sessionId);
  }

  put(draft: Session): void {
    const id = typeof draft.id === "string" ? draft.id.trim() : "";
    if (id === "") return;
    this.drafts.set(id, { ...draft, id });
  }

  /**
   * 取出并摘掉（落库那一刻用）。
   *
   * 摘除与落库分开是故意的：先同步摘掉，两次并发的 `send` 里后到的那一次就看不到草稿，
   * 不会两次插同一行。
   */
  take(sessionId: string): Session | undefined {
    const draft = this.drafts.get(sessionId);
    if (!draft) return undefined;
    this.drafts.delete(sessionId);
    return draft;
  }

  forget(sessionId: string): void {
    this.drafts.delete(sessionId);
  }
}
