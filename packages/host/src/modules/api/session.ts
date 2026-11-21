import { resolve } from "node:path";

import { z } from "zod";

import type { AgentNS } from "@ai-zen/agents-core";
import { createAgent } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import { hostPlugins, modelAndParamsFor } from "../agent/materials.js";
import { removeSessions } from "../session/remove.js";
import { rewindTo } from "../session/rewind.js";
import type { Session } from "../session/types.js";
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
  nameIsAuto: z.boolean(),
  pinned: z.boolean(),
  agentId: z.string(),
  modelId: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  autoHandoff: z.boolean(),
  lineage: z.string().nullable(),
  handoffThreshold: z.number().nullable(),
  guardThreshold: z.number().nullable(),
  pendingHandoff: z.enum(["self", "summary"]).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * 打开一段会话看到的那一份。
 *
 * `live` 为 `null` 表示这段会话现在没有执行体（重启之后所有会话都是这一种）—— 那时状态无从谈起，
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
 * 改完返回新的一行，与 `open` 那一支同名（`session`）：客户端拿到的是**改完之后**的那一行，
 * 不必自己把补丁叠到手里那份快照上 —— 那种叠法一旦漏掉一格（如 `updatedAt`、或被顺手清掉的
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
     * 打开一段会话：状态、消息、排队区一次取到。
     *
     * 有执行体时五样全从它的内存里读；没有执行体时才读库。分成两次取会在两次请求之间夹进新消息，
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
     * `nameIsAuto: false` 是「人改过之后就不再自动改它」：自动命名只碰那一格还是真的行，
     * 不置 false，用户刚改的名字下一次变闲就会被模型起的名字盖掉。
     */
    rename: api.procedure
      .input(sessionIdInput.extend({ name: z.string() }))
      .output(sessionResult)
      .mutation(({ input }) => ({
        session: deps.sessions.update(input.sessionId, { name: input.name, nameIsAuto: false }),
      })),

    /** 置顶。排序在库里（`pinned DESC, createdAt DESC`），所以写进去之后列表顺序当场就变 */
    pin: api.procedure
      .input(sessionIdInput.extend({ pinned: z.boolean() }))
      .output(sessionResult)
      .mutation(({ input }) => ({
        session: deps.sessions.update(input.sessionId, { pinned: input.pinned }),
      })),

    /** 自动交接开关。越线那一刻由插件从会话行现读，所以改完下一次越线就按新的 */
    setAutoHandoff: api.procedure
      .input(sessionIdInput.extend({ autoHandoff: z.boolean() }))
      .output(sessionResult)
      .mutation(({ input }) => ({
        session: deps.sessions.update(input.sessionId, { autoHandoff: input.autoHandoff }),
      })),

    /**
     * 两条阈值。两个数各自可设：需求给的是「建议硬线 ≈ 软线 × 1.5」，不是约束，所以这里**不做**
     * 「硬线必须大于软线」这类校验 —— 硬绑起来之后，用户想先把软线调到硬线之上试一下都做不到。
     *
     * 两个都写（而不是「传了哪个改哪个」）：`null` 是「跟随模型的配置」这个有意义的取值，
     * 「没传」与「传了 null」在入参上分不出来，分开处理就会把清空读成不改。
     */
    setThresholds: api.procedure
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
     * 换模型。**就地刷新，不杀执行体**：模型是执行体的构造参数，而「重建」不等于「杀」——
     * 参数挂在执行体上，刷新就是给字段赋值（`SdkAgent.useModel`）。杀掉会把排队区作废、把正在
     * 写的那条掐成 aborted，而用户按的是「换模型」。
     *
     * `modelId` 是必填的 `string`（不可为 `null`）：会话指不到模型那条路是「配置里没这个模型」，
     * 不是「清空」—— 清空之后这一段就没有可用的模型了，那不是用户能表达的意思。
     *
     * 两条报错的次序是**先会话、后模型**：会话不存在就是 `not_found`，模型不在配置里才是
     * `config_invalid`。反过来先校验模型的话，两者同时不成立时客户端听到的是「换个模型名试试」，
     * 而真正该做的是重新打开会话。
     */
    setModel: api.procedure
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

        // `setModel` 顺手把 `thinkingLevel` 清成 `null`（档位是模型的参数，把一家的 thinking 参数
        // 带到另一家会被直接拒），这里不重复清。
        const session = deps.sessions.setModel(input.sessionId, input.modelId);

        const agent = deps.runtime.get(session.id);
        if (agent !== undefined) {
          // 档位刚被清空，所以这一刻算出来的参数里没有档位补丁；而基础参数按「生效模型来自
          // 哪一级」取 —— 这里刚把模型写进会话行，那一级就是会话行，而会话行上没有参数这一格，
          // 于是参数整份是**空的**（定义那份配的是定义自己绑的那个模型，不能发给新模型）。
          // 仍然走同一个函数，不在这里另取一份：算「模型 + 档位补丁」的地方多一处，两处迟早
          // 不一致。
          const { params } = await modelAndParamsFor(deps, session);
          agent.useModel(input.modelId, params);
        }

        return { session };
      }),

    /**
     * 换思考档位。档位名是客户端的选择，请求参数是厂商的方言，两者之间只有档位表能翻译 ——
     * 表由**生效模型**的 `reasoningPreset` 指过来，所以校验要看生效模型，而不是会话行上那一格。
     *
     * `null` 是「跟随助手定义」，任何模型都接受；非 `null` 时它必须是那张表里的一个键。
     * 改完同样就地刷新（`useModel`），不杀执行体。
     */
    setThinkingLevel: api.procedure
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
     * 引用的素材字节），正文原样交回去让客户端回填输入框。
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
     * 代价不在这里算，也不为此另开一条读口：消息数与素材数都在 `open` 给的那一份里，客户端先
     * 数出代价、问过用户，再调这一条 —— 二次确认是客户端的两步，宿主只回答「删了之后少了什么」。
     *
     * 出参就只有这两个数：删掉了几条消息，以及跟着一起删掉的那几份素材（引用归零才删，所以它
     * 可能少于这一段引用过的份数）。会话本身没了，不必再回一行。
     *
     * 收尾与删项目那一条共用一个实现：杀执行体、收题、忘掉交接那一侧的记忆、收素材引用、删行、
     * 按引用归零扫素材。这里的范围只有这一段。
     */
    remove: api.procedure
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

    /**
     * 跑一次**一次性会话**：一句投进去、等它跑到闲、把这一次跑出来的消息原样带回去。
     *
     * 这条路给的是 `dev-docs/prd/04-session.md` 「一次性会话：唯一的逃生窗」里那三种里的
     * 宿主入口（今天头一个是 CLI 的纯 stdio 模式：一次调用、一个答案、一个退出码）。它们
     * **不是一段会话的第一次运行**，也不是段/轮/圈里的一个：就是一次到头的会话，跑完就散。
     *
     * **一个字都不落库**，这正是这条路全部的意思：不建会话行、不建 inbox 行、不写消息表。
     * 走 `agent.send`（建行 + 投递）的话，每敲一次命令行库里就多一段会话、项目里多一条工作区行
     * —— 一次性会话跑完就散，那些行没有谁会去删（`session.remove` 是用户手上的动作，不是这条路
     * 收尾的一部分），库只增不减。
     *
     * 所以入参是 `cwd`，**不是 `workspaceId`**：认项目的话，项目行必须先在，于是每敲一次
     * `ai "…"` 就多出一条项目行 —— 会话行是没了，垃圾还在，而项目「只走显式添加」
     * （`workspace.create`）。这条路不建任何行，项目行也不建；一次性会话要的只是一个目录去装配
     * 能力容器，不需要那一行。
     *
     * 四步与次序：
     * 1. `cwd` 归一化一次（`resolve(cwd)`，与 `WorkspaceService.create` 同一个口径）—— 容器按
     *    目录一份，同一个目录两种写法就会装配出两份。**不校验目录存不存在**：不存在的目录照常在、
     *    只报事实（PRD 4.1），真正用到它的那一步自然失败 —— 在这里先拦一道，等于把「这条路上
     *    有什么」提前说死，而那正是宿主不该替别人作的决定；
     * 2. 模型与参数：与装配一段会话同一份口径（`modelAndParamsFor`）—— 一次性会话没有会话行，
     *    所以三级解析只可能落在助手定义或全局兜底上，思考档位那一格这一次不存在（它长在会话行上）；
     * 3. 造**一次性执行体**：取能力容器（`runtime.scopes.for(归一化后的 cwd)`，同一个目录上的几段共用一个）、
     *    `createAgent(..., { lifetime: "one-shot" })`，再装上这条路上该装的那几颗插件
     *    （见 `hostPlugins`：硬线与 subagent 护栏、附件传输照装，自动交接不装）。
     *    **不走 `runtime.wake`** —— 它造的是常驻执行体，要登记、要装一段会话，而这一段既没有
     *    会话可装，也不该在登记表里留下一个跑完就该消失的项；
     * 4. `runOnce`：起 → 投递 → 等闲 → 关门，跑出来的东西就是它的返回值。`ctx.signal` 直接交给
     *    它：客户端断了就该掰掉这一次（一次性会话的寿命就在这条调用栈里）。
     *
     * 出参就是 `runOnce` 返回的那个数组（活对象原样，不拷贝、不重排），因为客户端要的就是
     * 「这一次跑出来的那几条」。
     */
    transient: api.procedure
      .input(
        z.object({
          /** 这次调用要在哪个目录上装配能力容器（归一化一次，不校验是否存在） */
          cwd: z.string().min(1),
          agentId: z.string().min(1),
          /** 与 `agent.send` 同一个 union：一段字符串，或一组内容段（多模态） */
          content: z.union([z.string(), z.array(z.custom<AgentNS.MessageContentSection>())]),
          /** 客户端给这一句的 id（可选）：不给就由执行体自己生成一个 */
          messageId: z.string().optional(),
        }),
      )
      .output(z.object({ messages: z.array(z.custom<AgentNS.Message>()) }))
      .mutation(async ({ input, signal }) => {
        // 项目行一次都不查：这条路不建行，没有行可查，也不该因为「这个目录还没有项目」而拒绝
        // 跑 —— 那种拒绝等于把项目行变成一次性会话的前置条件，正是这次补正要拆掉的那一条。
        //
        // 归一化只做一次，与 `WorkspaceService.create` 同一个口径：能力容器按目录一份，`/a/b` 与
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
            deps.t("助手 {agentDefinitionId} 没有可用的模型", {
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

        // 插件必须排在 `runOnce` 之前：装晚了的代价不是「晚一点生效」——第一批取件可能已经发生，
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
          // 但那条栈还挂着，掐掉它才不会有一个人人都不认的执行体在外面跑
          { signal },
        );

        return { messages };
      }),
  });
}

/**
 * 这个档位名生效模型认不认。
 *
 * 判据是档位表：键集合就是那个模型能选的全部档位（表里没有 `off` 就不存在「关掉思考」这一档）。
 * 表由生效模型的 `reasoningPreset` 指过来 —— 用助手定义上那个模型去查会读错表，那段会话换过
 * 模型时两边不是同一个。
 */
async function assertLevelAllowed(
  deps: HostApiDeps,
  session: Session,
  level: string | null,
): Promise<void> {
  // 「跟随助手定义」没有档位要翻译，也就没有表可查。
  if (level === null) return;

  const { resolved, model } = await modelAndParamsFor(deps, session);
  if (resolved === null) {
    throw new HostError(
      "invalid_params",
      deps.t("这段会话没有生效模型，思考档位只能跟随助手定义"),
      { entity: "session", sessionId: session.id, level },
    );
  }

  const presetName = model?.reasoningPreset;
  if (presetName === undefined) {
    throw new HostError(
      "invalid_params",
      deps.t("模型 {modelId} 没有思考档位，只能跟随助手定义", { modelId: resolved.modelId }),
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
