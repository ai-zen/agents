import type { AgentNS } from "@ai-zen/agents-core";

import type { MessageKey } from "../i18n/index.js";

/**
 * 产品形状（wire 的下半截）：事件与方法出参里那些「给人看 / 给界面排」的结构。
 *
 * 这一层的思想来源是 PRD §3 的尺子 ④⑤：**宿主给事实、客户端给表现**。
 * 于是这里的每个字段都只承载一种事实（数字是数字、列表是列表、状态是状态），
 * 需要句子的时候给 `LocalizedText`（码 + 参数 + 已渲染的一句），而不是把句子当数据结构。
 *
 * 消息相关的概念不在这里定义，直接用 core 的导出：
 *   - 消息本体 = `AgentNS.Message`（正文 / 思考 / 工具调用 / 状态 / 角色 / 结束原因 / 用量都在里面）；
 *   - 消息内容 = `AgentNS.MessageContent`、`AgentNS.MessageContentSection`（`text` / `image_url` / `file`）；
 *   - 工具调用 = `AgentNS.ToolCall`、`AgentNS.FunctionCall`；
 *   - 消息状态 / 角色 / 结束原因 = `AgentNS.MessageStatus` / `AgentNS.Role` / `AgentNS.FinishReason`；
 *   - 流式增量 = `AgentNS.Delta`；用量 = `AgentNS.Usage`（就在每条消息的 `usage` 上，要合计就
 *     自己把消息上的 `usage` 加起来 —— core 不算、不存、不报，也没有求和函数）。
 *
 * 本文件只装 core 没有的**产品事实**：会话此刻那四件事、inbox 的一行、思考档位、模型块、
 * 通知分档、问题对象、素材引用。外壳里的消息、内容、工具调用、用量字段装的就是 core 的
 * 那几个类型，没有第二份定义。
 *
 * 这里**没有**用量快照、没有「请求中 / 思考中 / 输出中」这类阶段：用量在每一条消息的
 * `usage` 上，阶段由客户端按到达的事件自己推 —— 宿主不算、不存、不报（PRD 硬规矩 7）。
 *
 * 时间用 ISO 8601 字符串（与 SDK 的 `createdAt` / `updatedAt` 同口径）；id 是字符串，
 * 由宿主分配（PRD L6）。
 */

// ---------------------------------------------------------------------------
// 通用：可本地化的一句话
// ---------------------------------------------------------------------------

/**
 * 宿主存「码 + 参数」、读出时按连接语言渲染的那一层（PRD D8 / F-J1）。
 *
 * `code` 是稳定码（客户端按它挑图标、分支），`messageKey` 是文案键，`params` 是渲染参数，
 * `message` 是**当前连接语言**下的成品句子。四样都给，是因为同一份数据要同时满足
 * 「界面显示」「客户端重排」「换个语言连回来重渲染」三种需要。
 */
export interface LocalizedText {
  /** 稳定码（如 `notice.settingsApplied`、`tool.failed`），与文案键分开，便于客户端分支 */
  code: string;
  /** 文案键（`i18n` 的键空间） */
  messageKey: MessageKey;
  /** 渲染参数 */
  params: Record<string, unknown>;
  /** 已按当前连接语言渲染好的句子 */
  message: string;
}

/**
 * 失败/降级这类「有事发生了」的事实。
 *
 * 在 `LocalizedText` 之上多一个 `detail`：结构化的原因（哪个工具、哪条错误、还差什么），
 * 让客户端能做出「点一下把失败的工具重跑」这种交互，而不必去解析句子。
 *
 * 它在三处出现，都是「这一处的失败原因」：消息上的失败事实（活得比进程长，PRD 4.15）、
 * 一个附件的结局（{@link AttachmentOutcome}）、一层发现来源坏在哪（`methods.ts` 的
 * `DiscoveryLayerView`）。
 */
