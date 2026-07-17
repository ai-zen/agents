import type { AgentNS } from "@ai-zen/agents-core";
import { readAgent } from "../crud/agents";
import { Capabilities } from "../capabilities/capabilities";
import { SdkAgent } from "./sdk-agent";
import type { Provider } from "./runtime";

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
  const definition = readAgent(provider.agentsDir, agentId);
  if (!definition) throw new Error(`Agent "${agentId}" 不存在`);

  const modelId = definition.modelId ?? provider.config.defaultModel;
  if (!modelId) throw new Error("未指定模型且无默认模型");

  const model = provider.createModel(modelId);

  const tools = caps.buildTools(definition.permissions ?? {}, {
    exclude: {
      subagents: definition.function?.name
        ? [definition.function.name]
        : undefined,
    },
  });

  return new SdkAgent({
    provider,
    definition,
    model,
    messages: definition.messages as AgentNS.Message[],
    tools,
    permissions: definition.permissions,
    caps,
  });
}
