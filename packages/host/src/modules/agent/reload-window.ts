/**
 * 正在重装的那几段会话：从「已经杀掉」到「装回来」之间，库里那一份排队区不跟着作废。
 *
 * 它只回答一个问题，而且只有观察者问：一条 `inboxCleared` 事实要不要把库里那几行删掉。杀死就是
 * 作废（`dev-docs/prd/04-session.md` 的「中断不是杀死」那张表：没消费的 InboxEntry「作废，库里也删」），
 * 重装不是 —— 那些 InboxEntry 正等着被放回新装起来的 Agent（`dev-docs/prd/05-control.md` 的「换模型不是
 * 杀死」：改配置引起的重建，inbox 里的东西一句不丢；`dev-docs/prd/07-handoff.md` 同一句：换掉 agent
 * 不丢 inbox）。
 *
 * 两条路共用同一个内核事实（`kill()` 清空队列并报 `inboxCleared`），后果却相反，区别只在宿主这一
 * 层 —— 与关机时那一条判据（`HostObserver.shutdown`）同一个形状：内核那一格一个字都不改。
 *
 * 用计数而不是布尔：同一段会话上两次重装叠在一起时（两次改动几乎同时写进 messages），先结束的那一次不该把
 * 另一次还开着的窗口关掉。
 *
 * 窗口挡的是那一次清空，不是用户的决定：用户在这个窗口里按「清空排队区」照样清得掉 —— 那一支不走
 * 这条判据（没有活 Agent 时它直接删库行），于是那些 InboxEntry 算作废。
 */
export class ReloadWindow {
  private readonly open = new Map<string, number>();

  /** 这段会话进入重装：从这一刻起，它那一次清空不作废库里那几行 */
  enter(sessionId: string): void {
    this.open.set(sessionId, (this.open.get(sessionId) ?? 0) + 1);
  }

  /** 这段会话装回来了（或者这一次重装没成）。没有进过窗口时是空动作 */
  leave(sessionId: string): void {
    const count = this.open.get(sessionId);
    if (count === undefined) return;
    if (count <= 1) this.open.delete(sessionId);
    else this.open.set(sessionId, count - 1);
  }

  /** 这段会话此刻在窗口里吗 —— 观察者问的就是这一句 */
  covers(sessionId: string): boolean {
    return this.open.has(sessionId);
  }
}
