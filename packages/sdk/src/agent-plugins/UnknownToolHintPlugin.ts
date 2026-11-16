import type { AgentPlugin, ToolHookContext } from "@ai-zen/agents-core";
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
 * 未注册时，core 自己回落到简单文本提示（`未知工具: X，没有找到对应的工具实现。`）。
 *
 * 是否"有 MCP 配置"经 `scope.getPluginById(McpScopePlugin.ID)` 查询 MCP 插件获得。
 *
 * ## 钩子：`onToolStart`（`onUnknownTool` 已删除）
 *
 * core 重写后没有单独的「未知工具」钩子了 —— 未知工具也走 `onToolStart`，只是
 * `ctx.toolCall.tool === undefined`（没匹配到已注册的实现）。于是本插件就守在这条缝上：
 * 判到「工具不存在」才返回提示字符串，其余一律放行（返回 undefined）。
 *
 * 返回的字符串**就是那条 tool 消息的正文**（core 会把它作为拒绝原因回给模型），
 * 因此模型读到的是引导、而不是默认的「没有找到对应的工具实现」。
 */
export class UnknownToolHintPlugin implements AgentPlugin {
  private readonly scope: Scope;

  constructor(options: { scope: Scope }) {
    this.scope = options.scope;
  }

  onToolStart(ctx: ToolHookContext): string | undefined {
    // 只关心「工具不存在」：匹配到实现的一律放行，别抢别的工具的活
    if (ctx.toolCall.tool !== undefined) return;

    const toolName = ctx.toolCall.tool_call.function?.name ?? "unknown";
    const mcpPlugin = this.scope.getPluginById<McpScopePlugin>(McpScopePlugin.ID);
    const hasMcpConfig = mcpPlugin?.hasConfig() ?? false;
    const hasCallMcpTool = ctx.agent.tools.some((t) => t.function.name === "call_mcp_tool");

    if (hasMcpConfig && !hasCallMcpTool) {
      return `Tool "${toolName}" does not exist. An MCP server is configured, but the call_mcp_tool permission is disabled — adjust permissions if you need to use MCP tools.`;
    }
    if (hasMcpConfig && hasCallMcpTool) {
      return `Tool "${toolName}" does not exist. To call MCP tools, use call_mcp_tool.`;
    }
    return `Tool "${toolName}" does not exist.`;
  }
}
