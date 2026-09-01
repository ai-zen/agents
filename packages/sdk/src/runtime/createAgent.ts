import type { AgentNS } from "@ai-zen/agents-core";
import { AgentRepository } from "../crud/AgentRepository.js";
import { SdkAgent } from "./SdkAgent.js";
import type { Provider } from "./Provider.js";
import { createModel } from "./createModel.js";

/**
 * 从磁盘创建 Agent。
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
  const definition = await new AgentRepository(provider.agentsDir).read(agentId);
  if (!definition) throw new Error(`Agent "${agentId}" 不存在`);

  const modelId = definition.modelId ?? provider.config.defaultModel;
  if (!modelId) throw new Error("未指定模型且无默认模型");

  const { client, model, modelConfig } = createModel(provider, modelId);

  const tools = provider.buildTools(definition, {
    exclude: {
      subagents: definition.function?.name
        ? [definition.function.name]
        : undefined,
    },
  });

  const agent = new SdkAgent({
    provider,
    definition,
    client,
    model,
    modelConfig,
    // 在 createAgent 层做模板快照（拷贝），隔离 definition.messages 的引用。
    // AgentContext.messages 是 mutable 运行时数组，若直接把 definition.messages
    // 传入，对话期间 append() 会反向污染 Agent 定义模板——definition.messages
    // 被塞入完整历史后，迁移 prune/omit 失效、/new 继承旧历史。
    // 快照后，运行时改动只作用于会话副本，模板保持纯净。
    messages: [...(definition.messages ?? [])] as AgentNS.Message[],
    tools,
  });

  return agent;
}
