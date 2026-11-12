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
 *
 * 一段对话的三处跨界钩子也在这里接（它们分属三个服务，契约里的位置却是同一对方法）：
 *   - `conversation.send` 之前问一句「有挡着的问题吗」（D23）；
 *   - 结算之后起一次自动命名（D2，幂等）；
 *   - `conversation.transient` 走不落库的那条执行路径（R1 / R49）。
 */

import { addUsage, sumUsage, ZERO_USAGE } from "@ai-zen/agents-core";
import type { AgentNS } from "@ai-zen/agents-core";
import type { AppConfig } from "@ai-zen/agents-sdk";

import { render } from "../i18n/index.js";
import type { Language, MessageKey } from "../i18n/index.js";
import type { HandlerTable } from "../net/index.js";
import type { ChatRunner } from "../runtime/index.js";
import type { AssetService } from "../services/AssetService.js";
import type { ConversationService } from "../services/ConversationService.js";
import type { MessageService } from "../services/MessageService.js";
import { ServerError } from "../wire/errors.js";
import type {
  ContextState,
  ConversationCreateParams,
  ConversationCreateResult,
  ConversationTransientParams,
  ConversationTransientResult,
  ConversationAbortParams,
  ConversationAbortResult,
  ConversationDeleteParams,
  ConversationDeleteResult,
  ConversationSendParams,
  ConversationSendResult,
  ConversationState,
  ConversationStateParams,
  ConversationStateResult,
  ConversationView,
  QuestionView,
  RunState,
  StatusBlock,
  StatusBlockId,
  UsageSnapshot,
} from "../wire/index.js";
import { STATUS_BLOCK_IDS } from "../wire/index.js";
import { localizeOutcome } from "./assetHandlers.js";

/** `conversation.*` 的实现要的持有者 */
export interface ConversationHandlerDeps {
  conversations: ConversationService;
  messages: MessageService;
  /** 素材挂接与文件清理（`conversation.send` / `conversation.delete` 用） */
  assets: AssetService;
  /** 一轮的执行者（受理、现场、中止、忘掉） */
  runner: ChatRunner;
  /** 挂在这段对话上的问题（`conversation.state` 现场快照的一部分，D22；不注入时为空） */
  questionsFor?: (conversationId: string) => Promise<QuestionView[]>;
  /** 读配置：上下文阈值跟着模型走（PRD F-D1） */
  readConfig: () => Promise<AppConfig>;
  /**
   * 目录没登记成项目时问一次「要不要登记」（PRD D10）。
   *
   * 不注入时 `conversation.create` 遇到未登记的 cwd 直接回参数错误（说清缺什么）。
   */
  askWorkspaceRegistration?: (
    input: { cwd: string; agentId: string; modelId?: string | null },
    language: Language,
  ) => Promise<QuestionView>;
  /** 刷新思考档位表快照（`setThinking` 之前调一次：改完读回的参数要用当前表） */
  refreshThinkingPresets: () => Promise<void>;
  /** 时钟（ISO 8601 时间戳） */
  now: () => string;
  /** 一轮结算之后的通知点：单根据此重算退出判据 */
  onTurnSettled: () => void;
  /** 有挡着的问题就拒绝（`QuestionService.assertSendable`，D23）；不注入时不检查 */
  assertSendable?: (conversationId: string) => Promise<void>;
  /** 一轮结算之后起一次自动命名（`AutoNaming.afterTurn`，D2：幂等，可无条件调） */
  autoNameAfterTurn?: (conversationId: string, language: Language) => Promise<void>;
  /**
   * 结算后钩子的失败去处（命名没跑成不影响这一轮，但要让组装层看得见）。
   *
   * 不注入时静默：钩子是「顺手做的事」，它的失败不能反过来把已经结算的一轮弄成失败。
   */
  onHookError?: (error: unknown, hook: string) => void;
  /** 临时对话的执行者（`TransientRunner`，D3 / R49）；不注入时这个方法回 `unsupported` */
  runTransient?: (
    params: ConversationTransientParams,
    language: Language,
  ) => Promise<ConversationTransientResult>;
}

/**
 * 注册 `conversation.*`。
 *
 * `conversation.transient`（临时对话，PRD D3）注册的前提是注入了 `runTransient`：
 * 不注入时这个方法仍然落到接线层的 `unsupported`（裁定 R11）。
 */
