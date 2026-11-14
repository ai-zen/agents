/**
 * `ChatRunner` —— 一轮对话的执行者（architecture §4 那张时序）。
 *
 * ## 一轮的骨架
 *
 * ```
 * RunRegistry.start（这一段对话同时只跑一轮；已经在跑的那一轮由 conversation.send 排队，D3）
 *   → 借 Scope（ScopeRegistry.acquire：懒创建或复用，依赖 +1）
 *   → 分配两个消息 id 并落库（用户消息 + 助手占位，PRD L6：id 在请求发出前就有）
 *   → 装配 agent（可注入的工厂；跑完即弃，PRD D28）
 *   → 流式：每片增量推 `message.delta`；同一时刻更新六态并推 `run.state`；同一条消息边流边写（D15）
 *   → 内循环结束：写一次最终版（F-C2）→ 释放 agent → RunRegistry.finish → ScopeRegistry.release
 *   → 推结算态 `run.state` + `usage`
 * ```
 *
 * ## 跑中发送走 inbox，不走第二轮（PRD D3）
 *
 * `conversation.send` 发现这一段已经有一轮在跑时，调的是 {@link ChatRunner.enqueue}：把那一句
 * 用户输入推给**那一轮的 agent**（core 的 `pushInbox`），由它在轮末落成一条 User 消息。于是
 * 「不打断」与「不丢」同时成立：流还是原来那条流，用户的话排在工具轮收尾的边界上。
 * 宿主在这里只做两件事：定死那条消息的 id（D5，客户端先画的那条与落地的是同一条），报出
 * `RunState.inboxPending`。两个不变量见 `TurnSession.enqueue` / `waitEnqueueable` 的注释。
 *
 * ## 三处刻意交给 core 的事
 *
 * 1. **消息与增量不重新定义**：`AgentNS.Message` / `AgentNS.Delta` / `AgentNS.MessageStatus` /
 *    `Usage` 全部原样用 core 的导出；攒消息用 core 的 `applyChunk`，求和用 core 的 `sumUsage`，
 *    中止修复用 core 的 `reconcileAbortedToolRounds` / `reconcileAbortedMessages`。
 * 2. **agent 循环不重写**：装配好的 agent 由 core 的 `send()` 驱动（内循环、工具并行、中止、
 *    收尾归一都在 core 里）。本文件只订阅它广播出来的事件，把「发生了什么」变成持久化与推送。
 * 3. **状态不存两处**：运行中的消息以内存（core 手里那份 `agent.messages`）为真相，库里的行是
 *    快照；`isRunning` 只在 `RunRegistry` 一处。
 *
 * ## 为什么要认领 core 追加的消息 id
 *
 * 消息 id 由宿主分配（PRD L6），而 assistant 占位是 core 在 `run()` 里自己 `append` 的
 * （它的 `Message` 构造会自己生成 id）。所以本文件在 `message` 事件里把「这一轮头两条」认领成
 * 宿主已经发给客户端的 id —— 客户端的 `message.delta` 与 `message.list` 才接得上同一条消息。
 * 后续工具轮次里 core 追加的消息同样在这一处被换成宿主分配的 id（`id` 不参与 core 的任何
 * 判断，换掉只会让它对客户端更一致）。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import {
  addUsage,
  AgentNS as AgentNSValue,
  generateMessageId,
  reconcileAbortedMessages,
  reconcileAbortedToolRounds,
  sumUsage,
} from "@ai-zen/agents-core";
import type { SubAgentContext, ToolCallEndContext } from "@ai-zen/agents-core";
import type {
  AgentDefinition,
  AppConfig,
  HandoffService,
  Model,
  ModelParams,
  ReasoningPresets,
  Scope,
} from "@ai-zen/agents-sdk";
import {
  AgentRepository,
  AutoMigratePlugin,
  AutoRefreshToolsPlugin,
  ContextGuardPlugin,
  createAgent,
  SubAgentGuardInstallerPlugin,
  UnknownToolHintPlugin,
} from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language, MessageKey } from "../i18n/index.js";
import type { Conversation, MessageUpsertInput, StoredMessage } from "../storage/types.js";
import { HostError } from "../wire/errors.js";
import type { EventMap, EventName } from "../wire/events.js";
import type {
  AssemblingToolCall,
  AttachmentOutcome,
  GenerationPhaseName,
  GenerationState,
  MessageInput,
  ProblemFact,
  RunOutcome,
  RunningTool,
  RunState,
  SubAgentSnapshot,
  UsageSnapshot,
} from "../wire/states.js";
import type { RunHandle, RunRegistry } from "./RunRegistry.js";
import type { Clock, ScopeRegistry } from "./ScopeRegistry.js";
import { systemClock } from "./ScopeRegistry.js";

// ---------------------------------------------------------------------------
// 注入点（形状即契约，测试与接线层都按它做替身）
// ---------------------------------------------------------------------------

/** 消息仓储里本文件用到的部分（`MessageRepository` 结构上满足） */
export interface MessageStore {
  upsert(input: MessageUpsertInput): Promise<void>;
  upsertMany(inputs: MessageUpsertInput[]): Promise<void>;
  /**
   * 按对话取主线消息。
   *
   * 历史装载传 `includeHidden`（`hidden` 的消息也在模型的上下文里，只是不给人看）；
   * 其余用途默认只要用户看得到的那部分。
   */
  listByConversation(
    conversationId: string,
    after?: string,
    options?: { includeHidden?: boolean },
  ): Promise<StoredMessage[]>;
}

/** 对话仓储里本文件用到的部分（`ConversationRepository` 结构上满足） */
export interface ConversationStore {
  get(id: string): Promise<Conversation | undefined>;
}

/** 推事件：接线层把它变成 JSON-RPC 通知（`WsHub.push`） */
export type ChatEventEmitter = <E extends EventName>(name: E, payload: EventMap[E]) => void;

/**
 * 装配 agent 时交给工厂的事实。
 *
 * 模型和助手的解析口径在 SDK 里（`createAgent` 三级解析：会话级 > 助手定义 > 全局兜底），
 * 所以这里只给 id 与 Scope，不给「用哪个模型」的结论。
 */
export interface AgentBuildContext {
  conversationId: string;
  workspaceId: string;
  /** 这段对话创建时定死的助手（PRD L7） */
  agentId: string;
  /** 这段会话现在用的模型（存在会话行上）；`null` 时交给 SDK 三级解析 */
  modelId: string | null;
  /**
   * 这段会话选的思考档位名（存在会话行上）；`null` = 跟随助手定义上的那份参数。
   *
   * 存名不存参数：档位属于模型，同名档位在不同模型的策略表里对应不同参数，展开在装配这一刻做。
   */
  thinkingLevel: string | null;
  scope: Scope;
  /** 这一轮开始前的历史（core 原样消息），工厂可以把它当作给 agent 的初始消息 */
  history: AgentNS.Message[];
}

/** 造 agent。测试注入假 agent，生产用 `createSdkAgentFactory()` */
export type AgentFactory = (context: AgentBuildContext) => Promise<ChatAgent>;

/**
 * 交接服务（SDK 口径）按这一轮的装配事实现场取一个。
 *
 * 给 `undefined` 就是「这一轮不装交接线插件」（R50：装配处会推一条警告，不静默）。
 */
export type HandoffProvider = (context: AgentBuildContext) => HandoffService | undefined;

/**
 * 本文件驱动的那部分 agent 表面。
 *
 * core 的 `Agent` 与 SDK 的 `SdkAgent` 都满足它；测试里的假 agent 也满足它，
 * 于是「一轮怎么跑」的用例不必真的连模型。
 */
export interface ChatAgent {
  /** 这一轮的消息数组（内存真相；本文件只往里追加历史、读它算用量） */
  messages: AgentNS.Message[];
  append(message: AgentNS.Message): AgentNS.Message;
  /** core 的 `send()`：跑完整组内循环（含多轮工具调用）后返回消息数组 */
  send(content: AgentNS.MessageContent): Promise<AgentNS.Message[]>;
  abort(): void;
  /**
   * 排队待发的内容（core 的 `Agent.inbox`，PRD D3）。
   *
   * 宿主**只读**它：`RunState.inboxPending` 就是这份数组的长度。不自己另记一份计数 ——
   * core 的 `abort()` 会把 inbox 清空，另记的数会在那一瞬与真相分叉。
   */
  inbox: AgentNS.InboxEntry[];
  /**
   * 推一条待发内容；core 在轮末（工具轮收尾之后 / 整组停下之后）把它落成一条 User 消息。
   *
   * `messageId` 允许由推的人定死：宿主已经把 id 告诉客户端了（D5），落地那条必须用同一个，
   * 否则同一条内容会在屏幕上画两遍。
   */
  pushInbox(
    entry: Omit<AgentNS.InboxEntry, "messageId" | "createdAt"> & { messageId?: string },
  ): AgentNS.InboxEntry;
  /** 事件广播口（core 的 `EventBus`）；本文件只用 `on` */
  events: { on(name: string, handler: (...args: never[]) => void): unknown };
}

/** 把已上传的素材变成真正发出去的内容段（PRD F-H7）；不给就原样用 `input.content` */
export interface AttachmentPreparation {
  /** 真正发给模型的内容（已按实发模型换成文件引用 / 内联 / 文字） */
  content: AgentNS.MessageContent;
  attachments: AttachmentOutcome[];
  /**
   * 落库用的内容（消息里只存我们自己的引用：段上的 `__asset_id`）。
   *
   * 不给时落库的就是 `content`：不是每个注入方都有“厂商产物不能进库”这回事。
   */
  storedContent?: AgentNS.MessageContent;
}

export type AttachmentPreparer = (context: {
  conversationId: string;
  agentId: string;
  modelId: string | null;
  input: MessageInput;
}) => Promise<AttachmentPreparation>;

/**
 * 历史里的素材引用还原成当前模型能吃的内容段（PRD F-H7）：每轮发送之前跑一次。
 *
 * 每轮都要跑一次：能不能吃跟着实发模型 / 端点变，而历史里存的是与端点无关的 `__asset_id`。
 * 不给就原样把历史交给 agent。
 */export type AttachmentHistoryResolver = (context: {
  conversationId: string;
  modelId: string | null;
  messages: AgentNS.Message[];
}) => Promise<AgentNS.Message[]>;

/**
 * 消息落库那一刻登记「这条消息引用了哪些素材」（`conversation_assets` 关系行）。
 *
 * 扫的是**落库的那一份内容**（段上的 `__asset_id`），所以调用点紧跟用户消息的 upsert；
 * 不注入时关系行就不记（引用计数少一份，删字节会晚一步）。
 */
export type MessageAssetLinker = (context: {
  conversationId: string;
  messageId: string;
  content: AgentNS.MessageContent | undefined;
}) => Promise<number>;

/** 一轮的入参（`conversation.send` 的 params 去掉 wire 外壳） */
export interface ChatRunParams {
  conversationId: string;
  input: MessageInput;
  /** 这一轮是哪条连接发起的语言（D8；缺省用注入的默认语言） */
  language?: Language;
}

