import type { AgentNS } from "@ai-zen/agents-core";

/**
 * 推给客户端的事实。全部是「事实变了」，不是「阶段到了」——所以这里没有「这一轮跑完了」这种东西，
 * 要知道它闲没闲看 `agent.status`。
 *
 * 每条只带一件事：需要几个值一起变的场合，那些值本身就该一起变；把三件事塞进一条事件，
 * 接收方就得判断「这次来的是哪几件变了」。
 */
export type HostEvent =
  | { readonly type: "message.added"; readonly sessionId: string; readonly message: AgentNS.Message }
  | { readonly type: "message.changed"; readonly sessionId: string; readonly message: AgentNS.Message }
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
  | { readonly type: "agent.status"; readonly sessionId: string; readonly status: AgentNS.AgentState }
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
    };
