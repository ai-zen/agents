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
 * 第二波把 `session.*` 铺满（19 个方法：`start` / `pause` 是第一波那两条）。铺满时多守着一条
 * **逐字符对齐 `methods.ts`** 的规矩，因为它决定第三波能不能把类型源码整段换成 `z.infer`：
 *
 *   | TS 里写的 | 这里写的 |
 *   |---|---|
 *   | `foo: T`（必填） | 必填 |
 *   | `foo?: T` | `.optional()` |
 *   | `foo: T \| null` | `.nullable()` |
 *   | `foo?: T \| null` | `.nullish()` |
 *
 * 另一条是**收紧的边界只到「这套边界原来已经这么判」为止**：必填的 id / 名字（空白不算值）、
 * 阈值那两格（`0` 不算）本来就把它们当参数不对，这里照样收；而服务层当「没给」
 * 处理的那些空白（`message.list` 的 `after` / `around`、`session.list` 的筛选条件这类），这里
 * 就只校类型，不替它改语义 —— 校验层的职责是「形状对不对」，不是重新立法。
 *
 * 一域一文件：这个文件只放 `session.*`。两处例外都是「同一条方法带来的形状」：
 *   - `agentIdSchema`（助手 id 同时是定义文件名）也在这里导出：第一波同批立的 `agent.delete`
 *     曾在这里落着，铺开 agent 域时整段搬到了 `agent.ts`（连同注释），它却像 `sessionIdSchema`
 *     一样是跨域复用的形状，所以留下；
 *   - `messageInputSchema`（`session.send` / `session.transient` 的嵌套入参）也在这里导出：
 *     它是 core 的内容形状 + 素材引用，将来别的域（`handoff.*`、搜索那侧）要用同一份，从哪儿
 *     import 都一样。
 */

import { z } from "zod";

/**
 * 对象入参的失败文案：`not_an_object`。
 *
 * 每个 schema 文件各有一份同值字面量 —— 客户端早就按它写了分支，换了词等于改契约。
 */
const OBJECT_ERROR = { error: "not_an_object" } as const;

// ---------------------------------------------------------------------------
// 可复用的形状
// ---------------------------------------------------------------------------

/**
 * 一段会话的 id：非空字符串，两侧空白不算内容。
 *
 * `empty` 是既有那套 reason 里的词（会话 id 一直报的就是它）；这里把「类型不是
 * 字符串」也归到 `empty`：对客户端来说，这两种情况说的是同一件事 —— 「这个字段没给出能用的值」。
 *
 * `.trim()` 是**归一化**不是检查：迁到 schema 上的方法不再自己剥空白（服务层原来逐处
 * 自己 `trim()` 一次），从边界下来就是干净的那一串。
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

// 说明：`agentIdSchema` 虽然由 `agent.*` 用，但它和 `sessionIdSchema` 一样是**跨域**的复用形状
// （`agent.delete` 之后还有 `agent.get` 等七条要用），所以留在这里导出，`agent.ts` 从这里 import。

/**
 * 必填的文本类参数：非空字符串，两侧空白不算内容。
 *
 * 与 `sessionIdSchema` 同一口径（同一个 reason 词 `empty`），只是不给它单独起一个导出的名字
 * —— 会话名、`beforeMessageId`、`cwd`、`workspaceId` 这些字段原来都由同一条判据管
 * （`trim()` 之后为空就当参数不对），形状就是这一份。
 *
 * `.trim()` 同样是归一化：改名、撤回点、一次性会话的目录基准，从边界下来就已经是干净的那一串
 * （`TransientRunner` 原来自己 `trim()` 一次 `cwd`，口径一致）。
 */
const nonEmptyText = z.string("empty").trim().min(1, "empty");

