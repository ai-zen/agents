import { z } from "zod";

import type {
  AppConfig,
  EndpointDefinition,
  ImageModelDefinition,
  ModelDefinition,
  ReasoningPresets,
} from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import { agentDefinitionRouter } from "./agentDefinition.js";
import type { HostApiDeps } from "./deps.js";
import { mcpRouter } from "./mcp.js";
import type { Trpc } from "./trpc.js";

/**
 * 写配置的出参一律是这一格，与 `get` 里那一格同名同形：客户端拿到的是**改完之后**的整份
 * `AppConfig`，不必自己把补丁叠到手里那份快照上（叠法一旦漏掉一格 —— 比如删模型时被顺手
 * 改指的默认项 —— 界面就安静地显示旧值）。
 *
 * 形状只有 SDK 那一处（`types/index.ts` 的 `AppConfig`），这里不抄第二份：`z.custom` 就是
 * 「这个值的形状由别处声明」（`session.ts` 里 `messages` / `inbox` 用同一个先例）。
 * 抄一份的代价是抄漏一格不会报错，只会让客户端安静地少一个字段。
 */
const configResult = z.object({ config: z.custom<AppConfig>() });

/** 动一个已经存在的 InboxEntry 时，入参只需要它的 id */
const idInput = z.object({ id: z.string() });

/** 默认项五格：给了 `null` 就是清空（`string | null` 与 `undefined` 在入参上分得开） */
const defaultsInput = z.object({
  defaultAgent: z.string().nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  defaultMigrationModel: z.string().nullable().optional(),
  defaultImageModel: z.string().nullable().optional(),
  namingModel: z.string().nullable().optional(),
});

/**
 * 全局那几格：语言、自动命名开关、工具输出上限、中断策略两项。
 *
 * 取值就是 `AppConfig` 里的那几种联合类型：写错了要在边界上被拒，而不是写进文件之后由
 * `normalizeConfig` 在下次启动时静默补成出厂值 —— 那时用户以为改成功了。语言尤其如此：
 * 这里放过一个 `fr`，宿主的 `t` 会一直照着回落到中文，而界面上写着「已保存」。
 *
 * `autoTitle` 只收布尔：这一格关掉只是省下每段新会话那一次几十 token 的请求。写进一个 `"false"`
 * 字符串，自动命名那一侧只能把它当真值读，用户在界面上关了开关而请求照旧发。
 */
const globalInput = z.object({
  language: z.enum(["en", "zh"]).optional(),
  autoTitle: z.boolean().optional(),
  maxToolOutput: z.number().optional(),
  abortedMessageStrategy: z.enum(["drop", "keep"]).optional(),
  abortedToolRoundStrategy: z.enum(["drop", "fill"]).optional(),
});

/**
 * 配置面：一份配置的读与改。
 *
 * 读写同一份形状（`AppConfig` + 档位表两张），一个 `get` 拿全、每个写口回整份。界面因此不需要
 * 「保存」这个动作：改一格提交一格，回来的就是新的那一份（`prd/03-legacy.md` 3.4
 * 「一处管完全部，改完即生效，没有全局保存键」）。
 */
