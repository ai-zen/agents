/**
 * `conversation.*`：一段对话的身份、历史，以及「投递一句 / 中断 / 现读」这三个动作。
 *
 * 这里只做「参数 → 交给服务或运行时 → 把结果翻译成契约形状」。业务判断不在这里：
 * 会话行归 `ConversationService`，投递 / 中断 / 四格归 `ChatRunner`，素材选路归
 * `AssetService`。本文件唯一多做的一步是**把素材准备摆在投递之前**（见 {@link sendTurn}）：
 * 那是「这一次发送」的事，只有接线层同时看得见素材服务、会话行（要助手与模型）与执行者。
 *
 * 三件以前挂在这里、现在没有的事：
 *   - **没有运行状态那本账**：`conversation.state` 给的是四格 + 待办（`ChatRunner.state`
 *     现读），用量与更细的阶段由客户端按到达的事件自己算（PRD 硬规矩 7）；
 *   - **没有排队分支**：投递只有一条路（`ChatRunner.deliver`），它自己判「对话在不在、agent
 *     活不活」，忙不忙不是拒绝的理由；
 *   - **没有「做完之后」的收尾链**：自动命名与交接线提问都挂在「变闲那一拍」（`app.ts` 的
 *     `onIdle`），这里不再接 `turn.done`。
 */

import type { Language } from "../i18n/index.js";
import type { HandlerTable } from "../net/index.js";
import type { ChatRunner } from "../runtime/index.js";
import type { AssetService } from "../services/AssetService.js";
import type { ConversationService } from "../services/ConversationService.js";
import type { MessageService } from "../services/MessageService.js";
import type {
  ConversationAbortParams,
  ConversationAbortResult,
  ConversationDeleteParams,
  ConversationDeleteResult,
  ConversationSendParams,
  ConversationSendResult,
  ConversationState,
  ConversationTransientParams,
  ConversationTransientResult,
} from "../wire/index.js";
import { localizeOutcome } from "./assetHandlers.js";

/** `conversation.*` 的实现要的持有者 */
export interface ConversationHandlerDeps {
  conversations: ConversationService;
  messages: MessageService;
  /** 素材层：发一句之前把 `assetIds` 变成内容段（PRD F-H7 的选路） */
  assets: AssetService;
  /** 投递 / 中断 / 现读的持有者（`ChatRunner`） */
  runner: ChatRunner;
  /** 刷新思考档位表快照（`setThinking` 之前调一次：改完读回的参数要用当前表） */
  refreshThinkingPresets: () => Promise<void>;
  /** 时钟（ISO 8601 时间戳） */
  now: () => string;
  /**
   * 写一条日志。
   *
   * 只有一处用它：`conversation.abort` 的 `reason`。core 的 `abort()` 不收原因（它只说
   * 「掐断」），而这个参数确实被客户端发过来了 —— 丢掉它等于把用户按中断的那个理由抹了，
   * 为它造一个概念（中止原因表、中止记录）又不值。写一条日志刚好。
   */
  log: (message: string, detail?: unknown) => void;
  /** 有挡着的问题就拒绝（`QuestionService.assertSendable`，D23）；不注入时不检查 */
  assertSendable?: (conversationId: string) => Promise<void>;
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

    "conversation.state": async (context) =>
      await readState(deps, context.params.conversationId),

    "conversation.abort": async (context) => await abort(deps, context.params),

    "conversation.setThinking": async (context) => {
      // 档位表先刷新一次再改：改完读回的「展开后的参数」要用当前表
      await deps.refreshThinkingPresets();
      return await deps.conversations.setThinking(context.params);
    },
  };

  const runTransient = deps.runTransient;
  if (runTransient) {
    // 临时对话没有 id、不落库、不推流式事件：一次调用同步返回那条助手消息（R1 / R49）
    handlers["conversation.transient"] = async (context) =>
      await runTransient(context.params, context.connection.language);
  }
  return handlers;
}

// ---------------------------------------------------------------------------
// 投递
// ---------------------------------------------------------------------------

