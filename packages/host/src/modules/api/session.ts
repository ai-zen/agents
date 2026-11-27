import { resolve } from "node:path";

import { z } from "zod";

import type { AgentNS } from "@ai-zen/agents-core";
import { createAgent } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import { hostPlugins, modelAndParamsFor } from "../agent/materials.js";
import { createSession } from "../session/create.js";
import { removeSessions } from "../session/remove.js";
import { rewindTo } from "../session/rewind.js";
import type { SessionRecord } from "../session/types.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 会话行过 wire 的那一份。形状只有 `session/types.ts` 那一处，这里是它的声明式影子：
 * `.output()` 拿它校验出去的值，客户端照它生成类型。
 */
const sessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  /** 名字从哪儿来（`default` / `auto` / `user` / `handoff` / `legacy`）—— 形状只有 `session/types.ts` 一处 */
  nameSource: z.enum(["default", "auto", "user", "handoff", "legacy"]),
  pinned: z.boolean(),
  agentId: z.string(),
  modelId: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  autoHandoff: z.boolean(),
  lineage: z.string().nullable(),
  handoffThreshold: z.number().nullable(),
  guardThreshold: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * 打开一段会话看到的那一份。
 *
 * `live` 为 `null` 表示这段会话现在没有 Agent（重启之后所有会话都是这一种）—— 那时状态无从谈起，
 * 而消息与排队区照样给得出来，因为那时库就是它的全部。
 *
 * 消息与排队区用 `z.custom`：形状只有 core 那一处，在这里再抄一份就是第二份，抄漏一格不会报错，
 * 只会让客户端安静地少一个字段。排队区那一格是 core 的 `InboxEntry`，其中「钥匙」那种没有正文
 * —— 界面要的是「还有几条在等」，不是每条都能拼出句子。
 */
const sessionView = z.object({
  session: sessionSchema,
  live: z
    .object({
      state: z.enum(["working", "idle"]),
      inputPaused: z.boolean(),
      outputPaused: z.boolean(),
      handingOff: z.boolean(),
    })
    .nullable(),
  messages: z.array(z.custom<AgentNS.Message>()),
  inbox: z.array(z.custom<AgentNS.InboxEntry>()),
});

/** 六条「改这一段」的动作共用这一格入参：它们认的都是会话 id */
const sessionIdInput = z.object({ sessionId: z.string() });

/**
 * 改完返回新的一行，与 `open` 那一支同名（`session`）：客户端拿到的是改完之后的那一行，
 * 不必自己把补丁叠到手里那份快照上 —— 那种叠法一旦漏掉一格（如 `updatedAt`、或被一并清掉的
 * `thinkingLevel`）就会安静地显示成旧值。
 */
const sessionResult = z.object({ session: sessionSchema });

