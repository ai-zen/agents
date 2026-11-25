/**
 * MCP elicitation 的答题通道安装器 — McpElicitationPlugin
 *
 * 为什么是插件：题必须挂在**某一段会话**下（`QuestionRegistry` 按会话列），而这件事只有宿主知道
 * （`materialsFor` 手里有那一段的会话行）。插件由宿主按会话装上，装的时候把那一段的 id 与题板
 * 一起交进来；之后 `call_mcp_tool` 发起调用时按 Agent 把这条通道压进 MCP 那一侧的栈
 * （`scope/plugins/mcp/elicitation.ts`），服务器发回来的 `elicitation/create` 就知道该问谁。
 *
 * 为什么不是「每段会话各建一条 MCP 连接」：MCP 客户端按 Scope（一个工作目录）共享，一段目录下的
 * 会话共用同一条连接 —— 那是刻意的（连接有进程、有握手、有清单）。于是「哪段会话」只能靠记账，
 * 不能靠连接本身。
 *
 * 一次性 Agent（子 agent、`runOnce`）不装这一层：它们没有题板，手上也就没有能答题的人。
 */
import type { AgentPlugin, LifecycleContext } from "@ai-zen/agents-core";

import { volunteerElicitation, type ElicitationOwner } from "../scope/plugins/mcp/elicitation.js";

export class McpElicitationPlugin implements AgentPlugin {
  constructor(private readonly owner: ElicitationOwner) {}

  /**
   * 挂在这一拍而不是构造函数里：插件是先造、再 `agent.use()`、最后 `start()` 的，构造时手上
   * 还没有 Agent 对象。`onStart` 是「要开跑了、Agent 已经拼好」那一刻。
   */
  onStart({ agent }: LifecycleContext): void {
    volunteerElicitation(agent, this.owner);
  }
}
