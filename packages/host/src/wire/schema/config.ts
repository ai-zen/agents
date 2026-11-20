/**
 * `config.*` 的入参形状 —— **唯一真相**。
 *
 * 口径与 `session.ts` 逐条相同：类型由 `z.infer` 推（`methods.ts` 里那几份 `XxxParams` 不手写
 * 第二遍）、执行点只有 `WsHub.invoke` 一处、失败文案用既有的 reason 词（`empty` /
 * `not_an_object` / `not_positive_integer` / `not_boolean` / `not_allowed` / `not_a_language` /
 * `unknown_transport`），Zod 的英文句子一句都不出网。
 *
 * config 这一域自己有三件事要说清：
 *
 *   1. **深的两块照真实字段展开**。`ConfigPatch`（defaults / limits / behavior）与
 *      `EndpointInput` / `McpServerEntryInput` 是**宿主自己的**形状（`methods.ts` 里逐字段写着），
 *      不是 SDK 的内部结构 —— 展开就是把契约里那句话变成可执行的。
 *   2. **「省略」与「可空」分得开**。`defaultAgent?: string | null` 里省略 = 这次不改、
 *      `null` = 清掉这一项（回落兜底 / 回落英文），所以是 `.nullish()`；写成 `.optional()`
 *      等于把「清空」这条路堵死。
 *   3. **只做「这个取值在不在集合里」这一层**。`language` / 三个行为开关 / MCP 的 `transport`
 *      都是闭合集合，其余判断一概不搬过来：`baseUrl` 像不像 http(s)、`workspace` 作用域要不要
 *      `workspaceId`、`defaultAgent` 指向的助手还在不在、被删的端点还有谁引用 —— 那些都要读磁盘，
 *      留在 `ConfigService` / `DiscoveryService`。
 */

import { z } from "zod";

/**
 * 对象入参的失败文案：`not_an_object`。
 *
 * 与 `session.ts` 里那份是同一个词 —— 客户端早就按它写了分支。
 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

/**
 * 必填文本：两侧空白不算内容，且顺手归一化掉。
 *
 * 判据就是「非空文本 + 剥掉两侧空白」，`empty` 是客户端已经在用的那个词；服务层不再自己剥空白，
 * 从边界下来就是干净的那一串。
 */
const requiredTextSchema = z.string("empty").trim().min(1, "empty");

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/** 端点能力声明（`EndpointCapabilities`）：今天只有「有没有 Files API」这一位 */
export const endpointCapabilitiesSchema = z.object(
  { filesApi: z.boolean("not_boolean").optional() },
  OBJECT_ERROR,
);

/**
 * 端点写入（`EndpointInput`，PRD F-F2）。
 *
 * `apiKey` 省略 = 保留磁盘原值：读出去的密钥是掩码（`sk-…9f3a`），把掩码当密钥写回来是这条路上
 * 最容易犯的错，所以「不改密钥」只由**省略**表达（清掉用空串），这一格因此是 `.optional()` 而
 * 不是 `.nullish()` —— `null` 不是一个有意义的写法，不开口子。
 */
export const endpointInputSchema = z.object(
  {
    id: requiredTextSchema,
    name: requiredTextSchema,
    /** 地址的形态（`not_http_url`）与结尾斜杠的归一化留在服务层：那是取值的事，不是形状 */
    baseUrl: requiredTextSchema,
    apiKey: z.string("empty").optional(),
    description: z.string("empty").optional(),
    capabilities: endpointCapabilitiesSchema.optional(),
  },
  OBJECT_ERROR,
);

/**
 * 默认项里的一格 id：省略 = 这次不改，`null` = 清掉这一项（写盘时字段消失，读出来就是「还没选」），
 * 字符串 = 换成它。
 *
 * 三种写法各有语义（`DefaultSelection` 里那几个 id 的类型就是 `string | null`），所以是
 * `.nullish()`。字符串那一半按 `empty` 那条：空白不算内容。
 */
const nullableSelectionSchema = requiredTextSchema.nullish();

/**
 * 默认项的补丁（`Partial<DefaultSelection>`）—— `config.patch` 的 `defaults` 与
 * `config.setDefaults` 的 `defaults` 共用这一份。
 *
 * 只有 `autoTitle` 是 `.optional()`：它是布尔开关，没有「清掉」这个状态（缺省视为开启，判定在
 * 消费方那一处）；其余六项都指向某个实体 / 某种语言，`null` 有明确含义。
 */
