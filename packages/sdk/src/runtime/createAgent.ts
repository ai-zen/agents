import type { AgentNS } from "@ai-zen/agents-core";
import { AgentRepository } from "../crud/AgentRepository.js";
import { SdkAgent } from "./SdkAgent.js";
import type { Scope } from "../scope/Scope.js";
import { createModel } from "./createModel.js";
import {
  CREATE_SESSION_TOOL,
  PEER_SESSION_TOOL_NAMES,
} from "../scope/plugins/peers/peerSessionTools.js";
import { resolveModel, resolveModelParams } from "./resolveModel.js";
import type { AgentDefinition, ModelParams } from "../types/index.js";
import type { AbortedMessageStrategy, AbortedToolRoundStrategy } from "@ai-zen/agents-core";

/**
 * `createAgent` 的可选行为开关。
 *
 * 两个中断策略开关不传时先取 `scope.config`（`config.json`）里的同名配置，再往下才是
 * core 默认值：中断策略属于**产品配置**，调用方不该自己读配置再转一道参数。
 */
export interface CreateAgentOptions {
  /** 工具轮次被中断（或结果不完整）时的归一策略（core 默认 `fill`） */
  abortedToolRoundStrategy?: AbortedToolRoundStrategy;
  /** `fill` 策略下，未完成工具结果的填充原因 */
  abortedToolRoundReason?: string;
  /**
   * 被中断的 assistant 消息（已输出的内容 / 思考）如何处置（未传时取 `scope.config`，
   * 再缺则用 core 默认 `drop`）。
   * `keep` 可让模型在下一次请求接着半截往下说，而不是忘掉自己说过什么。
   */
  abortedMessageStrategy?: AbortedMessageStrategy;
  /**
   * **会话级**模型覆盖（三级解析的第一级）。
   *
   * 只有「这一段会话」该换模型时才传（宿主从会话行的 `modelId` 取，`/model`
   * 不带作用级别的写法写的就是它）。不传就落到 Agent 定义，再落到 `config.defaultModel`。
   *
   * 为什么由调用方传、而不是 SDK 自己去读会话存档：本层不认识会话（它只认识 Scope 与
   * Agent 定义），会话存档是宿主的财产。解析顺序只有 `resolveModel` 一处实现。
   */
  modelId?: string;
  /**
   * **会话级**模型参数覆盖（三级解析里与 `modelId` 同一级的那一份，宿主从会话行的
   * `modelParams` 取）。
   *
   * 只有 `modelId` 那一级赢了它才会真正生效 —— 取哪一份由 `resolveModelParams` 按档位
   * 决定（同一处规则）。**它不会与 `AgentDefinition.modelParams` 合并**：定义那份是配给
   * 定义绑定的模型的，会话把模型换掉之后把旧参数发给新模型就是端点 400。
   */
  modelParams?: ModelParams;
  /**
   * 寿命：`resident`（缺省）还是 `one-shot`。
   *
   * `one-shot` 是「一次调用、一个答案、一个退出码」那条路（`PRD.md` 4.1 的一次性会话）：它只
   * 吃一次投递，跑完就死，`send` / `runOnce` 才有意义。缺省仍是常驻 —— 那是能力更大的那个。
   */
  lifetime?: AgentNS.AgentLifetime;
  /**
   * 这一段能不能再开平级会话（缺省能）。
   *
   * 「这一段自己是不是别人开出来的」只有运行时知道（`WakeMaterials.lineage`），所以由它给这一格。
   * 给 `false` 时排掉的是 `create_session` 一个工具：再开一层就是套娃，而排掉工具比让它调一次
   * 再回 `depth_exceeded` 早一步 —— 模型手上没有这个工具，也就不会去试。投递与问状态那两个照旧
   * 留着：平级会话之间是双向说话的。
   */
  canOpenPeers?: boolean;
}

/**
 * 从磁盘创建 Agent。
 *
 * 通过 Scope 获取已发现的能力，读取 Agent 定义，过滤并实例化工具，产出 SdkAgent。
 * 模型按 **会话级覆盖 > Agent 定义 > 全局兜底** 解析（唯一实现：`resolveModel`）；
 * **参数取「模型来自哪一级」那一份**，不跨级混合（同一处实现：`resolveModelParams`）。
 *
 * 寿命由 `options.lifetime` 定：缺省造出来的是**常驻**执行体；`one-shot` 造出来的是「一次调用、
 * 一个答案、一个退出码」那一种（只能 `send` / `runOnce`，跑完就散）。
 *
 * ```ts
 * const agent = await createAgent(scope, "my-agent");
 * // 这一段会话临时换个模型（不动 Agent 定义）：模型与参数都取会话级那一份
 * const scoped = await createAgent(scope, "my-agent", {
 *   modelId: "gpt-6-astra",
 *   modelParams: { reasoning_effort: "high" },
 * });
 * // 一次性执行体：没有会话行、跑完就死（宿主 `session.transient` 走这一条）
 * const once = await createAgent(scope, "my-agent", { lifetime: "one-shot" });
 * ```
 */
