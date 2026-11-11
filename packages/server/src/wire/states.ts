import type { MessageKey } from "../i18n/index.js";

/**
 * 产品形状（wire 的下半截）：事件与方法出参里那些「给人看 / 给界面排」的结构。
 *
 * 这一层的思想来源是 PRD §3 的尺子 ④⑤：**服务端给事实、客户端给表现**。
 * 于是这里的每个字段都只承载一种事实（数字是数字、列表是列表、状态是状态），
 * 需要句子的时候给 `LocalizedText`（码 + 参数 + 已渲染的一句），而不是把句子当数据结构。
 *
 * 时间用 ISO 8601 字符串（与 SDK 的 `createdAt` / `updatedAt` 同口径）；id 是字符串，
 * 由服务端分配（PRD L6）。
 */

// ---------------------------------------------------------------------------
// 通用：可本地化的一句话
// ---------------------------------------------------------------------------

/**
 * 服务端存「码 + 参数」、读出时按连接语言渲染的那一层（PRD D8 / F-J1）。
 *
 * `code` 是稳定码（客户端按它挑图标、分支），`messageKey` 是文案键，`params` 是渲染参数，
 * `message` 是**当前连接语言**下的成品句子。四样都给，是因为同一份数据要同时满足
 * 「界面显示」「客户端重排」「换个语言连回来重渲染」三种需要。
 */
export interface LocalizedText {
  /** 稳定码（如 `notice.settingsSaved`、`tool.failed`），与文案键分开，便于客户端分支 */
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
  toolCallId: string;
  name: string;
  /** 已收到的参数字符数，用来给「正在拼」一个可见的进度 */
  argumentsChars: number;
}