export const defaultSelectionPatchSchema = z.object(
  {
    defaultAgent: nullableSelectionSchema,
    defaultModel: nullableSelectionSchema,
    defaultMigrationModel: nullableSelectionSchema,
    defaultImageModel: nullableSelectionSchema,
    namingModel: nullableSelectionSchema,
    autoTitle: z.boolean("not_boolean").optional(),
    /** 缺省语言（裁定 R58）：取值与 `i18n` 的 `LANGUAGES` 同源，`null` = 清掉（回落英文） */
    language: z.enum(["en", "zh"], "not_a_language").nullish(),
  },
  OBJECT_ERROR,
);

/**
 * 上限的补丁（`Partial<Pick<ConfigLimits, "maxToolOutput">>`）。
 *
 * 只有 `maxToolOutput` 一项可写：`maxAssetBytes` / `maxAssetsPerMessage` 是传输上限（PRD D5），
 * 由 `hello` 报给客户端，不从配置读。
 */
export const configLimitsPatchSchema = z.object(
  {
    /** 工具输出上限（字符数）：正整数的判定只在这一层（`mergeLimits` 已经不判它了） */
    maxToolOutput: z
      .number("not_positive_integer")
      .int("not_positive_integer")
      .positive("not_positive_integer")
      .optional(),
  },
  OBJECT_ERROR,
);

/**
 * 行为开关的补丁（`Partial<ConfigBehavior>`）。
 *
 * 三个都是闭合集合，取值来自 SDK（`AbortedMessageStrategy` = `drop` / `keep`、
 * `AbortedToolRoundStrategy` = `drop` / `fill`、`AutoRefreshWhen | "off"`）。
 * 失败文案用 `not_allowed` —— 这三个字段一贯的词（闭合集合认不出的取值就报它）。
 */
export const configBehaviorPatchSchema = z.object(
  {
    abortedMessageStrategy: z.enum(["drop", "keep"], "not_allowed").optional(),
    abortedToolRoundStrategy: z.enum(["drop", "fill"], "not_allowed").optional(),
    autoRefreshTools: z
      .enum(["off", "outer-loop-start", "inner-loop-start"], "not_allowed")
      .optional(),
  },
  OBJECT_ERROR,
);

/**
 * `ConfigPatch`：一次改动的三块，每块都是局部。
 *
 * 三块全省略 = 空补丁，仍然是合法的一次调用（`ConfigService.patch` 对空补丁也回一次 `applied`，
 * 客户端拿它当「已是最新」的确认）。
 */
export const configPatchSchema = z.object(
  {
    defaults: defaultSelectionPatchSchema.optional(),
    limits: configLimitsPatchSchema.optional(),
    behavior: configBehaviorPatchSchema.optional(),
  },
  OBJECT_ERROR,
);

/** MCP 的两个可编辑作用域（`McpEditableScope`）：5 层链里只有这 2 层能写（PRD F-G1） */
export const mcpEditableScopeSchema = z.enum(["user", "workspace"], "not_allowed");

/**
 * MCP 的 oauth 配置（`McpServerConfig["oauth"]`）。
 *
 * `clientSecret` 与端点的 `apiKey` 同口径：省略 = 保留磁盘原值，空串 = 清掉，所以是
 * `.optional()`（`null` 不是一种写法）。其余几项给了就覆盖，形状照 SDK 原样，不 Trim 任何一格 ——
 * 这些值原样写回文件，多一步归一化就多一次「读回来跟写进去不一样」。
 */
export const mcpOauthInputSchema = z.object(
  {
    authorizationUrl: z.string("empty"),
    tokenUrl: z.string("empty"),
    clientId: z.string("empty"),
    clientSecret: z.string("empty").optional(),
    scope: z.string("empty").optional(),
  },
  OBJECT_ERROR,
);

