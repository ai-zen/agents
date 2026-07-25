import type { AgentNS } from "@ai-zen/agents-core";
import { AgentRepository } from "../crud/AgentRepository.js";
import { SdkAgent } from "./SdkAgent.js";
import type { Provider } from "./Provider.js";
import { createModel } from "./createModel.js";

/**
 * 从磁盘创建 Agent（异步）。
 *
 * 通过 Provider 获取已发现的能力，读取 Agent 定义，过滤并实例化工具，产出 SdkAgent。
 *
 * ```ts
 * const agent = await createAgent(provider, "my-agent");
 * // agent 是 SdkAgent，可直接注册插件、发送消息
 * ```
 */
export async function createAgent(
  provider: Provider,
  agentId: string,
): Promise<SdkAgent> {
  const definition = new AgentRepository(provider.agentsDir).read(agentId);
  if (!definition) throw new Error(`Agent "${agentId}" 不存在`);

  const modelId = definition.modelId ?? provider.config.defaultModel;
  if (!modelId) throw new Error("未指定模型且无默认模型");

  const model = createModel(provider, modelId);

  const tools = provider.buildTools(definition.permissions ?? {}, {
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
  });

  return agent;
}