/**
 * 一条会话自己的阈值（`session.setThresholds` 的两格）：**三态**。
 *
 * 省略 = 不动、`null` = 回到「跟模型走」、正整数 = 这一段自己的数字 —— 所以是 `.nullish()`
 * （`undefined` 与 `null` 都收），不是 `.optional()`。
 *
 * 数字部分：`0` 不收（阈值量的是「请求前的输入用量」的绝对 token 数，0 是个没有意义的线；
 * 要「这条线不设」请给 `null`），负数、小数、
 * `NaN` / `Infinity` 同理，失败文案沿用既有的 `not_positive_integer`。
 */
const thresholdSchema = z
  .number("not_positive_integer")
  .int("not_positive_integer")
  .min(1, "not_positive_integer")
  .nullish();

// ---------------------------------------------------------------------------
// 用户输入：内容段与素材引用（`session.send` / `session.transient` 的嵌套入参）
// ---------------------------------------------------------------------------

/**
 * 内容段上的 `index`：core 里是可省的序号（`AgentNS.MessageContentSection` 的三段都带它）。
 *
 * 只校「给了就得是数字」：core 不要求连续、也不要求从 0 起，那是调用方自己摆顺序的事。
 */
const sectionIndexSchema = z.number("not_a_number").optional();

/**
 * 一个纯文本段：core 的 `AgentNS.TextContentSection` 原样。
 *
 * `text` 不设非空下限：空字符串在 core 里就是一个合法的文本段（拼接、`formatContent` 白名单
 * 都按「有这个字段」处理），把「空的就不算数」搬进来等于在这里立法。
 */
const textSectionSchema = z.object(
  {
    index: sectionIndexSchema,
    type: z.literal("text", "bad_value"),
    text: z.string("not_a_string"),
  },
  OBJECT_ERROR,
);

/**
 * 一个图片段：core 的 `AgentNS.ImageUrlContentSection` 原样。
 *
 * `image_url.url` 既可能是 `data:` URL（内联）也可能是远端地址，host 不判它指哪儿；`detail`
 * 的四档取值是 core 那个联合类型的全部，别的一律 `bad_value`。
 */
const imageSectionSchema = z.object(
  {
    index: sectionIndexSchema,
    type: z.literal("image_url", "bad_value"),
    image_url: z.object(
      {
        url: z.string("not_a_string"),
        detail: z.enum(["low", "high", "original", "auto"], "bad_value").optional(),
      },
      OBJECT_ERROR,
    ),
  },
  OBJECT_ERROR,
);

/**
 * 一个文件段：core 的 `AgentNS.FileContentSection` 原样。
 *
 * `file_id` / `file_data` / `filename` 三格在 core 里都是可省的，三者之间的搭配规矩
 * （`file_id` 与 `file_data` 互斥、`filename` 只在 `file_data` 时能带）归 core 的
 * `formatContentSection`：那一层是发出去之前最后一道白名单，这里再写一遍就等于有两份规矩。
 */
const fileSectionSchema = z.object(
  {
    index: sectionIndexSchema,
    type: z.literal("file", "bad_value"),
    file_id: z.string("not_a_string").optional(),
    file_data: z.string("not_a_string").optional(),
    filename: z.string("not_a_string").optional(),
  },
  OBJECT_ERROR,
);

/**
 * 一个内容段：core 的 `AgentNS.MessageContentSection` 三种 `type` 的判别联合。
 *
 * 判别键就是 `type`，所以 `{ type: "图片" }` 这类会在**路径上**报出来（`content.0.type`），
 * 客户端据此知道是哪一段的第几段坏了。段上的 `__` 开头的本地扩展（`__asset_id`）不在
 * `MessageInput.content` 的类型里 —— 它由宿主在**落库那一刻**补上（`AssetService` 的
 * `withAssetId`），出网的那一份由 core 的 `formatContent` 按字段白名单重建，所以从边界下来
 * 的段不需要它。
 */
export const messageContentSectionSchema = z.discriminatedUnion(
  "type",
  [textSectionSchema, imageSectionSchema, fileSectionSchema],
  "bad_value",
);