export interface ProblemFact extends LocalizedText {
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// 会话此刻的四件事（PRD 4.4 / CORE「对外报四件事」/ PLAN §5.4）
// ---------------------------------------------------------------------------

/**
 * 手上有没有活（**只读的观测值**）：`working` 正在动、`idle` 手上没活。
 *
 * 它就是 core 的 `agent.state` 那两格，**名字不改**（`busy` 只留给拒绝原因码
 * `HostError("busy")`，不是状态值）。它只由循环的位置决定：取到一批就是 `working`，这批跑完
 * 且队列真空就是 `idle` —— 输出闸关着也照样会落到 `idle`（闸不参与这一格）。
 *
 * 它与「两道闸」没有任何关系：闲不等于会取件（输出闸可能关着），忙也不等于在收话。
 */
export type SessionActivity = "working" | "idle";

/** 忙闲的取值表（两个，不多不少） */
export const SESSION_ACTIVITIES: readonly SessionActivity[] = ["working", "idle"];

/**
 * 一段会话此刻的**四件事**，各占一格（PRD 4.4）：
 *
 * | 格 | 是什么 | 取值 |
 * |---|---|---|
 * | `status` | 闲 / 忙（只读的观测值） | {@link SessionActivity} |
 * | `inputPaused` | 输入闸：外面的话收不收 | `true` = 关着（投递进不来） |
 * | `outputPaused` | 输出闸：agent 取不取 inbox | `true` = 关着（从下一批起不取） |
 * | `alive` | 死活：有没有 agent 实例 | `true` / `false` |
 *
 * **四件事不压成一格**：「闲」与「输出闸关」必须分得开（一个是手上没活，一个是不取新活），
 * 「没有 agent」也不是四件事里的其中一件（它说的是有没有那个对象）。把三项合成一个合成值
 * （四个词）的旧写法已作废。
 *
 * 四件事都是**现读**，不落库、不是会话字段、不推算：`status` 读 `agent.state`、两道闸读
 * `agent.isInputPaused` / `agent.isOutputPaused`、死活看“有没有那个 agent 对象”。
 */
export interface SessionPresence {
  /** 闲 / 忙（只读） */
  status: SessionActivity;
  /** 输入闸：`true` = 关着（投递进不来；只有 `stop` / `kill` 关它） */
  inputPaused: boolean;
  /** 输出闸：`true` = 关着（从下一批起不取 inbox；手上那批照跑） */
  outputPaused: boolean;
  /** 死活：这一段此刻有没有 agent 实例（`false` = 死了，投递会报 `session_dead`） */
  alive: boolean;
}

/**
 * 一条还没落成消息的排队条目（{@link SessionState.inbox} 的一项）。
 *
 * 它是宿主拼好的一行摘要，不是 `content` 原文 —— 理由见 {@link SessionState.inbox}。
 */
export interface InboxItem {
  messageId: string;
  /**
   * 这条条目的来源，core 的 `AgentNS.MessageSource` **原样**（判别结构）。
   *
   * 从前这里是一个自由字符串（`"user"` / `"会话 1"` …）。core 改成判别结构之后，宿主不再
   * 自己解释它：`kind` 说「谁说的」，`label` 说「哪个来源」。客户端按 `kind` 分支即可，
   * 不必再去比字符串。
   */
  source: AgentNS.MessageSource;
  /** 入队时刻（ISO 8601） */
  createdAt: string;
  /** 一行摘要（宿主拼好）：文本段按顺序拼接、空白折叠、超 120 字截断加 `…`；非文本段记 `[图片]` / `[文件]` */
  preview: string;
}

/**
 * subagent 名册的一行（{@link SessionState.subAgents}）。
 *
 * subagent 不是一段会话、不入库（`CORE.md` §17）：它的话只在它自己那个对象里，名册在父
 * 身上。所以这一栏只能是**现读**，没有第二个来源可读。
 *
 * `state` 两格之外多一个 `ended`：一次性 subagent 跑完之后它自己那一格会停在 `idle`，把
 * 已经散场的东西报成「闲」等于告诉界面它还在 —— 名册上有了结束时刻就是 `ended`。
 */
export interface SubAgentFact {
  /** 委派那次工具调用的 id（客户端靠它分栏，也是 `message.list { toolCallId }` 的入参） */
  toolCallId: string;
  /** 这次委派用的工具名 */
  name: string;
  /** subagent 自己的两格（`working` / `idle`），或者「已经散场」 */
  state: AgentNS.AgentState | "ended";
}

/**
 * 一段会话此刻的读数：四件事（忙闲 / 输入闸 / 输出闸 / 死活）+ 队里还压着什么 + 名册上有哪些
 * subagent + 是不是正在交接。
 *
 * 重连的客户端拿这一份把界面的那四行与 inbox 一次摆回原样，再按 `message.list`（带 `after`）补齐消息。
 * 更细的阶段（请求中 / 思考中 / 输出中）与用量**不在这里**：客户端按到达的事件自己推、
 * 按消息上的 `usage` 自己合计。
 *
 * `subAgents` / `handoff` 两格与前面那几格同一个口径：**现读**，不落库、不是会话字段、不推算。
 * 它们只在这一个方法上出现 —— `session.list`（侧栏）不带，因为侧栏不需要为每段会话
 * 去问一次它的 agent。
 */
export interface SessionState extends SessionPresence {
  sessionId: string;
  /**
   * 还没落成消息的排队条目（现读 agent 的队列，顺序即取件顺序）。
   *
   * 现读而不存镜像：一份会与真队列分叉的副本没有存在的理由（PLAN §5.1）。它只给一行摘要
   * （{@link InboxItem.preview}）而不是 `content` 原文 —— 队列里可能压着带图片/文件的输入，
   * 搬原文等于每次读数都把附件搬一遍。
   */
  inbox: InboxItem[];
  /**
   * 这段会话此刻派出去的 subagent（现读父的名册）。
   *
   * 死了就是空数组：名册跟着 agent 走，它没了，那些话也一起没了。客户端拿它铺 subagent 那一栏，
   * 之后按事件（`toolCallId`）增量重建每一栏 —— 那一栏的消息**不从 `message.list` 补**
   * （subagent 不入库，重连之后也只有这一份名册）。
   */
  subAgents: SubAgentFact[];
  /**
   * 在交接态就是开始时刻；不在就是 `null`。
   *
   * 它不在那四件里：交接期间这一段照旧有自己的忙闲与两道闸，而「正在交接」是另一件事，
   * 界面要分开显示（交接期间输入框拦住、只留中断按钮）。
   */
  handoff: { since: string } | null;
  /** 这份读数的时间 */
  at: string;
}

// ---------------------------------------------------------------------------
// 思考强度与模型块（PRD F-B7 / F-I6）
// ---------------------------------------------------------------------------

/**
 * 思考强度的取值来源（PRD F-B7 / 1.5「配置即事实」）。
 *
 *   · `manual` —— 选定的是某一档（档位名记在会话行 / 定义上的参数正好凑成那一档）；
 *   · `custom` —— 定义上带着**属于这个策略的键**，却凑不成任何一档 = 有人手写过参数；
 *   · `following_default` —— 没设过，跟着模型默认走；
 *   · `not_adjustable` —— 这个模型引用的策略表里一档都没有。
 *
 * `custom` 与 `following_default` **必须分得开**：前者是「你改过」，后者是「你没设过」——
 * 把两者说成一样，用户会以为自己那份没生效（或再设一次把手写值覆盖掉）。
 */
export type ThinkingSource = "following_default" | "manual" | "custom" | "not_adjustable";

/**
 * 思考强度的状态（PRD F-B6 / F-B7）。
 *
 * `levels` 是该模型可选的全部档位名（来自思考策略表）；`selected` 是当前档位；
 * `params` 是这一档**展开后的请求参数**（档位名存在会话行上，展开发生在装配 agent 那一刻）。
 * `following_default` 表示这段会话没设过档位，用的是助手定义上的那份参数。
 *
 * 它是会话行视图（`SessionView.thinking` / `AgentView.thinking`）的一格，不在
 * `session.state` 的读数里：档位没变就不必每次读数都带一遍。
 */
export interface ThinkingState {
  /** 引用的思考策略名（模型上配的那个） */
  preset: string | null;
  /** 可选档位名；空数组表示这个模型没有思考档位 */
  levels: string[];
  /** 当前档位名；`not_adjustable` 时为空 */
  selected: string | null;
  /** 这个值从哪来 */
  source: ThinkingSource;
  /** 当前档位展开后的参数补丁 */
  params: Record<string, unknown>;
}

/**
 * 一段会话现在用的模型来自哪里（PRD F-B4 里「会话级」与「助手定义」两个动作的区别）。
 *
 * `agent` = 会话行上那个模型就是助手定义绑的那个（没换过）；
 * `session` = 会话行上是另一个模型（创建时点名，或 `session.setModel` 改过）。
 */
export type ModelSource = "agent" | "session";

/**
 * 模型块的事实（PRD F-I6 的状态栏块）。
 *
 * `modelId` / `name` / `vision` 是这段会话**现在**用的那个模型，`source` 说明它是助手定义
 * 给的还是这段会话自己定的。
 */
export interface ModelState {
  modelId: string;
  name: string;
  /** 这个模型能不能看图（PRD D20 / F-B8 的判定依据） */
  vision: boolean;
  source: ModelSource;
}

// ---------------------------------------------------------------------------
// 通知（PRD L3 / F-I8）
// ---------------------------------------------------------------------------

/**
 * 通知的**四档语气**（PRD 4.9）：信息 / 成功 / 警告 / 错误。
 *
 * 语气决定界面怎么摆（颜色、要不要打断），内容才是 `NoticeView.text`。四档各管什么：
 *
 * - `info`：说一声就好 —— 配置已生效、这段会话自动起了个名字这类；
 * - `success`：「已保存」这种一秒提示，配一个很短的 `duration`，自己消失；
 * - `warning`：快出问题了 —— 附件没发出去、MCP 连不上了，但还没坏；
 * - `error`：已经出错了 —— 写库失败、请求挂了。
 *
 * `warning` / `error` 也是宿主日志上浮的通道（PRD F-J2）。
 */
export type NoticeLevel = "info" | "success" | "warning" | "error";

/** 四档语气表（顺序照 PRD 4.9 的写法：信息 / 成功 / 警告 / 错误） */
export const NOTICE_LEVELS: readonly NoticeLevel[] = ["info", "success", "warning", "error"];

/**
 * 通知的来源：`app` 是应用自己要说的（缺省），`log` 是日志记录上浮来的。
 *
 * 一条来源只决定一件事：**清除的时机**。`log` 那批不入库、不重放（只推给当时在线的连接），
 * 所以客户端在用户发送那一刻就把屏上 `origin === "log"` 的几条清掉 —— 它们已经看过了，
 * 留着只会挡事；`app` 那批是真要说的事，得等用户自己处理。
 */
export type NoticeOrigin = "log" | "app";

/**
 * 一条通知。
 *
 * `duration` 是秒数：给了则到点自动消失，`null` 表示不自动消失、靠手动清除（PRD L3）。
 * 通知是独立通道，不进消息流（PRD F-I8）。
 */
export interface NoticeView {
  id: string;
  level: NoticeLevel;
  /** 秒；`null` 表示永久，直到被手动清掉 */
  duration: number | null;
  text: LocalizedText;
  /** 与哪段会话有关；`null` 表示全局通知 */
  sessionId: string | null;
  createdAt: string;
  /** 谁让它出现的（`app` / 日志上浮）；见 `NoticeOrigin` */
  origin: NoticeOrigin;
}

// ---------------------------------------------------------------------------
// 问题对象（PRD 4.10 / D22 / D23 / F-I9）
// ---------------------------------------------------------------------------

/**
 * 「这段现在不能立刻接手一批交接」的拒因：**四个词，全仓唯一一套**。
 *
 * 判据只有一处（`ChatRunner.canHandoffNow`），这四个词就是它的答案；换模型 / 换思考档位那类
 * 「手上有活」的判定复用 `working`，不另起 `not_idle`。它们出现在两个地方：判据本身，以及
 * `question.answer` 的回执（`QuestionEffects.handoffDeferredReason`）—— 客户端据此知道「为什么
 * 没开始交接」，不必自己猜。所以它定义在契约这一层，运行时从它 import。
 */
export type HandoffRefusalReason = "no_agent" | "working" | "output_paused" | "handoff_in_progress";

/**
 * 问题的种类。
 *
 * - `handoff`：到交接线时问「自交接 / 独立摘要 / 不交接」（PRD F-D2）；
 * - `confirmation`：不可撤销的动作前确认（PRD F-F9）。
 */
export type QuestionKind = "handoff" | "confirmation";

/** 问题的种类表 */
export const QUESTION_KINDS: readonly QuestionKind[] = ["handoff", "confirmation"];

/**
 * 问题的生命周期状态：挂着等人答 / 已经答了。**只有两格**。
 *
 * 题的去处只有两个：**被答了**、**这段会话没了（含意外死）**（PRD 4.10）。所以没有「过期」、
 * 没有「被取消」，也没有「关掉」这个动作 —— 那三种都是持久化时代的格子（题存得久，就需要
 * 一套清理语义），而题的命只有这一段会话活着的时间。第二个去处不发「题没了」这个事件：
 * 那段会话的事由 `session.changed`（`agent_gone`）说。
 *
 * 状态是宿主的事：题在内存里就一个对象，多端看到的是同一份（PRD 4.10）。
 */
export type QuestionState = "pending" | "answered";

/** 问题状态表 */
export const QUESTION_STATES: readonly QuestionState[] = ["pending", "answered"];

/** 一个候选答案：值 + 显示用的两句（标题与补充说明） */
export interface QuestionOption {
  /** 提交回答时回传的值 */
  value: string;
  label: LocalizedText;
  detail: LocalizedText | null;
}

/** 已有的回答；`answeredBy` 是回答它的那条连接（多端时用来显示「别的窗口答了」） */
export interface QuestionAnswer {
  value: string;
  answeredAt: string;
  answeredBy: string | null;
}

/**
 * 问题对象：有 id、类型、候选、状态、答案（PRD D22）。
 *
 * `blocking` 表示这道题正挡着会话：在它被回答之前，发消息会被拒（PRD D23 / F-D10），
 * 拒绝时用的业务码是 `question_pending`。
 */
export interface QuestionView {
  id: string;
  /** 与哪段会话有关：问题总是为某一段会话停下来问的 */
  sessionId: string;
  kind: QuestionKind;
  state: QuestionState;
  prompt: LocalizedText;
  options: QuestionOption[];
  answer: QuestionAnswer | null;
  /** 是否在挡着会话 */
  blocking: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 目录事实（PRD D12）
// ---------------------------------------------------------------------------

/**
 * 目录的事实：路径 + 还在不在。
 *
 * 目录不存在时会话与历史照常可用，只是不能读文件；「那就只读吧」这个判断归客户端（PRD D12），
 * 宿主只给这两个字段。
 */
export interface FolderFact {
  cwd: string;
  exists: boolean;
}

// ---------------------------------------------------------------------------
// 素材与用户输入（PRD F-H7 / F-H8 / D5）
// ---------------------------------------------------------------------------

/** 一张图片 / 一个文件的上限：20MB（PRD D5 / F-H8） */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** 一条消息最多带几张图片（PRD D5） */
export const MAX_ASSETS_PER_MESSAGE = 4;

/**
 * 内容段上的**本地扩展**：以 `__` 开头的键只在本机有意义（指回数据根下的一份素材）。
 * 发给厂商的那一份由 core 的 `formatContent` 按字段白名单重建（`__` 开头的键因此不在里面）。
 *
 * 目前只有一个：`__asset_id` 指向 `assets` 表的一行。它取代了早先把 `asset://<id>` 塞进
 * `image_url.url` / `file.file_id` 的做法：那两个字段是**真字段**，装一个假 scheme 会让
 * 「这一段的 url 是空的」与「这一段的 url 指向本机素材」看起来是同一件事。
 */
export interface LocalSectionExtensions {
  /** 这一段引用的素材 id（缺省 / 空串表示「这一段不引用素材」） */
  __asset_id?: string;
}

/**
 * 带本地扩展的内容段：core 的内容段 + `__` 开头的本机字段（交叉类型，不改 core）。
 *
 * 落库形态（`messages.content` 的 JSON）就是**发出去的那一份原样**：厂商产物（`file_id` /
 * base64）与本地标记一起存，一个字都不清理（prompt caching 要的是前后两次请求的前缀逐字一致）。
 *
 * ```json
 * { "index": 1, "type": "image_url", "image_url": { "url": "data:image/png;base64,…" }, "__asset_id": "9f3c…" }
 * { "index": 2, "type": "file", "file_id": "file-abc", "__asset_id": "c3d4…" }
 * ```
 */
export type LocalMessageContentSection = AgentNS.MessageContentSection & LocalSectionExtensions;

/**
 * 一个内容段里的素材 id（没有这个扩展字段时为空）。
 *
 * 判断依据就是「有没有这个字段」，不解析任何 scheme：段上的 url 是什么都不影响这个结论。
 */
export function localAssetIdOf(section: AgentNS.MessageContentSection): string | null {
  const value = (section as LocalMessageContentSection).__asset_id;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 素材引用：库与消息里存的是引用，字节落数据根的 `assets/`（PRD L2 / F-H8）。
 *
 * 带 `bytes` / `mime` / 尺寸这些事实，客户端据此排占位框，不必先下载再量。
 * 它是**上传的产物**（`asset.end` 回的），也是**去重命中时的答案**（`asset.begin` 的 `asset`）。
 * 消息里持久化的是段上的本地扩展字段 `__asset_id`（见 {@link LocalMessageContentSection}），
 * 不是这个对象本身：内容要回了原图、要换模型重发时都从 `assets` 这一份真相重算
 * （`asset.get` 取字节）。
 */
export interface AssetRef {
  assetId: string;
  /** MIME 类型，如 `image/png` */
  mime: string;
  /** 字节数 */
  bytes: number;
  /** 原始文件名（可缺） */
  name: string | null;
  width: number | null;
  height: number | null;
}

/**
 * 一次用户输入。
 *
 * 内容本体就是 core 的那一份：`AgentNS.MessageContent`（纯文本字符串，或
 * `text` / `image_url` / `file` 内容段数组）。这里只补一样 core 没有的东西：已上传但还没
 * 变成内容段的素材 id —— 素材怎么变成内容段（文件引用 / 内联 / 退化成文字）由宿主按
 * 实发模型决定（PRD F-H7），客户端只说「用了哪几张」。
 *
 * 落库的 content 里素材段上带着厂商产物（`image_url.url` 是 base64 / `file.file_id` 是厂商 id）
 * 与本地标记 `__asset_id`，**原样入库**：落库那份就是发给厂商那份，不做任何清理 —— 清掉之后
 * 重启或换端点，前后两次请求的前缀就对不上，prompt caching 全 miss。`__asset_id` 只是本地标记
 * （客户端回显「这条消息用了哪份素材」、换模型 / 换厂商时 `resolveHistory` 兜底重建）。
 */
export interface MessageInput {
  /** 用户输入的内容，core 原样 */
  content: AgentNS.MessageContent;
  /** 已上传、待转成内容段的素材 id（顺序即用户的摆放顺序）；没有素材时省略 */
  assetIds?: string[];
}

/** 附件真正发出去时用的路径：文件引用 / 内联 / 退化成文字 / 没发出去 */
export type AttachmentDelivery = "file_reference" | "inline" | "text_fallback" | "dropped";

/**
 * 一个附件的结局（PRD F-H7：失败要告警、全失败退回纯文本、不假成功）。
 *
 * 宿主说清「它最后是怎么走的」「变成了哪个内容段」与「没成功的原因」，客户端据此显示
 * 告警或保持沉默。`section` 用的是 core 的内容段类型：内联图片是 `image_url` 段、
 * Files API 是 `file` 段、降级成文字是 `text` 段。
 */
export interface AttachmentOutcome {
  assetId: string;
  deliveredAs: AttachmentDelivery;
  /**
   * 真正拼进消息的那个内容段，core 原样；没发出去时为空。
   *
   * 与落库的那一段是**同一个段**：上面带着厂商产物（`file_id` / 内联的 data URL），也带着本地
   * 标记 `__asset_id`（客户端靠它回显「这条消息用了哪份素材」）。
   */
  section: AgentNS.MessageContentSection | null;
  /** 没送达/降级时的人话原因 */
  problem: ProblemFact | null;
}

// ---------------------------------------------------------------------------
// 压缩（会话行上的一格）
// ---------------------------------------------------------------------------

/**
 * 一次压缩是谁促成的（`sessions.compactionMode` 的取值）。
 *
 * 两条路径各自落一种，于是「这段会话为什么被压了」在数据上答得出来：
 *   - `auto`：派生会话（平级会话开出来的那一段）越过交接线，`AutoMigratePlugin` 自己压的；
 *   - `manual`：用户在交接问题上答了「自交接 / 独立摘要」，宿主答完才压的。
 *
 * 它与 `compactedAt` 是会话行上的一格，跟着 `SessionSummary` / `SessionView` 走，
 * 不在 `session.state` 的读数里。
 */
export type CompactionMode = "auto" | "manual";