export async function createAgent(
  scope: Scope,
  agentId: string,
  options: CreateAgentOptions = {},
): Promise<SdkAgent> {
  const repository = new AgentRepository(scope.agentsDir);
  let stored: AgentDefinition | null;
  try {
    stored = await repository.read(agentId);
  } catch (error) {
    // 文件在、但读不出来（不是 JSON / 没权限）：这不是「没有这个助手」，别对用户说那句假话
    throw new Error(
      `Agent "${agentId}" definition could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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
  // 会话，落盘走的是会话行的 `modelId`（见宿主 `SessionRepository.setModel`）。
  const definition: AgentDefinition = { ...stored, modelId: resolved.modelId };

  // 参数跟着「模型来自哪一级」走：档位是上面那次解析的产物，这里只按它取那一份
  // （规则只有一处实现，见 `resolveModelParams`）。会话级没设参数、或模型来自全局兜底时
  // 拿到的是 `undefined` —— 那就一个字段都不覆盖，让模型走自己的 `defaultParams`。
  const params = resolveModelParams({
    level: resolved.level,
    sessionModelParams: options.modelParams,
    agentModelParams: definition.modelParams,
  });

  const { client, model, modelConfig } = createModel(scope, resolved.modelId, params);

  const tools = scope.buildTools(definition, {
    exclude: {
      subagents: definition.function?.name ? [definition.function.name] : undefined,
      // 平级会话那三个工具是**会话级**能力，谁手上没有哪一个，判据都是「它是不是一段能自己开平级
      // 会话的会话」。下面两支各自排掉哪些，理由不同：
      //
      // - 一次性执行体手上三个都不该有（第一处是 `subAgentTools.ts` 给 subagent 的 exclude，那边
      //   的判据是「被派出去的」，这边的判据是「一次性的」，结论一样）：它不是一段会话的执行体
      //   —— 没有可以署名的身份（`post_message` 要写「来自哪一段会话」，它会把发起方标签算成
      //   agentId 那串字符串），也开不出有人认领的新会话（`create_session` 必然回
      //   `depth_exceeded`）。那三个工具在它手上只有必错的路，而每一条必错的路都要烧一次模型
      //   调用去走 —— 不如一开始就不给。
      // - 别人开出来的那一段会话（`canOpenPeers: false`）只排 `create_session`：再开一层就是
      //   套娃；投递与问状态那两个照旧留着，平级之间是双向说话的。
      //
      // 取 exclude 而不动定义里的 permissions：定义文件是用户可编辑的配置，这条规矩不长在那儿；
      // 而 filter 先按 exclude 剔除、再按权限过滤，定义写 `allow: ["*"]` 也照样剔得掉。
      tools: excludedPeerTools(options),
    },
  });

  const agent = new SdkAgent({
    scope,
    definition,
    client,
    model,
    modelConfig,
    // 在 createAgent 层做模板快照（拷贝），隔离 definition.messages 的引用：
    // 运行时的消息数组是可变的，直接传模板进去会让 append() 反向污染 Agent 定义 ——
    // 模板被塞进完整历史之后，prune / omit 与「开一段新会话」都会带着旧历史。
    // 快照之后，运行时改动只作用于会话副本。
    messages: [...(definition.messages ?? [])] as AgentNS.Message[],
    tools,
    // 中断相关策略：**显式参数 > `scope.config` > core 默认值**。
    // 中间那一层是「配置即事实」：策略写在 `config.json` 里，各端与 subagent 创建
    // 读的是同一份，不必自己读配置再转成参数。
    abortedToolRoundStrategy:
      options.abortedToolRoundStrategy ?? scope.config?.abortedToolRoundStrategy,
    abortedToolRoundReason: options.abortedToolRoundReason,
    abortedMessageStrategy: options.abortedMessageStrategy ?? scope.config?.abortedMessageStrategy,
    // 缺省由 core 定（`resident`）：这里只在调用方显式要一次性执行体时才把那一格递下去
    lifetime: options.lifetime,
  });

  return agent;
}

/**
 * 这一段手上不该有的平级会话工具。
 *
 * 两种情形排掉的名单不一样（一次性执行体三个都不给、别人开出来的那一段只少了 `create_session`），
 * 名单只在这一处算 —— 调用方只说自己是什么，不自己拼名字。
 */
function excludedPeerTools(options: CreateAgentOptions): string[] | undefined {
  if (options.lifetime === "one-shot") return [...PEER_SESSION_TOOL_NAMES];
  if (options.canOpenPeers === false) return [CREATE_SESSION_TOOL];
  return undefined;
}
