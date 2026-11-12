/**
 * `conversation.*`：一段对话的身份、历史与一轮的运行。
 *
 * 这里只做「参数 → 交给服务/运行时 → 把结果翻译成契约形状」。业务判断在
 * `ConversationService` 与 `ChatRunner` 里：比如「忙就拒」在 `RunRegistry`、
 * 「模型解析不出来」在服务层，本文件不重新判断一遍。
 *
 * 唯一在接线层做的拼装是 `conversation.state` 的现场快照：它要把三处事实合起来
 * （服务层给的视图、运行时给的这一轮、库里消息求和的用量），而这三样分别属于三个持有者，
 * 只有接线层同时看得见它们。
 */

import { addUsage, sumUsage, ZERO_USAGE } from "@ai-zen/agents-core";
import type { AgentNS } from "@ai-zen/agents-core";
import type { AppConfig } from "@ai-zen/agents-sdk";

import type { Language } from "../i18n/index.js";
import type { HandlerTable } from "../net/index.js";
import type { ChatRunner } from "../runtime/index.js";
import type { AssetService } from "../services/AssetService.js";
import type { ConversationService } from "../services/ConversationService.js";
import type { MessageService } from "../services/MessageService.js";
import type {
  ContextState,
  ConversationAbortParams,
  ConversationAbortResult,
  ConversationDeleteParams,
  ConversationDeleteResult,
  ConversationSendParams,
  ConversationSendResult,
  ConversationState,
  ConversationStateParams,
  ConversationStateResult,
  RunState,
  UsageSnapshot,
} from "../wire/index.js";
import { localizeOutcome } from "./assetHandlers.js";

/** `conversation.*` 的实现要的持有者 */
export interface ConversationHandlerDeps {
  conversations: ConversationService;
  messages: MessageService;
  /** 素材挂接与文件清理（`conversation.send` / `conversation.delete` 用） */
  assets: AssetService;
  /** 一轮的执行者（受理、现场、中止、忘掉） */
  runner: ChatRunner;
  /** 读配置：上下文阈值跟着模型走（PRD F-D1） */
  readConfig: () => Promise<AppConfig>;
  /** 刷新思考档位表快照（`setThinking` 之前调一次：改完读回的参数要用当前表） */
  refreshThinkingPresets: () => Promise<void>;
  /** 时钟（ISO 8601 时间戳） */
  now: () => string;
  /** 一轮结算之后的通知点：单根据此重算退出判据 */
  onTurnSettled: () => void;
}

/**
 * 注册 `conversation.*`。
 *
 * `conversation.transient`（临时对话，PRD D3）不在这一批：它要走一条不落库的执行路径，
 * 归 W4。没注册的方法由接线层回 `unsupported`（裁定 R11）。
 */
export function createConversationHandlers(deps: ConversationHandlerDeps): HandlerTable {
  return {
    "conversation.list": async (context) => await deps.conversations.list(context.params),
    "conversation.create": async (context) => await deps.conversations.create(context.params),
    "conversation.get": async (context) => await deps.conversations.get(context.params),
    "conversation.rename": async (context) => await deps.conversations.rename(context.params),
    "conversation.pin": async (context) => await deps.conversations.pin(context.params),
    "conversation.revert": async (context) => await deps.conversations.revert(context.params),
    "conversation.setModel": async (context) => await deps.conversations.setModel(context.params),

    "conversation.delete": async (context) => await removeConversation(deps, context.params),

    "conversation.send": async (context) =>
      await sendTurn(deps, context.params, context.connection.language),

    "conversation.state": async (context) => ({
      state: await conversationStateOf(deps, context.params.conversationId),
    }),

    "conversation.abort": async (context) => await abort(deps, context.params),

    "conversation.setThinking": async (context) => {
      // 档位表先刷新一次再改：改完读回的「展开后的参数」要用当前表
      await deps.refreshThinkingPresets();
      return await deps.conversations.setThinking(context.params);
    },
  };
}

// ---------------------------------------------------------------------------
// 跨层补齐
// ---------------------------------------------------------------------------

/**
 * `conversation.send`：受理一轮，把素材挂到落库后的那条用户消息上（PRD L6 / F-I12 / D5）。
 *
 * 附件结局里的句子是素材层按默认语言渲染的（那一层不知道收件人是谁），这里按**这条连接**的
 * 语言重渲染一次再出网（D8：库里只留码与参数）。
 */
async function sendTurn(
  deps: ConversationHandlerDeps,
  params: ConversationSendParams,
  language: Language,
): Promise<ConversationSendResult> {
  const turn = await deps.runner.run({ conversationId: params.conversationId, input: params.input });

  const assetIds = params.input.assetIds ?? [];
  if (assetIds.length > 0) {
    // 上传早于消息落库：受理之后立刻把素材行挂到那条用户消息上
    await deps.assets.linkToMessage(assetIds, turn.userMessageId);
  }

  // 这一轮可能是最后一件欠着的事：结算之后让单根重算一次退出判据
  void turn.done.then(
    () => deps.onTurnSettled(),
    () => deps.onTurnSettled(),
  );

  return {
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.assistantMessageId,
    attachments: turn.attachments.map((outcome) => localizeOutcome(outcome, language)),
    acceptedAt: turn.acceptedAt,
  };
}

