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
 *
 * ## 参数为什么也必须跟着档位走（{@link resolveModelParams}）
 *
 * 模型有三级，参数也有：**参数取「模型来自哪一级」那一份，绝不跨级混合**。
 *
 *   - 模型来自 `session` → 参数取会话级（这一级没设则用该模型的出厂参数）；
 *   - 模型来自 `agent`   → 参数取 `AgentDefinition.modelParams`（一直以来的行为）；
 *   - 模型来自 `global`  → 参数**没有**可取的层，只用模型出厂参数。
 *
 * 跨级混合是会真出事的：装配时做的是 `模型出厂参数 + 覆盖` 的浅合并，会话级把模型换掉
 * 之后，**旧模型那套参数会原样发给新模型** —— 例如 `thinking: { type: "disabled" }`
 * 发给一个不接受它的端点，换来的是一句 400。所以「会话级模型 + 定义级参数」这个组合在
 * 这里就被排除掉，而不是留给各调用方各自小心。
 */

import type { ModelParams } from "../types/index.js";

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

/** 参数解析的输入：档位（{@link resolveModel} 的产物）+ 三档各自声明了什么 */
export interface ModelParamsResolutionInput {
  /**
   * 生效模型来自哪一级。
   *
   * 直接吃 `resolveModel` 的 `level`，而不是再传一遍三个 `modelId`：档位与「谁赢了」
   * 是同一次判断的两个面，分开传就等于让调用方有机会拼出「session 档 + 定义赢」这种
   * 自相矛盾的组合。
   */
  level: ModelLevel;
  /** 会话级参数覆盖（服务端从会话存档的 `modelParams` 递进来） */
  sessionModelParams?: ModelParams;
  /** Agent 定义上的参数覆盖（`AgentDefinition.modelParams`） */
  agentModelParams?: ModelParams;
}

/**
 * 参数该取哪一份 —— 与模型的三级解析一一对应（**同一个文件、同一处规则**）。
 *
 * 三条规则就是需求本身：
 *
 *   - `session` → 会话级那份。**注意这里不能再叠 Agent 定义那份**：会话把模型换掉了，
 *     定义那份参数是配给旧模型的（它可能带着旧模型才认的 `thinking` 形状），混进来就是
 *     把旧模型的参数发给新模型 → 端点 400。会话级没设（`undefined`）时返回 `undefined`，
 *     由 `createModel` 只用模型出厂参数，这才是「换模型之后什么都不带」的正确形态。
 *   - `agent`   → 定义那份，与三级解析之前的行为**逐字等价**（唯一变的是它现在由档位
 *     决定，而不是无条件参与合并）。
 *   - `global`  → `undefined`：全局兜底那一级只有 `config.defaultModel`，**没有任何地方
 *     可以放参数**（`AppConfig` 里没有「全局参数覆盖」这一层）。既然没有这一层，就不许
 *     从别的层挪一份过来 —— 那正是上面说的跨级混合。
 *
 * 返回 `undefined` 不是「没算出来」，而是一个有意义的答案：**不带覆盖**，让模型走自己的
 * `defaultParams`（`createModel` 里 `mergeParams` 对此的处理就是不合并）。
 */
export function resolveModelParams(input: ModelParamsResolutionInput): ModelParams | undefined {
  switch (input.level) {
    case "session":
      return input.sessionModelParams;
    case "agent":
      return input.agentModelParams;
    case "global":
      return undefined;
  }
}