/**
 * 一条消息的内容：core 的 `AgentNS.MessageContent` 原样 —— 纯文本字符串，或内容段数组。
 *
 * 两种形状都收（纯文本是最常见的那一种，别逼客户端包成一段 `text`），别的形状一律
 * `bad_content`：这个字段要的是「用户打的字」本身，不是可以放进任何东西的口袋。
 */
export const messageContentSchema = z.union(
  [z.string("not_a_string"), z.array(messageContentSectionSchema, "not_an_array")],
  "bad_content",
);

/**
 * 一次用户输入：core 的内容形状 + 已上传的素材 id（PRD F-H7 / F-H8 / D5）。
 *
 * 这是 `session.send` 与 `session.transient` 共用的那一份，也是**将来别的域要用的那一份**
 * （`handoff.*`、`session.revert` 的回填形状都跟它同一个口径），所以它单独导出。
 *
 * `assetIds` 是「已经上传、还没变成内容段」的素材 id（顺序即用户的摆放顺序）；素材怎么变成段
 * （文件引用 / 内联 / 退化成文字）由宿主按实发模型决定，客户端只说「用了哪几张」。所以这里
 * 只校形状：一串字符串，可省。不设非空下限 —— 单条素材 id 认不出来是**投递那一刻**的事
 * （`AssetService` 把那一份记成 `dropped` / `asset_not_found` 的附件结局，并不是整条请求不合法），
 * 那正是「失败要记账、不假成功」的落点，不该被边界拦成一句 `invalid_params`。
 */
export const messageInputSchema = z.object(
  {
    content: messageContentSchema,
    assetIds: z.array(z.string("not_a_string"), "not_an_array").optional(),
  },
  OBJECT_ERROR,
);

// ---------------------------------------------------------------------------
// session.*
// ---------------------------------------------------------------------------

/**
 * `session.list` 入参：按 Workspace 筛、按置顶筛，再切页。
 *
 * 四格都可省，且**空白与缺省不是一回事**（服务层按 `=== undefined` 分支：不传 = 全要）。
 * 所以这里只校类型，不把空白归一化成「没给」：
 *   - `workspaceId` 空串在服务层就是「按空 id 查」，回空列表（不是错误，也不是「全要」）；
 *   - `limit` / `offset` 服务层用 `Math.max(x, 0)` 兜住负数（负数当 0），小数也是 `slice` 自己
 *     截断 —— 那是它已经定下的语义，校验层不替它改判。
 */
export const sessionListParams = z.object(
  {
    workspaceId: z.string("not_a_string").optional(),
    /** true 只看置顶，false 只看未置顶，不传全要 */
    pinned: z.boolean("not_boolean").optional(),
    limit: z.number("not_a_number").finite().optional(),
    offset: z.number("not_a_number").finite().optional(),
  },
  OBJECT_ERROR,
);

/**
 * `session.create` 入参：项目与助手在创建时定死（PRD L7），模型可在这里点名。
 *
 * `workspaceId` 只收已经登记的项目 id（cwd 那条路是 `workspace.create` 先登记）；`agentId`
 * 同时是定义文件名，用与 `agent.delete` 同一份 `agentIdSchema`。`modelId` 缺省 = 用助手定义
 * 上那个（PRD F-B1），给了就得是个能用的 id —— 空串在服务层是 `empty`，不是「用默认」。
 */
export const sessionCreateParams = z.object(
  {
    workspaceId: nonEmptyText,
    agentId: agentIdSchema,
    modelId: nonEmptyText.optional(),
  },
  OBJECT_ERROR,
);

/** `session.get` 入参：只有一段会话的 id（宿主只提供「按 id 打开」，PRD F-A6） */
export const sessionGetParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

/**
 * `session.state` 入参：与 `session.get` 同形 —— 只有一段会话的 id。
 *
 * 读的是四件事 + inbox + subagent 名册 + 交接态（PRD L5：重连先拉读数）。
 */
