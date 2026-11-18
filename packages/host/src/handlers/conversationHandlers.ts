/**
 * `conversation.*`：一段对话的身份、历史，以及「投递一句 / 中断 / 暂停 / 继续 / 清空待办 / 现读」
 * 这几个动作。
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
  ConversationPauseResult,
  ConversationResumeResult,
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

    // 两条阈值：会话行上的覆盖层（PRD 1.4 / 4.7），宿主现读，所以本层连转发都不必绕道
    "conversation.setThresholds": async (context) =>
      await deps.conversations.setThresholds(context.params),

    "conversation.delete": async (context) => await removeConversation(deps, context.params),

    "conversation.send": async (context) =>
      await sendTurn(deps, context.params, context.connection.language),

    "conversation.state": async (context) =>
      await readState(deps, context.params.conversationId),

    "conversation.abort": async (context) => await abort(deps, context.params),

    // 暂停 / 继续：只翻输出闸（PRD 4.4）。判据全在 `ChatRunner` 里（没有 agent 回 `false`、
    // 交接期间拒），本层只把「打完之后是不是暂停着」现读回来
    "conversation.pause": async (context) =>
      await pause(deps, context.params.conversationId),

    "conversation.resume": async (context) =>
      await resume(deps, context.params.conversationId),

    // 清空待办：直接转 core（`agent.clearInbox()`），本层不加任何判断
    "conversation.clearInbox": async (context) => ({
      cleared: deps.runner.clearInbox(context.params.conversationId),
    }),

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
 *   3. **素材准备**（F-H7）：`assetIds` → 真正发出去的内容段（段上带着厂商产物与本地标记
 *      `__asset_id`，这一份也就是原样落库的那一份）。走文件引用、内联还是降级成文字，
 *      取决于这段会话现在的模型与端点 —— 那是 `AssetService` 的事，本层只把它要的三样事实
 *      （会话、助手、模型）递过去。
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

  const conversation = await deps.conversations.ensurePersisted(params.conversationId);

  const prepared = await deps.assets.prepareAttachments({
    conversationId: conversation.id,
    agentId: conversation.agentId,
    modelId: conversation.modelId,
    input: params.input,
  });

  const { userMessageId } = await deps.runner.deliver(params.conversationId, {
    // 发出去的那一份就是落库的那一份：段上带着厂商产物（`file_id` / base64）与 `__asset_id`
    content: prepared.content,
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
 * `conversation.pause`：暂停这段对话 —— **只翻输出闸，不接在途**（PRD 4.4）。
 *
 * 手上那批算已经开始，让它跑完；从下一批起不再取。要立刻停就用 `conversation.abort`。
 * 回的是**打完之后这段是不是暂停着**（现读那一格，不是每次变量）：没有 agent（死的）回 `false`
 * —— 没有闸可翻，也不是错误；交接期间直接拒（`busy` / `handoff_in_progress`），因为那期间
 * 闸归交接收口管。
 */
async function pause(
  deps: ConversationHandlerDeps,
  conversationId: string,
): Promise<ConversationPauseResult> {
  deps.runner.pause(conversationId);
  return { paused: deps.runner.state(conversationId).status === "paused" };
}

/**
 * `conversation.resume`：继续 —— **只开闸，不投任何东西**（PRD 4.4）。
 *
 * 压着的待办按原顺序接着跑。回的那一格与 {@link pause} 同一口径（打完之后是不是暂停着）。
 */
async function resume(
  deps: ConversationHandlerDeps,
  conversationId: string,
): Promise<ConversationResumeResult> {
  deps.runner.resume(conversationId);
  return { paused: deps.runner.state(conversationId).status === "paused" };
}

/**
 * `conversation.state`：一段对话此刻的读数（PRD L5：重连先拉读数）。
 *
 * 形状就是契约里的 `ConversationState`，而 `ChatRunner.state` 返的**就是那一份**（同一个形状
 * 只在一处定义）—— 所以这里不再手工摆一遍字段，只在读之前先问一次服务层，让「这段对话没了」
 * 与「这段对话闲着」是两种答复。
 *
 * 四格 / 待办 / 子 agent 名册 / 交接态都是现读，不落库、不是会话字段（口径见
 * `ConversationState` 自己的注释）。`conversation.list` 不带它们：侧栏不需要为每段对话去问
 * 一次驱动者。
 *
 * 消息本体不在这里给：客户端打开一段对话走的是「先订阅，再 `message.list` 拉全量」。
 */
async function readState(
  deps: ConversationHandlerDeps,
  conversationId: string,
): Promise<{ state: ConversationState }> {
  await deps.conversations.get({ conversationId });
  return { state: deps.runner.state(conversationId) };
}
