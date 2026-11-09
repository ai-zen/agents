import type { AgentNS } from "@ai-zen/agents-core";
import { AgentRepository } from "../crud/AgentRepository.js";
import { SdkAgent } from "./SdkAgent.js";
import type { Scope } from "../scope/Scope.js";
import { createModel } from "./createModel.js";
import { resolveModel } from "./resolveModel.js";
import type { AgentDefinition } from "../types/index.js";
import type { AbortedMessageStrategy, AbortedToolRoundStrategy } from "@ai-zen/agents-core";

/**
 * `createAgent` 的可选行为开关。
 *
 * 不传时先取 `scope.config`（`config.json`）里的同名配置，再往下才是 core 默认值：
 * 中断策略属于**产品配置**，调用方不该自己读配置再转一道参数。
 */
export interface CreateAgentOptions {
  /** 工具轮次被中断（或结果不完整）时的归一策略（core 默认 `fill`） */
  abortedToolRoundStrategy?: AbortedToolRoundStrategy;
  /** `fill` 策略下，未完成工具结果的填充原因 */
  abortedToolRoundReason?: string;
  /**
   * 被中断的 assistant 消息（已输出的内容 / 思考）如何处置（未传时取 `scope.config`，
   * 再缺则用 core 默认 `drop`）。
   * `keep` 可让模型在下一轮接着半截往下说，而不是忘掉自己说过什么。
   */
  abortedMessageStrategy?: AbortedMessageStrategy;
  /**
   * **会话级**模型覆盖（三级解析的第一级）。
   *
   * 只有「这一段会话」该换模型时才传（服务端从 `SessionRecord.modelId` 取，`/model`
   * 不带作用级别的写法写的就是它）。不传就落到 Agent 定义，再落到 `config.defaultModel`。
   *
   * 为什么由调用方传、而不是 SDK 自己去读会话存档：本层不认识会话（它只认识 Scope 与
   * Agent 定义），会话存档是服务端的财产。**解析顺序仍只在这里实现**（见 `resolveModel`）。
   */
  modelId?: string;
}

/**
 * 从磁盘创建 Agent。
 *
 * 通过 Scope 获取已发现的能力，读取 Agent 定义，过滤并实例化工具，产出 SdkAgent。
 * 模型按 **会话级覆盖 > Agent 定义 > 全局兜底** 解析（唯一实现：`resolveModel`）。
 *
 * ```ts
 * const agent = await createAgent(scope, "my-agent");
 * // 这一段会话临时换个模型（不动 Agent 定义）
 * const scoped = await createAgent(scope, "my-agent", { modelId: "gpt-6-astra" });
 * ```
 */
export async function createAgent(
  scope: Scope,
  agentId: string,
  options: CreateAgentOptions = {},
): Promise<SdkAgent> {
  const stored = await new AgentRepository(scope.agentsDir).read(agentId);
  if (!stored) throw new Error(`Agent "${agentId}" not found`);

  const resolved = resolveModel({
    sessionModelId: options.modelId,
    agentModelId: stored.modelId,
    defaultModel: scope.config?.defaultModel,
  });
  // 三级都没有就是**真的没有模型**：不静默挑一个出厂模型顶上 —— 用户会以为自己在用
  // 配置里那个，实际请求（和账单）落在别的模型上。带上 agentId 是因为同一条错误在
  // 服务端日志里必须能指出是哪份定义没绑。
  if (!resolved) {
    throw new Error(
      `Agent "${agentId}" has no model bound: no session override, no "modelId" in its definition, ` +
        `and no "defaultModel" in the config`,
    );
  }

  // 生效的模型写进**这一份**（内存里的）定义：运行期所有读 `definition.modelId` 的地方
  // —— 状态栏快照、上下文阈值（`tokenThresholds`）、插件 —— 必须看到同一个模型，否则
  // 就又回到「界面写着 A、请求发给 B」。磁盘上的定义一个字都不动：会话级覆盖只属于这一段
  // 会话，落盘走的是会话存档的 `modelId`（见服务端 `SessionManager.recordOf`）。
  const definition: AgentDefinition = { ...stored, modelId: resolved.modelId };

  const { client, model, modelConfig } = createModel(
    scope,
    resolved.modelId,
    definition.modelParams,
  );

  const tools = scope.buildTools(definition, {
    exclude: {
      subagents: definition.function?.name ? [definition.function.name] : undefined,
    },
  });

  const agent = new SdkAgent({
    scope,
    definition,
    client,
    model,
    modelConfig,
    // 合出来的是哪一级，客户端要把「当前生效档」标在选择器上
    modelLevel: resolved.level,
    // 在 createAgent 层做模板快照（拷贝），隔离 definition.messages 的引用。
    // AgentContext.messages 是 mutable 运行时数组，若直接把 definition.messages
    // 传入，对话期间 append() 会反向污染 Agent 定义模板——definition.messages
    // 被塞入完整历史后，迁移 prune/omit 失效、/new 继承旧历史。
    // 快照后，运行时改动只作用于会话副本，模板保持纯净。
    messages: [...(definition.messages ?? [])] as AgentNS.Message[],
    tools,
    // 中断相关策略：**显式参数 > `scope.config` > core 默认值**。
    // 中间那一层是「配置即事实」：策略写在 `config.json` 里，各端（CLI / Desktop）
    // 不必自己读配置再转成参数，子 Agent 创建时也能自然继承同一份策略。
    abortedToolRoundStrategy:
      options.abortedToolRoundStrategy ?? scope.config?.abortedToolRoundStrategy,
    abortedToolRoundReason: options.abortedToolRoundReason,
    abortedMessageStrategy: options.abortedMessageStrategy ?? scope.config?.abortedMessageStrategy,
  });

  return agent;
}
