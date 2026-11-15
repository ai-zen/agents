/**
 * `conversation.*`：一段对话的身份、历史与一轮的运行。
 *
 * 这里只做「参数 → 交给服务/运行时 → 把结果翻译成契约形状」。业务判断在
 * `ConversationService` 与 `ChatRunner` 里：比如「一段对话同时只跑一轮」在 `RunRegistry`、
 * 「跑中发送排进那一轮的 inbox」在 `ChatRunner.enqueue`（D14）、「模型解析不出来」在服务层，
 * 本文件不重新判断一遍。
 *
 * 唯一在接线层做的拼装是 `conversation.state` 的现场快照：它要把三处事实合起来
 * （服务层给的视图、运行时给的这一轮、库里消息求和的用量），而这三样分别属于三个持有者，
 * 只有接线层同时看得见它们。空闲时的子 Agent 快照也在这里合：服务层把「子 Agent 那一半」的行
 * 拼回 `SubAgentSnapshot`（`MessageService.subAgents`），主线那一页用同一次读取的另一半 ——
 * 一遍话读两次，两份快照之间必有一道缝。状态栏的块**不在这里拼**：那是界面的事（PRD F-I6），
 * 八块要的事实各自都在契约里有一份，客户端自己取。
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
import type { AgentDescription } from "../services/AgentService.js";
import type { ConversationService } from "../services/ConversationService.js";
import type { MessageService } from "../services/MessageService.js";
import { HostError } from "../wire/errors.js";
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
  SubAgentSnapshot,
  UsageSnapshot,
} from "../wire/index.js";
import { localizeOutcome } from "./assetHandlers.js";

/** `conversation.*` 的实现要的持有者 */
export interface ConversationHandlerDeps {
  conversations: ConversationService;
  messages: MessageService;
  /** 一轮的执行者（受理、现场、中止、忘掉） */
  runner: ChatRunner;
  /** 挂在这段对话上的问题（`conversation.state` 现场快照的一部分，D22；不注入时为空） */
  questionsFor?: (conversationId: string) => Promise<QuestionView[]>;
  /** 读配置：上下文阈值跟着模型走（PRD F-D1） */
  readConfig: () => Promise<AppConfig>;
  /**
   * 读助手定义那一层的最小事实（名字 + 能不能用，PRD F-I6 的状态栏助手块）。
   *
   * 只用到 `describe`（`AgentService.describe` 是唯一实现者）：接线层不碰定义文件，
   * 也不把 `AgentService` 整个搬进来。不注入时助手块的名字与可用性都是 `null`。
   */
  agents?: { describe: (agentId: string) => Promise<AgentDescription | null> };
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
    "conversation.create": async (context) => await deps.conversations.create(context.params),
    "conversation.get": async (context) => await deps.conversations.get(context.params),
    "conversation.rename": async (context) => await deps.conversations.rename(context.params),
    "conversation.pin": async (context) => await deps.conversations.pin(context.params),
    "conversation.revert": async (context) => await deps.conversations.revert(context.params),
    "conversation.setModel": async (context) => await deps.conversations.setModel(context.params),

    "conversation.delete": async (context) => await removeConversation(deps, context.params),

    "conversation.send": async (context) =>
      await sendTurn(deps, context.params, context.connection.language),

