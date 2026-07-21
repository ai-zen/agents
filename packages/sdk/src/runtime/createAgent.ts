import type { AgentNS } from "@ai-zen/agents-core";
import { AgentRepository } from "../crud/AgentRepository.js";
import { Capabilities } from "../capabilities/Capabilities.js";
import { SdkAgent } from "./SdkAgent.js";
import type { Provider } from "./Provider.js";
import { createModel } from "./createModel.js";

/**
 * 从磁盘创建 Agent（同步）。
 *
 * 内部创建 Capabilities 实例执行全局发现，读取 Agent 定义，
 * 过滤并实例化工具，产出 SdkAgent。
 *
 * ```ts
 * const agent = createAgent(runtime, "my-agent");
 * // agent 是 SdkAgent，可直接注册插件、发送消息
 * ```
 */
export function createAgent(
  provider: Provider,
  agentId: string,
): SdkAgent {
  const caps = new Capabilities(provider);
  const definition = new AgentRepository(provider.agentsDir).read(agentId);
  if (!definition) throw new Error(`Agent "${agentId}" 不存在`);

  const modelId = definition.modelId ?? provider.config.defaultModel;
  if (!modelId) throw new Error("未指定模型且无默认模型");

  const model = createModel(provider.config, modelId);

  const tools = caps.buildTools(definition.permissions ?? {}, {
    exclude: {
      subagents: definition.function?.name
        ? [definition.function.name]
        : undefined,
    },
  });

  // 收集当前注册的所有工具名称（用于 onUnknownTool 提示）
  const allToolNames = new Set(tools.map((t) => t.function.name));

  const agent = new SdkAgent({
    provider,
    definition,
    model,
    messages: definition.messages as AgentNS.Message[],
    tools,
    permissions: definition.permissions,
    caps,
  });

  // 设置 onUnknownTool 钩子：当 LLM 调用不存在的工具时，给出智能提示
  agent.onUnknownTool = (ctx) => {
    const toolName = ctx.toolCall.function?.name ?? "未知";

    // 检测 MCP 配置是否可用（provider 中有 mcpPaths 说明有 MCP 配置）
    const hasMcpConfig = provider.mcpPaths.length > 0;

    // 检测 call_mcp_tool 是否在工具列表中（被权限允许）
    const hasCallMcpTool = allToolNames.has("call_mcp_tool");

    // 列出所有可用工具名称
    const availableNames = Array.from(allToolNames);
    const availableList = availableNames.map((n) => `  - ${n}`).join("\n");

    let hint = "";
    if (hasMcpConfig && !hasCallMcpTool) {
      // 有 MCP 配置但 call_mcp_tool 被权限拒绝了
      hint = "\n提示：当前有 MCP 服务器配置，但 call_mcp_tool 权限已被禁用。如需使用 MCP 工具，请联系管理员调整权限。";
    } else if (hasMcpConfig && hasCallMcpTool) {
      // 有 MCP 且权限允许，但 LLM 直接用了 MCP 工具名而非 call_mcp_tool
      hint = "\n提示：MCP 服务器上的工具需要通过 call_mcp_tool 来调用，请先使用 load_mcp 连接服务器，再使用 call_mcp_tool。";
    }

    return `工具 "${toolName}" 不存在。当前可用的工具：\n${availableList}${hint}`;
  };

  return agent;
}