export function configRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    /**
     * 整份配置 + 整张思考档位表。
     *
     * 档位表与 `config.json` 是两个文件，但界面要同时看见它们（模型上那一格 `reasoningPreset`
     * 指的是表里的键），所以一次取回：分两次取，中间可能夹进另一处改动，界面于是显示出自相
     * 矛盾的两半。
     */
    get: api.procedure
      .output(z.object({ config: z.custom<AppConfig>(), presets: z.custom<ReasoningPresets>() }))
      .query(async () => ({
        config: deps.config.read(),
        presets: await deps.config.presets(),
      })),

    defaults: api.router({
      /**
       * 默认项五格。给了 `null` 就是清空（写进去的是 `undefined`，文件里这一格消失）。
       *
       * **赋值时校验引用**：指着一个不存在的 AgentDefinition / 模型，下一次新建会话会在解析模型那一步失败，
       * 而界面上看不出原因（出厂同步会改指 `defaultImageModel` / `defaultMigrationModel`，但那是
       * 下次启动的事）。清空不校验 —— 清空之后没有指向，也就没有指错。
       */
      update: api.procedure
        .input(defaultsInput)
        .output(configResult)
        .mutation(async ({ input }) => ({ config: await setDefaults(deps, input) })),
    }),

    /**
     * 全局那几格：语言、自动命名开关、工具输出上限、中断策略两项。
     *
     * `language` 写完**不重建任何 Agent**：宿主那份语言只有一个写口（`HostApp` 上的 `t`），它
     * 在调用那一刻现读配置，下一次渲染就是新语言。已经落库的通知也不回填 —— 那里存的是产生那
     * 一刻的成品句子，改语言不追认旧账。
     *
     * `autoTitle` 同样不重建 Agent：自动命名在动手之前现读配置（`AutoNamer`），所以写完之后
     * 下一次变闲就是新值。已经起过名的会话不受影响 —— 名字是会话行的格子，这一格只决定还要不要
     * 发那次请求。
     *
     * 中断策略写完**就地刷新活着的 Agent**（见 `applyInterruptStrategies`）；`maxToolOutput` 不
     * 在这条路上刷新，理由也写在那儿。
     */
    update: api.procedure
      .input(globalInput)
      .output(configResult)
      .mutation(async ({ input }) => {
        // 只把「给出来的那几格」放进补丁：`{ maxToolOutput: undefined }` 合并进去会把这一格
        // 从配置里抹掉，而调用方只是没提它
        const change: Partial<AppConfig> = {};
        if (input.language !== undefined) change.language = input.language;
        if (input.autoTitle !== undefined) change.autoTitle = input.autoTitle;
        if (input.maxToolOutput !== undefined) change.maxToolOutput = input.maxToolOutput;
        if (input.abortedMessageStrategy !== undefined) {
          change.abortedMessageStrategy = input.abortedMessageStrategy;
        }
        if (input.abortedToolRoundStrategy !== undefined) {
          change.abortedToolRoundStrategy = input.abortedToolRoundStrategy;
        }

        const config = await deps.config.patch(change);
        applyInterruptStrategies(deps, config);
        return { config };
      }),

    endpoints: api.router({
      create: api.procedure
        .input(z.object({ endpoint: z.custom<EndpointDefinition>() }))
        .output(configResult)
        .mutation(async ({ input }) => ({ config: await deps.endpoints.add(input.endpoint) })),

      update: api.procedure
        .input(
          z.object({ id: z.string(), change: z.custom<Partial<Omit<EndpointDefinition, "id">>>() }),
        )
        .output(configResult)
        .mutation(async ({ input }) => ({
          config: await deps.endpoints.update(input.id, input.change),
        })),

      delete: api.procedure
        .input(idInput)
        .output(configResult)
        .mutation(async ({ input }) => ({ config: await deps.endpoints.remove(input.id) })),
    }),

    models: api.router({
      create: api.procedure
        .input(z.object({ model: z.custom<ModelDefinition>() }))
        .output(configResult)
        .mutation(async ({ input }) => ({ config: await deps.models.add(input.model) })),

      update: api.procedure
        .input(
          z.object({ id: z.string(), change: z.custom<Partial<Omit<ModelDefinition, "id">>>() }),
        )
        .output(configResult)
        .mutation(async ({ input }) => ({
          config: await deps.models.update(input.id, input.change),
        })),

      delete: api.procedure
        .input(idInput)
        .output(configResult)
        .mutation(async ({ input }) => ({ config: await deps.models.remove(input.id) })),

      /** 恢复出厂：换回出厂清单里同 id 的那一条，并重新归入托管（`custom: false`） */
      reset: api.procedure
        .input(idInput)
        .output(configResult)
        .mutation(async ({ input }) => ({ config: await deps.models.reset(input.id) })),
    }),

    imageModels: api.router({
      create: api.procedure
        .input(z.object({ model: z.custom<ImageModelDefinition>() }))
        .output(configResult)
        .mutation(async ({ input }) => ({ config: await deps.imageModels.add(input.model) })),

      update: api.procedure
        .input(
          z.object({
            id: z.string(),
            change: z.custom<Partial<Omit<ImageModelDefinition, "id">>>(),
          }),
        )
        .output(configResult)
        .mutation(async ({ input }) => ({
          config: await deps.imageModels.update(input.id, input.change),
        })),

      delete: api.procedure
        .input(idInput)
        .output(configResult)
        .mutation(async ({ input }) => ({ config: await deps.imageModels.remove(input.id) })),

      reset: api.procedure
        .input(idInput)
        .output(configResult)
        .mutation(async ({ input }) => ({ config: await deps.imageModels.reset(input.id) })),
    }),

    presets: api.router({
      /**
       * 写整张档位表。形状校验在 `PresetService.write` 里（模型那一层还知道「哪一档」是什么
       * 意思）；这一格出参是 `presets` 而不是 `config` —— 它写的是另一份文件，回来的自然是
       * 那一份。
       */
      update: api.procedure
        .input(z.object({ presets: z.custom<ReasoningPresets>() }))
        .output(z.object({ presets: z.custom<ReasoningPresets>() }))
        .mutation(async ({ input }) => ({ presets: await deps.presets.write(input.presets) })),
    }),

    /**
     * AgentDefinition：一条一个文件（`<数据根>/agents/<id>.json`）。
     *
     * 它在 `config.` 下面，因为它就是配置的一种 —— 广义上说，凡是宿主读盘拿到的「该怎么跑」
     * 都算配置，端点、模型、档位表、AgentDefinition 只是各占一份文件或一份文件里的一组。
     * 名字取 `agents` 而不是 `agentDefinition`：`runtime.agent` 是活着的那个，`config.agents`
     * 是 ` 能跑的东西的清单 `，第一段已经把它们分开了。
     */
    agents: agentDefinitionRouter(deps, api),

    /** MCP 服务器：五层 `mcp.json` 的增删读。名字取 `mcp` —— 英文里没“mcps”。 */
    mcp: mcpRouter(deps, api),
  });
}