/**
 * 一条 MCP 条目写入（`McpServerEntryInput` = SDK 的 `McpServerConfig` + `extra`，PRD F-F6）。
 *
 * 与 `DiscoveryEntryView` 是同一份事实的两个方向：视图给 `enabled`，写入收 SDK 的 `disabled`；
 * 视图里 `null` 的字段在这边省略（省略 = 这一项不动，`applyEntryPatch` 的既有语义）。
 *
 * `extra` 收留这一版不认识的键，写回时逐字带上（F-F6「未知字段原样保留」）—— 它必须收成
 * `Record<string, unknown>`：在这一层把值收窄，搬回去的东西就不再是原样。
 */
export const mcpEntrySchema = z.object(
  {
    id: requiredTextSchema,
    /** 传输方式：`unknown_transport` 是 `DiscoveryService.entryId` 对这个字段的既有 reason */
    transport: z.enum(["stdio", "http", "sse"], "unknown_transport"),
    disabled: z.boolean("not_boolean").optional(),
    description: z.string("empty").optional(),
    // ---- stdio ----
    command: z.string("empty").optional(),
    args: z.array(z.string("empty")).optional(),
    env: z.record(z.string(), z.string("empty")).optional(),
    // ---- http / sse ----
    url: z.string("empty").optional(),
    headers: z.record(z.string(), z.string("empty")).optional(),
    // ---- oauth 与未知字段 ----
    oauth: mcpOauthInputSchema.optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  },
  OBJECT_ERROR,
);

// ---------------------------------------------------------------------------
// config.*
// ---------------------------------------------------------------------------

/**
 * `config.get` 入参：没有参数，但**不是**「塞什么都行」。
 *
 * 它的类型是 `ConfigGetParams`（= `NoParams` 的别名）。空对象也是形状：`params: 42` 该被拒，
 * 这就是它比「不校验」多出来的那一件事。
 */
export const configGetParams = z.object({}, OBJECT_ERROR);

/** `config.patch` 入参：一整块 `ConfigPatch`（默认项 / 上限 / 行为开关，三块各自局部） */
export const configPatchParams = z.object({ patch: configPatchSchema }, OBJECT_ERROR);

/** `config.setDefaults` 入参：只改默认项 —— 与 `config.patch` 的 `defaults` 是同一份形状 */
export const configSetDefaultsParams = z.object(
  { defaults: defaultSelectionPatchSchema },
  OBJECT_ERROR,
);

/** `config.saveEndpoint` 入参：建与改是同一个方法（`id` 已存在则改那一条） */
export const configSaveEndpointParams = z.object({ endpoint: endpointInputSchema }, OBJECT_ERROR);

/** `config.deleteEndpoint` 入参：删哪个端点 + 要不要只算引用（`dryRun` 只认布尔） */
export const configDeleteEndpointParams = z.object(
  {
    endpointId: requiredTextSchema,
    dryRun: z.boolean("not_boolean").optional(),
  },
  OBJECT_ERROR,
);

/**
 * `config.getDiscovery` 入参：给不给 `workspaceId`，决定要不要带上那一层的 Workspace 侧来源。
 *
 * 省略 = 只看全局那几层（`user` 与内置各层）；这不是「清空某个 id」，所以只有 `.optional()`。
 */
export const configGetDiscoveryParams = z.object(
  { workspaceId: z.string("empty").optional() },
  OBJECT_ERROR,
);

/**
 * `config.saveMcp` 入参：哪个作用域 + 一条条目（`entry.id` 已在这一层就改，没有就建）。
 *
 * `workspaceId` 在 `scope === "workspace"` 时是必填的 —— 这条**条件必填**不写进 schema：
 * 判它要跨字段，而且「落到哪个项目」本来就得读库（`ConfigService.requireWorkspaceCwd`）。
 * 这里只保形状。
 */
export const configSaveMcpParams = z.object(
  {
    scope: mcpEditableScopeSchema,
    workspaceId: z.string("empty").optional(),
    entry: mcpEntrySchema,
  },
  OBJECT_ERROR,
);

/**
 * `config.deleteMcp` 入参：删哪一层里的哪一条。
 *
 * `id` 本来就不在这一层里时不算失败（`removed: false`），那是服务的回答，不是形状。
 */
export const configDeleteMcpParams = z.object(
  {
    scope: mcpEditableScopeSchema,
    workspaceId: z.string("empty").optional(),
    id: requiredTextSchema,
  },
  OBJECT_ERROR,
);
