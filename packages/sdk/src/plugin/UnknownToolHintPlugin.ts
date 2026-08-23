import type { AgentPlugin, UnknownToolContext } from "@ai-zen/agents-core";
import type { Provider } from "../runtime/Provider.js";

/**
 * 未知工具智能提示插件 — MCP 场景引导。
 *
 * 当 LLM 调用不存在的工具时，根据当前环境给出更智能的提示：
 *   - 有 MCP 配置但 `call_mcp_tool` 不在工具列表中（权限禁用）→ 提示权限问题
 *   - 有 MCP 配置且 `call_mcp_tool` 可用 → 提示使用 `call_mcp_tool`
 *   - 否则 → 仅提示工具不存在
 *
 * 由调用方显式注册（`agent.use(new UnknownToolHintPlugin({ provider }))`）。
 * 未注册时，Agent 回落到底层的简单文本默认提示（core 内建）。
 */
export class UnknownToolHintPlugin implements AgentPlugin {
  /** 全局 Provider 实例 */
  private readonly provider: Provider;

  constructor(options: { provider: Provider }) {
    this.provider = options.provider;
  }

  onUnknownTool(ctx: UnknownToolContext): string | undefined {
    const toolName = ctx.toolCall.function?.name ?? "未知";
    const hasMcpConfig = this.provider.mcpPaths.length > 0;
    const hasCallMcpTool = ctx.availableTools.some(
      (t) => t.function.name === "call_mcp_tool",
    );

    if (hasMcpConfig && !hasCallMcpTool) {
      return `工具 "${toolName}" 不存在。当前有 MCP 服务器配置，但 call_mcp_tool 权限已被禁用，如需使用 MCP 工具请调整权限。`;
    }
    if (hasMcpConfig && hasCallMcpTool) {
      return `工具 "${toolName}" 不存在。如果要调用 MCP 工具，请使用 call_mcp_tool。`;
    }
    return `工具 "${toolName}" 不存在。`;
  }
}