export const sessionStateParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

/**
 * `session.rename` 入参：改名字（PRD D1 / F-C3）。
 *
 * 名字只是名字，不碰 id、不碰排序，所以形状就是「一段会话 + 一个非空的名字」：空名字就是
 * `empty`，这里同一个口径。
 */
export const sessionRenameParams = z.object(
  { sessionId: sessionIdSchema, name: nonEmptyText },
  OBJECT_ERROR,
);

/**
 * `session.pin` 入参：手动置顶（PRD F-C5 / D13）。
 *
 * `pinned` 是必填的布尔：服务层原来自己 `typeof params.pinned !== "boolean"` 抛 `not_boolean`，
 * 这一格搬上来之后就不再判第二次。
 */
export const sessionPinParams = z.object(
  { sessionId: sessionIdSchema, pinned: z.boolean("not_boolean") },
  OBJECT_ERROR,
);

/**
 * `session.delete` 入参：助手 id 之外的另一半 —— 一段会话 + 可选的预演开关。
 *
 * 与 `agent.delete` 同一个口径：`dryRun` 只认布尔（服务层原来读 `params.dryRun === true`，
 * 于是 `"yes"` / `1` 会被静默当成「不预演」）。删除的语义（硬删、图片按引用清理、代价怎么算）
 * 见契约那份的 `SessionDeleteParams`。
 */
export const sessionDeleteParams = z.object(
  {
    sessionId: sessionIdSchema,
    dryRun: z.boolean("not_boolean").optional(),
  },
  OBJECT_ERROR,
);

/**
 * `session.send` 入参：**只做投递**（PRD 4.2 / 5.1）。
 *
 * 嵌套的那一格 `input` 就是 {@link messageInputSchema}（内容 + 素材 id）—— 它是**共用形状**，
 * 所以单独导出（`session.transient` 用的是同一份，将来别的域也一样）。
 *
 * 投递只有两条判据（目标在不在、活不活），都在服务层；这里只管「一段会话的 id + 一份长得像
 * 用户输入的东西」。
 */
export const sessionSendParams = z.object(
  { sessionId: sessionIdSchema, input: messageInputSchema },
  OBJECT_ERROR,
);

/**
 * `session.start` 入参：只有一段会话的 id。
 *
 * 这个动作「为什么只是叫醒、不顺手投递」写在契约那份上（`wire/methods.ts` 的
 * `SessionStartParams`）；这里负责的只有形状：一个非空的 `sessionId`。
 */
export const sessionStartParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

/**
 * `session.abort` 入参：掐在途那一批（PRD D14）。
 *
 * `reason` 是**自由文本**：core 的 `abort()` 不收原因，它唯一的去处是接线层写的一条日志
 * （`sessionHandlers` 的 `abort`）。所以这一格只校类型，不设非空、不做归一化 —— 空串就是
 * 「用户没写理由」，服务层本来也是这么读的。
 */
export const sessionAbortParams = z.object(
  { sessionId: sessionIdSchema, reason: z.string("not_a_string").optional() },
  OBJECT_ERROR,
);

/**
 * `session.pause` 入参：与 `session.start` 同形 —— 只有一段会话的 id。
 *
 * 暂停的语义（关输出闸、不掐在途、交接期间拒）见契约那份的 `SessionPauseParams`。
 */
export const sessionPauseParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

/** `session.resume` 入参：继续 —— 只开闸，不投任何东西（PRD 4.4） */
export const sessionResumeParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

/** `session.kill` 入参：杀死（用户按的那一手）—— 只有一段会话的 id（PRD 4.4） */
export const sessionKillParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

/** `session.clearInbox` 入参：清空「收下但还没被取走」的那些话 —— 只有一段会话的 id */
export const sessionClearInboxParams = z.object({ sessionId: sessionIdSchema }, OBJECT_ERROR);