export function createConversationHandlers(deps: ConversationHandlerDeps): HandlerTable {
  const handlers: HandlerTable = {
    "conversation.list": async (context) => await deps.conversations.list(context.params),
    "conversation.create": async (context) =>
      await createConversation(deps, context.params, context.connection.language),
    "conversation.get": async (context) => await deps.conversations.get(context.params),
    "conversation.rename": async (context) => await deps.conversations.rename(context.params),
    "conversation.pin": async (context) => await deps.conversations.pin(context.params),
    "conversation.revert": async (context) => await deps.conversations.revert(context.params),
    "conversation.setModel": async (context) => await deps.conversations.setModel(context.params),

    "conversation.delete": async (context) => await removeConversation(deps, context.params),

    "conversation.send": async (context) =>
      await sendTurn(deps, context.params, context.connection.language),

    "conversation.state": async (context) => ({
      state: await conversationStateOf(deps, context.params.conversationId, context.connection.language),
    }),

    "conversation.abort": async (context) => await abort(deps, context.params),

    "conversation.setThinking": async (context) => {
      // 档位表先刷新一次再改：改完读回的「展开后的参数」要用当前表
      await deps.refreshThinkingPresets();
      return await deps.conversations.setThinking(context.params);
    },
  };

  const runTransient = deps.runTransient;
  if (runTransient) {
    // 临时对话没有 id、不落库、不推流式事件：一次调用同步返回结果（R1 / R49）
    handlers["conversation.transient"] = async (context) =>
      await runTransient(context.params, context.connection.language);
  }
  return handlers;
}

// ---------------------------------------------------------------------------
// 跨层补齐
// ---------------------------------------------------------------------------

/**
 * `conversation.create`：定位项目 → 未登记时先问一次（PRD D10）→ 建对话草稿（R56）。
 *
 * 「问一次」在这里接的理由：提问通道（`QuestionService`）与对话服务是两个持有者，而契约里的
 * 位置是这一个方法。答「要」之后登记项目与继续建对话由 `QuestionService` 自己完成（D22）。
 */
async function createConversation(
  deps: ConversationHandlerDeps,
  params: ConversationCreateParams,
  language: Language,
): Promise<ConversationCreateResult> {
  const located = await deps.conversations.locateWorkspace(params);
  if (!("needsRegistration" in located)) {
    return await deps.conversations.create(params);
  }

  const cwd = located.needsRegistration;
  const ask = deps.askWorkspaceRegistration;
  if (!ask) {
    // 没有提问通道就不默默建也能建：把「先登记」这个事实结构化地回给调用方
    throw new ServerError("invalid_params", {
      params: { field: "cwd" },
      detail: { field: "cwd", reason: "workspace_not_registered", cwd },
    });
  }
  const question = await ask(
    { cwd, agentId: params.agentId, modelId: params.modelId ?? null },
    language,
  );
  return { conversation: null, requiresRegistration: true, questionId: question.id, cwd };
}

/**
 * `conversation.send`：受理一轮，把素材挂到落库后的那条用户消息上（PRD L6 / F-I12 / D5）。
 *
 * 先把草稿落成真行（R56：首次 `send` 时才写 `conversations`）：FK 要求消息所属的对话已经存在，
 * 而且后端的一切（重连、列表、删除）都按「存在即能查」处理。
 *
 * 附件结局里的句子是素材层按默认语言渲染的（那一层不知道收件人是谁），这里按**这条连接**的
 * 语言重渲染一次再出网（D8：库里只留码与参数）。
 */
