import type { AgentNS } from "@ai-zen/agents-core";
import { AgentRepository } from "../crud/AgentRepository.js";
import { SdkAgent } from "./SdkAgent.js";
import type { Scope } from "../scope/Scope.js";
import { createModel } from "./createModel.js";
import type { AbortedMessageStrategy, AbortedToolRoundStrategy } from "@ai-zen/agents-core";

/**
 * `createAgent` 的可选行为开关（不传则全部沿用 core 默认值）。
 */
export interface CreateAgentOptions {
  /** 工具轮次被中断（或结果不完整）时的归一策略（core 默认 `fill`） */
  abortedToolRoundStrategy?: AbortedToolRoundStrategy;
  /** `fill` 策略下，未完成工具结果的填充原因 */
  abortedToolRoundReason?: string;
  /**
   * 被中断的 assistant 消息（已输出的内容 / 思考）如何处置（core 默认 `drop`）。
   * 传 `keep` 可让模型在下一轮接着半截往下说，而不是忘掉自己说过什么。
   */
  abortedMessageStrategy?: AbortedMessageStrategy;
}

/**
 * 从磁盘创建 Agent。
 *
 * 通过 Scope 获取已发现的能力，读取 Agent 定义，过滤并实例化工具，产出 SdkAgent。
 *
 * ```ts
 * const agent = await createAgent(scope, "my-agent");
 * // agent 是 SdkAgent，可直接注册插件、发送消息
 * ```
 */
export async function createAgent(
  scope: Scope,
  agentId: string,
  options: CreateAgentOptions = {},
): Promise<SdkAgent> {
  const definition = await new AgentRepository(scope.agentsDir).read(agentId);
  if (!definition) throw new Error(`Agent "${agentId}" 不存在`);

  const modelId = definition.modelId;
  if (!modelId) {
    throw new Error(
      `Agent "${agentId}" 未绑定模型（缺少 modelId）。请在配置里给它指定一个模型。`,
    );
  }

  const { client, model, modelConfig } = createModel(scope, modelId, definition.modelParams);

  const tools = scope.buildTools(definition, {
    exclude: {
      subagents: definition.function?.name
        ? [definition.function.name]
        : undefined,
    },
  });

  const agent = new SdkAgent({
    scope,
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
    // 中断相关策略：不传则由 core 取默认值（工具轮次 fill / 消息保留 drop）
    abortedToolRoundStrategy: options.abortedToolRoundStrategy,
    abortedToolRoundReason: options.abortedToolRoundReason,
    abortedMessageStrategy: options.abortedMessageStrategy,
  });

  return agent;
}
