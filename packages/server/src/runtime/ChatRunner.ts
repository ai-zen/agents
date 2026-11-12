/**
 * `ChatRunner` —— 一轮对话的执行者（architecture §4 那张时序）。
 *
 * ## 一轮的骨架
 *
 * ```
 * RunRegistry.start（忙即拒，PRD D14）
 *   → 借 Scope（ScopeRegistry.acquire：懒创建或复用，依赖 +1）
 *   → 分配两个消息 id 并落库（用户消息 + 助手占位，PRD L6：id 在请求发出前就有）
 *   → 装配 agent（可注入的工厂；跑完即弃，PRD D28）
 *   → 流式：每片增量推 `message.delta`；同一时刻更新六态并推 `run.state`；同一条消息边流边写（D15）
 *   → 内循环结束：写一次最终版（F-C2）→ 释放 agent → RunRegistry.finish → ScopeRegistry.release
 *   → 推结算态 `run.state` + `usage`
 * ```
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
 * 消息 id 由服务端分配（PRD L6），而 assistant 占位是 core 在 `run()` 里自己 `append` 的
 * （它的 `Message` 构造会自己生成 id）。所以本文件在 `message` 事件里把「这一轮头两条」认领成
 * 服务端已经发给客户端的 id —— 客户端的 `message.delta` 与 `message.list` 才接得上同一条消息。
 * 后续工具轮次里 core 追加的消息同样在这一处被换成服务端分配的 id（`id` 不参与 core 的任何
 * 判断，换掉只会让它对客户端更一致）。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import {
  addUsage,
  AgentNS as AgentNSValue,
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
import { ServerError } from "../wire/errors.js";
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
  /** 事件广播口（core 的 `EventBus`）；本文件只用 `on` */
  events: { on(name: string, handler: (...args: never[]) => void): unknown };
}

/** 把已上传的素材变成真正发出去的内容段（PRD F-H7）；不给就原样用 `input.content` */
export interface AttachmentPreparation {
  /** 真正发给模型的内容（已按实发模型换成文件引用 / 内联 / 文字） */
  content: AgentNS.MessageContent;
  attachments: AttachmentOutcome[];
  /**
   * 落库用的内容（消息里只存我们自己的引用：`asset://<assetId>`）。
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
 * 每轮都要跑一次：能不能吃跟着实发模型 / 端点变，而历史里存的是与端点无关的 `asset://<id>`。
 * 不给就原样把历史交给 agent。
 */
export type AttachmentHistoryResolver = (context: {
  conversationId: string;
  modelId: string | null;
  messages: AgentNS.Message[];
}) => Promise<AgentNS.Message[]>;

/**
 * 「厂商说这个 file 不在了」之后的服务端动作：作废这段对话在那个端点上的缓存，返回删掉的行数。
 *
 * 返回 0 表示没有可作废的东西（本来就没缓存、或解析不出端点），那一轮就不重试了 —— 没有东西
 * 被清掉时重试只是再拿同一个 `file_id` 去撞同一面墙。
 */
export type VendorFileInvalidator = (context: {
  conversationId: string;
  modelId: string | null;
  error: unknown;
}) => Promise<number>;

/** 一轮的入参（`conversation.send` 的 params 去掉 wire 外壳） */
export interface ChatRunParams {
  conversationId: string;
  input: MessageInput;
  /** 这一轮是哪条连接发起的语言（D8；缺省用注入的默认语言） */
  language?: Language;
}

/**
 * 一轮结算之后的事实（R59：交接线问题由服务端自己在这个时机问）。
 *
 * 「到交接线了没有」只在服务端算得出来：`promptTokens` 是这一轮实际用量，`handoffTokens`
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
  /** 服务端分配消息 id；缺省用 `crypto.randomUUID` */
  newId?: () => string;
  /** 边流边写的节流时长（毫秒）；0 表示每到一片就写一次 */
  streamWriteIntervalMs?: number;
  prepareAttachments?: AttachmentPreparer;
  /**
   * 历史里的 `asset://` → 当前模型能吃的段（F-H7）。不给时历史原样交给 agent。
   *
   * 与 `prepareAttachments` 分开两个注入点，是因为它们错在不同时机：一个在受理时算一次，
   * 一个每一次发送（含重试）都要重算。
   */
  prepareHistory?: AttachmentHistoryResolver;
  /**
   * 厂商报「file 不存在/无效」时的自愈口（删缓存 + 重试）。不注入就不重试。
   */
  invalidateVendorFiles?: VendorFileInvalidator;
  /** 这一轮没带语言时用哪种语言渲染服务端注入的那段话（D8） */
  defaultLanguage?: Language;
  /** 一轮结算之后的回调（R59：交接线问题由它触发） */
  onTurnSettled?: (facts: TurnSettledFacts) => void;
  /** 内部错误的去处（写库失败、回收失败等）；缺省忽略 */
  onError?: (error: unknown, context: string) => void;
}