export function sessionRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    list: api.procedure
      .input(z.object({ workspaceId: z.string() }))
      .output(z.array(sessionSchema))
      .query(({ input }) => deps.sessions.list(input.workspaceId)),

    /**
     * 建一行会话：写库，不做别的 —— 不唤醒 Agent、不投递任何东西、不推任何「这一段活了」
     * 的事实。新建出来的这一段就是一段没有 Agent 的会话，与「重启之后所有会话都是死的」是同一种
     * 状态：`open` 读回来 `live` 是 `null`，消息与排队区都是空的。
     *
     * 起 Agent 是 `runtime.agent.wake`，投递消息是 `runtime.agent.send`：三件事各有一条口，客户端要哪一件就调哪
     * 一条。建行顺带唤醒再顺带投一句（投的还是空正文）会让 Agent 白跑一次模型请求，历史里还会
     * 多一条空的用户消息。
     *
     * 模型在这一刻解析出来写进会话行（见 `createSession`）：解析不出就当场失败，不落半条行。
     */
    create: api.procedure
      .input(z.object({ workspaceId: z.string(), agentId: z.string() }))
      .output(sessionResult)
      .mutation(async ({ input }) => ({ session: await createSession(deps, input) })),

    /**
     * 打开一段会话：状态、消息、排队区一次取到。
     *
     * 有 Agent 时五样全从它的内存里读；没有 Agent 时才读库。分成两次取会在两次请求之间夹进新消息，
     * 而库里的正文在流式期间本来就落后于内存——两处各读一半，客户端拿到的是一份混着两个时刻的状态。
     */
    open: api.procedure
      .input(z.object({ sessionId: z.string() }))
      .output(sessionView)
      .query(({ input }) => {
        const session = deps.sessions.get(input.sessionId);
        if (session === undefined) {
          throw new HostError(
            "not_found",
            deps.t("找不到 id 为 {sessionId} 的会话", { sessionId: input.sessionId }),
            { entity: "session", sessionId: input.sessionId },
          );
        }

        const agent = deps.runtime.get(session.id);
        if (agent === undefined) {
          return {
            session,
            live: null,
            messages: deps.messages.listBySession(session.id),
            inbox: deps.inbox.listBySession(session.id),
          };
        }

        return {
          session,
          live: {
            state: agent.state,
            inputPaused: agent.isInputPaused,
            outputPaused: agent.isOutputPaused,
            handingOff: deps.handoff.isHandingOff(session.id),
          },
          messages: [...agent.messages],
          inbox: [...agent.inboxPending],
        };
      }),

    /**
     * 改名。行不存在时是 `not_found` —— `deps.sessions.update` 抛的就是那一条（带 id、带
     * `entity: "session"`），这一层不另判一次。
     *
     * `nameSource: "user"` 是「人改过之后就不再自动改它」：自动命名只碰 `default` / `auto`
     * 那两格。这一格不置的话，用户刚改的名字下一次变闲就会被模型起的名字盖掉。
     */
    rename: api.procedure
      .input(sessionIdInput.extend({ name: z.string() }))
      .output(sessionResult)
      .mutation(({ input }) => ({
        session: deps.sessions.update(input.sessionId, { name: input.name, nameSource: "user" }),
      })),

    /**
     * 让模型给这一段起个名字（CLI 的 `/title`）：用户点名要的那一次请求。
     *
     * 与「第一次答完自己起一个」是同一套动作（`AutoNamer` 那一处），差在判据只有这一条 ——
     * 用户点了。所以内容多长、名字原来归谁都不影响；`autoTitle` 关着也不拦（那是「别自己动手」
     * 的开关）。写回的来源记 `auto`：名字确实是模型起的。
     *
     * `named: false` = 模型没给出能用的名字，名字原样留着 —— 那不是错误，是一条要说得出口的结果
     * （所以走回执而不抛错）。没有模型可用才是错的（`config_invalid`），那是用户能去改的东西。
     */
    autoTitle: api.procedure
      .input(sessionIdInput)
      .output(z.object({ session: sessionSchema, named: z.boolean() }))
      .mutation(({ input }) => deps.autoNamer.nameOnDemand(input.sessionId)),

    /** 置顶。排序在库里（`pinned DESC, updatedAt DESC`），所以写进去之后列表顺序当场就变 */
    pin: api.procedure
      .input(sessionIdInput.extend({ pinned: z.boolean() }))
      .output(sessionResult)
      .mutation(({ input }) => ({
        session: deps.sessions.update(input.sessionId, { pinned: input.pinned }),
      })),

    /** 自动交接开关。越线那一刻由插件从会话行现读，所以改完下一次越线就按新的 */
    updateAutoHandoff: api.procedure
      .input(sessionIdInput.extend({ autoHandoff: z.boolean() }))
      .output(sessionResult)
      .mutation(({ input }) => ({
        session: deps.sessions.update(input.sessionId, { autoHandoff: input.autoHandoff }),
      })),

    /**
     * 两条阈值。两个数各自可设：需求给的是「建议硬线 ≈ 软线 × 1.5」，不是约束，所以这里不做
     * 「硬线必须大于软线」这类校验 —— 硬绑起来之后，用户想先把软线调到硬线之上试一下都做不到。
     *
     * 两个都写（而不是「传了哪个改哪个」）：`null` 是「跟随模型的配置」这个有意义的取值，
     * 「没传」与「传了 null」在入参上分不出来，分开处理就会把清空读成不改。
     */
    updateThresholds: api.procedure
      .input(
        sessionIdInput.extend({
          handoffThreshold: z.number().nullable(),
          guardThreshold: z.number().nullable(),
        }),
      )
      .output(sessionResult)
      .mutation(({ input }) => ({
        session: deps.sessions.update(input.sessionId, {
          handoffThreshold: input.handoffThreshold,
          guardThreshold: input.guardThreshold,
        }),
      })),

    /**
     * 换模型。就地刷新，不杀 Agent：模型是 Agent 的构造参数，而「重建」不等于「杀」——
     * 参数挂在 Agent 上，刷新就是给字段赋值（`SdkAgent.useModel`）。杀掉会把排队区作废、把正在
     * 写的那条置成 aborted，而用户按的是「换模型」。
     *
     * `modelId` 是必填的 `string`（不可为 `null`）：会话指不到模型那条路是「配置里没这个模型」，
     * 不是「清空」—— 清空之后这一段就没有可用的模型了，那不是用户能表达的意思。
     *
     * 两条报错的次序是先会话、后模型：会话不存在就是 `not_found`，模型不在配置里才是
     * `config_invalid`。反过来先校验模型的话，两者同时不成立时客户端听到的是「换个模型名试试」，
     * 而真正该做的是重新打开会话。
     */
    updateModel: api.procedure
      .input(sessionIdInput.extend({ modelId: z.string() }))
      .output(sessionResult)
      .mutation(async ({ input }) => {
        // 先认会话，再认模型：一段根本不存在的会话，第一句该说的是「这段会话不存在」，而不是
        // 「配置里没有这个模型」—— 后者会让客户端以为换个模型名就好了。这一条与 `update` 里
        // 那一句同词（同一个 `deps.t` 键、同样的 `details`），客户端只认一处文案。
        if (deps.sessions.get(input.sessionId) === undefined) {
          throw new HostError(
            "not_found",
            deps.t("找不到 id 为 {sessionId} 的会话", { sessionId: input.sessionId }),
            { entity: "session", sessionId: input.sessionId },
          );
        }

        if (!deps.config.read().models.some((model) => model.id === input.modelId)) {
          throw new HostError(
            "config_invalid",
            deps.t("配置里没有 id 为 {modelId} 的模型", { modelId: input.modelId }),
            { entity: "model", modelId: input.modelId },
          );
        }

        // `setModel` 一并把 `thinkingLevel` 清成 `null`（档位是模型的参数，把一家的 thinking 参数
        // 带到另一家会被直接拒），这里不重复清。
        const session = deps.sessions.setModel(input.sessionId, input.modelId);

        const agent = deps.runtime.get(session.id);
        if (agent !== undefined) {
          // 档位刚被清空，所以这一刻算出来的参数里没有档位补丁；而基础参数按「生效模型来自
          // 哪一级」取 —— 这里刚把模型写进会话行，那一级就是会话行，而会话行上没有参数这一格，
          // 于是参数整份是空的（定义那份配的是定义自己绑的那个模型，不能发给新模型）。
          // 仍然走同一个函数，不在这里另取一份：算「模型 + 档位补丁」的地方多一处，两处迟早
          // 不一致。
          const { params } = await modelAndParamsFor(deps, session);
          agent.useModel(input.modelId, params);
        }

        return { session };
      }),

    /**
     * 换思考档位。档位名是客户端的选择，请求参数是厂商的方言，两者之间只有档位表能翻译 ——
     * 表由生效模型的 `reasoningPreset` 指过来，所以校验要看生效模型，而不是会话行上那一格。
     *
     * `null` 是「跟随 AgentDefinition」，任何模型都接受；非 `null` 时它必须是那张表里的一个键。
     * 改完同样就地刷新（`useModel`），不杀 Agent。
     */
    updateThinkingLevel: api.procedure
      .input(sessionIdInput.extend({ level: z.string().nullable() }))
      .output(sessionResult)
      .mutation(async ({ input }) => {
        const current = deps.sessions.get(input.sessionId);
        // 与 `setModel` 同一个次序：先认会话，再认模型（这里是「这个模型的档位表认不认它」）。
        // 校验要读会话行（会话级模型是三级里的第一级）。行不在时没有可校验的对象 —— 直接走到
        // 下面 `update`，它抛的 `not_found` 就是这条路上唯一的那一句，这一层不另造一句。
        if (current !== undefined) await assertLevelAllowed(deps, current, input.level);

        const session = deps.sessions.update(input.sessionId, { thinkingLevel: input.level });

        const agent = deps.runtime.get(session.id);
        if (agent !== undefined) {
          // 与装配时同一个算法（基础参数按生效模型来自哪一级取，再叠新档位那一份），只在这一处实现。
          const { resolved, params } = await modelAndParamsFor(deps, session);
          // 三级都空 = 这段会话现在根本没有生效模型：没有可换的目标，这一格已经落库，等它有
          // 模型时按它生效。
          if (resolved !== null) agent.useModel(resolved.modelId, params);
        }

        return { session };
      }),

    /**
     * 撤回到某条自己说过的话之前：那一条与它之后的全部硬删（库里的行、记忆里那一份、没人再
     * 引用的 Asset 字节），正文原样交回去让客户端回填输入框。
     *
     * 规则全在 `rewindTo` 里：只认用户自己说的话、跑着的时候不许撤、删掉的每一条推一条
     * `message.removed`。这一层只把入参递下去 —— 多写一句判断就是两处各有一份规则。
     */
    rewind: api.procedure
      .input(sessionIdInput.extend({ messageId: z.string() }))
      .output(z.object({ content: z.custom<AgentNS.MessageContent>() }))
      .mutation(({ input }) => rewindTo(deps, input.sessionId, input.messageId)),

    /**
     * 删掉这一段会话：硬删，删完这一段的记忆与排队区都没了。
     *
     * 代价不在这里算，也不为此另开一条读口：消息数与 Asset 数都在 `open` 给的那一份里，客户端先
     * 数出代价、问过用户，再调这一条 —— 二次确认是客户端的两步，宿主只回答「删了之后少了什么」。
     *
     * 出参就只有这两个数：删掉了几条消息，以及跟着一起删掉的那几份 Asset（引用归零才删，所以它
     * 可能少于这一段引用过的份数）。会话本身没了，不必再回一行。
     *
     * 收尾与删项目那一条共用一个实现：杀 Agent、收题、忘掉交接那一侧的记忆、收 Asset 引用、删行、
     * 按引用归零扫 Asset。这里的范围只有这一段。
     */
    delete: api.procedure
      .input(sessionIdInput)
      .output(z.object({ messages: z.number(), assets: z.number() }))
      .mutation(({ input }) => {
        // 与 `open` 同一句话、同一份 `details`：`SessionService.remove` 不看有没有这一行，删一段
        // 不存在的会话会安静地成功 —— 先 `get` 一次，才分得出「删掉了」与「本来就没有」。
        if (deps.sessions.get(input.sessionId) === undefined) {
          throw new HostError(
            "not_found",
            deps.t("找不到 id 为 {sessionId} 的会话", { sessionId: input.sessionId }),
            { entity: "session", sessionId: input.sessionId },
          );
        }

        // 条数在删之前数：删完之后这一段的消息行就没有了
        const messages = deps.messages.countBySession(input.sessionId);
        const assets = removeSessions(deps, [input.sessionId], () =>
          deps.sessions.remove(input.sessionId),
        );

        return { messages, assets: assets.length };
      }),
  });
}