/** 正在跑的工具：等工具态里列出来的就是这些（并行时只含还在跑的，PRD L8） */
export interface RunningTool {
  toolCallId: string;
  name: string;
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

/** 子 Agent 的状态：跑完就是跑完，失败就是失败，不合并成一个「结束」 */
export type SubAgentStatus = "running" | "done" | "error" | "aborted";

/**
 * 子 Agent 的快照：某次委派产生的一个子 Agent。
 *
 * `toolCallId` 是它挂在哪一个工具调用下面（客户端据此把它塞进对应消息段的折叠区），
 * `messageCount` 说明它有几句可回看的话，取用 `message.list` 带上 `toolCallId`。
 */
export interface SubAgentSnapshot {
  toolCallId: string;
  name: string;
  status: SubAgentStatus;
  startedAt: string;
  finishedAt: string | null;
  messageCount: number;
  usage: UsageSnapshot | null;
  problem: ProblemFact | null;
}

// ---------------------------------------------------------------------------
// 消息与消息段（PRD F-I1 / F-I2）
// ---------------------------------------------------------------------------

/** 消息是谁说的；工具结果挂在助手消息的工具调用段里，不单独成一条 */
export type MessageRole = "user" | "assistant";

/**
 * 一条消息的状态。
 *
 * 四态对应界面上的四件事：还在流（`streaming`）/ 说完了（`done`）/ 被中止（`aborted`）/
 * 出错停下（`error`）。「是否还在上下文里」是另一回事，见 `omit`。
 */
export type MessageStatus = "streaming" | "done" | "aborted" | "error";

/** 全部消息状态；运行时校验与测试遍历用 */
export const MESSAGE_STATUSES: readonly MessageStatus[] = [
  "streaming",
  "done",
  "aborted",
  "error",
];

/** 工具调用段的状态：参数在拼、工具在跑、跑完、失败、被中止 */
export type ToolCallStatus = "assembling" | "running" | "done" | "error" | "aborted";

/** 思考段：模型的思考内容 */
export interface ThinkingSegment {
  kind: "thinking";
  text: string;
}

/**
 * 工具调用段：一次调用的全部事实（名字、参数、结果、状态、子 Agent）。
 *
 * `argumentsText` 保留原始参数文本而不是解析后的对象：流式过程中它可能是半截 JSON，
 * 显示与「拼到哪儿了」都靠它；解析结果由客户端在需要时自己做。
 */
export interface ToolCallSegment {
  kind: "tool_call";
  toolCallId: string;
  name: string;
  argumentsText: string;
  status: ToolCallStatus;
  /** 工具返回的文本；还没结果时为空 */
  resultText: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** 失败/中止的原因 */
  problem: ProblemFact | null;
  /** 这次调用是子 Agent 委派时，带上子 Agent 的快照 */
  subagent: SubAgentSnapshot | null;
}

/** 正文段：模型说给用户的话 */
export interface TextSegment {
  kind: "text";
  text: string;
}

/**
 * 一条助手消息由若干段组成，段的类型只有这三种（PRD F-I2）。
 *
 * 段在图上的先后与产出顺序一致：思考在前、工具调用居中、正文在后；界面照数组顺序排，
 * 就能让同一条消息在多次渲染、多个客户端之间长得一样。
 */
export type MessageSegment = ThinkingSegment | ToolCallSegment | TextSegment;

/** 段的种类名 */
export type SegmentKind = MessageSegment["kind"];

/** 段的种类表 */
export const SEGMENT_KINDS: readonly SegmentKind[] = ["thinking", "tool_call", "text"];

/**
 * 附件引用：库与消息里存的是引用，字节落数据根的 `assets/`（PRD L2 / F-H8）。
 *
 * 带 `bytes` / `mime` / 尺寸这些事实，客户端据此排占位框，不必先下载再量。
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

/** 一条消息的可读形状：事件与 `message.list` 都发它 */
export interface MessageView {
  id: string;
  conversationId: string;
  role: MessageRole;
  status: MessageStatus;
  /**
   * 这条是否还在上下文里。
   *
   * 服务端给的事实（PRD F-I1）：`omit: true` 表示它还在库里、还能看，但不再发给模型。
   * 界面用删除线表示「已失效」这个表现，由客户端定。
   */
  omit: boolean;
  /**
   * 是否是服务端注入的内容（例如「现在在哪个目录」，PRD F-D9）。
   *
   * 客户端可据此把它与用户输入区分开显示。
   */
  injected: boolean;
  /** 段序列（顺序见 `MessageSegment`） */
  segments: MessageSegment[];
  /** 用户消息带的图片/文件 */
  attachments: AssetRef[];
  /** 这条消息自身失败/被中止的原因 */
  problem: ProblemFact | null;
  /** 这条消息那次响应自身的 token 用量（助手消息才有） */
  usage: TokenCounts | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 用量（PRD F-I5）
// ---------------------------------------------------------------------------

/**
 * 一组 token 计数。
 *
 * 分三个数字而不是一个总数：输入端与输出端的价格不同，界面要能把它们分开摆。
 */
export interface TokenCounts {
  prompt: number;
  completion: number;
  total: number;
}

/** 速率的统计口径：按输出 token 算，还是按总量算 */
export type RateBasis = "completion" | "total";

/**
 * 用量快照：本轮 / 累计 / 速率（PRD F-I5）。
 *
 * `total` 含子 Agent（含孙级）—— 这是 PRD 明确要求的：漏了子 Agent，用户会发现账单比界面大。
 * `subAgent` 单独再给一份，是为了让「累计里有子 Agent 多少」这件事本身可见。
 */
export interface UsageSnapshot {
  /** 本轮（当前这一轮请求） */
  turn: TokenCounts;
  /** 累计（这段对话至今，含子 Agent） */
  total: TokenCounts;
  /** 累计里由子 Agent 贡献的部分 */
  subAgent: TokenCounts;
  /** 速率 */
  rate: {
    value: number;
    unit: "tokens_per_second";
    basis: RateBasis;
  };
  /** 这份快照算到哪一刻 */
  updatedAt: string;
}

/** 空用量（构造默认值用） */
export function zeroTokenCounts(): TokenCounts {
  return { prompt: 0, completion: 0, total: 0 };
}

/** 逐字段相加，返回新对象 */
export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    prompt: a.prompt + b.prompt,
    completion: a.completion + b.completion,
    total: a.total + b.total,
  };
}

