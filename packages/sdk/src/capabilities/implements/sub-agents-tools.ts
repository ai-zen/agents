import { Agent, AgentToolLazy, type FunctionCallContext } from "@ai-zen/agents-core";
import type { Tool, AgentNS, ChatCompletionModel } from "@ai-zen/agents-core";
import type { AgentDefinition } from "../../types";
import type { Provider } from "../../runtime/runtime";
import type { Capabilities } from "../capabilities";

/**
 * 创建 SubAgent 工具（AgentToolLazy）。
 *
 * SubAgent 是有 `function` 字段的 Agent，可被其他 Agent 作为工具调用。
 * 使用延迟构建（AgentToolLazy）避免工具列表构建阶段的递归创建问题。
 */
export function createSubAgentTool(
  def: AgentDefinition,
  provider: Provider,
  caps?: Capabilities,
): Tool {
  if (!def.function) {
    throw new Error(`Agent "${def.id}" 没有 function 字段，不能作为 SubAgent 工具`);
  }

  const selfName = def.function.name;

  const lazy = new AgentToolLazy({
    function: {
      name: selfName,
      description: def.function.description || def.description || def.name,
      parameters: def.function.parameters as unknown as AgentNS.FunctionDefine["parameters"],
    },
    messages: def.messages as unknown as AgentNS.Message[],
    buildAgent: function (this: FunctionCallContext, _parsedArgs: any): Agent {
      if (!caps) {
        throw new Error(
          `SubAgent "${selfName}" 缺少 Capabilities 引用。` +
          `请确保 Capabilities.instantiate() 传入了 caps（this）。`,
        );
      }

      // 模型解析：SubAgent 可指定独立模型，否则复用父 Agent 的模型
      let subModel: ChatCompletionModel;
      if (def.modelId) {
        subModel = provider.createModel(def.modelId);
      } else {
        const parentModel = this.agent?.model;
        if (!parentModel) {
          throw new Error(
            `SubAgent "${selfName}" 未指定 modelId，且父 Agent 没有可复用的模型`,
          );
        }
        subModel = parentModel;
      }

      // SubAgent 独立解析自己的工具（排除自身，防止递归）
      const subFiltered = caps.filter(def.permissions ?? {}, {
        exclude: {
          subagents: def.function?.name ? [def.function.name] : undefined,
        },
      });
      const tools = caps.instantiate(subFiltered);

      const subAgent = new Agent({
        model: subModel,
        tools,
      });

      return subAgent;
    },
  });

  return lazy;
}