/**
 * 这个档位名生效模型认不认。
 *
 * 判据是档位表：键集合就是那个模型能选的全部档位（表里没有 `off` 就不存在「关掉思考」这一档）。
 * 表由生效模型的 `reasoningPreset` 指过来 —— 用 AgentDefinition 上那个模型去查会读错表，那段会话换过
 * 模型时两边不是同一个。
 */
async function assertLevelAllowed(
  deps: HostApiDeps,
  session: SessionRecord,
  level: string | null,
): Promise<void> {
  // 「跟随 AgentDefinition」没有档位要翻译，也就没有表可查。
  if (level === null) return;

  const { resolved, model } = await modelAndParamsFor(deps, session);
  if (resolved === null) {
    throw new HostError(
      "invalid_params",
      deps.t("这段会话没有生效模型，思考档位只能跟随AgentDefinition"),
      { entity: "session", sessionId: session.id, level },
    );
  }

  const presetName = model?.reasoningPreset;
  if (presetName === undefined) {
    throw new HostError(
      "invalid_params",
      deps.t("模型 {modelId} 没有思考档位，只能跟随AgentDefinition", { modelId: resolved.modelId }),
      { entity: "session", sessionId: session.id, modelId: resolved.modelId, level },
    );
  }

  const levels = Object.keys((await deps.config.presets())[presetName]?.levels ?? {});
  if (!levels.includes(level)) {
    throw new HostError(
      "invalid_params",
      deps.t("模型 {modelId} 没有 {level} 这一档，可选：{levels}", {
        modelId: resolved.modelId,
        level,
        levels: levels.join(" / "),
      }),
      {
        entity: "session",
        sessionId: session.id,
        modelId: resolved.modelId,
        level,
        available: levels,
      },
    );
  }
}