/**
 * 一轮结算之后的事实（R59：交接线问题由宿主自己在这个时机问）。
 *
 * 「到交接线了没有」只在宿主算得出来：`promptTokens` 是这一轮实际用量，`handoffTokens`
 * 是生效模型上配的那条线（0 表示这个模型没配）。带着 `language` 一起给，是因为问用户的话
 * 要按发起这条连接的语言渲染（D8）。
 */
export interface TurnSettledFacts {
  conversationId: string;
  outcome: RunOutcome;
  /** 这一轮的 `prompt_tokens`（结算快照里的本轮用量） */
  promptTokens: number;
  /** 生效模型的交接线；`0` 表示没配 */
  handoffTokens: number;
  language: Language;
}

/** 受理之后立刻给客户端的东西（PRD F-I12 / L6） */
export interface ChatTurn {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  /** 每个附件这一轮最后是怎么走的 */
  attachments: AttachmentOutcome[];
  /** 受理时刻（ISO 8601） */
  acceptedAt: string;
  /** 结算之后 resolve（写库、释放 agent 与 Scope、推结算态都已完成） */
  readonly done: Promise<TurnSettlement>;
  /** 中止这一轮（与 `conversation.abort` 走同一条路：用户显式动作，PRD D14） */
  abort(reason?: string): void;
  /**
   * 此刻的现场快照（六态、子 Agent、用量）。
   *
   * 重连的客户端拉 `conversation.state` 时用这一份（PRD L5）；它读的是这一轮自己的内存，
   * 不是第二份「谁在跑」：那个事实只在 `RunRegistry`。
   */
  runState(): RunState;
}

/**
 * 一句排进**正在跑的那一轮**的用户输入（`conversation.send` 的排队回执，PRD D3）。
 *
 * 没有 `assistantMessageId`：排队的话还没有「这一次要被回答的助手消息」—— 它落成一条 User
 * 消息之后由那一轮接着跑，流还是那一轮原来那条流。宿主在入队这一刻就把 `userMessageId`
 * 定死（D5），客户端先按它画一条，落地那条用的就是同一个 id。
 */
export interface QueuedTurn {
  conversationId: string;
  /** 入队时就定死的消息 id（落地那条消息用的就是它） */
  userMessageId: string;
  /** 每个附件这一句最后是怎么走的（与老路径同一份事实，F-H7） */
  attachments: AttachmentOutcome[];
  /** 入队时刻（ISO 8601） */
  acceptedAt: string;
}

/** 一轮的结局 */
export interface TurnSettlement {
  conversationId: string;
  assistantMessageId: string;
  outcome: RunOutcome;
  problem: ProblemFact | null;
  /** 这一轮结束后内存里的全部消息（历史 + 本轮产出，core 原样） */
  messages: AgentNS.Message[];
  /** 这一轮产出的消息（写进库里的就是这些） */
  produced: AgentNS.Message[];
  usage: UsageSnapshot;
  run: RunState;
}

/** 装载/重启后的修复结果 */
export interface ReconcileResult {
  /** 修好之后的消息（顺序即对话顺序，core 原样） */
  messages: AgentNS.Message[];
  /** 被改写的消息 id（状态或 `omit` 变了） */
  repairedIds: string[];
}

export interface ChatRunnerOptions {
  messages: MessageStore;
  conversations: ConversationStore;
  scopes: ScopeRegistry;
  runs: RunRegistry;
  /** 造 agent 的工厂；不注入时按 SDK 口径装配（交接服务由 `handoff` 提供） */
  createAgent?: AgentFactory;
  /**
   * 交接服务：注入之后每一轮都装交接线插件（R59 / R50）；不注入时那个插件就不装。
   *
   * 只在不注入 `createAgent` 时生效（两边都注入时以 `createAgent` 为准）。
   */
  handoff?: HandoffProvider;
  emit: ChatEventEmitter;
  clock?: Clock;
  /** 宿主分配消息 id；缺省用 `crypto.randomUUID` */
  newId?: () => string;
  /** 边流边写的节流时长（毫秒）；0 表示每到一片就写一次 */
  streamWriteIntervalMs?: number;
  prepareAttachments?: AttachmentPreparer;
  /**
   * 历史里的素材引用 → 当前模型能吃的段（F-H7）。不给时历史原样交给 agent。
   *
   * 与 `prepareAttachments` 分开两个注入点，是因为它们错在不同时机：一个在受理时算一次，
   * 一个是每次装配 agent 之前按当时的模型 / 端点算。
   */
  prepareHistory?: AttachmentHistoryResolver;
  /**
   * 用户消息落库那一刻登记素材关系行（`conversation_assets`）。不注入就不记。
   */
  linkMessageAssets?: MessageAssetLinker;
  /** 这一轮没带语言时用哪种语言渲染宿主注入的那段话（D8） */
  defaultLanguage?: Language;
  /** 一轮结算之后的回调（R59：交接线问题由它触发） */
  onTurnSettled?: (facts: TurnSettledFacts) => void;
  /** 内部错误的去处（写库失败、回收失败等）；缺省忽略 */
  onError?: (error: unknown, context: string) => void;
}

/** 边流边写的缺省节流：200ms 一次，兼顾「客户端断了丢得少」与「写盘次数」 */
export const DEFAULT_STREAM_WRITE_INTERVAL_MS = 200;

/**
 * 「等这一轮的 agent 装上再入队」的上界（毫秒）。
 *
 * `RunRegistry` 从 `start()` 到 agent `attach()` 之间有一段看不见的空窗：读会话行、拿 Scope
 * （首次进某个项目要 MCP 发现）、修复历史、准备素材（可能要上传厂商）、装配 agent。正常是
 * 几十到几百毫秒，卡在某个外部调用上时可能是无限久。继续挂着等，客户端那侧只是一直转圈 ——
 * 到点就按老口径回 `busy`，让用户自己决定是等还是按停。
 */
export const QUEUE_READY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// 六态里那些「每片都要摸一遍」的小工具
// ---------------------------------------------------------------------------

/** core 广播的原始 chunk 里本文件用到的部分（`choices[0].delta` 就是 `AgentNS.Delta`） */
interface RawChunk {
  usage?: AgentNS.Usage;
  choices?: Array<{ delta?: AgentNS.Delta; finish_reason?: string | null }>;
}

/** 正文 / 思考的字符数（分段内容只数文本段） */
function contentChars(content: AgentNS.MessageContent | undefined): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const section of content) {
      if ("text" in section && typeof section.text === "string") total += section.text.length;
    }
    return total;
  }
  return 0;
}

/** 工具调用的定位键：优先用 `id`，没有就退回「名字 + 序号」（`function_call` 形态） */
function toolKey(toolCall: AgentNS.ToolCall): string {
  if (toolCall.id) return `id:${toolCall.id}`;
  return `fn:${toolCall.function?.name ?? ""}#${toolCall.index ?? 0}`;
}

/** 两位小数（速率是给人看的一个数，不是账目） */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// core 消息 ⇄ 存储行
// ---------------------------------------------------------------------------

const ROLES: ReadonlySet<string> = new Set(Object.values(AgentNSValue.Role));
const STATUSES: ReadonlySet<string> = new Set(Object.values(AgentNSValue.MessageStatus));

function toRole(value: string): AgentNS.Role {
  return ROLES.has(value) ? (value as AgentNS.Role) : AgentNSValue.Role.Unknown;
}

