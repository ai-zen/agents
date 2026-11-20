/**
 * `model.*` 的入参形状 —— **唯一真相**。
 *
 * 口径与 `session.ts` 完全一致（那里把三条理由写全了，这里不重复）：类型由 `z.infer` 推、执行点
 * 只有 `WsHub.parseParams` 一处、失败文案只用既有的 reason 词（`empty` / `not_an_object` /
 * `not_positive_integer` / `not_boolean`）—— Zod 默认的英文句子一句都不出网。
 *
 * 这一层只回答「形状对不对」。**取值范围与业务事实留在服务层**，一条都没搬上来：
 *   - 端点存不存在 → `ModelService.validateModelShape`（`endpoint_not_found`）；
 *   - 思考策略在不在表里 → 同上（`unknown_preset`，要读 `reasoning-presets.json`）；
 *   - 模型被谁引用 / 默认项指向它 → `ModelService.delete`（`config.referenced`）；
 *   - 两条阈值的相对关系（`handoff < guard`）→ `ModelService.assertThresholds`
 *     （`handoff_not_below_guard`）：它跨 `handoff` / `guard` 两格，且是「这条线该怎么画」而不是
 *     「这一格填的是什么」，暂留服务层。
 *
 * 另一个刻意的克制：这个域里**没有枚举**。`reasoningPreset` / `defaultSize` / `defaultQuality` 在
 * 契约里都是裸 `string`（策略表与尺寸表是配置里的事实，不是封闭集合），所以这里不发明 `z.enum`。
 */

import { z } from "zod";

import { sessionIdSchema } from "./session.js";

/**
 * 对象入参的失败文案：`not_an_object`。
 *
 * 与 `session.ts` 里的那个常量同一个词 —— 客户端早就按它写了分支。
 * （`session.ts` 没把它导出，所以这里各自留一份字面量；值一样，不构成第二套契约。）
 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/**
 * 必填的一段文本：非空字符串，两侧空白不算内容。
 *
 * 判据是「非空文本 + 两侧空白不算内容」，`empty` 是客户端已经在用的那个词（`model` 与
 * `imageModel` 上面那几格必填文本报的都是它）。
 * `.trim()` 是**归一化**不是检查：从边界下来就是干净的那一串。
 */
const requiredTextSchema = z.string("empty").trim().min(1, "empty");

/**
 * 选填的一段文本：给了就得是字符串，**不 min、不 trim**。
 *
 * `description` / `defaultSize` / `defaultQuality` 这几个字段服务层从来只是原样存（`definedOnly`
 * 直接透传），空串一直是合法的取值 —— 这里也只判类型，不替它决定「空串算不算没填」。
 */
const optionalTextSchema = z.string("empty").optional();

/**
 * 一个模型 id（图片模型 id 同形）：非空字符串，两侧空白不算内容。
 *
 * 它与 `sessionIdSchema` 同形 —— 模型不是一实体一文件（存在 `config.json` 里），所以不套
 * `agentIdSchema` 那套文件名字符集。直接复用，不重写第二份 id 规则。
 */
const modelIdSchema = sessionIdSchema;

/** `dryRun?: boolean`：只认布尔（`"yes"` / `1` 不再被静默当成「不预演」） */
const dryRunSchema = z.boolean("not_boolean").optional();

/**
 * 一条阈值：**正整数**。
 *
 * `0` 与负数、小数、非数字一律 `not_positive_integer`（与 `session.setThresholds`、
 * `config.patch` 的上限那几个字段同一个词）—— 阈值量的是绝对 token 数，0 是条没有意义的线。
 */
const thresholdSchema = z
  .number("not_positive_integer")
  .int("not_positive_integer")
  .positive("not_positive_integer");

/**
 * 两条上下文阈值（PRD F-D1 / D27：交接软线 + 阻断硬线）。
 *
 * 两格都必填：`TokenThresholds` 没有可省略的一格，缺一格就是「这条模型没有阈值」——
 * 那正是 SDK 侧要拿出厂值去补的坏状态，不该从边界上进得来。（`handoff < guard` 的关系见文件头：
 * 仍由服务层判。）
 */
export const tokenThresholdsSchema = z.object(
  { handoff: thresholdSchema, guard: thresholdSchema },
  OBJECT_ERROR,
);

/**
 * 模型写入（PRD F-F3）：`model.create` 的 `model`、以及 `model.update` 的 `patch` 减掉 `id`。
 *
 * 逐字段对着 `wire/methods.ts` 的 `ModelInput`：`modelName` / `tokenThresholds` / `defaultParams` /
 * `reasoningPreset` / `vision` / `description` 全是「省略 = 不写这一格」（`.optional()`，
 * 没有一个可空）。`tokenThresholds` 省略的语义两处不同（`create` 套出厂默认、`update` 不动），
 * 那是服务层的事，形状上是一样的。
 */
