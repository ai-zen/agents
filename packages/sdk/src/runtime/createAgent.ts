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

    const hasMcpConfig = provider.mcpPaths.length > 0;
    const hasCallMcpTool = tools.some((t) => t.function.name === "call_mcp_tool");

    if (hasMcpConfig && !hasCallMcpTool) {
      return `工具 "${toolName}" 不存在。当前有 MCP 服务器配置，但 call_mcp_tool 权限已被禁用，如需使用 MCP 工具请调整权限。`;
    }

    if (hasMcpConfig && hasCallMcpTool) {
      return `工具 "${toolName}" 不存在。如果要调用 MCP 工具，请使用 call_mcp_tool。`;
    }

    return `工具 "${toolName}" 不存在。`;
  };

  return agent;
}