function toStatus(value: string): AgentNS.MessageStatus {
  return STATUSES.has(value) ? (value as AgentNS.MessageStatus) : AgentNSValue.MessageStatus.Unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从 `data` 列里认出 core 的用量（三个数字都在才算） */
function toUsage(value: unknown): AgentNS.Usage | undefined {
  if (!isRecord(value)) return undefined;
  const { prompt_tokens, completion_tokens, total_tokens } = value;
  if (
    typeof prompt_tokens !== "number" ||
    typeof completion_tokens !== "number" ||
    typeof total_tokens !== "number"
  ) {
    return undefined;
  }
  return { prompt_tokens, completion_tokens, total_tokens };
}

/**
 * 会话创建时那条 cwd 消息的正文（PRD F-D9：告诉模型「当前目录是哪儿」）。
 *
 * 这条消息在对话落库时写一次，之后不再重写、也不随每轮拼接（说了两遍模型会以为目录变了）。
 * 目录取的是这个对话所属项目的 cwd（不是进程工作目录）；句子用的是「这是宿主加的，不是
 * 用户输入的」那条文案（R21：不新造消息类型）。
 */
export function injectedContextOf(cwd: string, language: Language): string {
  const summary = render(language, "message.injectedContext.cwd", { cwd });
  return render(language, "message.injectedContext", { summary });
}

/**
 * 消息 → 边流边写的入参。
 *
 * `content` 走 JSON 列：存储层的 `content` 列就是 core 内容段的 JSON，两边的形状一致，
 * 只差存储层为了「不 import core」而声明的索引签名，故此处做一次显式转换。
 * `parentToolCallId` 非空即「这条消息是某个子 Agent 说的」（R37 / F-I7）。
 */
function toRow(
  message: AgentNS.Message,
  conversationId: string,
  createdAt: number,
  statusOverride?: AgentNS.MessageStatus,
  parentToolCallId?: string,
): MessageUpsertInput {
  const data: Record<string, unknown> = {};
  if (message.tool_calls) data.tool_calls = message.tool_calls;
  if (message.function_call) data.function_call = message.function_call;
  if (message.tool_call_id !== undefined) data.tool_call_id = message.tool_call_id;
  if (message.name !== undefined) data.name = message.name;
  if (message.reasoning_content !== undefined) data.reasoning_content = message.reasoning_content;
  if (message.usage) data.usage = message.usage;
  if (message.subAgentUsage) data.subAgentUsage = message.subAgentUsage;
  if (message.finish_reason !== undefined) data.finish_reason = message.finish_reason;
  if (message.hidden !== undefined) data.hidden = message.hidden;

  return {
    id: message.id,
    conversationId,
    role: message.role,
    status: (statusOverride ?? message.status ?? AgentNSValue.MessageStatus.Unknown) as string,
    omit: message.omit === true,
    content: (message.content ?? null) as unknown as MessageUpsertInput["content"],
    data: Object.keys(data).length > 0 ? data : null,
    parentToolCallId: parentToolCallId ?? null,
    createdAt,
  };
}

/** 存储行 → core 消息（缺的字段让它缺，不补空值：core 用 `undefined` 表示「没有」） */
function fromRow(row: StoredMessage): AgentNS.Message {
  const data = row.data ?? {};
  const message: AgentNS.Message = {
    id: row.id,
    role: toRole(row.role),
    status: toStatus(row.status),
  };
  if (row.content !== null) {
    message.content = row.content as unknown as AgentNS.MessageContent;
  }
  if (Array.isArray(data.tool_calls)) {
    message.tool_calls = data.tool_calls as AgentNS.ToolCall[];
  }
  if (isRecord(data.function_call)) {
    message.function_call = data.function_call as AgentNS.FunctionCall;
  }
  if (typeof data.tool_call_id === "string") message.tool_call_id = data.tool_call_id;
  if (typeof data.name === "string") message.name = data.name;
  if (typeof data.reasoning_content === "string") {
    message.reasoning_content = data.reasoning_content;
  }
  const usage = toUsage(data.usage);
  if (usage) message.usage = usage;
  const subAgentUsage = toUsage(data.subAgentUsage);
  if (subAgentUsage) message.subAgentUsage = subAgentUsage;
  if (typeof data.finish_reason === "string") {
    message.finish_reason = data.finish_reason as AgentNS.FinishReason;
  }
  if (typeof data.hidden === "boolean") message.hidden = data.hidden;
  message.omit = row.omit;
  return message;
}

// ---------------------------------------------------------------------------
// 失败事实（ProblemFact：码 + 文案键 + 参数 + 一句已渲染的话）
// ---------------------------------------------------------------------------

/**
 * 造一条失败事实。
 *
 * `message` 用缺省语言渲染一份：落库/推送里总要有一句现成的话给日志和排查用；
 * 真正面向某个连接的语言由接线层按 `code` / `messageKey` / `params` 重新渲染（architecture §6）。
 */
function problem(
  code: string,
  messageKey: MessageKey,
  params: Record<string, unknown> = {},
  detail?: unknown,
): ProblemFact {
  const fact: ProblemFact = {
    code,
    messageKey,
    params,
    message: render(DEFAULT_LANGUAGE, messageKey, params),
  };
  if (detail !== undefined) fact.detail = detail;
  return fact;
}

/** SDK 的 `ContextOverflowError` 形状（只认字段，避免为一次判断引入 SDK 的运行时依赖面） */
function asContextOverflow(
  error: unknown,
): { promptTokens: number; guardTokens: number } | undefined {
  if (!isRecord(error)) return undefined;
  if (error.name !== "ContextOverflowError") return undefined;
  const { promptTokens, guardTokens } = error;
  if (typeof promptTokens !== "number" || typeof guardTokens !== "number") return undefined;
  return { promptTokens, guardTokens };
}

/** 任意抛出物 → 失败事实：到了硬线就说硬线，其余都归为内部错误 + 原始原因 */
function toProblem(error: unknown): ProblemFact {
  const overflow = asContextOverflow(error);
  if (overflow) {
    return problem(
      "context_guard",
      "error.contextGuard",
      { limit: overflow.guardTokens, used: overflow.promptTokens },
      overflow,
    );
  }
  const reason = error instanceof Error ? error.message : String(error);
  return problem("internal", "error.internal", {}, { reason });
}

// ---------------------------------------------------------------------------
// 一轮
// ---------------------------------------------------------------------------

interface TurnSessionInit {
  conversation: Conversation;
  scope: Scope;
  /** 造 agent 的工厂（由 `ChatRunner` 在受理时定下：注入的那个，或按 SDK 口径装配的那个） */
  createAgent: AgentFactory;
  /** 还原之后的历史（`__asset_id` 已按当时的模型 / 端点换过） */
  history: AgentNS.Message[];
  content: AgentNS.MessageContent;
  /** 落库用的内容；不给时就是 `content` */
  storedContent?: AgentNS.MessageContent;
  attachments: AttachmentOutcome[];
  userMessageId: string;
  assistantMessageId: string;
  handle: RunHandle;
  language: Language;
  acceptedAt: string;
  startedAtMs: number;
  /** 结算收尾之后通知一声（`ChatRunner` 用它把这一轮从「现场」表里摘掉） */
  onSettled?: () => void;
}

/**
 * 一轮的现场：消息真相、六态、用量、写库节流。
 *
 * 它同时是 `ChatTurn`（`conversation.send` 的受理回执）：受理与执行是同一件事的两半，
 * 分成两个对象只会让「谁持有内存真相」含糊。
 */
class TurnSession implements ChatTurn {
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly attachments: AttachmentOutcome[];
  readonly acceptedAt: string;
  readonly done: Promise<TurnSettlement>;

  private readonly conversation: Conversation;
  private readonly scope: Scope;
  private readonly createAgent: AgentFactory;
  /** 还原后的历史（这一轮实际交给 agent 的那份） */
  private history: AgentNS.Message[];
  /** 这一轮发给模型的内容（`prepareAttachments` 的产物） */
  private content: AgentNS.MessageContent;
  /** 落库的内容（`__asset_id` 形态）：它就是用户挂的那几张图 */
  private readonly storedContent: AgentNS.MessageContent;
  private readonly language: Language;
  private readonly handle: RunHandle;
  private readonly options: ChatRunnerOptions;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly startedAtMs: number;
  private readonly onSettled?: () => void;

  private resolveDone!: (settlement: TurnSettlement) => void;
  private agent?: ChatAgent;
  private aborted = false;
  private problem: ProblemFact | null = null;
  private settledAtMs: number | null = null;

  /** 已经确认过 id 的消息（历史 + 本轮）；不在里面的会被认领成宿主 id */
  private readonly knownIds = new Set<string>();
  /** 每条消息第一次出现的时间（库里的 `createdAt`） */
  private readonly createdAtOf = new Map<string, number>();
  /** 本轮 core 追加过的消息 id，按先后顺序 */
  private readonly producedIds: string[] = [];
  /** 中止时在途的消息 id（D15：这些行以 `Aborted` 落库） */
  private readonly abortedInFlight = new Set<string>();
  private readonly deltaSeq = new Map<string, number>();
  private readonly runningTools = new Map<string, RunningTool>();
  private readonly subagents = new Map<string, SubAgentSnapshot>();
  /** 已经落过库的子 Agent 委派（工具调用 id） */
  private readonly persistedSubAgents = new Set<string>();
  /**
   * 子 Agent 的消息 → 宿主分配的 id。
   *
   * 子 Agent 跑的时候它的消息只在**它自己的内存**里，而客户端要按 id 才拼得起来；id 必须
   * 在第一次见到这条消息时定死，否则「流式时推出去的 id」与「结束后落库的 id」会是两个，
   * 客户端就会以为那是两条消息。
   */
  private readonly subAgentIds = new WeakMap<AgentNS.Message, string>();
  /** 子 Agent 消息的节流写：每条约 streamWriteIntervalMs 写一次（与主线同一个口径） */
  private readonly subWriteAt = new Map<string, number>();
  /** 每个子 Agent 到目前为止追加过几条消息（快照里的 `messageCount` 用它） */
  private readonly subAgentCount = new Map<string, number>();

  private userIdUsed = false;
  private assistantIdUsed = false;
  private streaming?: AgentNS.Message;
  /** 结算后 agent 已经被丢掉：把本轮产出留在这里，快照与用量还读得到 */
  private detached?: AgentNS.Message[];
  private generation: GenerationState;
  private writeTimer?: () => void;
  private lastWriteAt = 0;
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * 这一轮还能不能接新话（`conversation.send` 的排队分支靠它定夺，PRD D3）。
   *
   * 三态，转换只有四处：
   *   - `pending` → `open`：`attach()` 里 agent 装上了；
   *   - `open` → `closed`：`send()` 返回了（这一轮再没有轮末插入点）或用户按了停；
   *   - `pending` → `closed`：装配就失败了，或用户还没跑就先按了停；
   *   - `settle()` 兜底关一次（正常路径上它已经是 `closed` 了）。
   */
  private enqueueState: "pending" | "open" | "closed" = "pending";
  /** 正在等「这一轮能不能排」的那些调用方（装配期间来的那几句在这里排着） */
  private readonly enqueueWaiters = new Set<(ready: boolean) => void>();
  /**
   * 已经排队、还没落地的消息 id（落地时据此把它们记进 `producedIds`，按**落地顺序**落库）。
   *
   * 这些 id 同时也在 `knownIds` 里：落地时 core 那条消息带着我们入队时定的 id 回来，
   * `claimId` 不该再给它换一个（D5）。
   */
  private readonly queuedIds = new Set<string>();
  /**
   * 排队条目的**落库那一份**内容（`__asset_id` 形态）。
   *
   * 与老路径的用户消息同一个道理：发给模型的是厂商的 `file_id` / base64，库里要留与端点
   * 无关的引用（F-H7）。core 落地那一刻只认 id 与内容，落库的内容在我们手里。
   */
  private readonly queuedStored = new Map<string, AgentNS.MessageContent>();

  constructor(options: ChatRunnerOptions, init: TurnSessionInit) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? defaultNewId;
    this.conversation = init.conversation;
    this.conversationId = init.conversation.id;
    this.scope = init.scope;
    this.createAgent = init.createAgent;
    this.history = init.history;
    this.content = init.content;
    this.storedContent = init.storedContent ?? init.content;
    this.language = init.language;
    this.attachments = init.attachments;
    this.userMessageId = init.userMessageId;
    this.assistantMessageId = init.assistantMessageId;
    this.handle = init.handle;
    this.acceptedAt = init.acceptedAt;
    this.startedAtMs = init.startedAtMs;
    this.onSettled = init.onSettled;
    this.generation = { phase: "connected", since: init.acceptedAt };
    // 受理时刚写过一次占位行：节流从那一次算起
    this.lastWriteAt = init.startedAtMs;
    this.done = new Promise<TurnSettlement>((resolve) => {
      this.resolveDone = resolve;
    });

    for (const message of init.history) {
      this.knownIds.add(message.id);
      this.createdAtOf.set(message.id, this.startedAtMs);
    }
    // 两条由宿主预先分配的消息：id 已经是我们的，不再认领
    this.createdAtOf.set(this.userMessageId, this.startedAtMs);
    this.createdAtOf.set(this.assistantMessageId, this.startedAtMs);
  }

  // ---- 对外的三个动作 ----

  abort(reason?: string): void {
    this.handle.abort(reason);
  }

  runState(): RunState {
    return this.buildRunState();
  }

  /**
   * 这一刻能不能把新话排进这一轮（PRD D3 的排队分支）。
   *
   * `pending`（轮次已登记、agent 还在装配）时会等，最多等 `timeoutMs`；`closed` 立刻 `false`。
   *
   * ## 为什么是「等」而不是「直接回 busy」
   *
   * `RunRegistry` 从 `start()` 到 `attach()` 之间有一段看不见的空窗：读会话行、拿 Scope
   * （首次进某个项目要 MCP 发现）、修复历史、准备素材（可能要上传厂商）、装配 agent。这一段
   * 可能好几秒，而「刚发完第一句紧接着发第二句」正是最常撞上它的时刻 —— 那一刻回 `busy`
   * 等于这一单什么都没改。等它装好（正常是毫秒级）再入队，用户看到的就是「已排队」。
   *
   * ## 为什么要有上界
   *
   * 装配卡在某个不应答的 MCP 服务上时，一直等会让这条请求一直挂着（客户端那侧只是转圈）。
   * 到点回 `false`，调用方按老口径（`busy`）回话，把选择权交回用户。
   */
  async waitEnqueueable(timeoutMs: number): Promise<boolean> {
    if (this.enqueueState === "open") return true;
    if (this.enqueueState === "closed") return false;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        this.enqueueWaiters.delete(finish);
        cancel();
        resolve(ready);
      };
      // 到点按「排不进去」处理：等下去只是把这条请求挂着
      const cancel = this.clock.setTimeout(() => finish(false), timeoutMs);
      this.enqueueWaiters.add(finish);
    });
  }

  /**
   * 把一句用户输入排进这一轮（PRD D3）。
   *
   * 返回 `null` = 这一轮接不了：agent 还没装上、这一轮已经跑完（正在收尾写库）、或者用户刚
   * 按了停。三种都不是错误 —— 调用方回老路径，由 `run()` 决定「开新一轮」还是 `busy`。
   *
   * ## 为什么「判能不能排」与「推」之间不允许有 await
   *
   * 中间一旦让出执行权，就可能出现「判完还开着、推的时候已经关上」：条目推进一个再也不会
   * 被取走的 inbox，而我们已经回了客户端 `queued: true` —— 那就是一句假话。所以除了入口那次
   * `waitEnqueueable`，这里全程同步。
   */
  enqueue(input: {
    content: AgentNS.MessageContent;
    storedContent?: AgentNS.MessageContent;
    attachments: AttachmentOutcome[];
  }): QueuedTurn | null {
    if (this.enqueueState !== "open" || !this.agent) return null;
    if (this.aborted || this.handle.aborted) return null;

    // 消息 id 现在就定死（D5）：客户端马上要按它画一条，落地那条必须用同一个
    const userMessageId = generateMessageId();
    this.agent.pushInbox({
      messageId: userMessageId,
      // 用户自己说的话：不带「这条消息来自…自动推送」那行注释（core 只给非 user 来源加）
      source: "user",
      // 高优先：落点是「工具轮跑完的边界」—— 不打断模型正在吐的那一段，又能尽快接住
      priority: "high",
      content: input.content,
    });
    // 先认下这个 id：落地时 core 那条消息带着它回来，`claimId` 不该再改一遍
    this.knownIds.add(userMessageId);
    this.queuedIds.add(userMessageId);
    this.createdAtOf.set(userMessageId, this.clock.now());
    if (input.storedContent !== undefined) {
      this.queuedStored.set(userMessageId, input.storedContent);
    }

    // 客户端要看得见「已排队 N 条」：`inboxPending` 这会儿刚多了一条
    this.pushRunState();

    return {
      conversationId: this.conversationId,
      userMessageId,
      attachments: input.attachments,
      acceptedAt: this.nowIso(),
    };
  }

  /** agent 装上了：装配期间排着的那些调用方可以入队了 */
  private openEnqueue(): void {
    if (this.enqueueState !== "pending") return;
    this.enqueueState = "open";
    this.flushEnqueueWaiters(true);
  }

  /** 这一轮不再接新话（跑完了 / 被叫停 / 正在收尾）：排着的一律按「排不进去」放走 */
  private closeEnqueue(): void {
    if (this.enqueueState === "closed") return;
    this.enqueueState = "closed";
    this.flushEnqueueWaiters(false);
  }

  private flushEnqueueWaiters(ready: boolean): void {
    for (const waiter of [...this.enqueueWaiters]) waiter(ready);
    this.enqueueWaiters.clear();
  }

  /** 真正跑一轮。`ChatRunner` 在受理之后立刻叫它，不等结果 */
  async execute(): Promise<void> {
    try {
      this.pushRunState();
      await this.attemptOnce();
    } catch (error) {
      // 一轮就是一次尝试：失败原样记成这一轮的结局。厂商那侧的降级（Files API 失败改内联、
      // 模型看不了图转为文字）在 SDK 的选路里，这里不重发。
      this.recordFailure(error);
    } finally {
      await this.settle();
    }
  }

  /** 一次尝试：建 agent → 把历史与用户输入发出去；失败原样上抛，由 `execute` 记成这一轮的结局 */
  private async attemptOnce(): Promise<void> {
    const agent = await this.createAgent({
      conversationId: this.conversationId,
      workspaceId: this.conversation.workspaceId,
      agentId: this.conversation.agentId,
      modelId: this.conversation.modelId,
      thinkingLevel: this.conversation.thinkingLevel,
      scope: this.scope,
      history: [...this.history],
    });
    this.attach(agent);

    // 装配 agent 期间用户就按了停：不再发请求，直接按中止结算
    if (this.handle.aborted) {
      this.takeAbortSnapshot();
      agent.abort();
      return;
    }
    try {
      await agent.send(this.content);
    } finally {
      // `send()` 返回 = 这一轮再没有轮末插入点：此刻起排进来的条目一句也不会被发出去。
      // 门必须在这里关上 —— `settle()` 还要写库，那一段时间在 `RunRegistry` 眼里仍然「在跑」。
      // （core 侧的对称保证：`send()` 返回时 inbox 已经被取空，所以关门的这一刻不欠任何
      // 已经回过 `queued` 的条目 —— 工单 J。）
      this.closeEnqueue();
    }
  }

  // ---- 装配：把 core 的事件接到本文件 ----

  private attach(agent: ChatAgent): void {
    this.agent = agent;
    // 历史就是 agent 的既有消息（内存里只有这一份）
    agent.messages.push(...this.history);

    agent.events.on("message", (message: AgentNS.Message) => this.onMessage(message));
    agent.events.on("open", () => this.enterAwaitingFirstToken());
    agent.events.on("chunk-parsed", (receiver: AgentNS.Message, chunk: RawChunk) =>
      this.onChunk(receiver, chunk),
    );
    agent.events.on("error", (error: unknown) => this.recordFailure(error));
    agent.events.on("tool-call-end", (ctx: ToolCallEndContext) => this.onToolCallEnd(ctx));
    agent.events.on("sub-agent-start", (ctx: SubAgentContext) => this.onSubAgentStart(ctx));
    agent.events.on("sub-agent-end", (ctx: SubAgentContext) => this.onSubAgentEnd(ctx));

    // 中止只有一个入口：RunRegistry 的句柄（服务层的 abort 也走这里）
    this.handle.onAbort(() => {
      this.takeAbortSnapshot();
      this.agent?.abort();
    });

    // 装好了：装配期间来的那几句可以排队了（见 `waitEnqueueable`）
    this.openEnqueue();
  }

  /** core 追加了一条消息：认领 id、记时间、更新六态里那些跟消息有关的部分 */
  private onMessage(message: AgentNS.Message): void {
    if (this.queuedIds.delete(message.id)) {
      // 排队的那条落地了：core 在轮末把它 append 进来，id 是入队时定的那个（D5），
      // 所以这里既不重新认领、也不换 id。现在才把它记进 `producedIds`。
      this.createdAtOf.set(message.id, this.clock.now());
      if (!this.producedIds.includes(message.id)) this.producedIds.push(message.id);
      // **落地这一刻就写库**（不能拖到 `persistFinal`）：`seq` 是 `MAX(seq)+1` 按插入顺序
      // 给的，而助手消息是边流边写的 —— 排队这一句若等到收尾才第一次写，它就会排到
      // 它引出的那条回答**之后**（真机上量出来的颠倒）。见 `persistLandedQueued`。
      this.persistLandedQueued(message);
      // 排队的少了一条（core 落地时已经从 inbox 里摘走），客户端据此收起一个「已排队」
      this.pushRunState();
      return;
    }
    if (!this.knownIds.has(message.id)) {
      message.id = this.claimId(message);
      this.knownIds.add(message.id);
      this.createdAtOf.set(message.id, this.clock.now());
      if (!this.producedIds.includes(message.id)) this.producedIds.push(message.id);
    }

    if (message.role === AgentNSValue.Role.Assistant) {
      if (message.status === AgentNSValue.MessageStatus.Pending) {
        // 新一轮内循环的占位：接下来要拼的就是它
        this.streaming = message;
        this.setGeneration({ phase: "connected", since: this.sinceFor("connected") });
      }
      return;
    }

    if (
      message.role === AgentNSValue.Role.Tool ||
      message.role === AgentNSValue.Role.Function
    ) {
      this.trackRunningTool(message);
      // 工具结果一出现就落一行（状态还是 pending）：进程中间没了，装载时能看出
      // 「这个工具参与了、但没定型」，而不是压根不知道它存在
      this.enqueueWrite(message);
    }
  }

  /**
   * 认领 id：这一轮的头两条（用户消息、助手占位）用宿主已经发给客户端的 id，
   * 之后 core 追加的每一条各自要一个新 id（id 由宿主分配，PRD L6）。
   */
  private claimId(message: AgentNS.Message): string {
    if (message.role === AgentNSValue.Role.User && !this.userIdUsed) {
      this.userIdUsed = true;
      return this.userMessageId;
    }
    if (
      message.role === AgentNSValue.Role.Assistant &&
      !this.assistantIdUsed &&
      message.status === AgentNSValue.MessageStatus.Pending
    ) {
      this.assistantIdUsed = true;
      return this.assistantMessageId;
    }
    return this.newId();
  }

  /** 一片增量：推事件（core 的 `AgentNS.Delta` 原样）+ 推进六态 + 节流写库 */
  private onChunk(receiver: AgentNS.Message, chunk: RawChunk): void {
    const delta = chunk.choices?.[0]?.delta;
    // 只有外层字段的收尾片（带 usage / finish_reason）不产生增量事件
    if (!delta) return;
    const seq = this.deltaSeq.get(receiver.id) ?? 0;
    this.deltaSeq.set(receiver.id, seq + 1);
    this.options.emit("message.delta", {
      conversationId: this.conversationId,
      messageId: receiver.id,
      seq,
      delta,
      at: this.nowIso(),
    });

    this.advanceGeneration(receiver, delta);
    this.scheduleStreamWrite(receiver);
  }

  /**
   * 一个工具定型了（L8 的「在等哪几个工具」）。
   *
   * 剩下还有工具没定型就继续报「在等工具」，并把列表缩到还在跑的那些（并行时逐个减少）。
   * 都定型了就不该停在「在等工具」：那一态描述的是一件已经不成立的事，此时回到「连上」
   * （接下来要么是下一轮的首字，要么这一轮结束）。
   */
  private onToolCallEnd(ctx: ToolCallEndContext): void {
    this.runningTools.delete(toolKey(ctx.toolCall));
    if (this.runningTools.size === 0) {
      this.setGeneration({ phase: "connected", since: this.sinceFor("connected") });
      return;
    }
    this.setGeneration({
      phase: "awaiting_tools",
      since: this.sinceFor("awaiting_tools"),
      runningTools: [...this.runningTools.values()],
    });
  }

  private onSubAgentStart(ctx: SubAgentContext): void {
    const toolCallId = ctx.toolCallContext.tool_call.id ?? "";
    const snapshot: SubAgentSnapshot = {
      toolCallId,
      name: subAgentName(ctx.subAgent),
      status: "running",
      startedAt: this.nowIso(),
      finishedAt: null,
      messageCount: ctx.subAgent.messages.length,
      usage: null,
      problem: null,
    };
    this.subagents.set(toolCallId, snapshot);

    // 子 Agent 说的话也要过线（F-I7）：它跑在自己的 Agent 实例里，宿主不转发的话，
    // 客户端只能等它跑完去读库 —— 中间整段时间屏幕上是一个字都没有的。
    ctx.subAgent.events.on("message", (message: AgentNS.Message) => {
      this.onSubAgentMessage(toolCallId, message);
    });
    ctx.subAgent.events.on("chunk-parsed", (receiver: AgentNS.Message, chunk: RawChunk) => {
      this.onSubAgentChunk(toolCallId, receiver, chunk);
    });

    const running = this.runningTools.get(toolKey(ctx.toolCallContext.tool_call));
    if (running) running.subagent = snapshot;
    this.pushRunState();
  }

  /** 子 Agent 追加了一条消息：先定 id（与落库那份一致），再刷新条数 */
  private onSubAgentMessage(toolCallId: string, message: AgentNS.Message): void {
    if (this.subAgentIds.has(message)) return;
    this.subAgentIdOf(message);
    const count = (this.subAgentCount.get(toolCallId) ?? 0) + 1;
    this.subAgentCount.set(toolCallId, count);
    const snapshot = this.subagents.get(toolCallId);
    if (snapshot) snapshot.messageCount = count;
    this.pushRunState();
  }

  /** 子 Agent 的一片增量：推成 `message.delta`（带 `toolCallId`）+ 节流写库 */
  private onSubAgentChunk(toolCallId: string, receiver: AgentNS.Message, chunk: RawChunk): void {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    const messageId = this.subAgentIdOf(receiver);
    const seq = this.deltaSeq.get(messageId) ?? 0;
    this.deltaSeq.set(messageId, seq + 1);
    this.options.emit("message.delta", {
      conversationId: this.conversationId,
      messageId,
      seq,
      delta,
      at: this.nowIso(),
      toolCallId,
    });
    this.scheduleSubAgentWrite(toolCallId, receiver);
  }

  /** 子 Agent 那条消息的 id（第一次见就定下来，之后一直用这一个） */
  private subAgentIdOf(message: AgentNS.Message): string {
    const existing = this.subAgentIds.get(message);
    if (existing !== undefined) return existing;
    const id = this.newId();
    this.subAgentIds.set(message, id);
    this.createdAtOf.set(id, this.clock.now());
    return id;
  }

  private onSubAgentEnd(ctx: SubAgentContext): void {
    const toolCallId = ctx.toolCallContext.tool_call.id ?? "";
    const existing = this.subagents.get(toolCallId);
    if (!existing) return;

    const usage = sumUsage(ctx.subAgent.messages);
    const failed = ctx.subAgent.messages.some(
      (message) => message.status === AgentNSValue.MessageStatus.Error,
    );
    existing.status = this.aborted ? "aborted" : failed ? "error" : "done";
    existing.finishedAt = this.nowIso();
    existing.usage = usage;
    if (failed) {
      const reason = lastErrorText(ctx.subAgent.messages);
      existing.problem = problem("subagent.failed", "message.subagentFailed", {
        name: existing.name,
        reason,
      });
    }

    // F-I7：子 Agent 说过的话也落库（挂在那次委派的工具调用上），条数就是真落下去的条数
    const rows = this.persistSubAgent(toolCallId, ctx.subAgent.messages);
    existing.messageCount = rows;
    this.pushRunState();
  }

  /**
   * 把子 Agent 的消息落库（F-I7），返回落了多条。
   *
   * 同一次委派只落一遍（`sub-agent-end` 重复到达时不重复写）；每条都拿**宿主已经发给客户端的**
   * 那个 id（`subAgentIds`）—— 另给一个新 id 会让客户端把同一条消息当成两条。
   * 挂上 `parentToolCallId`，`seq` 由仓储在对话内递增。
   */
  private persistSubAgent(toolCallId: string, messages: readonly AgentNS.Message[]): number {
    if (this.persistedSubAgents.has(toolCallId)) return messages.length;
    this.persistedSubAgents.add(toolCallId);
    const now = this.clock.now();
    const rows = messages.map((message) => {
      const id = this.subAgentIdOf(message);
      return toRow(
        { ...message, id },
        this.conversationId,
        this.createdAtOf.get(id) ?? now,
        undefined,
        toolCallId,
      );
    });
    this.enqueueWrites(rows);
    return rows.length;
  }

  /** 工具结果消息一出现就算「开始等它」；并行时列表里有几个就是几个（PRD L8） */
  private trackRunningTool(message: AgentNS.Message): void {
    const call: AgentNS.ToolCall = {
      id: message.tool_call_id,
      type: "function",
      function: { name: message.name ?? "" },
    };
    const key = message.tool_call_id ? `id:${message.tool_call_id}` : toolKey(call);
    if (this.runningTools.has(key)) return;
    this.runningTools.set(key, { toolCall: call, startedAt: this.nowIso() });
    this.setGeneration({
      phase: "awaiting_tools",
      since: this.sinceFor("awaiting_tools"),
      runningTools: [...this.runningTools.values()],
    });
  }

  // ---- 六态 ----

  /** 同一态内沿用原来的 `since`，换态才用此刻（客户端据此算「这一态多久了」） */
  private sinceFor(phase: GenerationPhaseName): string {
    return this.generation.phase === phase ? this.generation.since : this.nowIso();
  }

  private enterAwaitingFirstToken(): void {
    this.setGeneration({
      phase: "awaiting_first_token",
      since: this.sinceFor("awaiting_first_token"),
    });
  }

  /**
   * 按这一片带来的东西推进六态。
   *
   * 只往前推、不回退：思考之后来正文是「在想 → 在输出」；正文之后再来的思考片
   * 不把状态拽回「在想」（同一条消息内部顺序恒定，F-I2）。
   */
  private advanceGeneration(receiver: AgentNS.Message, delta: AgentNS.Delta): void {
    if (delta.tool_calls?.length) {
      this.setGeneration({
        phase: "assembling_tool_calls",
        since: this.sinceFor("assembling_tool_calls"),
        toolCalls: assemblingToolCalls(receiver),
      });
      return;
    }
    if (delta.content !== undefined) {
      this.setGeneration({
        phase: "generating",
        since: this.sinceFor("generating"),
        chars: contentChars(receiver.content),
      });
      return;
    }
    if (delta.reasoning_content !== undefined && this.generation.phase !== "generating") {
      this.setGeneration({
        phase: "thinking",
        since: this.sinceFor("thinking"),
        chars: receiver.reasoning_content?.length ?? 0,
      });
    }
  }

  /**
   * 换态/换列表时推一次 `run.state`。
   *
   * 字符数增长不单独推：增量本来就在 `message.delta` 里，`run.state` 只在「换了一态」或
   * 「还在跑的工具变了」这两种事实变化时发，免得一条流式消息把状态事件刷成两倍流量。
   */
  private setGeneration(next: GenerationState): void {
    const changed = !sameGeneration(this.generation, next);
    this.generation = next;
    if (changed) this.pushRunState();
  }

  // ---- 写库 ----

  /** 节流：到点就写一条，不到点就排一个「到点再写」 */
  private scheduleStreamWrite(message: AgentNS.Message): void {
    const interval = this.options.streamWriteIntervalMs ?? DEFAULT_STREAM_WRITE_INTERVAL_MS;
    const now = this.clock.now();
    if (interval <= 0 || now - this.lastWriteAt >= interval) {
      this.enqueueWrite(message);
      return;
    }
    if (this.writeTimer) return;
    this.writeTimer = this.clock.setTimeout(() => {
      this.writeTimer = undefined;
      if (this.streaming) this.enqueueWrite(this.streaming);
    }, interval - (now - this.lastWriteAt));
  }

  private enqueueWrite(message: AgentNS.Message): void {
    this.lastWriteAt = this.clock.now();
    const row = toRow(
      message,
      this.conversationId,
      this.createdAtOf.get(message.id) ?? this.clock.now(),
      this.abortedInFlight.has(message.id) ? AgentNSValue.MessageStatus.Aborted : undefined,
    );
    this.writeChain = this.writeChain
      .then(() => this.options.messages.upsert(row))
      .catch((error: unknown) => this.options.onError?.(error, "stream-write"));
  }

  /**
   * 子 Agent 消息的节流写（与主线同一份节奏）。
   *
   * 不写的话，子 Agent 在跑的那几十分钟里库里什么都没有：客户端切过去是一页空白，
   * 中途断线也一个字不剩。写完不丢终版：`sub-agent-end` 时 `persistSubAgent` 用同一批 id 再写一次。
   */
  private scheduleSubAgentWrite(toolCallId: string, message: AgentNS.Message): void {
    const interval = this.options.streamWriteIntervalMs ?? DEFAULT_STREAM_WRITE_INTERVAL_MS;
    if (interval <= 0) {
      this.enqueueSubAgentWrite(toolCallId, message);
      return;
    }
    const id = this.subAgentIdOf(message);
    const now = this.clock.now();
    if (now - (this.subWriteAt.get(id) ?? 0) < interval) return;
    this.subWriteAt.set(id, now);
    this.enqueueSubAgentWrite(toolCallId, message);
  }

  private enqueueSubAgentWrite(toolCallId: string, message: AgentNS.Message): void {
    const id = this.subAgentIdOf(message);
    const row = toRow(
      { ...message, id },
      this.conversationId,
      this.createdAtOf.get(id) ?? this.clock.now(),
      undefined,
      toolCallId,
    );
    this.writeChain = this.writeChain
      .then(() => this.options.messages.upsert(row))
      .catch((error: unknown) => this.options.onError?.(error, "sub-agent-stream-write"));
  }

  /**
   * 排队落地的那条用户消息：**落地这一刻**写下它的行（而不是等到收尾）。
   *
   * ## 为什么必须是这一刻
   *
   * `seq` 由存储层按插入顺序给（`MAX(seq)+1`，见 `MessageRepository` 的 UPSERT），而助手消息是
   * 边流边写的（`scheduleStreamWrite`）。排队那句要是等到 `persistFinal` 才第一次写，它的
   * `seq` 就排在**它引出的那一轮回答之后** —— 客户端重开这段对话时读到的转录成了
   * 「助手说完 → 助手又说 → 用户冒一句」，而且最后那句永远没有回答它的助手消息。
   * 普通（非排队）用户消息没有这个毛病：它在 `run()` 受理时就写行了。
   *
   * ## 为什么写行与记素材关系绑在一起
   *
   * `conversation_assets.messageId` 的外键指着 `messages.id`，所以只能「先写行、再记关系」;
   * 老路径也是这个顺序（受理时写行 → 紧接着 `linkMessageAssets`）。排队这条晚落地，但口径
   * 一样，只是搬到了它真正成为一条消息的那一刻。
   *
   * 写进串行链（`writeChain`）而不是当场 await：`onMessage` 是同步的事件处理器，接不住
   * Promise；而链上已经有边流边写与子 Agent 的写，跟着排队才能保证落盘顺序与事件顺序一致，
   * 也让 `settle()` 的 `flushWrites()` 自然等到它写完。
   *
   * 落库正文用 `queuedStored` 那一份（`__asset_id` 形态），与主消息同一个口径：发给模型的
   * 是厂商产物，库里不能绑死在这次发送的端点上。
   */
  private persistLandedQueued(message: AgentNS.Message): void {
    // 落地时刻（onMessage 刚记下的那一份）：库里的时间线要与它在对话里的位置一致，
    // 用受理时刻会把它拉到这一轮开头，用收尾时刻会把它推到回答后面，两个都不对
    const createdAt = this.createdAtOf.get(message.id) ?? this.clock.now();
    const row = toRow(message, this.conversationId, createdAt);
    const stored = this.queuedStored.get(message.id);
    if (stored !== undefined) {
      row.content = stored as unknown as MessageUpsertInput["content"];
    }
    this.writeChain = this.writeChain
      .then(async () => {
        // 同一 id 再写是覆盖（仓储 `ON CONFLICT (id) DO UPDATE`：`seq` 与 `createdAt` 保留
        // 第一次写入时的值），所以收尾那一遍不会把这条换成两行、也不会改掉它的 `seq`
        await this.options.messages.upsert(row);
        await this.linkQueuedAssets([message]);
      })
      .catch((error: unknown) => this.options.onError?.(error, "queued-landing-write"));
  }

  /** 一批行按同一份额度写下去（子 Agent 的消息一次写一拍）；与边流边写共用一条串行链 */
  private enqueueWrites(rows: MessageUpsertInput[]): void {
    if (rows.length === 0) return;
    this.lastWriteAt = this.clock.now();
    this.writeChain = this.writeChain
      .then(() => this.options.messages.upsertMany(rows))
      .catch((error: unknown) => this.options.onError?.(error, "sub-agent-write"));
  }

  /** 把挂着的节流写收干净（结算前必须做：不能让「最终版」被一次迟到的增量写覆盖） */
  private async flushWrites(): Promise<void> {
    this.writeTimer?.();
    this.writeTimer = undefined;
    await this.writeChain;
  }

  // ---- 结算 ----

  private recordFailure(error: unknown): void {
    // 用户按下中止时 core 也可能抛一次（请求被 abort）：那不是失败，不记 problem
    if (this.aborted || this.handle.aborted) return;
    this.problem = toProblem(error);
  }

  /** 中止那一刻在途的消息：core 会把它们标成 Aborted，这里的 id 用来保证库里也记 Aborted（D15） */
  private takeAbortSnapshot(): void {
    this.aborted = true;
    // 用户按停 = 排队的那些话不发了（core 的 `abort()` 会清空 inbox），所以入队门此刻就关
    this.closeEnqueue();
    for (const message of this.agent?.messages ?? []) {
      if (
        message.status === AgentNSValue.MessageStatus.Pending ||
        message.status === AgentNSValue.MessageStatus.Writing
      ) {
        this.abortedInFlight.add(message.id);
      }
    }
    if (!this.assistantIdUsed) this.abortedInFlight.add(this.assistantMessageId);
  }

  private outcome(): RunOutcome {
    if (this.aborted || this.handle.aborted) return "aborted";
    return this.problem ? "error" : "completed";
  }

  private async settle(): Promise<void> {
    if (this.settledAtMs !== null) return;
    this.settledAtMs = this.clock.now();
    // 兜底：装配就失败 / 没走完 `send()` 的那几条路径也把入队门关上
    this.closeEnqueue();

    const outcome = this.outcome();
    const produced = this.producedMessages();

    try {
      await this.flushWrites();
      await this.persistFinal(outcome, produced);
    } catch (error) {
      this.options.onError?.(error, "final-write");
    }

    // 收工那一刻 inbox 里还有东西 = 出事了。core 保证 `send()` 的返回点已经把各处取件点
    // （含整组收尾钩子 `onInnerLoopsEnd` 与 `onAfterSend` 之后那两处）全走完（工单 J），
    // 所以正常路径上这里必然是空的；还有存货意味着有人在最后一个取件点**之后**才推进来
    // （插件在更晚的异步尾巴上 push，或 abort 清空之后又来的）。不吭声最糟：客户端按回包
    // 画了一条，屏幕上却永远等不到它。至少让日志里有一行。
    const leftover = this.agent?.inbox ?? [];
    if (leftover.length > 0) {
      const ids = leftover.map((entry) => entry.messageId).join(", ");
      this.options.onError?.(
        new Error(`这一轮已经收工，inbox 里还剩 ${leftover.length} 条没被取走：${ids}`),
        "inbox-leftover",
      );
    }

    // agent 跑完即弃（PRD D28）：之后这一轮只剩内存里的消息与库里的快照。
    // 本轮产出先捡出来，否则用量与 `done` 的载荷会跟着 agent 一起消失。
    this.detached = produced;
    this.agent = undefined;

    this.options.runs.finish(this.conversationId);
    this.options.scopes.release(this.conversation.workspaceId);

    const usage = this.usageSnapshot();
    const run = this.buildRunState();
    this.options.emit("run.state", {
      conversationId: this.conversationId,
      run,
      at: this.nowIso(),
    });
    this.options.emit("usage", { conversationId: this.conversationId, usage, at: this.nowIso() });
    this.options.emit("conversation.changed", {
      conversationId: this.conversationId,
      workspaceId: this.conversation.workspaceId,
      change: "messages_persisted",
      messageCount: this.history.length + produced.length,
      at: this.nowIso(),
    });

    this.resolveDone({
      conversationId: this.conversationId,
      assistantMessageId: this.assistantMessageId,
      outcome,
      problem: this.problem,
      messages: [...this.history, ...produced],
      produced,
      usage,
      run,
    });

    this.notifySettled(outcome, usage);
    this.onSettled?.();
  }

  /**
   * 一轮结算之后通知组装层（R59：交接线问题由它触发）。
   *
   * 这一跳只报事实：本轮 `prompt_tokens`、生效模型上那条交接线、这一轮连接的语言。
   * 「到线了没、要不要问用户」不在本文件判断（PRD D22：问，且不在流式中途）。
   */
  private notifySettled(outcome: RunOutcome, usage: UsageSnapshot): void {
    const onSettled = this.options.onTurnSettled;
    if (!onSettled) return;
    const model = this.scope.config.models.find(
      (candidate) => candidate.id === this.conversation.modelId,
    );
    try {
      onSettled({
        conversationId: this.conversationId,
        outcome,
        promptTokens: usage.turn.prompt_tokens,
        handoffTokens: model?.tokenThresholds.handoff ?? 0,
        language: this.language,
      });
    } catch (error) {
      this.options.onError?.(error, "on-turn-settled");
    }
  }

  /**
   * 内循环结束写一次最终版（PRD F-C2）。
   *
   * 除了本轮产出的消息，还要兜住两种情况：助手占位在 agent 建起来之前就结束了（装配失败、
   * 或被立刻中止），库里那条占位必须有个终态，否则客户端会看到一条永远在写的消息。
   *
   * **这一写不是所有消息的首次写入**：助手消息边流边写、普通用户消息在受理时就写、排队落地
   * 的用户消息在落地那一刻写（`persistLandedQueued`）。这里是「把终态盖回去」的那一遍 ——
   * 尤其用户消息，第一次写入时它还只是一条刚落地的行。所以它必须留在，但不能再被当成
   * 「排队那条第一次出现的时刻」。
   */
  private async persistFinal(outcome: RunOutcome, produced: AgentNS.Message[]): Promise<void> {
    const rows = produced.map((message) => {
      const row = toRow(
        message,
        this.conversationId,
        this.createdAtOf.get(message.id) ?? this.settledAtMs ?? this.clock.now(),
        this.abortedInFlight.has(message.id) ? AgentNSValue.MessageStatus.Aborted : undefined,
      );
      // 用户那条消息在 core 那边带着「这一次发出去的内容」（厂商的 file_id / base64）。
      // 落库要的是 `__asset_id` 那一份：否则库里这条消息就绑死在这次发送所用的端点上了。
      // 排队进来的那几句同样有这个岔路（D3：排队的也走一遍素材准备），只是它们各自那一份
      // 存在 `queuedStored` 里 —— 每句话的附件可以不同，不能拿主消息那份套上去。
      const stored =
        message.id === this.userMessageId ? this.storedContent : this.queuedStored.get(message.id);
      if (stored !== undefined) {
        row.content = stored as unknown as MessageUpsertInput["content"];
      }
      return row;
    });

    if (!this.assistantIdUsed) {
      const status =
        outcome === "aborted"
          ? AgentNSValue.MessageStatus.Aborted
          : outcome === "error"
            ? AgentNSValue.MessageStatus.Error
            : AgentNSValue.MessageStatus.Completed;
      rows.push({
        id: this.assistantMessageId,
        conversationId: this.conversationId,
        role: AgentNSValue.Role.Assistant,
        status: status as string,
        omit: false,
        content: null,
        data: null,
        createdAt: this.startedAtMs,
      });
    }

    // 收尾这一写是**终态回写**：所有消息都要，包括本轮落地时已经写过行的那几句排队消息
    // （`persistLandedQueued`）。同一 id 的重复写只是覆盖（仓储 `ON CONFLICT (id) DO UPDATE`，
    // `seq` / `createdAt` 保留第一次的值），所以它不会把那条变成两行、也不会把它的 `seq`
    // 改到回答后面 —— 但前提是落地那一刻已经写过一次，不能靠它当首次写入。
    if (rows.length > 0) await this.options.messages.upsertMany(rows);
  }

  /**
   * 排队落地的那些用户消息 → 素材关系行（F-H7）。
   *
   * 调用点是 {@link persistLandedQueued} 里紧跟着行写入的那一步：外键方向决定了只能「先写行、
   * 再记关系」（`conversation_assets.messageId` 指着 `messages.id`）。放到收尾就算晚了 ——
   * 那时这条消息已经该在库里了。
   *
   * 失败不当成这一轮的失败（消息已经发出去了）：记不下来只是引用计数少一行，删字节会晚一步。
   */
  private async linkQueuedAssets(landed: readonly AgentNS.Message[]): Promise<void> {
    const link = this.options.linkMessageAssets;
    if (!link) return;
    for (const message of landed) {
      const content = this.queuedStored.get(message.id);
      // 只有排队进来的那些在 `queuedStored` 里（主消息走受理那一处，不在这里重记一遍）
      if (content === undefined) continue;
      try {
        await link({ conversationId: this.conversationId, messageId: message.id, content });
      } catch (error) {
        this.options.onError?.(error, "link-queued-assets");
      }
    }
  }

  /** 本轮 core 追加过的消息（按先后顺序；被 core 整段替换掉的就不在里面了） */
  private producedMessages(): AgentNS.Message[] {
    if (this.detached) return this.detached;
    const messages = this.agent?.messages ?? [];
    const byId = new Map(messages.map((message) => [message.id, message]));
    const produced: AgentNS.Message[] = [];
    for (const id of this.producedIds) {
      const message = byId.get(id);
      if (message) produced.push(message);
    }
    return produced;
  }

  // ---- 用量（PRD F-I5：本轮 / 累计（含子 Agent）/ 速率） ----

  private usageSnapshot(): UsageSnapshot {
    const produced = this.producedMessages();
    const turn = sumUsage(produced);
    // 累计 = 这一轮之前 + 这一轮；子 Agent 的开销在 `subAgentUsage` 里，`sumUsage` 已并入
    const total = addUsage(sumUsage(this.history), turn);
    const subAgent = sumSubAgentUsage([...this.history, ...produced]);

    const elapsedMs = Math.max(0, (this.settledAtMs ?? this.clock.now()) - this.startedAtMs);
    const rate =
      elapsedMs > 0 ? round2(turn.completion_tokens / (elapsedMs / 1000)) : 0;

    return {
      turn,
      total,
      subAgent,
      rate: { value: rate, unit: "tokens_per_second", basis: "completion" },
      updatedAt: this.nowIso(),
    };
  }

  // ---- 快照与推送 ----

  buildRunState(): RunState {
    const settledAt = this.settledAtMs;
    return {
      conversationId: this.conversationId,
      status: settledAt !== null ? "settled" : "running",
      assistantMessageId: this.assistantMessageId,
      // 排队数直接问这一轮的 agent（core 的 `inbox`），不自己另记一份：`abort()` 会清空
      // inbox，另记的数会在那一瞬与真相分叉。收工之后 agent 已经丢了，所以是 0。
      inboxPending: this.agent?.inbox.length ?? 0,
      startedAt: new Date(this.startedAtMs).toISOString(),
      settledAt: settledAt !== null ? new Date(settledAt).toISOString() : null,
      generation: settledAt !== null ? null : this.generation,
      outcome: settledAt !== null ? this.outcome() : null,
      problem: this.problem,
      subagents: this.finalizedSubagents(),
      usage: this.usageSnapshot(),
    };
  }

  private pushRunState(): void {
    this.options.emit("run.state", {
      conversationId: this.conversationId,
      run: this.buildRunState(),
      at: this.nowIso(),
    });
  }

  /** 结算时还没跑完的子 Agent：这一轮中止了就记 aborted，否则记 error（没有「悄悄消失」这一档） */
  private finalizedSubagents(): SubAgentSnapshot[] {
    const settled = this.settledAtMs !== null;
    const items = [...this.subagents.values()];
    if (!settled) return items;
    for (const item of items) {
      if (item.status !== "running") continue;
      item.status = this.aborted || this.handle.aborted ? "aborted" : "error";
      item.finishedAt = item.finishedAt ?? this.nowIso();
    }
    return items;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

/** 六态里「正在拼的工具调用」：从 core 正在拼的消息上取，参数长度给出一个可见的进度 */
function assemblingToolCalls(receiver: AgentNS.Message): AssemblingToolCall[] {
  return (receiver.tool_calls ?? []).map((toolCall) => ({
    toolCall,
    argumentsChars: toolCall.function?.arguments?.length ?? 0,
  }));
}

/** 两个六态快照是不是「同一件事」（只比对外有意义的那些事实） */
function sameGeneration(a: GenerationState, b: GenerationState): boolean {
  if (a.phase !== b.phase) return false;
  // 在想 / 在输出：字符数逐片在长，但那件事本身没变（增量已经逐片推过了）
  if (a.phase === "assembling_tool_calls" && b.phase === "assembling_tool_calls") {
    return toolListKey(a.toolCalls.map((item) => item.toolCall)) ===
      toolListKey(b.toolCalls.map((item) => item.toolCall));
  }
  if (a.phase === "awaiting_tools" && b.phase === "awaiting_tools") {
    return toolListKey(a.runningTools.map((item) => item.toolCall)) ===
      toolListKey(b.runningTools.map((item) => item.toolCall));
  }
  return true;
}

function toolListKey(toolCalls: readonly AgentNS.ToolCall[]): string {
  return toolCalls.map((toolCall) => toolKey(toolCall)).join("|");
}

/** 子 Agent 的名字：SDK 的 `SdkAgent` 带定义，core 的 `Agent` 没有，认不出来就退回通用名 */
function subAgentName(agent: { messages: AgentNS.Message[] }): string {
  const definition = (agent as { definition?: { name?: string } }).definition;
  return definition?.name ?? "sub-agent";
}

/** 子 Agent 失败时给人看的原因：最后一条 error 消息的正文 */
function lastErrorText(messages: readonly AgentNS.Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.status !== AgentNSValue.MessageStatus.Error) continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((section) => ("text" in section ? section.text : ""))
        .join(" ")
        .trim();
      if (text) return text;
    }
    return "error";
  }
  return "error";
}