/**
 * `conversation.delete`：删掉这段对话，再补齐两件只有接线层知道的事（R33）。
 *
 *   1. 运行时里这一轮的现场要丢掉（`ChatRunner.forget`：正在跑就先让它停）；
 *   2. `assets/` 下的文件按引用清掉（服务层只算清单，删文件是素材层的事）。
 */
async function removeConversation(
  deps: ConversationHandlerDeps,
  params: ConversationDeleteParams,
): Promise<ConversationDeleteResult> {
  const report = await deps.conversations.delete(params);
  if (params.dryRun !== true && report.removed) {
    deps.runner.forget(params.conversationId);
    await deps.assets.removeFiles(report.assetPaths);
  }
  return { removed: report.removed, consequences: report.consequences };
}

/**
 * `conversation.abort`：中止走 `RunRegistry`（`ChatRunner` 只是把它转发出去）。
 *
 * `aborted: false` 表示本来就没在跑 —— 那不是错误。回包同时带上中止之后的运行状态，
 * 客户端不必再拉一次现场就能把界面收回去。
 */
async function abort(
  deps: ConversationHandlerDeps,
  params: ConversationAbortParams,
): Promise<ConversationAbortResult> {
  const aborted = deps.runner.abort(params.conversationId, params.reason);
  return { aborted, run: await runStateOf(deps, params.conversationId) };
}

// ---------------------------------------------------------------------------
// 现场快照
// ---------------------------------------------------------------------------

/** 这一轮现在的运行状态；没有在跑的一轮时是「空闲」（`state` 与 `abort` 共用） */
async function runStateOf(
  deps: ConversationHandlerDeps,
  conversationId: string,
): Promise<RunState> {
  const turn = deps.runner.turn(conversationId);
  if (turn) return turn.runState();
  const page = await deps.messages.list({ conversationId });
  return idleRunState(conversationId, usageOfMessages(page.messages, deps.now()));
}

/**
 * 一段对话的现场（PRD L5：重连先拉状态）。
 *
 * 拼装顺序：视图（身份 / 思考档 / 目录）→ 运行状态（在跑就用这一轮自己的快照）→
 * 用量（在跑用这一轮，空闲就用库里消息求和）→ 上下文阈值（跟着模型走）。
 *
 * 两处暂时是空数组，因为它们的持有者还没来：`questions`（问题对象归 W4-H）、
 * `statusBlocks`（状态栏的块归 W4，PRD F-I6）。
 */
async function conversationStateOf(
  deps: ConversationHandlerDeps,
  conversationId: string,
): Promise<ConversationState> {
  const now = deps.now();
  const { conversation } = await deps.conversations.get({ conversationId });
  const turn = deps.runner.turn(conversationId);
  const page = await deps.messages.list({ conversationId });
  const usage = turn ? turn.runState().usage : usageOfMessages(page.messages, now);
  const config = await deps.readConfig();
  const model = config.models.find((item) => item.id === conversation.model.modelId);

  return {
    conversationId,
    run: turn ? turn.runState() : idleRunState(conversationId, usage),
    context: contextOf(page.messages, model),
    thinking: conversation.thinking,
    usage,
    questions: [],
    statusBlocks: [],
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 纯函数：把几处事实拼成契约形状
// ---------------------------------------------------------------------------

/** 空闲的现场：没有在跑的一轮，但历史用量还在 */
export function idleRunState(conversationId: string, usage: UsageSnapshot): RunState {
  return {
    conversationId,
    status: "idle",
    assistantMessageId: null,
    startedAt: null,
    settledAt: null,
    generation: null,
    outcome: null,
    problem: null,
    subagents: [],
    usage,
  };
}

/**
 * 一批消息的用量快照。
 *
 * `total` 与 `subAgent` 用 core 的口径求和（含子 Agent，与计费同口径）；`turn` 在「没有一轮
 * 在跑」时是零值（没有这一轮这件事，就是零），速率同理。
 */
export function usageOfMessages(
  messages: readonly AgentNS.Message[],
  now: string,
): UsageSnapshot {
  let subAgent: AgentNS.Usage = { ...ZERO_USAGE };
  for (const message of messages) {
    if (message.subAgentUsage) subAgent = addUsage(subAgent, message.subAgentUsage);
  }
  return {
    turn: { ...ZERO_USAGE },
    total: sumUsage(messages),
    subAgent,
    rate: { value: 0, unit: "tokens_per_second", basis: "completion" },
    updatedAt: now,
  };
}

/**
 * 上下文占用：最近一次请求的用量 + 这个模型的两条阈值（PRD F-D1 / D27）。
 *
 * 阈值跟着模型走；模型在配置里被删掉时两条线都是 0（「没有阈值」而不是「阈值为零就超了」）。
 */
export function contextOf(
  messages: readonly AgentNS.Message[],
  model: AppConfig["models"][number] | undefined,
): ContextState {
  let usage: AgentNS.Usage = { ...ZERO_USAGE };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]?.usage;
    if (candidate) {
      usage = candidate;
      break;
    }
  }
  const handoffThreshold = model?.tokenThresholds.handoff ?? 0;
  const guardThreshold = model?.tokenThresholds.guard ?? 0;
  return {
    usage,
    handoffThreshold,
    guardThreshold,
    overHandoff: handoffThreshold > 0 && usage.prompt_tokens >= handoffThreshold,
    overGuard: guardThreshold > 0 && usage.prompt_tokens >= guardThreshold,
  };
}
