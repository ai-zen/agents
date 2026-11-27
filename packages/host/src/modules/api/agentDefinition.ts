import { z } from "zod";

import type { AgentDefinition } from "@ai-zen/agents-sdk";

import { materialsFor } from "../agent/materials.js";
import { reloadDefinition } from "../agent/reload.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 出参一律是这一格：改完之后客户端要的就是新的那一份，不必自己把补丁叠到手里那份快照上。
 *
 * 形状只有 SDK 那一处（`types/index.ts` 的 `AgentDefinition`），这里不抄第二份：`z.custom` 就是
 * 「这个值的形状由别处声明」（`config.ts` 的 `config` 也是同一个先例）。
 */
const definitionResult = z.object({ definition: z.custom<AgentDefinition>() });

/** 动一个已经存在的定义时，入参只需要它的 id */
const idInput = z.object({ agentId: z.string() });

/**
 * AgentDefinition 与 subagent 的定义面：列、取、建、改、删、恢复出厂。
 *
 * subagent 不另开一条 `list`：它是带 `function` 的那几条定义，客户端按这一格自己分栏。
 *
 * 写之前的校验全在 `AgentDefinitionService` 那一层（标识是不是文件名安全的、模板里有没有系统
 * 提示、四维权限是不是 allow / deny 其一、模型在不在配置里、subagent 的函数形状全不全，以及
 * `function.parameters` 那段文本是不是合法 JSON）—— 这里是那条规矩的入口，不是另一个落点。
 */
export function agentDefinitionRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    list: api.procedure
      .output(z.array(z.custom<AgentDefinition>()))
      .query(() => deps.definitions.list()),

    get: api.procedure
      .input(idInput)
      .output(definitionResult)
      .query(async ({ input }) => ({ definition: await deps.definitions.get(input.agentId) })),

    /**
     * 建一条定义，写完照样走一次重装：新定义还不会有会话用着，这一次等于空动作 —— 留在同一条
     * 路上，是为了让「定义改过之后要重装」只有一处，而不是每个写口自己记得。
     */
    create: api.procedure
      .input(z.object({ definition: z.custom<Omit<AgentDefinition, "createdAt" | "updatedAt">>() }))
      .output(definitionResult)
      .mutation(async ({ input }) => {
        const definition = await deps.definitions.add(input.definition);
        await reload(deps, definition.id);
        return { definition };
      }),

    /**
     * `change` 是同一份定义去掉 `id` 的那一部分。给了 `messages` 就是整份替换模板 —— 用着这个
     * 定义的 Agent 在下面那一次重装里按新模板重新装一遍。
     *
     * 没有真的改动就不重装：`AgentDefinitionService.update` 在「合出来与当前逐字一样」时原样
     * 返回当前那份（不写盘），所以这里拿返回的那一份与改动前的那一份逐字比一次 —— 一样就是没
     * 改动，也就没有要重装的东西。重装会中止在途的写入（正在写的那一条会断），空做一次同样是代价。
     */
    update: api.procedure
      .input(
        z.object({
          agentId: z.string(),
          change: z.custom<Partial<Omit<AgentDefinition, "id" | "createdAt">>>(),
        }),
      )
      .output(definitionResult)
      .mutation(async ({ input }) => {
        const before = await deps.definitions.get(input.agentId);
        const definition = await deps.definitions.update(input.agentId, input.change);
        if (JSON.stringify(definition) !== JSON.stringify(before)) {
          await reload(deps, input.agentId);
        }
        return { definition };
      }),

    /**
     * 删一条定义。默认 AgentDefinition 指着它时，那一格跟着清掉（在 service 里，与删定义是同一次写盘）。
     *
     * 删完不重装：那些还活着的会话下一次唤醒会失败。删 AgentDefinition 不看还有几段会话在用它 ——
     * 「删之前说清还有谁指它」是端点到模型那条路上的事，AgentDefinition 这一条需求里没有这道校验。
     */
    delete: api.procedure
      .input(idInput)
      .output(z.object({ agentId: z.string() }))
      .mutation(async ({ input }) => {
        await deps.definitions.remove(input.agentId);
        return { agentId: input.agentId };
      }),

    /** 恢复出厂：整条换回出厂那一条（`custom` 置回 `false`），然后与 `update` 一样重装 */
    reset: api.procedure
      .input(idInput)
      .output(definitionResult)
      .mutation(async ({ input }) => {
        const definition = await deps.definitions.reset(input.agentId);
        await reload(deps, input.agentId);
        return { definition };
      }),
  });
}

/**
 * 定义改完之后那一次重装。材料那一格在这里才凑得齐：它要读历史、排队区与配置，而 `HostApiDeps`
 * 上正好有它们（`materialsFor` 认的就是这几样）。
 */
function reload(deps: HostApiDeps, agentId: string): Promise<string[]> {
  return reloadDefinition(
    {
      sessions: deps.sessions,
      workspaces: deps.workspaces,
      runtime: deps.runtime,
      materials: (session) => materialsFor(deps, session),
      // 与观察者读的是同一份：重装期间那一次清空不作废库里那几行排队区
      reloads: deps.reloads,
      onError: deps.onError,
    },
    agentId,
  );
}