/** 子 Agent 贡献的用量：`subAgentUsage` 一栏（含孙级，core 的委派路径会累加） */
function sumSubAgentUsage(messages: readonly AgentNS.Message[]): AgentNS.Usage {
  let total: AgentNS.Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const message of messages) {
    if (message.subAgentUsage) total = addUsage(total, message.subAgentUsage);
  }
  return total;
}

/** 宿主分配 id 的缺省实现（Node 19+ 有 `crypto.randomUUID`） */
function defaultNewId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// ChatRunner
// ---------------------------------------------------------------------------

export class ChatRunner {
  private readonly options: ChatRunnerOptions;
  private readonly clock: Clock;
  /**
   * 正在跑的轮次（对话 id → 那一轮的现场）。
   *
   * 存的是**这一轮自己的内存对象**（`TurnSession` 就是 `ChatTurn` 的另一半：受理与执行是
   * 同一件事），供 `conversation.state` 拿到流中的六态与用量，也供跑中发送找那一轮的 inbox；
   * 「有没有在跑」仍然只问 `RunRegistry.isRunning`，两张表不由这里合并。
   */
  private readonly turns = new Map<string, TurnSession>();

  constructor(options: ChatRunnerOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
  }

  /** 宿主分配消息 id（PRD L6）：缺省 `crypto.randomUUID`，测试可注入递增 id */
  private newId(): string {
    return (this.options.newId ?? defaultNewId)();
  }

