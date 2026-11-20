import { Agent, AgentToolLazy, type ToolCallContext } from "@ai-zen/agents-core";
import type { Tool, AgentNS } from "@ai-zen/agents-core";
import type OpenAI from "openai";
import type { AgentDefinition } from "../../../types/index.js";
import type { Scope } from "../../Scope.js";
import { createModel } from "../../../runtime/createModel.js";

/**
 * 创建 SubAgent 工具（AgentToolLazy）。
 *
 * SubAgent 是有 `function` 字段的 Agent，可被其他 Agent 作为工具调用。
 */
export function createSubAgentTool(def: AgentDefinition, scope: Scope): Tool {
  if (!def.function) {
    throw new Error(
      `Agent "${def.id}" has no function field, so it cannot be used as a SubAgent tool`,
    );
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
        // SubAgent 可声明自己的模型与参数覆盖（与主 Agent 同一套规则：直接合并）
        const m = createModel(scope, def.modelId, def.modelParams);
        client = m.client;
        model = m.model;
        modelConfig = m.modelConfig;
      } else {
        const parent = ctx.agent;
        if (!parent) {
          throw new Error(
            `SubAgent "${selfName}" does not specify a modelId, and the parent Agent has no reusable model`,
          );
        }
        client = parent.client;
        model = parent.model;
        modelConfig = parent.modelConfig;
      }

      // SubAgent 独立解析自己的工具（排除自身，防止递归）
      const subFiltered = scope.filter(def, {
        exclude: {
          subagents: def.function?.name ? [def.function.name] : undefined,
        },
      });
      const tools = scope.instantiate(subFiltered);

      const subAgent = new Agent({
        client,
        model,
        modelConfig,
        tools,
        // 委派就是「干一件已经看得见结果的活」：`buildAgent` 造出来的必须是**一次性**
        // （`CORE.md` §9）。常驻子节点不能走这条路 —— 它得有人给它定地址、有人负责 stop。
        lifetime: "one-shot",
      });

      return subAgent;
    },
  });

  return lazy;
}