/** 边流边写的缺省节流：200ms 一次，兼顾「客户端断了丢得少」与「写盘次数」 */
export const DEFAULT_STREAM_WRITE_INTERVAL_MS = 200;

// ---------------------------------------------------------------------------
// 六态里那些「每片都要摸一遍」的小工具
// ---------------------------------------------------------------------------

/** core 广播的原始 chunk 里本文件用到的部分（`choices[0].delta` 就是 `AgentNS.Delta`） */
interface RawChunk {
  usage?: AgentNS.Usage;
  choices?: Array<{ delta?: AgentNS.Delta; finish_reason?: string | null }>;
}

/**
 * 这一条错误像不像「厂商说那个 file 不在了」。
 *
 * 这条判断靠错误里的文字（SDK / 厂商给的，各家写法不一样），所以两半都对上才算：说的是「文件」
 * （或 `file_id`），而且给的是「不存在 / 无效 / 已过期」这类结局。只看一半就重试，会变成对任何
 * 报错都重发一遗（额度就是这么烧掉的）。
 */
function looksLikeVendorFileProblem(error: unknown): boolean {
  const text = errorText(error);
  if (text === "") return false;
  const mentionsFile = /\bfile\b|file_id/i.test(text);
  const saysGone = /not\s*found|does\s*not\s*exist|no\s*such|invalid|expired|unknown|deleted|missing/i.test(
    text,
  );
  return mentionsFile && saysGone;
}

