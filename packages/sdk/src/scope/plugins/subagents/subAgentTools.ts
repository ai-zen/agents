import { Agent, AgentToolLazy, type ToolCallContext } from "@ai-zen/agents-core";
import type { Tool, AgentNS } from "@ai-zen/agents-core";
import type OpenAI from "openai";
import type { AgentDefinition } from "../../../types/index.js";
import type { Scope } from "../../Scope.js";
import { newProviderSessionId } from "../../../shared/clientInfo.js";
import { createModel } from "../../../runtime/createModel.js";
import { PEER_SESSION_TOOL_NAMES } from "../peers/peerSessionTools.js";
import { ASYNC_TASK_TOOL_NAMES } from "../builtin/asyncTasks.js";

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
      // 模型解析：SubAgent 可指定独立模型，否则跟父 Agent 用同一个模型。
      //
      // 两条路都自己建 client，哪怕模型相同 —— 因为出网标识要另起一个：子 Agent 带的是自己的
      // 上下文（自己的历史、自己的工具），拿父那一串去报自己的请求，服务方的路由与前缀缓存都会
      // 指错地方。建一份同模型的 client 只是内存对象，不发请求。
      const parent = ctx.agent;
      const parentDefinition = (parent as { definition?: AgentDefinition }).definition;
      const modelId = def.modelId ?? parentDefinition?.modelId;

      let client: OpenAI;
      let model: string;
      let modelConfig: Record<string, unknown> | undefined;
      if (modelId !== undefined) {
        // 自己的模型声明优先；没有就用父那一个，参数跟父的「生效值」走（`modelConfig` 是
        // 定义参数与会话级覆盖合并后的那一份，不重新拿定义算一遍）
        const m = createModel(
          scope,
          modelId,
          def.modelId === undefined ? parent.modelConfig : def.modelParams,
          { providerSessionId: newProviderSessionId() },
        );
        client = m.client;
        model = m.model;
        modelConfig = m.modelConfig;
      } else {
        // 走到这儿说明父 Agent 不是 sdk 造的那种（拿裸 core `Agent` 当父）：问不到模型 id，
        // 只能复用它的 client，出网标识也就跟着父那串
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
          // PeerSession 那三个工具是会话级能力，被派出去的 Agent 手上不该有：它不属于任何一段
          // 会话 —— 没有可以署名的身份（发话要写「来自哪一段会话」），也开不出有人认领的新
          // 会话，所以这三个工具在它手上只有必错的路（发话在端口层直接抛，创建被判
          // depth_exceeded）。取 exclude 而不动定义里的 permissions：定义文件是用户可编辑的
          // 配置，这条规矩不长在那儿；而 filter 先按 exclude 剔除、再按权限过滤，定义写
          // `allow: ["*"]` 也照样剔得掉。
          //
          // 两个后台工具同理：被派出去的是个一次性 Agent，结果回来时它的调用栈已经退了。
          tools: [...PEER_SESSION_TOOL_NAMES, ...ASYNC_TASK_TOOL_NAMES],
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