  /** 缺省的 agent 工厂（不注入 `createAgent` 时用）：按 SDK 口径装配，交接服务来自 `handoff` */
  private agentFactory(): AgentFactory {
    return this.options.createAgent ?? createSdkAgentFactory({ handoff: this.options.handoff });
  }

  /**
   * 受理一轮：占位、落两条消息、把执行放到后台，然后把两个 id 还给调用方（PRD L6 / F-I12）。
   *
   * 忙即拒（`HostError("busy")`，D14）；对话不存在则 `not_found`。任何一种失败都不会
   * 留下一个占着不动的轮次，也不会让 Scope 的依赖计数多算一次。
   */
  async run(params: ChatRunParams): Promise<ChatTurn> {
    const { conversationId } = params;
    const handle = this.options.runs.start(conversationId);
    const language = params.language ?? this.options.defaultLanguage ?? DEFAULT_LANGUAGE;

    let workspaceId: string | undefined;
    let session: TurnSession | undefined;
    try {
      const conversation = await this.options.conversations.get(conversationId);
      if (!conversation) {
        throw new HostError("not_found", { params: { entity: "conversation" } });
      }
      workspaceId = conversation.workspaceId;
      const scope = await this.options.scopes.acquire(workspaceId);

      // 装载即修复：上一次进程如果是在写的时候没的，这里把在途消息修成可继续的状态
      const stored = await this.reconcile(conversationId);
      const history = await this.resolveHistory(
        conversationId,
        stored.messages,
        conversation.modelId,
      );
      const prepared = await this.prepare(params, conversation);

      const nowMs = this.clock.now();
      const acceptedAt = new Date(nowMs).toISOString();
      const userId = this.newId();
      const assistantId = this.newId();

      // 用户消息与助手占位都在请求返回之前落库（L6：客户端拿着这两个 id 接流）。
      // 用户消息存的是 `__asset_id` 形态（`storedContent`），不是这一次发送的产物
      await this.options.messages.upsertMany([
        {
          id: userId,
          conversationId,
          role: AgentNSValue.Role.User as string,
          status: AgentNSValue.MessageStatus.Completed as string,
          omit: false,
          content: (prepared.storedContent ?? prepared.content) as unknown as MessageUpsertInput["content"],
          data: null,
          createdAt: nowMs,
        },
        {
          id: assistantId,
          conversationId,
          role: AgentNSValue.Role.Assistant as string,
          status: AgentNSValue.MessageStatus.Pending as string,
          omit: false,
          content: null,
          data: null,
          createdAt: nowMs,
        },
      ]);

      // 用户消息刚落库：把 content 里的 `__asset_id` 记成关系行（同一 message+asset 只一行）
      await this.linkMessageAssets(conversationId, userId, prepared.storedContent ?? prepared.content);

      session = new TurnSession(this.options, {
        conversation,
        scope,
        createAgent: this.agentFactory(),
        history,
        content: prepared.content,
        ...(prepared.storedContent === undefined ? {} : { storedContent: prepared.storedContent }),
        attachments: prepared.attachments,
        userMessageId: userId,
        assistantMessageId: assistantId,
        handle,
        language,
        acceptedAt,
        startedAtMs: nowMs,
        onSettled: () => {
          this.turns.delete(conversationId);
        },
      });
    } catch (error) {
      this.options.runs.finish(conversationId);
      if (workspaceId !== undefined) this.options.scopes.release(workspaceId);
      throw error;
    }

    // 受理完成：执行交给后台，事件从这一刻起会陆续推给在线客户端
    this.turns.set(session.conversationId, session);
    void session.execute();
    return session;
  }

