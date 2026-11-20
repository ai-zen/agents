/**
 * `agent.*` 的入参形状 —— **唯一真相**。
 *
 * 口径与 `session.ts` / `config.ts` 逐条相同：类型由 `z.infer` 推、执行点只有 `WsHub.invoke`
 * 一处、失败文案用既有的 reason 词（`empty` / `not_a_file_name` / `not_an_object` /
 * `not_boolean`），Zod 的英文句子一句都不出网。
 *
 * 第一波同批立的 `agent.delete`（原先落在 `session.ts`）也整段搬到了这里，`agent.*` 的形状
 * 于是只有这一个文件。
 *
 * **一件要先说清的事**：`AgentInput` 里那三个字段（`messages` / `permissions` / `function`）的
 * 形状**属于 SDK/core，不属于宿主** —— `methods.ts` 里写的就是 `AgentDefinition["messages"]`
 * 这类引用，没有第二份定义。所以这里不逐字段重建它们，只用 `z.custom<...>` 把类型钉住：
 *
 *   - `messages` 是 `AgentNS.Message[]`，里面还带宿主的本机扩展字段（`__asset_id`，见
 *     `states.ts` 的 `LocalMessageContentSection`）和类实例字段（`error: AgentError`）。
 *     照字段重建一遍等于给 SDK 的形状立第二份定义：`z.object` 会把没写的键**静默剥掉**，
 *     「原样交给 SDK」这个保证当场断掉，而且两处定义迟早有一处先漂。
 *   - `permissions` / `function` 同理（`function.parameters` 是一整份 JSON Schema）。
 *
 * 于是这一层对它们只做一件事：钉住类型，让 `z.infer` 推出的就是 SDK 那份类型；字段级校验
 * 留给定义它的那一层。内容语义也不在这里：「至少要有一条 system 消息」（`no_system_message`）
 * 是助手定义的内容约束，`AgentService.requireMessages` 留着。
 */

import type { AgentDefinition } from "@ai-zen/agents-sdk";
import { z } from "zod";

import { agentIdSchema } from "./session.js";

/**
 * 对象入参的失败文案：`not_an_object`。
 *
 * 与 `session.ts`、`WsHub` 的 `asRecord` 是同一个词 —— 客户端早就按它写了分支。
 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

/**
 * 必填文本：两侧空白不算内容，且顺手归一化掉。
 *
 * 与 `AgentService.requireName` 一模一样（`empty` 那个词也是从它来的）。`agentId` 用的不是它，
 * 是 `agentIdSchema`（助手 id 同时是文件名，字符集更严）。
 */
const requiredTextSchema = z.string("empty").trim().min(1, "empty");

// ---------------------------------------------------------------------------
// 可复用的形状（SDK 拥有的那三样：只钉类型，不复制字段）
// ---------------------------------------------------------------------------

/**
 * 预设消息（`AgentDefinition["messages"]` = `AgentNS.Message[]`）。
 *
 * 只钉「它是一组消息」这一层：非数组沿用 `AgentService.requireMessages` 原来那个 reason
 * （`empty`）。字段不重建，理由见文件头。
 */
export const agentMessagesSchema = z.custom<AgentDefinition["messages"]>(
  (value) => Array.isArray(value),
  "empty",
);

/** 四维权限（`AgentDefinition["permissions"]` = `AgentPermissions`）：形状照 SDK 原样 */
export const agentPermissionsSchema = z.custom<NonNullable<AgentDefinition["permissions"]>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "not_an_object",
);

/** subagent 的函数定义（`AgentDefinition["function"]` = `AgentNS.FunctionDefine`） */
export const agentFunctionSchema = z.custom<NonNullable<AgentDefinition["function"]>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "not_an_object",
);

/**
 * 助手写入（`AgentInput`）—— `agent.create` 的 `agent` 与 `agent.update` 的 `patch` 同源。
 *
 * `id` 同时是定义文件名（PRD F-G3），所以用第一波立好的 `agentIdSchema`（字符集比一般文本严）；
 * `messages` 必填：没有提示词的助手定义跑起来没有行为约束。
 *
 * `modelId` 这一格**不能** `.min(1)` 也**不能** `.trim()`：空串是一个有效写法，表示「把绑定
 * 清掉」（`AgentService.update` 里那条三分支），三级解析于是落到配置里的兜底模型。
 */