async function sendTurn(
  deps: ConversationHandlerDeps,
  params: ConversationSendParams,
  language: Language,
): Promise<ConversationSendResult> {
  // D23：有一段挡着的问题（交接确认、不可撤销动作的确认）就先答它再发
  await deps.assertSendable?.(params.conversationId);

  // R56：草稿在第一条用户消息之前不落库，这里把它写成真行（同一个 id）
  await deps.conversations.ensurePersisted(params.conversationId);

  const turn = await deps.runner.run({
    conversationId: params.conversationId,
    input: params.input,
    language,
  });

  const assetIds = params.input.assetIds ?? [];
  if (assetIds.length > 0) {
    // 上传早于消息落库：受理之后立刻把素材行挂到那条用户消息上
    await deps.assets.linkToMessage(assetIds, turn.userMessageId);
  }

  // 结算之后的两个收尾：起一次自动命名（D2，条件不成立时它自己什么都不做），
  // 再让单根重算一次退出判据（这一轮可能是最后一件欠着的事）
  void turn.done.then(
    async () => {
      try {
        await deps.autoNameAfterTurn?.(params.conversationId, language);
      } catch (error) {
        // 起名失败就是「没起成」（D2：保持原名），不影响已经结算的这一轮
        deps.onHookError?.(error, "autoNaming");
      }
      deps.onTurnSettled();
    },
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
 * 用量（在跑用这一轮，空闲就用库里消息求和）→ 上下文阈值（跟着模型走）→ 挂在这段对话上的问题
 * → 状态栏的块（PRD F-I6）。
 */
async function conversationStateOf(
  deps: ConversationHandlerDeps,
  conversationId: string,
  language: Language,
): Promise<ConversationState> {
  const now = deps.now();
  const { conversation } = await deps.conversations.get({ conversationId });
  const turn = deps.runner.turn(conversationId);
  const page = await deps.messages.list({ conversationId });
  const usage = turn ? turn.runState().usage : usageOfMessages(page.messages, now);
  const config = await deps.readConfig();
  const model = config.models.find((item) => item.id === conversation.model.modelId);
  const run = turn ? turn.runState() : idleRunState(conversationId, usage);
  const context = contextOf(page.messages, model);

  return {
    conversationId,
    run,
    context,
    thinking: conversation.thinking,
    usage,
    questions: deps.questionsFor ? await deps.questionsFor(conversationId) : [],
    statusBlocks: statusBlocksOf({ conversation, run, context, usage, language }),
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 状态栏的块（PRD F-I6 / 裁定 R65）
// ---------------------------------------------------------------------------

/** 造状态栏块要的那几处事（每一项都已经在别处算好了，这里只负责装箱） */
export interface StatusBlockInput {
  /** 服务层给的对话视图（身份、模型、思考档、目录事实） */
  conversation: ConversationView;
  /** 这一轮的快照（六态、工具、子 Agent、本轮用量） */
  run: RunState;
  /** 上下文占用与两条阈值 */
  context: ContextState;
  /** 累计用量 */
  usage: UsageSnapshot;
  /** 收件人的语言（块的标签是给人看的一句话） */
  language: Language;
}

/** 块的标签（`label.agent` / `label.model` …，PRD F-I6：服务端给块名，客户端排版） */
function blockLabel(id: StatusBlockId, language: Language): StatusBlock["label"] {
  const messageKey = `label.${id}` as MessageKey;
  return { code: messageKey, messageKey, params: {}, message: render(language, messageKey) };
}

/**
 * 按 `STATUS_BLOCK_IDS` 的顺序拼装状态栏的块（PRD F-I6 / 裁定 R65）。
 *
 * 这里**不产生新事实**：每一块装的都是别处已经算好的那份 —— 对话视图里的身份 / 模型 / 思考档 /
 * 目录、`conversation.state` 里的上下文与用量、以及这一轮快照里的六态与子 Agent。工具块只取
 * `awaiting_tools` 态里还在跑的那几个（并行时有几个列几个，正是 L8 要的语义）；其余态下没有
 * 工具在跑，列表就是空的。
 *
 * 助手名字与「这个助手能不能用」不在这一层（它们在助手定义那边，`ConversationView` 只给 id），
 * 所以这两个字段在拿不到时给 `null` —— 不猜，也不编一个看起来像真的值。
 */
export function statusBlocksOf(input: StatusBlockInput): StatusBlock[] {
  const { conversation, run, context, usage, language } = input;
  const generation = run.generation;
  const runningTools = generation?.phase === "awaiting_tools" ? generation.runningTools : [];

  const blocks: Record<StatusBlockId, StatusBlock> = {
    agent: {
      id: "agent",
      label: blockLabel("agent", language),
      facts: { agentId: conversation.agentId, name: null, available: null },
    },
    model: {
      id: "model",
      label: blockLabel("model", language),
      facts: conversation.model,
    },
    thinking: {
      id: "thinking",
      label: blockLabel("thinking", language),
      facts: conversation.thinking,
    },
    context: {
      id: "context",
      label: blockLabel("context", language),
      facts: context,
    },
    usage: {
      id: "usage",
      label: blockLabel("usage", language),
      facts: usage,
    },
    cwd: {
      id: "cwd",
      label: blockLabel("cwd", language),
      facts: conversation.folder,
    },
    tools: {
      id: "tools",
      label: blockLabel("tools", language),
      facts: { running: runningTools },
    },
    subagents: {
      id: "subagents",
      label: blockLabel("subagents", language),
      facts: { items: run.subagents },
    },
  };

  // 顺序按 `STATUS_BLOCK_IDS` 给：那是建议的摆放顺序，客户端可以只取自己摆得下的前几块
  return STATUS_BLOCK_IDS.map((id) => blocks[id]);
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