  /**
   * 历史装载完之后的第一件事情：把里面的 `__asset_id` 还原成当前模型能吃的段（F-H7）。
   *
   * 还原失败不让整轮发不出去：打一条日志、带着原样的历史继续。
   */
  private async resolveHistory(
    conversationId: string,
    messages: AgentNS.Message[],
    modelId: string | null,
  ): Promise<AgentNS.Message[]> {
    const resolve = this.options.prepareHistory;
    if (!resolve) return messages;
    try {
      return await resolve({ conversationId, modelId, messages });
    } catch (error) {
      this.options.onError?.(error, "还原历史里的素材引用失败");
      return messages;
    }
  }

  /**
   * 用户消息落库之后登记素材关系行（`conversation_assets`）。
   *
   * 记不下来不让这一轮失败（消息已经发出去了）：打一条日志继续 —— 后果只是这份素材的
   * 引用计数少一行，删字节会晚一步。
   */
  private async linkMessageAssets(
    conversationId: string,
    messageId: string,
    content: AgentNS.MessageContent | undefined,
  ): Promise<void> {
    const link = this.options.linkMessageAssets;
    if (!link) return;
    try {
      await link({ conversationId, messageId, content });
    } catch (error) {
      this.options.onError?.(error, "登记消息的素材引用失败");
    }
  }