    "conversation.state": async (context) => {
      const snapshot = await conversationStateOf(
        deps,
        context.params.conversationId,
        context.connection.language,
      );
      // 消息来自同一次读取（用量与上下文已经要了它），要就一起给，不要就整个键不出现
      return context.params.includeMessages
        ? { state: snapshot.state, messages: snapshot.messages }
        : { state: snapshot.state };
    },

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
 * `conversation.send`：受理一句用户输入。
 *
 * 先把草稿落成真行（R56：首次 `send` 时才写 `conversations`）：FK 要求消息所属的对话已经存在，
 * 而且后端的一切（重连、列表、删除）都按「存在即能查」处理。
 *
 * ## 两条受理路（PRD D14）
 *
 * 1. **这段对话正跑着一轮** → 这一句排进**那一轮**的 inbox，立即回 `queued: true`（不再 `busy`）：
 *    不打断正在说的那一段，core 在轮末把它落成一条用户消息。
 * 2. 其余情况（空闲 / 刚跑完还没结算干净）→ 老路径 `runner.run()`：开新的一轮；真开不了
 *    （装配窗口等超了上界、或者这一轮正好在收尾）才回 `busy` —— 那是兜底，不是跑中发送的答复。
 *
 * 为什么入队的定夺不在这一层：「跑着的那一轮」只在 `ChatRunner` 里（它手上才有 agent）；
 * 这里只负责把回执翻译成契约形状。`assertSendable`（D23）在两条路之前就过了 —— 排队不是
 * 绕过问题闸门的通道。
 *
 * 素材关系行不在这里写：它跟着「用户消息落库那一刻」走（`ChatRunner` 注入的
 * `linkMessageAssets` 扫落库内容里的 `__asset_id`），所以重试与重写都不会重复记。
 *
 * 附件结局里的句子是素材层按默认语言渲染的（那一层不知道收件人是谁），这里按**这条连接**的
 * 语言重渲染一次再出网（D8：库里只留码与参数）。
 */
async function sendTurn(
  deps: ConversationHandlerDeps,
  params: ConversationSendParams,
  language: Language,
): Promise<ConversationSendResult> {
  // D23：有一段挡着的问题（交接确认、不可撤销动作的确认）就先答它再发。
  // 排队也不是绕道：这个闸门在两条受理路之前。
  await deps.assertSendable?.(params.conversationId);

  // R56：草稿在第一条用户消息之前不落库，这里把它写成真行（同一个 id）
  await deps.conversations.ensurePersisted(params.conversationId);

  // D14：跑中发送 → 排进那一轮的 inbox。`null` = 现在没有能排进去的一轮，落到下面的老路径。
  const queued = await deps.runner.enqueue({
    conversationId: params.conversationId,
    input: params.input,
    language,
  });
  if (queued) {
    // 排队的话还没有属于它的助手消息（流还是那一轮原来那条），所以这里是 `null`（D14 / D5）
    return {
      userMessageId: queued.userMessageId,
      assistantMessageId: null,
      queued: true,
      attachments: queued.attachments.map((outcome) => localizeOutcome(outcome, language)),
      acceptedAt: queued.acceptedAt,
    };
  }

  const turn = await deps.runner.run({
    conversationId: params.conversationId,
    input: params.input,
    language,
  });

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
 * `conversation.delete`：删掉这段对话，再补齐一件只有接线层知道的事（R33）。
 *
 * 运行时里这一轮的现场要丢掉（`ChatRunner.forget`：正在跑就先让它停）；素材字节的清理不在这里
 * —— 服务层删完之后已经由素材层问过「还剩几张引用」，归零的那几份才删（见
 * `ConversationService.delete` 的 `sweepAssets`）。
 */
async function removeConversation(
  deps: ConversationHandlerDeps,
  params: ConversationDeleteParams,
): Promise<ConversationDeleteResult> {
  const report = await deps.conversations.delete(params);
  if (params.dryRun !== true && report.removed) {
    deps.runner.forget(params.conversationId);
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
  return idleRunState(
    conversationId,
    usageOfMessages(page.messages, deps.now()),
    await deps.messages.subAgents(conversationId, page.messages),
  );
}

/**
 * 一段对话的现场（PRD L5：重连先拉状态）。
 *
 * 拼装顺序：视图（身份 / 思考档 / 目录）→ 运行状态（在跑就用这一轮自己的快照）→
 * 用量（在跑用这一轮，空闲就用库里消息求和）→ 上下文阈值（跟着模型走）→ 挂在这段对话上的问题。
 * 空闲时运行状态里还要有历次委派的子 Agent（重开一段对话，「子代理」页签不该是空的）。
 */
async function conversationStateOf(
  deps: ConversationHandlerDeps,
  conversationId: string,
  language: Language,
): Promise<{ state: ConversationState; messages: AgentNS.Message[] }> {
  const now = deps.now();
  const { conversation } = await deps.conversations.get({ conversationId });
  const turn = deps.runner.turn(conversationId);
  const page = await deps.messages.list({ conversationId });
  const usage = turn ? turn.runState().usage : usageOfMessages(page.messages, now);
  const config = await deps.readConfig();
  const model = config.models.find((item) => item.id === conversation.model.modelId);
  // 子 Agent 快照也只用这一份 `page.messages`（子 Agent 那一半由服务层按 `parentToolCallId` 补）
  const run = turn
    ? turn.runState()
    : idleRunState(
        conversationId,
        usage,
        await deps.messages.subAgents(conversationId, page.messages),
      );
  const context = contextOf(page.messages, model);

  return {
    state: {
      conversationId,
      run,
      context,
      thinking: conversation.thinking,
      usage,
      questions: deps.questionsFor ? await deps.questionsFor(conversationId) : [],
      updatedAt: now,
    },
    // 这份消息就是上面算用量与上下文用的那一次读取，不是又读一遍
    messages: page.messages,
  };
}

// ---------------------------------------------------------------------------
// 纯函数：把几处事实拼成契约形状
// ---------------------------------------------------------------------------

/**
 * 空闲的现场：没有在跑的一轮，但历史用量与历次委派还在。
 *
 * `subagents` 是入参而不是现取的：本函数是纯函数（没有库访问能力，也没有「从哪去问」的
 * 分支），而子 Agent 快照要把库里两处事实合起来（子 Agent 那一半的行、主线那一页的工具名
 * 与用量）。拼这一步交给调用方（`MessageService.subAgents`），调用方本来就为用量与上下文
 * 读过那段话，两处共用同一份，快照之间不会差一瞬。
 */
export function idleRunState(
  conversationId: string,
  usage: UsageSnapshot,
  subagents: SubAgentSnapshot[],
): RunState {
  return {
    conversationId,
    status: "idle",
    assistantMessageId: null,
    // 没在跑的一轮就没有谁的入队可排：这里是空数组，不是「未知」（D14）
    inbox: [],
    startedAt: null,
    settledAt: null,
    generation: null,
    outcome: null,
    problem: null,
    subagents,
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
