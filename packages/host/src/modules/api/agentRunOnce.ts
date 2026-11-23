import { resolve } from "node:path";

import { z } from "zod";

import type { AgentNS } from "@ai-zen/agents-core";
import { createAgent } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import { hostPlugins, modelAndParamsFor } from "../agent/materials.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * `runtime.agent.runOnce`：在一个目录上装一次性的 `Agent`，把这一句话跑完。
 *
 * 它不在 `session.` 下面：这条路上不建任何会话行 —— 一次性调用要的只是一个目录去装配 Scope。
 */
export function agentRunOnceProcedure(deps: HostApiDeps, api: Trpc) {
  /**
   * 跑一次**一次性会话**：一句投进去、等它跑到闲、把这一次跑出来的消息原样带回去。
   *
   * 这条路给的是 `dev-docs/prd/04-session.md` 「一次性会话：唯一的逃生窗」里那三种里的
   * 宿主入口（今天头一个是 CLI 的纯 stdio 模式：一次调用、一个答案、一个退出码）。它们
   * **不是一段会话的第一次运行**，也不是段/轮/圈里的一个：就是一次到头的会话，跑完就散。
   *
   * **一个字都不落库**，这正是这条路全部的意思：不建会话行、不建 inbox 行、不写消息表。
   * 走真会话（`session.create` + `runtime.agent.wake` + `runtime.agent.send`）的话，每敲一次命令行库里就多一段
   * 会话、项目里多一条工作区行 —— 一次性会话跑完就散，那些行没有谁会去删（`session.delete`
   * 是用户手上的动作，不是这条路收尾的一部分），库只增不减。
   *
   * 所以入参是 `cwd`，**不是 `workspaceId`**：认项目的话，项目行必须先在，于是每敲一次
   * `ai "…"` 就多出一条项目行 —— 会话行是没了，垃圾还在，而项目「只走显式添加」
   * （`workspace.create`）。这条路不建任何行，项目行也不建；一次性会话要的只是一个目录去装配
   * Scope，不需要那一行。
   *
   * 四步与次序：
   * 1. `cwd` 归一化一次（`resolve(cwd)`，与 `WorkspaceService.create` 同一个口径）—— 容器按
   *    目录一份，同一个目录两种写法就会装配出两份。**不校验目录存不存在**：不存在的目录照常在、
   *    只报事实（PRD 4.1），真正用到它的那一步自然失败 —— 在这里先拦一道，等于把「这条路上
   *    有什么」提前说死，而那正是宿主不该替别人作的决定；
   * 2. 模型与参数：与装配一段会话同一份口径（`modelAndParamsFor`）—— 一次性会话没有会话行，
   *    所以三级解析只可能落在 AgentDefinition 或全局兜底上，思考档位那一格这一次不存在（它长在会话行上）；
   * 3. 造**一次性 Agent**：取 Scope（`runtime.scopes.for(归一化后的 cwd)`，同一个目录上的几段共用一个）、
   *    `createAgent(..., { lifetime: "one-shot" })`，再装上这条路上该装的那几颗插件
   *    （见 `hostPlugins`：硬线与 subagent 护栏、附件传输照装，自动交接不装）。
   *    **不走 `runtime.wake`** —— 它造的是常驻 Agent，要登记、要装一段会话，而这一段既没有
   *    会话可装，也不该在登记表里留下一个跑完就该消失的项；
   * 4. `runOnce`：起 → 投递 → 等闲 → 关门，跑出来的东西就是它的返回值。`ctx.signal` 直接交给
   *    它：客户端断了就该掰掉这一次（一次性会话的寿命就在这条调用栈里）。
   *
   * 出参就是 `runOnce` 返回的那个数组（活对象原样，不拷贝、不重排），因为客户端要的就是
   * 「这一次跑出来的那几条」。
   */
  return api.procedure
    .input(
      z.object({
        /** 这次调用要在哪个目录上装配 Scope（归一化一次，不校验是否存在） */
        cwd: z.string().min(1),
        agentId: z.string().min(1),
        /** 与 `runtime.agent.send` 同一个 union：一段字符串，或一组内容段（多模态） */
        content: z.union([z.string(), z.array(z.custom<AgentNS.MessageContentSection>())]),
        /** 客户端给这一句的 id（可选）：不给就由 Agent 自己生成一个 */
        messageId: z.string().optional(),
      }),
    )
    .output(z.object({ messages: z.array(z.custom<AgentNS.Message>()) }))
    .mutation(async ({ input, signal }) => {
      // 项目行一次都不查：这条路不建行，没有行可查，也不该因为「这个目录还没有项目」而拒绝
      // 跑 —— 那种拒绝等于把项目行变成一次性会话的前置条件，正是这次补正要拆掉的那一条。
      //
      // 归一化只做一次，与 `WorkspaceService.create` 同一个口径：Scope 按目录一份，`/a/b` 与
      // `/a/b/` 得落到同一个键上，否则同一个目录会装配出两份工具、两份 mcp 连接。
      const cwd = resolve(input.cwd);

      // 模型与参数：与装配一段会话同一个函数（「模型 + 档位补丁」只有这一处实现）。三格覆盖
      // 全给 `null` —— 一次性会话没有行，没有更近的那一级可说。
      const { resolved, model, params } = await modelAndParamsFor(deps, {
        agentId: input.agentId,
        modelId: null,
        thinkingLevel: null,
      });

      if (resolved === null) {
        throw new HostError(
          "config_invalid",
          deps.t("AgentDefinition {agentDefinitionId} 没有可用的模型", {
            agentDefinitionId: input.agentId,
          }),
          { entity: "agentDefinition", agentDefinitionId: input.agentId },
        );
      }

      // 解析出来的模型不在配置的模型表里：宿主自己那份配置前后不一致（上面那一步是从同一份
      // 配置里解析出来的），这是运行事故，不是客户端能改的入参 —— 与 `materialsFor` 那一处同词
      if (model === undefined) {
        throw new Error(
          `Cannot run a one-shot agent: model "${resolved.modelId}" is not in the config`,
        );
      }

      const scope = await deps.runtime.scopes.for(cwd);

      const agent = await createAgent(scope, input.agentId, {
        lifetime: "one-shot",
        // 同一次解析的结果显式递下去，与 `materialsFor` 那一处同一个口径：不在这一层再算一遍
        modelId: resolved.modelId,
        modelParams: params,
      });

      // 插件必须排在 `runOnce` 之前：装晚了的代价不是「晚一点生效」——第一批取走可能已经发生，
      // 这一次就有一段活在「插件还没装」的状态里跑完了。
      for (const plugin of hostPlugins(deps, null, model)) agent.use(plugin);

      const messages = await agent.runOnce(
        {
          content: input.content,
          // 低：没有第二个触发方在等它，「插进手上那一批中间」没有意义
          priority: "low",
          source: { kind: "user" },
          messageId: input.messageId,
        },
        // 客户端断了（连接没了 / 调方取消了）：掰掉这一次。一次性会话没有「继续」可言，
        // 但那条栈还挂着，掐掉它才不会有一个人人都不认的 Agent 在外面跑
        { signal },
      );

      return { messages };
    });
}