type DefaultsInput = z.infer<typeof defaultsInput>;

/**
 * 把五格默认项里「给出来的」那一格落进配置。
 *
 * 每一格各自「校验引用 → 换成 `undefined`（清空）或原值」，最后一次写盘：分五次 `patch` 会
 * 写五次盘、发五次事件 —— 而这是一次「保存改动」。
 */
async function setDefaults(deps: HostApiDeps, input: DefaultsInput): Promise<AppConfig> {
  const change: Partial<AppConfig> = {};

  if (input.defaultAgent !== undefined) {
    if (input.defaultAgent !== null) await assertAgentDefinition(deps, input.defaultAgent);
    change.defaultAgent = input.defaultAgent ?? undefined;
  }

  if (input.defaultModel !== undefined) {
    if (input.defaultModel !== null) assertModel(deps, input.defaultModel);
    change.defaultModel = input.defaultModel ?? undefined;
  }

  if (input.defaultMigrationModel !== undefined) {
    if (input.defaultMigrationModel !== null) assertModel(deps, input.defaultMigrationModel);
    change.defaultMigrationModel = input.defaultMigrationModel ?? undefined;
  }

  if (input.namingModel !== undefined) {
    if (input.namingModel !== null) assertModel(deps, input.namingModel);
    change.namingModel = input.namingModel ?? undefined;
  }

  if (input.defaultImageModel !== undefined) {
    if (input.defaultImageModel !== null) assertImageModel(deps, input.defaultImageModel);
    change.defaultImageModel = input.defaultImageModel ?? undefined;
  }

  return deps.config.patch(change);
}

function assertModel(deps: HostApiDeps, id: string): void {
  if (deps.config.read().models.some((model) => model.id === id)) return;
  throw new HostError(
    "invalid_params",
    deps.t("配置里没有 id 为 {modelId} 的模型", { modelId: id }),
    { entity: "model", modelId: id },
  );
}

function assertImageModel(deps: HostApiDeps, id: string): void {
  if ((deps.config.read().imageModels ?? []).some((model) => model.id === id)) return;
  throw new HostError(
    "invalid_params",
    deps.t("配置里没有 id 为 {imageModelId} 的图片模型", { imageModelId: id }),
    { entity: "imageModel", imageModelId: id },
  );
}

async function assertAgentDefinition(deps: HostApiDeps, id: string): Promise<void> {
  const all = await deps.definitions.list();
  if (all.some((definition) => definition.id === id)) return;
  throw new HostError(
    "invalid_params",
    deps.t("找不到 id 为 {agentDefinitionId} 的AgentDefinition", { agentDefinitionId: id }),
    { entity: "agentDefinition", agentDefinitionId: id },
  );
}

/**
 * 把中断策略两项赋到**每一段活着的 Agent**上。
 *
 * 需求原文说这两项「只在造 agent 时读，改完要重建才生效」（`prd/03-legacy.md` 3.4），而过关
 * 标准是「改完下一句话就按新的走」（`prd/PLAN.md` 第 9 行）。两者靠**就地赋这两格**同时成立：
 * core 在每次请求之前才读它们（组装请求时现读 `this.abortedMessageStrategy` /
 * `this.abortedToolRoundStrategy`），所以赋完不杀会话、下一句话就是新策略 —— 而「重建」会把
 * 排队区作废、把正在写的那一条掐成 aborted，用户按的只是改个开关。
 *
 * `maxToolOutput` **不在这条路上刷**：它是 Scope 的输入（工具拿 `Scope.config` 现读），
 * Agent 上没有这一格；容器由配置事件驱动重读（`app.ts` 里那条订阅），写完之后它自己就拿
 * 新值了。
 */
function applyInterruptStrategies(deps: HostApiDeps, config: AppConfig): void {
  const message = config.abortedMessageStrategy;
  const toolRound = config.abortedToolRoundStrategy;
  // 两格都没有就没什么可赋的（`normalizeConfig` 会补齐，走到这里说明配置里确实是缺省的）
  if (message === undefined && toolRound === undefined) return;

  for (const workspace of deps.workspaces.list()) {
    for (const session of deps.sessions.list(workspace.id)) {
      // 拿到就是活着的那一个；`undefined` 表示这段会话现在没有 Agent（重启之后都是这一种），
      // 它下一次被装起来时会读到新配置，现在没有可赋的对象
      const agent = deps.runtime.get(session.id);
      if (agent === undefined) continue;

      if (message !== undefined) agent.abortedMessageStrategy = message;
      if (toolRound !== undefined) agent.abortedToolRoundStrategy = toolRound;
    }
  }
}
