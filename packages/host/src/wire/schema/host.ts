/**
 * `host.*` 的入参形状 —— **唯一真相**。
 *
 * 这一层只回答一个问题：「这份 `params` 的形状对不对」。凭证认不认、托盘那边能不能升级、
 * 进程要不要真的退 —— 都是拿到入参之后的事（服务层 / 接线层直接相信这里的结果，不再自己
 * `typeof`）。
 *
 * 六条按「谁执行」分两拨，但**形状都在这儿**：
 *   - 服务层执行：`upgrade` / `shutdown` / `reload` / `version`；
 *   - 接线层代管：`hello` / `setLanguage`（凭证与语言都是**连接状态**，见 `WsHub.handleHello`
 *     / `handleSetLanguage`）。代管的是「拿到之后做什么」，不是「形状长什么样」—— 所以
 *     这两条照样得有个形状，`parseParams` 也照样在分发之前校一次。
 *
 * 两条贯穿本文件的规矩，与 `session.ts` 一模一样：
 *   1. **可选就是可选**：`foo?: T` → `.optional()`，`T | null` → `.nullable()`。写错一格，
 *      第三波 `z.infer` 顶掉手写类型时当场红。
 *   2. **文案用既有的 reason 词**，Zod 的英文句子一句都不出网。`hello` 那三个字段是个例外里
 *      的例外：它们今天由接线层的 `asHelloParams` 校，客户端已经按 `missing_token` /
 *      `missing_name` / `missing_version` 分支了 —— 这里**逐字沿用**，不换成别的域那个
 *      `empty`（换了就是改契约）。
 */

import { z } from "zod";

/** `not_an_object`：与 `session.ts` / `WsHub.asRecord` 同一个词 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/**
 * 握手凭证（`HostHelloParams.token`）。
 *
 * 口径逐字来自 `asHelloParams`：非字符串、空白串都算「凭证没给」，reason 是既有的
 * `missing_token`；两侧空白剥掉（`verifyToken` 不该看见空格）。
 */
export const hostTokenSchema = z.string("missing_token").trim().min(1, "missing_token");

/**
 * 客户端自报的身份（`ClientInfo`）：连接列表与日志上写的那几格。
 *
 * - `name` / `version`：必填且不能空白，reason 沿用 `asClientInfo` 的
 *   `missing_name` / `missing_version`；
 * - `platform`：可选，仅供展示。空白串**不拒**（`asHelloParams` 把它当「没给」，别为了
 *   一格展示字段把握手拒掉）。
 *
 * 根上不是对象时报 `not_an_object`，字段名由 `parseParams` 从路径拼出来（`clientInfo`）——
 * 与 `asHelloParams` 那句 `asRecord(value, "clientInfo")` 同一个出口。
 */
export const clientInfoSchema = z.object(
  {
    name: z.string("missing_name").trim().min(1, "missing_name"),
    version: z.string("missing_version").trim().min(1, "missing_version"),
    platform: z.string("empty").trim().optional(),
  },
  OBJECT_ERROR,
);

// ---------------------------------------------------------------------------
// host.*（六条）
// ---------------------------------------------------------------------------

/**
 * `host.hello` 入参：凭证 + 可选语言 + 客户端身份（PLAN §6：首帧 `hello`，凭证不放查询串）。
 *
 * `language` **不 trim、不 min**：`asHelloParams` 只判它是不是字符串，空白串由
 * `handleHello` 当作「没声明语言」再回落默认语言（`normalizeLanguage` 自己会 trim）。
 * 这里若加上 `.min(1)`，`language: ""` 就会从「回落默认」变成「握手被拒」—— 那是改语义。
 */
export const hostHelloParams = z.object(
  {
    token: hostTokenSchema,
    language: z.string("empty").optional(),
    clientInfo: clientInfoSchema,
  },
  OBJECT_ERROR,
);

/**
 * `host.version` 入参：没有入参。
 *
 * 空对象也是**形状**：`params: 42` / `null` 该被拒（`not_an_object`）。这不是「没什么可校的」。
 * 形状外的键照 Zod 的默认做法丢掉 —— `NoParams = Record<string, never>` 本来也留不住它们。
 */
export const hostVersionParams = z.object({}, OBJECT_ERROR);

/**
 * `host.upgrade` 入参：可选的目标版本。
 *
 * 不传 = 「升到磁盘上装好的那个版本」。空白串不拒：`app.ts` 的 `upgradeHost` 本来就把它当
 * 「没给」（`trim() !== ""` 才当成一个目标），这里只把两侧空白剥掉，判定仍留在那一处。
 */
export const hostUpgradeParams = z.object(
  {
    targetVersion: z.string("empty").trim().optional(),
  },
  OBJECT_ERROR,
);

/**
 * `host.shutdown` 入参：可选的收尾理由。
 *
 * 只落日志、不参与收尾决策，所以只校「是不是字符串」。空白串不拒 —— 一个说不清理由的退出
 * 请求仍然是个合法的退出请求。
 */
export const hostShutdownParams = z.object(
  {
    reason: z.string("empty").trim().optional(),
  },
  OBJECT_ERROR,
);

/** `host.reload` 入参：没有入参（与 `host.version` 同形，理由见那一条）。 */
export const hostReloadParams = z.object({}, OBJECT_ERROR);

/**
 * `host.setLanguage` 入参：这条连接以后说哪种语言（PRD D8 / F-E4：`/lang` 是连接级动作）。
 *
 * 这里**不枚举** `Language`：`normalizeLanguage` 认 `zh-CN` / `EN` 这类带地区 / 大写的写法，
 * 认不出来回落默认语言 —— 它的职责是「收敛」，不是「驳回」。所以形状只要求「非空字符串」，
 * reason 沿用 `handleSetLanguage` 既有的 `missing_language`（字符串之外的值与空白串都算
 * 「没说清要哪种语言」）。
 */
export const hostSetLanguageParams = z.object(
  {
    language: z.string("missing_language").trim().min(1, "missing_language"),
  },
  OBJECT_ERROR,
);
