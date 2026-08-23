import { Agent, AgentToolLazy, type ToolCallContext } from "@ai-zen/agents-core";
import type { Tool, AgentNS } from "@ai-zen/agents-core";
import type OpenAI from "openai";
import type { AgentDefinition } from "../../types/index.js";
import type { Provider } from "../../runtime/Provider.js";
import { createModel } from "../../runtime/createModel.js";

/**
 * 创建 SubAgent 工具（AgentToolLazy）。
 *
 * SubAgent 是有 `function` 字段的 Agent，可被其他 Agent 作为工具调用。
 * 使用延迟构建（AgentToolLazy）避免工具列表构建阶段的递归创建问题。
 */
export function createSubAgentTool(
  def: AgentDefinition,
  provider: Provider,
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
    buildAgent: (_parsedArgs: any, ctx: ToolCallContext): Agent => {
      // 模型解析：SubAgent 可指定独立模型，否则复用父 Agent 的模型
      let client: OpenAI;
      let model: string;
      let modelConfig: Record<string, unknown> | undefined;
      if (def.modelId) {
        const m = createModel(provider, def.modelId);
        client = m.client;
        model = m.model;
        modelConfig = m.modelConfig;
      } else {
        const parent = ctx.agent;
        if (!parent) {
          throw new Error(
            `SubAgent "${selfName}" 未指定 modelId，且父 Agent 没有可复用的模型`,
          );
        }
        client = parent.client;
        model = parent.model;
        modelConfig = parent.modelConfig;
      }

      // SubAgent 独立解析自己的工具（排除自身，防止递归）
      const subFiltered = provider.filter(def, {
        exclude: {
          subagents: def.function?.name ? [def.function.name] : undefined,
        },
      });
      const tools = provider.instantiate(subFiltered);

      const subAgent = new Agent({
        client,
        model,
        modelConfig,
        tools,
      });

      return subAgent;
    },
  });

  return lazy;
}