/** 一份零值用量快照 */
export function zeroUsage(now: string): UsageSnapshot {
  return {
    turn: zeroTokenCounts(),
    total: zeroTokenCounts(),
    subAgent: zeroTokenCounts(),
    rate: { value: 0, unit: "tokens_per_second", basis: "completion" },
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 上下文与思考强度（PRD F-D1 / F-B7）
// ---------------------------------------------------------------------------

/**
 * 上下文占用的当轮事实：当前用量 + 两条线的绝对值（PRD F-D1 / D27）。
 *
 * 比例由客户端自己算（前端不做算术的另一面是：服务端把原始数字给全）。
 * `overHandoff` / `overGuard` 是服务端判定出的结论，客户端不必自己比大小。
 */
export interface ContextState {
  /** 当前 prompt token 用量（决定「还装得下多少」的那个数） */
  promptTokens: number;
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
 * `params` 是这一档**展开后的请求参数**——服务端写入的是参数，档位名只是给人和界面看的标签。
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

// ---------------------------------------------------------------------------
// 通知（PRD L3 / F-I8）
// ---------------------------------------------------------------------------

/**
 * 通知的三档语气。
 *
 * 语气决定界面怎么摆（颜色、要不要打断），内容才是 `NoticeView.text`。
 * `error` 与 `warning` 也是服务端日志上浮的通道（PRD F-J2）。
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
 * - `workspace_registration`：遇到未登记的 cwd 时问一次要不要登记成项目（PRD D10）；
 * - `confirmation`：不可撤销的动作前确认（PRD F-F9）。
 */
export type QuestionKind = "handoff" | "workspace_registration" | "confirmation";

/** 问题的种类表 */
export const QUESTION_KINDS: readonly QuestionKind[] = [
  "handoff",
  "workspace_registration",
  "confirmation",
];

/**
 * 问题的生命周期状态：挂在那里等人答 / 已答 / 过期 / 被取消。
 *
 * 状态是服务端的事：多端看同一个问题时看到的是同一个状态（PRD D22）。
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
  /** 与哪段对话有关；`null` 表示不挂在某段对话上（如登记项目） */
  conversationId: string | null;
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
 * 服务端只给这两个字段。
 */
export interface FolderFact {
  cwd: string;
  exists: boolean;
}

// ---------------------------------------------------------------------------
// 输入与附件（PRD F-H7 / F-H8 / D5）
// ---------------------------------------------------------------------------

/** 一张图片 / 一个文件的上限：20MB（PRD D5 / F-H8） */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** 一条消息最多带几张图片（PRD D5） */
export const MAX_ASSETS_PER_MESSAGE = 4;

/** 一次文本输入 */
export interface TextInputPart {
  type: "text";
  text: string;
}

/** 一次附件输入：引用已上传的素材（上传走 `asset.begin` / `asset.chunk` / `asset.end`） */
export interface AssetInputPart {
  type: "asset";
  assetId: string;
}

/**
 * 一条用户输入由若干部分拼成：文本段与附件段。
 *
 * 图片变成消息内容时，文本段在前（PRD F-H7）；具体按哪条传输路径发给模型是服务端的判断，
 * 结果以 `AttachmentOutcome` 的形式回到客户端。
 */
export type InputPart = TextInputPart | AssetInputPart;

/** 附件真正发出去时用的路径：文件引用 / 内联 / 退化成文字 / 没发出去 */
export type AttachmentDelivery = "file_reference" | "inline" | "text_fallback" | "dropped";

/**
 * 一个附件这一轮的结局（PRD F-H7：失败要告警、全失败退回纯文本、不假成功）。
 *
 * 服务端说清「它最后是怎么走的」与「没成功的原因」，客户端据此显示告警或保持沉默。
 */
export interface AttachmentOutcome {
  assetId: string;
  deliveredAs: AttachmentDelivery;
  /** 没送达/降级时的人话原因 */
  problem: ProblemFact | null;
}

// ---------------------------------------------------------------------------
// 状态栏的块（PRD F-I6）
// ---------------------------------------------------------------------------

/**
 * 状态栏每一块的事实。块名固定，块内结构按块名不同而不同（判别式联合）。
 *
 * 这样的好处是：服务端给的是可排版的块，客户端决定摆哪几块、摆在哪（PRD F-I6 /
 * 「服务端给能力、客户端给交互」），双方都不需要解析一整行字符串。
 */
export type StatusBlock =
  | { id: "agent"; label: LocalizedText; facts: { agentId: string; name: string; available: boolean } }
  | {
      id: "model";
      label: LocalizedText;
      facts: { modelId: string; name: string; vision: boolean; overriddenThisSession: boolean };
    }
  | { id: "thinking"; label: LocalizedText; facts: ThinkingState }
  | { id: "context"; label: LocalizedText; facts: ContextState }
  | { id: "usage"; label: LocalizedText; facts: UsageSnapshot }
  | { id: "cwd"; label: LocalizedText; facts: FolderFact }
  | { id: "tools"; label: LocalizedText; facts: { running: RunningTool[] } }
  | { id: "subagents"; label: LocalizedText; facts: { items: SubAgentSnapshot[] } };

/** 状态栏块的 id */
export type StatusBlockId = StatusBlock["id"];

/** 全部块 id，按建议的摆放顺序 */
export const STATUS_BLOCK_IDS: readonly StatusBlockId[] = [
  "agent",
  "model",
  "thinking",
  "context",
  "usage",
  "cwd",
  "tools",
  "subagents",
];

// ---------------------------------------------------------------------------
// 一段对话的现场状态（PRD L5：重连先拉状态）
// ---------------------------------------------------------------------------

/**
 * 一段对话的现场：在跑哪一轮、上下文用了多少、有没有问题挂着、用量多少。
 *
 * 重连的客户端拿这一份就能把界面摆回原样，再按 `message.list`（带 `after`）补齐消息。
 */
export interface ConversationState {
  conversationId: string;
  run: RunState;
  context: ContextState;
  thinking: ThinkingState;
  usage: UsageSnapshot;
  /** 挂在这段对话上的问题（含已回答/已过期的，客户端按状态决定要不要显示） */
  questions: QuestionView[];
  /** 状态栏的块（PRD F-I6） */
  statusBlocks: StatusBlock[];
  /** 这份快照的时间 */
  updatedAt: string;
}
