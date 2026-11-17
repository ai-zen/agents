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
 *   - 流式增量 = `AgentNS.Delta`；用量 = `AgentNS.Usage`（求和用 core 的 `sumUsage`）。
 *
 * 本文件只装 core 没有的**产品事实**：对话此刻落在哪一格、待办的一行、思考档位、模型块、
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
// 对话此刻的读数（PRD 4.4 的四格 / PLAN §10.1）
// ---------------------------------------------------------------------------

/**
 * 一段对话此刻处于哪一格 —— 只有四个值，死 = 连 agent 对象都没有。
 *
 * 这四格是**合成值**：core 只报两格（`busy` / `idle`，由循环的位置决定），暂停是**另一处状态**
 * （闸挂着：`agent.paused`），死是「查不到对象」。不落库、不是会话字段、不推算。
 * 客户端要分得开「闲」与「暂停」，因为前者会理你、后者不会。
 */
export type ConversationStatus = "dead" | "busy" | "idle" | "paused";

/**
 * 一条还没落成消息的排队条目（{@link ConversationState.inbox} 的一项）。
 *
 * 它是宿主拼好的一行摘要，不是 `content` 原文 —— 理由见 {@link ConversationState.inbox}。
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
 * 子 agent 名册的一行（{@link ConversationState.subAgents}）。
 *
 * 子 agent 不是一段会话、不入库（`CORE.md` §17）：它的话只在它自己那个对象里，名册在父
 * 身上。所以这一栏只能是**现读**，没有第二个来源可读。
 *
 * `state` 两格之外多一个 `ended`：一次性子 agent 跑完之后它自己那一格会停在 `idle`，把
 * 已经散场的东西报成「闲」等于告诉界面它还在 —— 名册上有了结束时刻就是 `ended`。
 */
export interface SubAgentFact {
  /** 委派那次工具调用的 id（客户端靠它分栏，也是 `message.list { toolCallId }` 的入参） */
  toolCallId: string;
  /** 这次委派用的工具名 */
  name: string;
  /** 子 agent 自己的两格（忙 / 闲），或者「已经散场」 */
  state: AgentNS.AgentState | "ended";
}

/**
 * 一段对话此刻的读数：落在哪一格、队里还压着什么、名册上有哪些子 agent、是不是正在交接。
 *
 * 重连的客户端拿这一份把界面的四格与待办摆回原样，再按 `message.list`（带 `after`）补齐消息。
 * 更细的阶段（请求中 / 思考中 / 输出中）与用量**不在这里**：客户端按到达的事件自己推、
 * 按消息上的 `usage` 自己合计。
 *
 * `subAgents` / `handoff` 两格与前面那几格同一个口径：**现读**，不落库、不是会话字段、不推算。
 * 它们只在这一个方法上出现 —— `conversation.list`（侧栏）不带，因为侧栏不需要为每段对话
 * 去问一次它的驱动者。
 */
export interface ConversationState {
  conversationId: string;
  /** 此刻的读数，不落库、不是会话字段 */
  status: ConversationStatus;
  /**
   * 还没落成消息的排队条目（现读 agent 的队列，顺序即取件顺序）。
   *
   * 现读而不存镜像：一份会与真队列分叉的副本没有存在的理由（PLAN §5.1）。它只给一行摘要
   * （{@link InboxItem.preview}）而不是 `content` 原文 —— 队列里可能压着带图片/文件的输入，
   * 搬原文等于每次读数都把附件搬一遍。
   */
  inbox: InboxItem[];
  /**
   * 这段对话此刻派出去的子 agent（现读父的名册）。
   *
   * 死了就是空数组：名册跟着驱动者走，它没了，那些话也一起没了。客户端拿它铺子 agent 那一栏，
   * 之后按事件（`toolCallId`）增量重建每一栏 —— 那一栏的消息**不从 `message.list` 补**
   * （子 agent 不入库，重连之后也只有这一份名册）。
   */
  subAgents: SubAgentFact[];
  /**
   * 在交接态就是开始时刻；不在就是 `null`。
   *
   * 它不是四格里的任何一格：交接期间这段对话照旧是忙 / 闲 / 暂停，而「正在交接」是另一件事，
   * 界面要分开显示（交接期间输入框拦住、只留中断按钮）。
   */
  handoff: { since: string } | null;
  /** 这份读数的时间 */
  at: string;
}