export const modelInputSchema = z.object(
  {
    id: modelIdSchema,
    name: requiredTextSchema,
    endpointId: requiredTextSchema,
    modelName: optionalTextSchema,
    tokenThresholds: tokenThresholdsSchema.optional(),
    defaultParams: z.record(z.string(), z.unknown(), OBJECT_ERROR).optional(),
    reasoningPreset: optionalTextSchema,
    vision: z.boolean("not_boolean").optional(),
    description: optionalTextSchema,
  },
  OBJECT_ERROR,
);

/**
 * `model.update` 的 `patch`：`Partial<Omit<ModelInput, "id">>` 的形状。
 *
 * 八格全选填，但**给了就得对**（`name: "#"` 依旧被拒、`name: 3` 依旧 `empty`）。`id` 不在里面：
 * 改模型不改 id（`modelId` 单独一格），这条在类型上就已经定死了。
 */
export const modelPatchSchema = z.object(
  {
    name: requiredTextSchema.optional(),
    endpointId: requiredTextSchema.optional(),
    modelName: optionalTextSchema,
    tokenThresholds: tokenThresholdsSchema.optional(),
    defaultParams: z.record(z.string(), z.unknown(), OBJECT_ERROR).optional(),
    reasoningPreset: optionalTextSchema,
    vision: z.boolean("not_boolean").optional(),
    description: optionalTextSchema,
  },
  OBJECT_ERROR,
);

/**
 * 图片模型写入（PRD F-F4）：`ImageModelInput` 的形状。
 *
 * `id` / `name` / `endpointId` / `modelName` 四格必填（reason 都是 `empty`）；
 * `description` / `defaultSize` / `defaultQuality` 三格可省略。与文本模型不同，这里**没有**阈值、
 * 没有 `defaultParams`、没有 `vision` —— 图片模型既不看上下文窗口也没有思考概念。
 */
export const imageModelInputSchema = z.object(
  {
    id: modelIdSchema,
    name: requiredTextSchema,
    endpointId: requiredTextSchema,
    modelName: requiredTextSchema,
    description: optionalTextSchema,
    defaultSize: optionalTextSchema,
    defaultQuality: optionalTextSchema,
  },
  OBJECT_ERROR,
);

// ---------------------------------------------------------------------------
// model.*（8 个，顺序与方法表一致）
// ---------------------------------------------------------------------------

/**
 * `model.list` 入参：只有「连不可用的也列吗」一格。
 *
 * 默认列（PRD F-B5 / D12 的口径：藏起来会让人以为它没了），`includeUnavailable: false` 时才筛掉。
 */
export const modelListParams = z.object(
  { includeUnavailable: z.boolean("not_boolean").optional() },
  OBJECT_ERROR,
);

/**
 * `model.listImages` 入参：**空对象也是形状**。
 *
 * 方法表里它写的是 `params: NoParams`（无入参），但「无入参」不等于「什么都不看」：
 * `params: 42` / `params: "x"` 该被拒（`not_an_object`），`params` 整个不给则照旧（`frames.ts`
 * 把缺省的 `params` 补成 `{}`）。顺手把形状外的键丢掉，与其它已迁移的方法同一口径。
 */
export const modelListImagesParams = z.object({}, OBJECT_ERROR);

/** `model.create` 入参：一条模型写入，建出来就是自定义（PRD F-F3） */
export const modelCreateParams = z.object({ model: modelInputSchema }, OBJECT_ERROR);

/**
 * `model.update` 入参：改哪条 + 改哪几格（PRD F-F3：编辑即转自定义）。
 *
 * `patch` 是**必填的**（与 `ModelUpdateParams` 一致）；服务层现在写的是 `params.patch ?? {}`，
 * 即「不给 patch 就当空补丁」—— 那是 TS 类型之外的宽容，这里不跟着放宽。
 */
export const modelUpdateParams = z.object(
  { modelId: modelIdSchema, patch: modelPatchSchema },
  OBJECT_ERROR,
);

/** `model.delete` 入参（被助手引用时禁删并列出引用者，PRD F-F2 / F-F7） */
export const modelDeleteParams = z.object(
  { modelId: modelIdSchema, dryRun: dryRunSchema },
  OBJECT_ERROR,
);

/** `model.restoreFactory` 入参（PRD F-F3：恢复出厂是整条替换，不需要补丁） */
export const modelRestoreFactoryParams = z.object({ modelId: modelIdSchema }, OBJECT_ERROR);

/** `model.saveImage` 入参（PRD F-F4：同一个方法兼创建与修改，`id` 在就改、不在就建） */
export const modelSaveImageParams = z.object({ imageModel: imageModelInputSchema }, OBJECT_ERROR);

/** `model.deleteImage` 入参（被「默认图片模型」引用时禁删，PRD F-F7 / F-F4） */
export const modelDeleteImageParams = z.object(
  { imageModelId: modelIdSchema, dryRun: dryRunSchema },
  OBJECT_ERROR,
);