  /** 这一段对话正在跑的那一轮（没有就 `undefined`）：拉现场用 */
  turn(conversationId: string): ChatTurn | undefined {
    return this.turns.get(conversationId);
  }

  /**
   * 把一句用户输入排进**正在跑的那一轮**（PRD D3：跑中发送不打断、也不拒）。
   *
   * 返回 `null` 表示「这一段对话现在没有能排进去的一轮」：没在跑（`turns` 里没有这一段的
   * 现场）、刚登记轮次而 agent 还没装上且等超了上界（`QUEUE_READY_TIMEOUT_MS`）、或者这一轮
   * 已经跑完正在收尾。调用方拿到 `null` 就回老路径（`run()`）—— 于是「空闲时发送」与
   * 「刚好跑完时发送」都走老路，只有真正在跑的时候才排队。
   *
   * ## 为什么入队这件事长在 `ChatRunner` 上，而不是让接线层直接摸 agent
   *
   * 附件准备（F-H7 的选路，可能要上传厂商文件）、消息 id 的口径、落库那一份内容、
   * `run.state` 推送 —— 全都在这一层。接线层只该拿到一份回执，再由它翻译成契约形状。
   *
   * ## 顺序是刻意的：先等得进来，再做附件准备
   *
   * 附件准备可能是这几步里最慢的一跳（厂商 Files API）。放在「等 agent 装上」之前做，等于
   * 让一个马上就要结束的轮次陪着我们上传一遍。代价是：真到了「等完发现这一轮已经收工」时，
   * 老路径会把附件再准备一次 —— 罕见，且素材层自己按 sha256 / 厂商 file_id 缓存，重复一次
   * 不产生额外副作用。
   */
  async enqueue(params: ChatRunParams): Promise<QueuedTurn | null> {
    const { conversationId } = params;
    const turn = this.turns.get(conversationId);
    if (!turn) return null;

    // 装配期间来的那几句在这里等（有界）：等到 agent 装上，或者这一轮先收工/被叫停
    if (!(await turn.waitEnqueueable(QUEUE_READY_TIMEOUT_MS))) return null;

    const conversation = await this.options.conversations.get(conversationId);
    if (!conversation) return null;

    const prepared = await this.prepare(params, conversation);
    return turn.enqueue({
      content: prepared.content,
      attachments: prepared.attachments,
      ...(prepared.storedContent === undefined ? {} : { storedContent: prepared.storedContent }),
    });
  }