// ---------------------------------------------------------------------------
// 思考强度与模型块（PRD F-B7 / F-I6）
// ---------------------------------------------------------------------------

/** 思考强度的取值来源：跟随默认 / 手动设了某档 / 这个模型不可调（PRD F-B7） */
export type ThinkingSource = "following_default" | "manual" | "not_adjustable";

/**
 * 思考强度的状态（PRD F-B6 / F-B7）。
 *
 * `levels` 是该模型可选的全部档位名（来自思考策略表）；`selected` 是当前档位；
 * `params` 是这一档**展开后的请求参数**（档位名存在会话行上，展开发生在装配 agent 那一刻）。
 * `following_default` 表示这段会话没设过档位，用的是助手定义上的那份参数。
 *
 * 它是会话行视图（`ConversationView.thinking` / `AgentView.thinking`）的一格，不在
 * `conversation.state` 的读数里：档位没变就不必每次读数都带一遍。
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
 * `conversation` = 会话行上是另一个模型（创建时点名，或 `conversation.setModel` 改过）。
 */
export type ModelSource = "agent" | "conversation";

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
 * 通知的三档语气。
 *
 * 语气决定界面怎么摆（颜色、要不要打断），内容才是 `NoticeView.text`。
 * `error` 与 `warning` 也是宿主日志上浮的通道（PRD F-J2）。
 */
export type NoticeLevel = "info" | "warning" | "error";

/** 三档语气表 */
export const NOTICE_LEVELS: readonly NoticeLevel[] = ["info", "warning", "error"];

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
  /** 与哪段对话有关；`null` 表示全局通知 */
  conversationId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 问题对象（PRD D22 / D23 / F-I9）
// ---------------------------------------------------------------------------

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
 * 问题的生命周期状态：挂在那里等人答 / 已答 / 过期 / 被取消。
 *
 * 状态是宿主的事：多端看同一个问题时看到的是同一个状态（PRD D22）。
 */
export type QuestionState = "pending" | "answered" | "expired" | "cancelled";

/** 问题状态表 */
export const QUESTION_STATES: readonly QuestionState[] = [
  "pending",
  "answered",
  "expired",
  "cancelled",
];

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
 * `blocking` 表示这道题正挡着对话：在它被回答之前，发消息会被拒（PRD D23 / F-D10），
 * 拒绝时用的业务码是 `question_pending`。
 */
export interface QuestionView {
  id: string;
  /** 与哪段对话有关：问题总是为某一段对话停下来问的 */
  conversationId: string;
  kind: QuestionKind;
  state: QuestionState;
  prompt: LocalizedText;
  options: QuestionOption[];
  answer: QuestionAnswer | null;
  /** 是否在挡着对话 */
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
 * 目录不存在时对话与历史照常可用，只是不能读文件；「那就只读吧」这个判断归客户端（PRD D12），
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
 * 落库形态（`messages.content` 的 JSON）：
 *
 * ```json
 * { "index": 1, "type": "image_url", "image_url": { "url": "" }, "__asset_id": "9f3c…" }
 * { "index": 2, "type": "file", "filename": "报表.pdf", "__asset_id": "c3d4…" }
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
 * 落库的 content 里素材写成段上的 `__asset_id`（`image_url.url` / `file.file_id` 留空）：
 * 厂商的 `file_id`、base64、绝对路径都是「这一次发送的产物」，不进库。
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
  /** 真正拼进消息的那个内容段，core 原样；没发出去时为空 */
  section: AgentNS.MessageContentSection | null;
  /** 没送达/降级时的人话原因 */
  problem: ProblemFact | null;
}

// ---------------------------------------------------------------------------
// 压缩（会话行上的一格）
// ---------------------------------------------------------------------------

/**
 * 一次压缩是谁促成的（`conversations.compactionMode` 的取值）。
 *
 * 两条路径各自落一种，于是「这段会话为什么被压了」在数据上答得出来：
 *   - `auto`：派生会话（平级会话开出来的那一段）越过交接线，`AutoMigratePlugin` 自己压的；
 *   - `manual`：用户在交接问题上答了「自交接 / 独立摘要」，宿主答完才压的。
 *
 * 它与 `compactedAt` 是会话行上的一格，跟着 `ConversationSummary` / `ConversationView` 走，
 * 不在 `conversation.state` 的读数里。
 */
export type CompactionMode = "auto" | "manual";
