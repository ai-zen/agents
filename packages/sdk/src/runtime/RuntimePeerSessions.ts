import type { Agent } from "@ai-zen/agents-core";
import type { AgentRuntime } from "./AgentRuntime.js";
import type {
  PeerSessionCreateInput,
  PeerSessionCreated,
  PeerSessionPort,
  PeerSessionPostInput,
  PeerSessionPosted,
  PeerSessionStatus,
} from "../scope/plugins/peers/peerSessionTools.js";

/**
 * PeerSession 的端口，由运行时实现 —— 于是那三个工具在没有宿主时也能用。
 *
 * 这一层只做一件翻译：工具拿到的 `caller` 是一个 Agent（`ctx.agent`），运行时的动作要的是
 * 一段会话的身份。「谁在说话」这件事只有登记表答得出，所以翻译放在这里，工具那一侧永远不必
 * 知道会话与 Agent 是两个东西。
 */
export class RuntimePeerSessions implements PeerSessionPort {
  constructor(private readonly runtime: AgentRuntime) {}

  /**
   * 开一段：调用方必须是某一段会话自己的 Agent。
   *
   * 查不到 = 它不是任何一段会话的 Agent（被派出去的那个），它开出来的会话没有人认领 ——
   * 与「这一段自己也是别人开的」同一类拒绝：这一层不许再开。
   */
  async create(input: PeerSessionCreateInput): Promise<PeerSessionCreated> {
    const from = this.runtime.sessionOf(input.caller);
    if (from === undefined) return { ok: false, reason: "depth_exceeded" };

    return this.runtime.openPeer({
      from,
      prompt: input.prompt,
      agentId: input.agentId,
      modelId: input.modelId,
      label: input.label,
    });
  }

  /** 现读那一格：忙不忙、名字、最近一句的摘要。`caller` 不参与判断（谁都能看谁） */
  async status(input: { caller: Agent; sessionId: string }): Promise<PeerSessionStatus> {
    return this.runtime.status(input.sessionId);
  }

  /**
   * 投一句。
   *
   * 投递不看关系，但发话要有一个可以署名的身份：被派出去的 Agent 不属于
   * 任何一段会话，它说的每句话都会被记成「来自谁」而那一格是空的。这是错的装配 —— 它手上
   * 本来就不该有这三个工具 —— 所以当场抛，而不要给一个说着别的事的拒绝理由。
   */
  async post(input: PeerSessionPostInput): Promise<PeerSessionPosted> {
    const from = this.runtime.sessionOf(input.caller);
    if (from === undefined) {
      throw new Error(
        "post_message needs an agent of a session: this agent is not one (an agent delegated " +
          "as a tool speaks through the session that delegated to it)",
      );
    }

    return this.runtime.post({ from, to: input.sessionId, content: input.content });
  }
}