/**
 * `conversation.send`：把一句用户输入投进去。
 *
 * 五步，顺序都是有理由的：
 *
 *   1. `assertSendable`（D23）：有挡着的问题（交接确认、不可撤销动作的确认）就先答它再发。
 *      排队不是绕过闸门的通道，所以这一步在投递之前。
 *   2. `ensurePersisted`（R56）：草稿在第一条用户消息之前不落库，这里把它写成真行（同 id）——
 *      消息行、素材关系行都按 `conversationId` 挂外键。
 *   3. **素材准备**（F-H7）：`assetIds` → 真正发出去的内容段，同时拿到「落库那一份」
 *      （段上只有 `__asset_id`）。走文件引用、内联还是降级成文字，取决于这段会话现在的模型与
 *      端点 —— 那是 `AssetService` 的事，本层只把它要的三样事实（会话、助手、模型）递过去。
 *   4. 投递：`ChatRunner.deliver`。它只判两件事 —— 对话在不在、agent 活不活；死的那一格
 *      只有创建者能把它叫起来（`mayStart`），界面上的发送按钮就是创建者之一，所以这里给 `true`。
 *   5. 回执：`userMessageId`（投递那一刻就定死，客户端按它画乐观回显）+ 每个附件的结局。
 *
 * 附件结局里的句子是素材层按默认语言渲染的（那一层不知道收件人是谁），这里按**这条连接**的
 * 语言重渲染一次再出网（D8：库里只留码与参数）。
 *
 * 素材关系行不在这里写：它跟着「用户消息落库那一刻」走（`ChatRunner` 注入的
 * `linkMessageAssets` 扫落库内容里的 `__asset_id`），所以重试与重写都不会重复记。
 */
async function sendTurn(
  deps: ConversationHandlerDeps,
  params: ConversationSendParams,
  language: Language,
): Promise<ConversationSendResult> {
  await deps.assertSendable?.(params.conversationId);

  const conversation = await deps.conversations.ensurePersisted(params.conversationId, language);

  const prepared = await deps.assets.prepareAttachments({
    conversationId: conversation.id,
    agentId: conversation.agentId,
    modelId: conversation.modelId,
    input: params.input,
  });

  const { userMessageId } = await deps.runner.deliver(params.conversationId, {
    content: prepared.content,
    // 落库那一份与发出去那一份可能不同（厂商的 file_id / base64 不进库）
    ...(prepared.storedContent === undefined ? {} : { storedContent: prepared.storedContent }),
    source: { kind: "user" },
    mayStart: true,
  });

  return {
    userMessageId,
    attachments: prepared.attachments.map((outcome) => localizeOutcome(outcome, language)),
  };
}

/**
 * `conversation.delete`：删掉这段对话，再补齐一件只有接线层知道的事（R33）。
 *
 * 运行时里那段对话的现场要丢掉（`ChatRunner.forget`：先摘桥再让 agent 硬着陆）；素材字节的
 * 清理不在这里 —— 服务层删完之后已经由素材层问过「还剩几张引用」，归零的那几份才删（见
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

// ---------------------------------------------------------------------------
// 中断与现读
// ---------------------------------------------------------------------------

/**
 * `conversation.abort`：掐掉活着的 agent 手上那一批。
 *
 * `signalled: false` 表示那个 agent 本来就不在（死格），不是错误。中断不是杀死：core 的
 * `abort()` 掐掉在途请求与工具并顺带挂上暂停，待办一条不丢（PRD 4.4）。
 *
 * `reason` 没有去处（core 的 `abort()` 不收原因，契约里也没有「中止记录」这个东西）：
 * 写一条日志，别把用户按下中断的理由直接从世界上抹掉。
 */
async function abort(
  deps: ConversationHandlerDeps,
  params: ConversationAbortParams,
): Promise<ConversationAbortResult> {
  const signalled = deps.runner.abort(params.conversationId);
  deps.log("conversation.abort", {
    conversationId: params.conversationId,
    reason: params.reason ?? null,
    signalled,
  });
  return { signalled };
}

/**
 * `conversation.state`：一段对话此刻的读数（PRD L5：重连先拉读数）。
 *
 * 四格与待办由 `ChatRunner.state` 现读（不落库、不推算）；`at` 是这份读数的时刻。
 * 会话不存在（连草稿都没有）仍按老口径报 `not_found` —— 这里先问一次服务层，就是为了让
 * 「这段对话没了」与「这段对话闲着」是两种答复。
 *
 * 消息本体不在这里给：客户端打开一段对话走的是「先订阅，再 `message.list` 拉全量」。
 */
async function readState(
  deps: ConversationHandlerDeps,
  conversationId: string,
): Promise<{ state: ConversationState }> {
  await deps.conversations.get({ conversationId });
  const { status, inbox } = deps.runner.state(conversationId);
  const state: ConversationState = {
    conversationId,
    status,
    inbox,
    at: deps.now(),
  };
  return { state };
}