/** 任意抛出物 → 一段可搜的文本（错误体里嵌套的 `error.message` 也拿上） */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const body = (error as { error?: unknown }).error;
    return `${error.message} ${typeof body === "object" && body !== null ? JSON.stringify(body) : ""}`;
  }
  return "";
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
 * 目录取的是这个对话所属项目的 cwd（不是进程工作目录）；句子用的是「这是服务端加的，不是
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
  /** 库里装载出来的历史（未还原） */
  rawHistory: AgentNS.Message[];
  /** 还原之后的历史（这一轮第一次尝试用的那份） */
  history: AgentNS.Message[];
  content: AgentNS.MessageContent;
  /** 落库用的内容；不给时就是 `content` */
  storedContent?: AgentNS.MessageContent;
  attachments: AttachmentOutcome[];
  /** 重新备一次发送内容（重试用）：历史与输入都重算一遍 */
  reprepare?: () => Promise<AttachmentPreparation>;
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
  /** 库里装载出来的历史（原样，带 `asset://`）：每轮发送前才按当前模型还原 */
  private readonly rawHistory: AgentNS.Message[];
  /** 还原后的历史（这一轮实际交给 agent 的那份） */
  private history: AgentNS.Message[];
  /** 这一轮发给模型的内容；重试时会被重新备一次（厂商产物变了） */
  private content: AgentNS.MessageContent;
  /** 落库的内容（`asset://` 形态）：重试不改它，它就是用户挂的那几张图 */
  private readonly storedContent: AgentNS.MessageContent;
  private readonly language: Language;
  private readonly handle: RunHandle;
  private readonly options: ChatRunnerOptions;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly startedAtMs: number;
  private readonly onSettled?: () => void;
  /** 重试用的重备口（没有注入时就不重试） */
  private readonly reprepare?: () => Promise<AttachmentPreparation>;

  private resolveDone!: (settlement: TurnSettlement) => void;
  private agent?: ChatAgent;
  private aborted = false;
  private problem: ProblemFact | null = null;
  private settledAtMs: number | null = null;

  /** 已经确认过 id 的消息（历史 + 本轮）；不在里面的会被认领成服务端 id */
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

  private userIdUsed = false;
  private assistantIdUsed = false;
  private streaming?: AgentNS.Message;
  /** 这一次尝试还没产生任何可观测的进展（没流出增量、没落过行）—— 只有在这种时候重试才安全 */
  private cleanAttempt = true;
  /** 结算后 agent 已经被丢掉：把本轮产出留在这里，快照与用量还读得到 */
  private detached?: AgentNS.Message[];
  private generation: GenerationState;
  private writeTimer?: () => void;
  private lastWriteAt = 0;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ChatRunnerOptions, init: TurnSessionInit) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? defaultNewId;
    this.conversation = init.conversation;
    this.conversationId = init.conversation.id;
    this.scope = init.scope;
    this.createAgent = init.createAgent;
    this.rawHistory = init.rawHistory;
    this.history = init.history;
    this.content = init.content;
    this.storedContent = init.storedContent ?? init.content;
    this.reprepare = init.reprepare;
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
    // 两条由服务端预先分配的消息：id 已经是我们的，不再认领
    this.createdAtOf.set(this.userMessageId, this.startedAtMs);
    this.createdAtOf.set(this.assistantMessageId, this.startedAtMs);
  }

  // ---- 对外的两个动作 ----

  abort(reason?: string): void {
    this.handle.abort(reason);
  }

  runState(): RunState {
    return this.buildRunState();
  }

  /** 真正跑一轮。`ChatRunner` 在受理之后立刻叫它，不等结果 */
  async execute(): Promise<void> {
    try {
      this.pushRunState();
      await this.attemptOnce();
    } catch (error) {
      // 厂商说「这个 file 不存在/无效」：把这段对话在那个端点上的缓存作废，再试一次（最多一次）。
      // 作废后下一轮发送自然走到重传；重传还不行，SDK 那条既有选路会自己降级到内联、再退到文本。
      const recovered = await this.retryAfterVendorFileError(error);
      if (!recovered) this.recordFailure(error);
    } finally {
      await this.settle();
    }
  }

  /** 一次尝试（建 agent → 把历史与用户输入发出去）；失败原样上抛，由 `execute` 决定要不要重试 */
  private async attemptOnce(): Promise<void> {
    this.cleanAttempt = true;
    const agent = await this.createAgent({
      conversationId: this.conversationId,
      workspaceId: this.conversation.workspaceId,
      agentId: this.conversation.agentId ?? "",
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
    await agent.send(this.content);
  }

  /**
   * 「file 失效」那条错误的自愈：作废缓存 → 重备内容 → 重跑一次。
   *
   * 只在一次尝试还没产生任何可观测进展时重试（第一个请求就因 file 被拒的情形）：已经流出过增量
   * 或已落过库的那一轮重跑，会在历史里多出一条用户消息，那不是用户做过的事。
   * 返回 `true` 表示“重试过了”，不管重试本身的成败：成败由重试那一趟自己的错误路径管。
   */
  private async retryAfterVendorFileError(error: unknown): Promise<boolean> {
    const invalidate = this.options.invalidateVendorFiles;
    if (!invalidate) return false;
    if (!this.cleanAttempt || this.handle.aborted) return false;
    if (!looksLikeVendorFileProblem(error)) return false;

    let removed = 0;
    try {
      removed = await invalidate({
        conversationId: this.conversationId,
        modelId: this.conversation.modelId,
        error,
      });
    } catch (caught) {
      this.options.onError?.(caught, "作废厂商文件缓存失败");
      return false;
    }
    // 没东西可清：重试只是拿同一个 file_id 再撞一次
    if (removed === 0) return false;

    this.resetForRetry();
    try {
      await this.reprepareContent();
      await this.attemptOnce();
      return true;
    } catch (again) {
      this.recordFailure(again);
      return true;
    }
  }

  /** 重试前把这一轮的内存现场回到「还没开始」：只有历史与两条预先分配的 id 留着 */
  private resetForRetry(): void {
    this.userIdUsed = false;
    this.assistantIdUsed = false;
    this.streaming = undefined;
    this.detached = undefined;
    this.problem = null;
    this.producedIds.length = 0;
    this.deltaSeq.clear();
    this.runningTools.clear();
    this.subagents.clear();
    this.persistedSubAgents.clear();
    this.abortedInFlight.clear();
    this.generation = { phase: "connected", since: this.acceptedAt };
  }

  /** 重算这一轮的发送内容：历史与用户输入都按当前模型重新还原/转换一次 */
  private async reprepareContent(): Promise<void> {
    if (!this.reprepare) return;
    const prepared = await this.reprepare();
    this.content = prepared.content;
    this.history = await this.resolveHistory();
  }

  // ---- 装配：把 core 的事件接到本文件 ----

  /** 这一轮交给 agent 的历史（`asset://` 已还原成当前模型能吃的段） */
  private async resolveHistory(): Promise<AgentNS.Message[]> {
    const resolve = this.options.prepareHistory;
    if (!resolve) return this.rawHistory;
    try {
      return await resolve({
        conversationId: this.conversationId,
        modelId: this.conversation.modelId,
        messages: this.rawHistory,
      });
    } catch (error) {
      // 还原失败不让整轮发不出去：带着库里原样的历史继续（模型最多拿到一句降级说明）
      this.options.onError?.(error, "还原历史里的素材引用失败");
      return this.rawHistory;
    }
  }

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
  }

  /** core 追加了一条消息：认领 id、记时间、更新六态里那些跟消息有关的部分 */
  private onMessage(message: AgentNS.Message): void {
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
   * 认领 id：这一轮的头两条（用户消息、助手占位）用服务端已经发给客户端的 id，
   * 之后 core 追加的每一条各自要一个新 id（id 由服务端分配，PRD L6）。
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
    // 已经流出内容了：这一轮不能整轮重跑（重跑会在历史里多一条用户消息）
    this.cleanAttempt = false;

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

    const running = this.runningTools.get(toolKey(ctx.toolCallContext.tool_call));
    if (running) running.subagent = snapshot;
    this.pushRunState();
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
   * 同一次委派只落一遍（`sub-agent-end` 重复到达时不重复写）；每条都拿服务端分配的 id（L6），
   * 挂上 `parentToolCallId`，`seq` 由仓储在对话内递增。
   */
  private persistSubAgent(toolCallId: string, messages: readonly AgentNS.Message[]): number {
    if (this.persistedSubAgents.has(toolCallId)) return messages.length;
    this.persistedSubAgents.add(toolCallId);
    const now = this.clock.now();
    const rows = messages.map((message) => {
      const id = this.newId();
      this.createdAtOf.set(id, now);
      return toRow({ ...message, id }, this.conversationId, now, undefined, toolCallId);
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
    // 已经落过行了：这一轮不能整轮重跑
    this.cleanAttempt = false;
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

    const outcome = this.outcome();
    const produced = this.producedMessages();

    try {
      await this.flushWrites();
      await this.persistFinal(outcome, produced);
    } catch (error) {
      this.options.onError?.(error, "final-write");
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
      // 落库要的是 `asset://` 那一份：否则库里这条消息就绑死在这次发送所用的端点上了。
      if (message.id === this.userMessageId) {
        row.content = this.storedContent as unknown as MessageUpsertInput["content"];
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

    if (rows.length > 0) await this.options.messages.upsertMany(rows);
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

/** 服务端分配 id 的缺省实现（Node 19+ 有 `crypto.randomUUID`） */
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
   * 存的是**这一轮自己的内存对象**，供 `conversation.state` 拿到流中的六态与用量；
   * 「有没有在跑」仍然只问 `RunRegistry.isRunning`，两张表不由这里合并。
   */
  private readonly turns = new Map<string, ChatTurn>();

  constructor(options: ChatRunnerOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
  }

  /** 服务端分配消息 id（PRD L6）：缺省 `crypto.randomUUID`，测试可注入递增 id */
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
   * 忙即拒（`ServerError("busy")`，D14）；对话不存在则 `not_found`。任何一种失败都不会
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
        throw new ServerError("not_found", { params: { entity: "conversation" } });
      }
      workspaceId = conversation.workspaceId;
      const scope = await this.options.scopes.acquire(workspaceId);

      // 装载即修复：上一次进程如果是在写的时候没的，这里把在途消息修成可继续的状态
      const stored = await this.reconcile(conversationId);
      const rawHistory = stored.messages;
      const prepared = await this.prepare(params, conversation);
      const history = await this.resolveHistory(conversationId, rawHistory, conversation.modelId);

      const nowMs = this.clock.now();
      const acceptedAt = new Date(nowMs).toISOString();
      const userId = this.newId();
      const assistantId = this.newId();

      // 用户消息与助手占位都在请求返回之前落库（L6：客户端拿着这两个 id 接流）。
      // 用户消息存的是 `asset://` 形态（`storedContent`），不是这一次发送的产物
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

      session = new TurnSession(this.options, {
        conversation,
        scope,
        createAgent: this.agentFactory(),
        rawHistory,
        history,
        content: prepared.content,
        ...(prepared.storedContent === undefined ? {} : { storedContent: prepared.storedContent }),
        attachments: prepared.attachments,
        // 重试用：重新备一次发送内容与历史（厂商 file_id 已经被作废的那一批）
        reprepare: async () => await this.prepare(params, conversation),
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
   * 历史装载完之后的第一件事情：把里面的 `asset://` 还原成当前模型能吃的段（F-H7）。
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

  /** 这一段对话正在跑的那一轮（没有就 `undefined`）：拉现场用 */
  turn(conversationId: string): ChatTurn | undefined {
    return this.turns.get(conversationId);
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
      agentId: conversation.agentId ?? "",
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
            // R59 / PRD §5：服务端不替用户决定「要不要迁移」——问用户的是
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