export const agentInputSchema = z.object(
  {
    id: agentIdSchema,
    name: requiredTextSchema,
    description: z.string("empty").optional(),
    messages: agentMessagesSchema,
    modelId: z.string("empty").optional(),
    modelParams: z.record(z.string(), z.unknown()).optional(),
    permissions: agentPermissionsSchema.optional(),
    function: agentFunctionSchema.optional(),
  },
  OBJECT_ERROR,
);

/**
 * 局部更新（`Partial<AgentInput>`）：`agent.update` 的 `patch`。
 *
 * 每一格都 `.optional()`：省略 = 这次不改（`definedOnly` 的既有语义）。形状与 `agentInputSchema`
 * 是同源的一份，所以直接 `.partial()` —— 第二份手写的 Partial 迟早与它漂开。
 */
export const agentInputPatchSchema = agentInputSchema.partial();

// ---------------------------------------------------------------------------
// agent.*
// ---------------------------------------------------------------------------

/** `agent.get` 入参：看哪个助手 */
export const agentGetParams = z.object({ agentId: agentIdSchema }, OBJECT_ERROR);

/**
 * `agent.list` 入参：没有。
 *
 * 空对象也是一种形状：`params: 42` / `"x"` 在边界上被拒（以前它被静默当成「没给」）。
 */
export const agentListParams = z.object({}, OBJECT_ERROR);

/** `agent.create` 入参：一整份助手定义（`custom: true` 由服务层写，不是入参） */
export const agentCreateParams = z.object({ agent: agentInputSchema }, OBJECT_ERROR);

/** `agent.update` 入参：改哪个助手 + 局部定义（省略的字段不动） */
export const agentUpdateParams = z.object(
  {
    agentId: agentIdSchema,
    patch: agentInputPatchSchema,
  },
  OBJECT_ERROR,
);

/**
 * `agent.delete` 入参：助手 id + 可选的预演开关。
 *
 * `dryRun` 只认布尔：`true` = 只算代价不落盘。原来服务层读的是 `params.dryRun === true`，
 * 于是 `"yes"` / `1` 这类值会被静默当成「不预演」—— 那正是这一层要收掉的东西。
 *
 * 删除的语义（引用者清单、删默认助手时连带清默认）见契约那份的 `AgentDeleteParams`。
 */
export const agentDeleteParams = z.object(
  {
    agentId: agentIdSchema,
    dryRun: z.boolean("not_boolean").optional(),
  },
  OBJECT_ERROR,
);

/**
 * `agent.setModel` 入参：把助手默认模型换成哪个（影响以后的会话；与 `session.setModel` 是两个
 * 动作、两个入口）。
 *
 * `modelId` 在这条路上走的是 `AgentService.requireId`（模型 id 也是文件名），这里只把
 * 「非空文本」钉住；字符集（`not_a_file_name`）仍由那一处判 —— 它同时管着 `.` / `..` 这种
 * 落到文件系统上会指别处的值，那是判定，不是形状。
 */
export const agentSetModelParams = z.object(
  {
    agentId: agentIdSchema,
    modelId: requiredTextSchema,
  },
  OBJECT_ERROR,
);

/**
 * `agent.setThinking` 入参：写进去的是档位名（`ThinkingState.levels` 里的一档），
 * `null` 是撤回设值 —— 把定义里属于思考策略的那些参数删掉，回到「参数即真相」。
 *
 * `level: string | null` ⇒ `.nullable()`，**不是** `.optional()`：「这次不改思考」就是不调这个
 * 方法（`setThinking` 只有「某一档」与「撤回」两条路），省略不是一个有意义的写法。
 * 档位在不在这个模型的策略表里要读配置，仍由服务层判。
 */
export const agentSetThinkingParams = z.object(
  {
    agentId: agentIdSchema,
    level: requiredTextSchema.nullable(),
  },
  OBJECT_ERROR,
);

/**
 * `agent.restoreFactory` 入参：恢复哪个助手 + 要不要只预演（`dryRun` 只认布尔）。
 *
 * 「这个助手有没有出厂版本」（`not_a_factory_agent`）不在形状这一层：它看的是 SDK 的出厂清单。
 */
export const agentRestoreFactoryParams = z.object(
  {
    agentId: agentIdSchema,
    dryRun: z.boolean("not_boolean").optional(),
  },
  OBJECT_ERROR,
);
