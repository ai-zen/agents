import type { AgentPlugin, UnknownToolContext } from "@ai-zen/agents-core";
import type { Scope } from "../scope/Scope.js";
import { McpScopePlugin } from "../scope/plugins/mcp/McpScopePlugin.js";

/**
 * 未知工具智能提示插件 — MCP 场景引导。
 *
 * 当 LLM 调用不存在的工具时，根据当前环境给出更智能的提示：
 *   - 有 MCP 配置但 `call_mcp_tool` 不在工具列表中（权限禁用）→ 提示权限问题
 *   - 有 MCP 配置且 `call_mcp_tool` 可用 → 提示使用 `call_mcp_tool`
 *   - 否则 → 仅提示工具不存在
 *
 * 由调用方显式注册（`agent.use(new UnknownToolHintPlugin({ scope }))`）。
 * 未注册时（或返回 `undefined` 时），core 自己回落到简单文本提示
 * （`未知工具: X，没有找到对应的工具实现。`）。
 *
 * 是否"有 MCP 配置"经 `scope.getPluginById(McpScopePlugin.ID)` 查询 MCP 插件获得。
 *
 * ## 钩子：`onUnknownTool`
 *
 * 「未知工具」与「工具开始」是**两个问题**，core 分别用两个钩子问，一次工具调用只走其中一个：
 *   - `onToolStart`：工具**存在**，问「要不要开始跑」；
 *   - `onUnknownTool`：工具**不存在**，问「模型调了个不存在的工具，要怎么回应它」。
 *
 * 本插件守的是后一条缝 —— 于是不必再自己判「工具在不在」：来到这里就是不存在。
 * 被调用的工具名与当时全部可用的工具都在入参里（`toolCall.function?.name` /
 * `availableTools`），不必去别处捞。
 *
 * 返回的字符串**就是那条 tool 消息的正文**：模型读到的是引导，而不是默认的
 * 「没有找到对应的工具实现」；返回 `undefined` 则交回 core 走默认文案。
 */
export class UnknownToolHintPlugin implements AgentPlugin {
  private readonly scope: Scope;

  constructor(options: { scope: Scope }) {
    this.scope = options.scope;
  }

  onUnknownTool(ctx: UnknownToolContext): string | undefined {
    const toolName = ctx.toolCall.function?.name ?? "unknown";
    const mcpPlugin = this.scope.getPluginById<McpScopePlugin>(McpScopePlugin.ID);
    const hasMcpConfig = mcpPlugin?.hasConfig() ?? false;
    const hasCallMcpTool = ctx.availableTools.some((t) => t.function.name === "call_mcp_tool");

    if (hasMcpConfig && !hasCallMcpTool) {
      return `Tool "${toolName}" does not exist. An MCP server is configured, but the call_mcp_tool permission is disabled — adjust permissions if you need to use MCP tools.`;
    }
    if (hasMcpConfig && hasCallMcpTool) {
      return `Tool "${toolName}" does not exist. To call MCP tools, use call_mcp_tool.`;
    }
    return `Tool "${toolName}" does not exist.`;
  }
}
