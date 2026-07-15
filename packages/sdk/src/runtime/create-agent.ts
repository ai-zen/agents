import type { AgentNS } from "@ai-zen/agents-core";
import { readAgent } from "../crud/agents";
import { Capabilities } from "../capabilities/capabilities";
import { SdkAgent } from "./sdk-agent";
import type { Runtime } from "./runtime";

/**
 * 从磁盘创建 Agent。
 *
 * 内部创建 Capabilities 实例执行全局发现，读取 Agent 定义，
 * 过滤并实例化工具，产出 SdkAgent。
 *
 * ```ts
 * const agent = await createAgent(runtime, "my-agent");
 * // agent 是 SdkAgent，可直接用于 createSession
 * ```
 */
export async function createAgent(
  runtime: Runtime,
  agentId: string,
): Promise<SdkAgent> {
  const caps = new Capabilities(runtime);
  const definition = readAgent(runtime.agentsDir, agentId);
  if (!definition) throw new Error(`Agent "${agentId}" 不存在`);

  const modelId = definition.modelId ?? runtime.config.defaultModel;
  if (!modelId) throw new Error("未指定模型且无默认模型");

  const model = await runtime.createModel(modelId);

  const tools = caps.buildTools(definition.permissions ?? {}, {
    exclude: {
      subagents: definition.function?.name
        ? [definition.function.name]
        : undefined,
    },
  });

  return new SdkAgent({
    runtime,
    definition,
    model,
    messages: definition.messages as AgentNS.Message[],
    tools,
    permissions: definition.permissions,
    caps,
  });
}
