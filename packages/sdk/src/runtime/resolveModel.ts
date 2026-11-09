/**
 * 模型的三级解析 —— **整个仓库只有这一处实现**。
 *
 * ## 三档是什么、为什么是这个顺序
 *
 *   1. `session` —— 会话级覆盖（用户对**这一段对话**说过「这次用这个模型」）；
 *   2. `agent`   —— Agent 定义上绑的 `modelId`（日常在用的那个，写进 `agents/*.json`）；
 *   3. `global`  —— `AppConfig.defaultModel`（**兜底**：Agent 定义没绑模型时才轮到它）。
 *
 * 越靠近「这一次」的越优先：会话是用户当下的意思，Agent 定义是长期配置，全局是兜底。
 *
 * ## 为什么必须只有一处
 *
 * 这个顺序以前散在好几层（客户端算一遍、运行时再算一遍、状态栏显示第三遍），结果是
 * 「界面写着 A、请求实际发给 B」——用户点了半天切模型，401 还是照样报。所以：
 * 解析只在这里做一次，产出**值 + 档位**两件事；服务端只负责把「会话级覆盖」递进来
 * （`createAgent` 的 `options.modelId`），客户端只负责渲染服务端告诉它的结果。
 *
 * 「值」和「档位」一起返回，而不是分成两个函数：档位是这次判断的副产品，分开写就等于
 * 把同一个 `??` 链写两遍，两遍迟早漂成不一致（`/model` 的选择器要靠档位标「当前生效」）。
 */

/** 模型从哪一级来（越靠前越优先） */
export type ModelLevel = "session" | "agent" | "global";

/** 解析的输入：三档各自声明了什么（没声明就是 `undefined`） */
export interface ModelResolutionInput {
  /** 会话级覆盖（`SessionRecord.modelId`）；只有这一段会话有效 */
  sessionModelId?: string;
  /** Agent 定义绑定的模型（`AgentDefinition.modelId`） */
  agentModelId?: string;
  /** 全局兜底（`AppConfig.defaultModel`） */
  defaultModel?: string;
}

export interface ResolvedModel {
  modelId: string;
  /** 这个 `modelId` 是从哪一级拿到的 */
  level: ModelLevel;
}

/**
 * 按 `session > agent > global` 取第一个有值的模型；三级都空返回 `null`。
 *
 * 空串按「没配」算（`if (modelId)` 而不是 `!== undefined`）：`modelId: ""` 不是某个模型
 * 的名字，把它当成一档命中，只会在 `createModel` 里变成一句更难懂的
 * `Model "" not found`。协议层已经要求 `modelId` 非空，这里只是让手工改坏的配置
 * 也落到那条**明确的**报错上。
 */
export function resolveModel(input: ModelResolutionInput): ResolvedModel | null {
  if (input.sessionModelId) return { modelId: input.sessionModelId, level: "session" };
  if (input.agentModelId) return { modelId: input.agentModelId, level: "agent" };
  if (input.defaultModel) return { modelId: input.defaultModel, level: "global" };
  return null;
}
