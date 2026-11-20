/**
 * `session.*`（以及第一波一起立的 `agent.delete`）的入参形状 —— **唯一真相**。
 *
 * 这一层只回答一个问题：「这份 `params` 的形状对不对」。取值允不允许、实体在不在、此刻能不能
 * 动，都不在这里（那是服务层的事：它们拿到的是已经校验过的东西，直接相信，不再自己 `typeof`）。
 *
 * 三条口径：
 *   1. **类型由 `z.infer` 推**：`methods.ts` 里那几份 `XxxParams` 是这里的推导结果，不手写第二
 *      遍 —— 两处各写一份，迟早有一处先漂。
 *   2. **执行点只有一处**：`WsHub.invoke` 在分发之前统一校验一次。服务层不 `parse`。
 *   3. **文案用既有的 reason 词**（`empty` / `not_an_object` / `not_a_file_name` / `not_boolean`）：
 *      这些是客户端已经在按它分支的 `detail.reason`。Zod 默认的英文句子
 *      （`Invalid input: expected string, received undefined`）一句都不出网 —— 出网的是码 + 参数，
 *      句子归 i18n 渲染（PRD D8）。
 *
 * 一域一文件：这个文件只放 `session.*`。`agent.*` 目前只有第一波的 `agent.delete` 一条，先在
 * 这里落着（同批立的模式），铺开 agent 域时整段搬到 `agent.ts`。
 */

import { z } from "zod";

/**
 * 对象入参的失败文案：`not_an_object`。
 *
 * 与 `WsHub` 里 `asRecord` 那一处同一个词 —— 客户端早就按它写了分支，换了词等于改契约。
 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/**
 * 一段会话的 id：非空字符串，两侧空白不算内容。
 *
 * `empty` 是既有那套 reason 里的词（`SessionService.requireId` 用的就是它）；这里把「类型不是
 * 字符串」也归到 `empty`：对客户端来说，这两种情况说的是同一件事 —— 「这个字段没给出能用的值」。
 *
 * `.trim()` 是**归一化**不是检查：迁到 schema 上的方法不再自己剥空白（服务层原来逐处
 * `requireId` / `requireSession` 各 trim 一次），从边界下来就是干净的那一串。
 */
export const sessionIdSchema = z.string("empty").trim().min(1, "empty");

/**
 * 一个助手 id：它同时是定义文件名（PRD F-G3），所以字符集比会话 id 严。
 *
 * 规则与 `AgentService.requireId` 原来那条一模一样：只允许字母数字与 `-` `_` `.`，且不能是 `.`
 * 或 `..`（那两个在文件系统里指自己与上级目录）。失败文案沿用既有的 `not_a_file_name`。
 */
const AGENT_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** 一个助手 id（见 {@link AGENT_ID_PATTERN}） */
export const agentIdSchema = z
  .string("empty")
  .trim()
  .min(1, "empty")
  .regex(AGENT_ID_PATTERN, "not_a_file_name");

// ---------------------------------------------------------------------------
// session.*
// ---------------------------------------------------------------------------

/**
 * `session.start` 入参：只有一段会话的 id。
 *
 * 这个动作「为什么只是叫醒、不顺手投递」写在契约那份上（`wire/methods.ts` 的
 * `SessionStartParams`）；这里负责的只有形状：一个非空的 `sessionId`。
 */
export const sessionStartParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

/**
 * `session.pause` 入参：与 `session.start` 同形 —— 只有一段会话的 id。
 *
 * 暂停的语义（关输出闸、不掐在途、交接期间拒）见契约那份的 `SessionPauseParams`。
 */
export const sessionPauseParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

// ---------------------------------------------------------------------------
// agent.*（第一波同批立模式的一条）
// ---------------------------------------------------------------------------

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
