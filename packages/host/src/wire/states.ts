import type { AgentNS } from "@ai-zen/agents-core";
import { ZERO_USAGE } from "@ai-zen/agents-core";

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
 * 本文件只装 core 没有的**产品事实**：生成六态、通知分档、问题对象、上下文阈值、
 * 状态栏块、素材引用，以及「哪个对话 / 哪一轮」这类薄外壳。外壳里的消息、内容、工具调用、
 * 用量字段装的就是 core 的那几个类型，没有第二份定义。
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
 */
export interface ProblemFact extends LocalizedText {
  detail?: unknown;
}

// ---------------------------------------------------------------------------
// 生成六态（PRD L8 / F-I3）
// ---------------------------------------------------------------------------

/** 拼装中的工具调用：名字已到、参数还在流里 */
export interface AssemblingToolCall {
  /** 正在拼的那个调用，core 原样（`id` / `index` / `function.name` / `function.arguments`） */
  toolCall: AgentNS.ToolCall;
  /** 已收到的参数字符数，用来给「正在拼」一个可见的进度 */
  argumentsChars: number;
}

/** 正在跑的工具：等工具态里列出来的就是这些（并行时只含还在跑的，PRD L8） */
export interface RunningTool {
  /** 被执行的调用，core 原样（工具名在 `function.name` 上） */
  toolCall: AgentNS.ToolCall;
  startedAt: string;
  /** 该工具是子 Agent 委派时带上它的快照（PRD F-I7） */
  subagent?: SubAgentSnapshot;
}

/**
 * 生成六态。每一态带它自己那份事实，取一个态就够画状态栏，不必再回头问别处。
 *
 * 六态与 PRD L8 的六个说法一一对应：连上 / 等首字 / 在想 / 在输出 / 拼工具调用 / 等工具。
 * 「等哪几个工具」是列表而不是布尔：并行时有几个还在跑就列几个（PRD L8 括注）。
 */
export type GenerationState =
  | { phase: "connected"; since: string }
  | { phase: "awaiting_first_token"; since: string }
  | { phase: "thinking"; since: string; chars: number }
  | { phase: "generating"; since: string; chars: number }
  | { phase: "assembling_tool_calls"; since: string; toolCalls: AssemblingToolCall[] }
  | { phase: "awaiting_tools"; since: string; runningTools: RunningTool[] };

/** 六态的名字（客户端按它取图标/文案，事件里也用这组值） */
export type GenerationPhaseName = GenerationState["phase"];

/** 六态的取值表，运行时校验与测试遍历用 */
export const GENERATION_PHASES: readonly GenerationPhaseName[] = [
  "connected",
  "awaiting_first_token",
  "thinking",
  "generating",
  "assembling_tool_calls",
  "awaiting_tools",
];

/** 一轮的结局；`aborted` 是用户的显式动作，和 `error` 不是一回事（PRD D14） */
export type RunOutcome = "completed" | "aborted" | "error";

/** 这段对话当前的运行状态：空闲 / 在跑 / 已结束 */
export type RunStatus = "idle" | "running" | "settled";

/**
 * 一轮的运行状态快照（`run.state` 事件的载荷、`conversation.state` 的一部分）。
 *
 * 重连的客户端靠它把界面恢复成「正在发生什么」（PRD L5）：`status` 说这一轮在不在跑，
 * `generation` 说跑到哪一态，`usage` 说花了多少，`subagents` 说有哪些子 Agent 在跑/跑过。
 */
export interface RunState {
  conversationId: string;
  status: RunStatus;
  /** 本轮那条助手消息的 id（请求发出前就分配，PRD L6）；空闲时为空 */
  assistantMessageId: string | null;
  startedAt: string | null;
  settledAt: string | null;
  /** `status === "running"` 时是六态之一；其余情况为空 */
  generation: GenerationState | null;
  /** `status === "settled"` 时的结局 */
  outcome: RunOutcome | null;
  /** 出错停下时的原因（`status === "settled"` 且 `outcome === "error"`） */
  problem: ProblemFact | null;
  /** 本轮涉及的全部子 Agent（PRD F-I7：存在、状态、失败要显示失败） */
  subagents: SubAgentSnapshot[];
  /** 本轮用量（PRD F-I5 的「本轮」一侧） */
  usage: UsageSnapshot;
}

// ---------------------------------------------------------------------------
// 子 Agent（PRD F-I7）
// ---------------------------------------------------------------------------

/** 子 Agent 的运行状态：跑完就是跑完，失败就是失败，不合并成一个「结束」 */
export type SubAgentStatus = "running" | "done" | "error" | "aborted";

/**
 * 子 Agent 的快照：某次委派产生的一个子 Agent。
 *
 * `toolCallId` 是它挂在哪一个工具调用下面（客户端据此把它塞进对应工具调用的折叠区），
 * `messageCount` 说明它有几句可回看的话，取用 `message.list` 带上 `toolCallId`。
 *
 * `usage` 是这一个子 Agent（含其孙级）的求和结果，形状就是 core 的 `Usage`
 * （求和使用 core 的 `sumUsage`）。
 */
