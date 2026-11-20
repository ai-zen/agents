/**
 * `asset.*` 的入参形状 —— **唯一真相**。
 *
 * 三段式上传（PLAN A11 / PRD F-H8）：`begin` 声明、二进制帧送字节、`end` 校验落定。其中
 * `begin` / `end` 是**接线层自己代管**的（`net/UploadReceiver`：分片要按 `uploadId` 认路、
 * 直接写临时文件，不进 handler 表），`get` 是普通请求。三条都在这张表里 —— 「谁执行」与
 * 「形状是什么」是两件事，代管的那两条同样要从边界上下来就是校验过的。
 *
 * 这一层只回答一个问题：「这份 `params` 的形状对不对」。三条口径与 `session.ts` 同一套：
 *   1. **类型由 `z.infer` 推**：`methods.ts` 里那几份 `XxxParams` 是这里的推导结果；
 *   2. **执行点只有一处**：`WsHub.parseParams` 在分发之前统一校验；
 *   3. **文案用既有的 reason 词**，Zod 的英文句子一句都不出网（PRD D8）。
 *
 * 与 `UploadReceiver` 里那套 `require*` 的分工（迁移是分批的，两边现在并存）：
 *   - **超限**要读配置（`maxAssetBytes`，20MB/张），留在服务层 —— 那是取值，不是形状；
 *   - **用途枚举**与**摘要长度**没有第二个判据，归形状：`bad_value` / `not_a_sha256_digest`
 *     都是这一层能独立判死的；
 *   - `mime` 的格式校验（`type/subtype`）**仍留在** `UploadReceiver`：那条正则不是这一层的
 *     事实，抄一份到这里就是立了第二份，两处只要有一处先改，客户端先撞上哪一边要看运气。
 *     这一层只保证它是「一个非空字符串」。
 *
 * 文案词表沿用同波那几份（`session.ts` / `message.ts` / `model.ts`）的分工：
 *   - `empty` = 必填且不能空；
 *   - `not_a_string` = 只校「是不是字符串」（空串由服务层按自己的语义解释）；
 *   - `not_positive_integer` = 正整数；`bad_value` = 闭环枚举认不出的取值。
 */

import { z } from "zod";

import { sessionIdSchema } from "./session.js";

/**
 * 对象入参的失败文案：`not_an_object`。
 *
 * 与 `WsHub` 里 `asRecord`、`schema/session.ts` 的同一个词 —— 客户端早就按它写了分支。
 * （`session.ts` 里那份是私有的，本波不动它；四个新文件各留一份同名常量。）
 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/** 附件的用途：目前只有图片一种（PRD D5：图片走上传入口）。`bad_value` = 认不出的取值。 */
export const assetPurposeSchema = z.enum(["message_image"], "bad_value");

/** `asset.get` 取哪一档：原图，还是缩略图。缺省由服务层补成 `original`。 */
export const assetVariantSchema = z.enum(["original", "thumb"], "bad_value");

/**
 * 一个素材 id：非空字符串。
 *
 * 失败文案用 `empty`（与 `sessionIdSchema` 同口径：类型不对与没给值对客户端是同一件事
 * ——「这个字段没给出能用的值」）。`.trim()` 是归一化不是检查。
 */
export const assetIdSchema = z.string("empty").trim().min(1, "empty");

/**
 * 一个上传句柄：非空字符串。
 *
 * 文案沿用 `UploadReceiver.requireUploadId` 那个词（`missing_upload_id`）：这个字段今天出网
 * 报的就是它，换成 `empty` 等于改契约。
 */
export const uploadIdSchema = z.string("missing_upload_id").trim().min(1, "missing_upload_id");

/** 内容的 sha256（64 位十六进制）。`.trim()` 与 `normalizeDigest` 同口径；小写化仍由它做。 */
export const sha256Schema = z
  .string("not_a_sha256_digest")
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, "not_a_sha256_digest");

/**
 * 一段声明的字节数：正整数。
 *
 * 判据与 `UploadReceiver.requireDeclaredBytes` 逐条一致（整数、大于 0）。上限**不在**这里：
 * 要读配置（`maxAssetBytes`）才知道这一档是多少 —— 那是取值，留在服务层。
 *
 * 文案用 `not_positive_integer`（同波那几份的公共词；`requireDeclaredBytes` 今天报的是多一个
 * `a` 的 `not_a_positive_integer`，两者是同一条判据的两种拼法 —— 见交付说明的歧义清单）。
 */
const declaredBytesSchema = z
  .number("not_positive_integer")
  .int("not_positive_integer")
  .positive("not_positive_integer");

/** 原始文件名：可以没有；给了就得是个字符串（`trim` 后为空串由服务层当成「没有名字」）。 */
const fileNameSchema = z.string("not_a_string").trim();

// ---------------------------------------------------------------------------
// asset.*
// ---------------------------------------------------------------------------

/**
 * `asset.begin` 入参（三段式的第一段）：声明总长、用途、类型与归属的会话。
 *
 * 六个字段逐一对齐 `AssetBeginParams`：`name` / `sha256` 是可缺的（`?` → `.optional()`），
 * 其余必填。`sha256` 带上就按摘要去重（命中时 `begin` 直接短路，客户端不必再送字节）。
 */
export const assetBeginParams = z.object(
  {
    purpose: assetPurposeSchema,
    mime: z.string("empty").trim().min(1, "empty"),
    bytes: declaredBytesSchema,
    name: fileNameSchema.optional(),
    sha256: sha256Schema.optional(),
    sessionId: sessionIdSchema,
  },
  OBJECT_ERROR,
);

/**
 * `asset.end` 入参（三段式的第三段）：句柄 + 客户端算的摘要。
 *
 * 长度对不对、摘要与字节对不对，都要等字节收完才知道 —— 那是服务层的事，这里只管形状。
 */
export const assetEndParams = z.object(
  {
    uploadId: uploadIdSchema,
    sha256: sha256Schema,
  },
  OBJECT_ERROR,
);

/**
 * `asset.get` 入参：按素材 id 取回内容，`variant` 可缺（缺省 `original`）。
 *
 * 「这段素材在不在」不在这里判（那是 `not_found`，服务层的事）。
 */
export const assetGetParams = z.object(
  {
    assetId: assetIdSchema,
    variant: assetVariantSchema.optional(),
  },
  OBJECT_ERROR,
);
