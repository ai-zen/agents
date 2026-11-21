import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import type { SessionService } from "../session/service.js";

/**
 * 交接态变了要推给客户端的那一格：输入框能不能发、这段要不要标成「正在交接」都看它。
 *
 * 没有并进 `HostEvent`：那是客户端事件的唯一形状，加一格要连客户端的类型一起改，而这一格还
 * 没定下来。接线那一次并进去，这个别名随即删掉 —— 留着它就是第二份事件清单。
 */
export type HandoffEvent = {
  readonly type: "session.handoff";
  readonly sessionId: string;
  readonly handingOff: boolean;
};

export interface HandoffDeps {
  readonly sessions: SessionService;
  readonly events: Bus<HandoffEvent>;
  readonly t: Translator;
}

/**
 * 交接：这段会话的记忆要被换成新的一份的那段时间。
 *
 * 「这段在交接」是内存里的一格，不落会话行：它只在这一趟活着期间成立，进程没了这一趟也就没了。
 * 会话行上的 `pendingHandoff` 是另一件事 —— 那是「答完交接题的那一刻不闲、等它变闲再兑现」的
 * 一项待办；两件事可以同时成立，写进同一格之后就读不出眼前说的是哪一件。
 *
 * 换记忆那一步不在这里，因为它要一个库事务（插存档会话行、把旧消息行改挂到存档名下、写回新
 * 记忆的那几条），而 `session/` 还没有这样一个口：它只有单张表各自的行级读写。
 */
export class HandoffService {
  private readonly handingOff = new Set<string>();

  constructor(private readonly deps: HandoffDeps) {}

  start(sessionId: string): void {
    if (this.deps.sessions.get(sessionId) === undefined) {
      throw new HostError(
        "not_found",
        this.deps.t("找不到 id 为 {sessionId} 的会话", { sessionId }),
        { entity: "session", sessionId },
      );
    }

    // 同一段不并排放两趟：两趟各自结束时都会清掉这一格，先结束的那一趟清完，后一趟写的消息
    // 就又开始落库了 —— 那正是「交接期间不落库」要防的事。
    if (this.handingOff.has(sessionId)) {
      throw new HostError("busy", this.deps.t("会话 {sessionId} 正在交接", { sessionId }), {
        entity: "session",
        sessionId,
        reason: "handoff_in_progress",
      });
    }

    this.handingOff.add(sessionId);
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: true });
  }

  /** 退出交接态。取消与正常结束两条路都会叫到这里；第二次到时事实没有变化，不再推事件 */
  finish(sessionId: string): void {
    if (!this.handingOff.delete(sessionId)) return;
    this.deps.events.emit({ type: "session.handoff", sessionId, handingOff: false });
  }

  /** 写库那条路动手之前问这一格：交接期间这段会话的消息照样推事件，但不落库 */
  isHandingOff(sessionId: string): boolean {
    return this.handingOff.has(sessionId);
  }
}