export interface SubAgentSnapshot {
  toolCallId: string;
  name: string;
  status: SubAgentStatus;
  startedAt: string;
  finishedAt: string | null;
  messageCount: number;
  usage: AgentNS.Usage | null;
  problem: ProblemFact | null;
}

// ---------------------------------------------------------------------------
// 用量（PRD F-I5）
// ---------------------------------------------------------------------------

/** 速率的统计口径：按输出 token 算，还是按总量算 */
export type RateBasis = "completion" | "total";

/**
 * 用量快照：本轮 / 累计 / 速率（PRD F-I5）。
 *
 * 三个口径里装的是同一份 core `Usage`，字段名与取值照 core（`prompt_tokens` /
 * `completion_tokens` / `total_tokens`）：
 *   - `turn`：当前这一轮请求；
 *   - `total`：这段对话至今，含子 Agent（含孙级）—— 这是 PRD 明确要求的：漏了子 Agent，
 *     用户会发现账单比界面大；
 *   - `subAgent`：累计里由子 Agent 贡献的那部分，单独再给一份是为了让「累计里有多少是
 *     子 Agent 花的」这件事本身可见。
 */
export interface UsageSnapshot {
  /** 本轮（当前这一轮请求） */
  turn: AgentNS.Usage;
  /** 累计（这段对话至今，含子 Agent） */
  total: AgentNS.Usage;
  /** 累计里由子 Agent 贡献的部分 */
  subAgent: AgentNS.Usage;
  /** 速率 */
  rate: {
    value: number;
    unit: "tokens_per_second";
    basis: RateBasis;
  };
  /** 这份快照算到哪一刻 */
  updatedAt: string;
}

/** 一份零值用量快照（三个口径都是 core 的零值 `Usage`） */
export function zeroUsage(now: string): UsageSnapshot {
  return {
    turn: { ...ZERO_USAGE },
    total: { ...ZERO_USAGE },
    subAgent: { ...ZERO_USAGE },
    rate: { value: 0, unit: "tokens_per_second", basis: "completion" },
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 上下文与思考强度（PRD F-D1 / F-B7）
// ---------------------------------------------------------------------------

/**
 * 上下文占用的当轮事实：最近一次请求的用量 + 两条线的绝对值（PRD F-D1 / D27）。
 *
 * 比例由客户端自己算（前端不做算术的另一面是：宿主把原始数字给全）。
 * 「还装得下多少」看的是 `usage.prompt_tokens`；`overHandoff` / `overGuard` 是宿主
 * 判定出的结论，客户端不必自己比大小。
 */
export interface ContextState {
  /** 最近一次请求的用量，core 原样 */
  usage: AgentNS.Usage;
  /** 交接线（软线，SDK 的 `tokenThresholds.handoff`） */
  handoffThreshold: number;
  /** 硬线（`tokenThresholds.guard`） */
  guardThreshold: number;
  /** 是否已过交接线（该问用户要不要交接了） */
  overHandoff: boolean;
  /** 是否已过硬线（这一轮不再发出请求，PRD F-D1 / D23） */
  overGuard: boolean;
}

/** 思考强度的取值来源：跟随默认 / 手动设了某档 / 这个模型不可调（PRD F-B7） */
export type ThinkingSource = "following_default" | "manual" | "not_adjustable";

/**
 * 思考强度的状态（PRD F-B6 / F-B7）。
 *
 * `levels` 是该模型可选的全部档位名（来自思考策略表）；`selected` 是当前档位；
 * `params` 是这一档**展开后的请求参数**（档位名存在会话行上，展开发生在装配 agent 那一刻）。
 * `following_default` 表示这段会话没设过档位，用的是助手定义上的那份参数。
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
 * 一个附件这一轮的结局（PRD F-H7：失败要告警、全失败退回纯文本、不假成功）。
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

/**
 * 一段对话的现场：在跑哪一轮、上下文用了多少、有没有问题挂着、用量多少。
 *
 * 重连的客户端拿这一份就能把界面摆回原样，再按 `message.list`（带 `after`）补齐消息。
 *
 * **这里没有状态栏的块**（PRD F-I6）。块是「取哪几处事实、按什么顺序摆」，属于界面的排版：
 * 八块要的事实全都已经在契约里各自有一份 —— 助手与模型与目录在 `ConversationView`，
 * 上下文、思考档、用量在下面这几行，工具与子 Agent 在 `run` 里。界面自己拼即可。
 *
 * 曾经有过一份宿主拼好的 `statusBlocks`：它只在 `conversation.state` 被拉的那一刻成立，
 * 于是聊天过程中「上下文百分比 / 模型名 / 本轮 tokens / 正在跑的工具」全冻在打开对话那一刻
 * —— 一份拼好的副本没有刷新通道，而按块再推一份又会把同一批事实讲两遍。
 */
export interface ConversationState {
  conversationId: string;
  run: RunState;
  context: ContextState;
  thinking: ThinkingState;
  usage: UsageSnapshot;
  /** 挂在这段对话上的问题（含已回答/已过期的，客户端按状态决定要不要显示） */
  questions: QuestionView[];
  /** 这份快照的时间 */
  updatedAt: string;
}