/**
 * `session.revert` 入参：从某条用户消息开始（含它）往后硬删（PRD F-C8 / D24）。
 *
 * `beforeMessageId` 是撤回点，空串就是 `empty`；「它是不是一条 user
 * 消息」**不在这里** —— 那要读那条消息（服务层查库，拒因 `not_a_user_message`），是取值不是形状。
 */
export const sessionRevertParams = z.object(
  { sessionId: sessionIdSchema, beforeMessageId: nonEmptyText },
  OBJECT_ERROR,
);

/**
 * `session.setModel` 入参：换这段会话的模型（PRD F-B4 / F-B8 / D20）。
 *
 * `modelId` 是 `string | null`：`null` 表示回到助手定义上那个模型 —— 所以是 `.nullable()`
 * 而**不是** `.optional()`。省掉这一格与给 `null` 是两件事，别把省略读成「回到默认」。
 * 给了字符串就得是个能用的 id（空串在服务层是 `empty`）。
 */
export const sessionSetModelParams = z.object(
  { sessionId: sessionIdSchema, modelId: nonEmptyText.nullable() },
  OBJECT_ERROR,
);

/**
 * `session.setThinking` 入参：调这段会话的思考档位（PRD F-B6 / F-B7）。
 *
 * `level` 同 `modelId`：`string | null`，`null` = 回到跟随助手默认，所以 `.nullable()`。
 * 档位名在不在该模型引用的策略表里（`preset.levels`）**不在这里** —— 那要读配置里的策略表，
 * 是取值与实体问题（服务层的拒因带着 `levels` 清单）。
 */
export const sessionSetThinkingParams = z.object(
  { sessionId: sessionIdSchema, level: nonEmptyText.nullable() },
  OBJECT_ERROR,
);

/**
 * `session.setThresholds` 入参：两条阈值（PRD 1.4 / 4.7）。
 *
 * 两个字段都是 `number | null | undefined`，所以都是 `.nullish()`（见 {@link thresholdSchema}）。
 * 省略 = 不动、显式 `null` = 回到跟模型走 —— 这条三态是这一条的**全部重点**，`optional` 会把
 * `null` 当成「类型不对」而当场拒掉，那就把「回默认」这条路堵死了。
 *
 * `handoff < guard` 那条大小关系不在这里：它跨两个字段，且只在两个都给（且都不是 `null`）时才
 * 成立，判据在服务层（拒因 `handoff_not_below_guard`）。
 */
export const sessionSetThresholdsParams = z.object(
  {
    sessionId: sessionIdSchema,
    handoffThreshold: thresholdSchema,
    guardThreshold: thresholdSchema,
  },
  OBJECT_ERROR,
);

/**
 * `session.transient` 入参：一次性会话（PRD F-A2 / D3 / 4.3）。
 *
 * `cwd` 必填、非空：一次性会话的目录基准不能靠进程工作目录猜（宿主是常驻进程）——
 * 与 `TransientRunner` 原来那条 `trim()` 之后为空报 `empty` 逐字一致。
 *
 * `agentId` / `modelId` 都可省，但**只校类型、不设非空的理由不一样**：
 *   - `agentId` 在运行时层是「空白 = 没点名」（`resolveAgentId`：`trim().length > 0` 才算点名，
 *     否则回落配置里的默认助手），所以这里不能用 `agentIdSchema`：那会把「空白 = 用默认」
 *     变成一句 `empty` 的错；
 *   - `modelId` 直接交给 `createAgent` 当 `modelId ?? null`，空白是个用不上的 id，但那是装配
 *     那一刻的事（装配失败会带原因回来），边界不替它判。
 */
export const sessionTransientParams = z.object(
  {
    cwd: nonEmptyText,
    input: messageInputSchema,
    agentId: z.string("not_a_string").optional(),
    modelId: z.string("not_a_string").optional(),
  },
  OBJECT_ERROR,
);
