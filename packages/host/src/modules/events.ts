import type { AgentNS } from "@ai-zen/agents-core";

import type { Notice } from "./notice/types.js";
import type { Question } from "./question/types.js";
import type { Session } from "./session/types.js";

/**
 * 推给客户端的事实。全部是「事实变了」，不是「阶段到了」——所以这里没有「这一轮跑完了」这种东西，
 * 要知道它闲没闲看 `agent.status`。
 *
 * 每条只带一件事：需要几个值一起变的场合，那些值本身就该一起变；把三件事塞进一条事件，
 * 接收方就得判断「这次来的是哪几件变了」。
 */
export type HostEvent =
  | {
      readonly type: "message.added";
      readonly sessionId: string;
      readonly message: AgentNS.Message;
    }
  | {
      readonly type: "message.changed";
      readonly sessionId: string;
      readonly message: AgentNS.Message;
    }
  | { readonly type: "message.removed"; readonly sessionId: string; readonly messageId: string }
  /**
   * subagent 说的话。它从不入库，所以单独一条：混进上面三条，客户端会把它当成主转录里的一句话。
   * `toolCallId` 是它挂在哪次工具调用上，界面靠它在输入框上方分页。
   */
  | {
      readonly type: "subagent.message";
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly message: AgentNS.Message;
    }
  | {
      readonly type: "agent.status";
      readonly sessionId: string;
      readonly status: AgentNS.AgentState;
    }
  | {
      readonly type: "agent.paused";
      readonly sessionId: string;
      readonly side: "input" | "output";
      readonly paused: boolean;
    }
  | { readonly type: "agent.alive"; readonly sessionId: string; readonly alive: boolean }
  | {
      readonly type: "agent.inbox";
      readonly sessionId: string;
      readonly inbox: readonly AgentNS.InboxEntry[];
    }
  /**
   * 会话行变了。整个一行带走，不说哪几格动过：新建与改动对客户端是同一个动作 —— 拿这一份
   * 替换掉它手里那一行，要说「变了哪些格」就得让客户端知道宿主每次改了哪几处。
   */
  | { readonly type: "session.changed"; readonly session: Session }
  /**
   * 这一段没了。删成功之后发：发起删除的那个客户端自己会换屏，而同一台机器上另一个连着的客户端
   * 要等到下一次 `session.list` 才会发现列表里少了一段。
   *
   * 只带 id：那一段行已经没了，再带一份整行就是发一份读不回来的东西。会话自己的通知、消息、
   * 排队区都随它一起没了，收方不必逐样收，清掉这一段就对了。
   */
  | { readonly type: "session.removed"; readonly sessionId: string }
  /**
   * 这段会话在交接。输入框能不能发、界面上要不要直说「正在交接」都看它。
   *
   * 不并进 `session.changed`：交接态不落在会话行上，混进那一行就得给它编一个并不存在的字段。
   */
  | { readonly type: "session.handoff"; readonly sessionId: string; readonly handingOff: boolean }
  | { readonly type: "notice"; readonly notice: Notice }
  /**
   * 清掉了哪一档：清一条带 `id`，清一段会话带 `sessionId`，两格都不带就是清掉了全部。
   * 清掉的若是全局通知，`sessionId` 那一格跟着空：它不属于哪一段，收到的人该动的是自己那个栏位。
   */
  | { readonly type: "notice.cleared"; readonly id?: string; readonly sessionId?: string }
  | {
      readonly type: "question.asked";
      readonly sessionId: string;
      readonly question: Question;
    }
  /**
   * 答了就没了，所以这条只带 `questionId`，不重复整道题：客户端据此把那一块收起来。
   */
  | {
      readonly type: "question.answered";
      readonly sessionId: string;
      readonly questionId: string;
      readonly value: string;
    };