  /** 中止（转发给 `RunRegistry`：中止的唯一入口在那里） */
  abort(conversationId: string, reason?: string): boolean {
    return this.options.runs.abort(conversationId, reason);
  }

  /**
   * 对话（或它所在的项目）被删之后，把这一轮的内存现场丢掉。
   *
   * 正在跑的那一轮会先被要求停下，再等它自己结算写库（删对话的人已经先确认过代价）。
   */
  forget(conversationId: string): void {
    const turn = this.turns.get(conversationId);
    turn?.abort("conversation removed");
    this.turns.delete(conversationId);
  }

  /**
   * 装载/重启后修复（PRD D15）。
   *
   * 两步：
   *   1. 在途（`pending` / `writing`）消息当作被中断 —— 进程是在写它们的时候没的；
   *   2. 交 core 的两支归一：工具轮次 `fill`（整轮进出，补上未完成的原因）、
   *      被中断的 assistant `keep`（已输出的内容留在上下文里，模型下一轮能接着半截说）。
   *
   * 只写回状态/`omit` 真的变了的那些行，于是「启动时扫一遍」不会把整段历史重写一次。
   */
  async reconcile(conversationId: string): Promise<ReconcileResult> {
    // 历史要连 `hidden` 的一起取：那些消息只是不给人看，模型下一轮照样得看到它们
    // （会话创建时那条 cwd 消息、交接摘要）
    const rows = await this.options.messages.listByConversation(conversationId, undefined, {
      includeHidden: true,
    });
    const messages = rows.map(fromRow);

    for (const message of messages) {
      if (
        message.status === AgentNSValue.MessageStatus.Pending ||
        message.status === AgentNSValue.MessageStatus.Writing
      ) {
        message.status = AgentNSValue.MessageStatus.Aborted;
      }
    }

    reconcileAbortedToolRounds(messages, "fill");
    reconcileAbortedMessages(messages, "keep");

    const changed: MessageUpsertInput[] = [];
    messages.forEach((message, index) => {
      const row = rows[index];
      if (!row) return;
      if (row.status === message.status && row.omit === (message.omit === true)) return;
      changed.push(toRow(message, conversationId, row.createdAt));
    });
    if (changed.length > 0) await this.options.messages.upsertMany(changed);

    return { messages, repairedIds: changed.map((row) => row.id) };
  }

  private async prepare(
    params: ChatRunParams,
    conversation: Conversation,
  ): Promise<AttachmentPreparation> {
    const prepare = this.options.prepareAttachments;
    if (!prepare) {
      // 没有注入素材转换：`assetIds` 原样不处理，内容照客户端给的发（事实在 `attachments` 里给空）
      return { content: params.input.content, attachments: [] };
    }
    return prepare({
      conversationId: conversation.id,
      agentId: conversation.agentId,
      modelId: conversation.modelId,
      input: params.input,
    });
  }
}

// ---------------------------------------------------------------------------
// 真实工厂：按 SDK 口径装配 agent（含硬线、孙级递归、交接线）
// ---------------------------------------------------------------------------

export interface SdkAgentFactoryOptions {
  /**
   * 交接服务（写交接文档 + 迁移）。给了才装交接线插件（`AutoMigratePlugin`）；
   * 交接服务自己会在交接回合往 agent 上装工具守卫。
   */
  handoff?: HandoffProvider;
  /**
   * 工具刷新时机；缺省读 SDK 配置的 `autoRefreshTools`，再缺省 `inner-loop-start`。
   *
   * 取值直接用 SDK `AppConfig` 里那一字段的类型，不在这里再定义一份（`off` 表示不装插件）。
   */
  autoRefreshTools?: AppConfig["autoRefreshTools"];
  /**
   * 思考策略表（档位名 → 参数补丁）的现读入口。
   *
   * 装配是异步的，所以这里给一个取快照的函数而不是快照本身：接线层在配置变更后会重新
   * 读一次表（`refreshThinkingPresets`），拿旧快照会把已删掉的档位展开成空补丁。
   */
  thinkingPresets?: () => ReasoningPresets | null;
}

/**
 * 这一段会话该带哪些模型参数（PRD F-B6）。
 *
 * 两件事合在这里：
 *   1. 助手定义上的 `modelParams`（用户给这个助手配的参数，也是「跟随默认」所指的那份）；
 *   2. 会话行上的思考档位展开出的补丁（档位名 → 参数），盖在 1 上面。
 *
 * 只在「会话定的模型就是助手定义那个模型」时才叠上 1：会话把模型换掉之后，定义上那份参数
 * 是配给旧模型的（可能带着旧模型才认的键），发给新模型只会换来一句 400。换模型时档位会被
 * 清空，所以那之后这里通常什么都不带，让模型走自己的出厂参数。
 */
export function conversationModelParams(input: {
  /** 会话行上的模型（从 `scope.config` 里找到的那个；找不到时为空） */
  model: Model | undefined;
  /** 助手定义上的模型 id（未绑定时为 `undefined`） */
  agentModelId: string | undefined;
  /** 配置里的兜底模型（`AppConfig.defaultModel`） */
  defaultModelId: string | undefined;
  /** 助手定义上的参数（`AgentDefinition.modelParams`） */
  agentParams: ModelParams | undefined;
  /** 会话行上的思考档位名；`null` = 跟随助手定义 */
  thinkingLevel: string | null;
  presets: ReasoningPresets | null;
}): ModelParams | undefined {
  const agentModelId = input.agentModelId ?? input.defaultModelId;
  const sameModel = input.model !== undefined && input.model.id === agentModelId;
  const base = sameModel ? input.agentParams : undefined;

  const patch = thinkingPatchOf(input.model, input.thinkingLevel, input.presets);
  if (!patch) return base;
  return { ...(base ?? {}), ...patch };
}

/** 档位名 → 参数补丁（模型没配策略表、表里没这个档、或没选档位时都是 `undefined`） */
function thinkingPatchOf(
  model: Model | undefined,
  thinkingLevel: string | null,
  presets: ReasoningPresets | null,
): ModelParams | undefined {
  if (!model || thinkingLevel === null || !presets) return undefined;
  const presetName = model.reasoningPreset;
  if (!presetName) return undefined;
  const preset = presets[presetName];
  if (!preset || !Object.prototype.hasOwnProperty.call(preset.levels, thinkingLevel)) {
    return undefined;
  }
  return preset.levels[thinkingLevel];
}

/**
 * 读一次助手定义（只为拿它绑定哪个模型、带哪些参数）。
 *
 * SDK 的 `createAgent` 自己也会读一次定义；这里多这一遍是因为会话档位展开的参数要叠在
 * 定义那份参数上，而只有定义在手才知道该叠什么。读不出来就当作没有（真正的报错由
 * `createAgent` 那句给出）。
 */
async function readAgentDefinition(
  context: AgentBuildContext,
): Promise<AgentDefinition | null> {
  try {
    return await new AgentRepository(context.scope.agentsDir).read(context.agentId);
  } catch {
    return null;
  }
}

/**
 * 造一个按 SDK 口径装配的 agent 工厂。
 *
 * 装的东西与阈值来源（PRD D27：阈值属 SDK 的 `AppConfig` / 模型配置，不在这里另起一套）：
 *   - `ContextGuardPlugin`：硬线，`tokenThresholds.guard`；
 *   - `SubAgentGuardInstallerPlugin`：同一个硬线递归装到子 Agent 与孙级（PRD F-D8）；
 *   - `AutoMigratePlugin`：交接线，`tokenThresholds.handoff`（需注入交接服务）；
 *   - `AutoRefreshToolsPlugin`：改完能力不用重启（PRD F-E2）；
 *   - `UnknownToolHintPlugin`：未知工具时给出 MCP 场景的引导。
 */
export function createSdkAgentFactory(options: SdkAgentFactoryOptions = {}): AgentFactory {
  return async (context: AgentBuildContext): Promise<ChatAgent> => {
    // 会话行上的模型就是这一轮的模型（`conversation.setModel` 写的就是它），
    // 再往下的三级解析（助手定义 → 全局兜底）仍由 SDK 那一处算
    const modelId = context.modelId ?? undefined;
    const sessionModel = context.scope.config.models.find(
      (candidate) => candidate.id === modelId,
    );
    const definition = await readAgentDefinition(context);
    const agent = await createAgent(context.scope, context.agentId, {
      modelId,
      modelParams: conversationModelParams({
        model: sessionModel,
        agentModelId: definition?.modelId,
        defaultModelId: context.scope.config.defaultModel,
        agentParams: definition?.modelParams,
        thinkingLevel: context.thinkingLevel,
        presets: options.thinkingPresets?.() ?? null,
      }),
    });

    // 生效的模型写在 `agent.definition.modelId` 上（SDK 三级解析之后的那一份）
    const model = context.scope.config.models.find(
      (candidate) => candidate.id === agent.definition.modelId,
    );
    const thresholds = model?.tokenThresholds;
    const handoff = options.handoff?.(context);
    // 交接回合本身就是上下文最满的时刻：硬线要对它让行，否则「交接触发拦截 → 拦截又触发交接」
    const isSuspended = handoff ? () => handoff.busy : undefined;

    if (thresholds) {
      agent.use(new ContextGuardPlugin({ guardTokens: thresholds.guard, isSuspended }));
      agent.use(
        new SubAgentGuardInstallerPlugin({ guardTokens: thresholds.guard, isSuspended }),
      );
      if (handoff) {
        agent.use(
          new AutoMigratePlugin({
            service: handoff,
            handoffTokens: thresholds.handoff,
            // R59 / PRD §5：宿主不替用户决定「要不要迁移」——问用户的是
            // `QuestionService.askHandoff`（一轮结算之后），这里一律跳过本次迁移。
            resolveMode: () => null,
          }),
        );
      }
    }

    const refreshWhen =
      options.autoRefreshTools ??
      context.scope.config.autoRefreshTools ??
      "inner-loop-start";
    if (refreshWhen !== "off") {
      agent.use(new AutoRefreshToolsPlugin({ when: refreshWhen }));
    }

    agent.use(new UnknownToolHintPlugin({ scope: context.scope }));

    // 插件在 send 之前 init（例如工具刷新插件的首次准备）
    await agent.init();
    return agent;
  };
}
