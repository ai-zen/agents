/**
 * 平级会话服务 —— 一段对话里的模型**开另一段对话**、之后还能**接着跟它说话**，那边跑完把结果
 * **推送回**发起者。
 *
 * 对应技术方案 `.ai-zen/plans/20261115-peer-sessions.md`：阶段 1 是「建 → 跑 → 推回 → 被唤醒」
 * 的最小闭环；**阶段 2 第一块**加了三样东西：`send_to_session`（模型能继续跟子会话说话）、
 * `create_session` 的并发限额（每个父对话同时最多 {@link MAX_RUNNING_PEERS} 个在跑的）、以及
 * 投递回执（`chatRunner.deliver` 回「投递那一刻对方是什么状态」）。仍然**不落库**、没有超时 /
 * 看门狗、没有 UI 标记。
 *
 * ## 四件它负责的事
 *
 * 1. **建**：按 `conversation.create` 同一条路开一段会话（草稿 → 落真行），拿到 conversationId
 *    就是 `sessionId`，立刻开跑并**立刻返回**（不等结果 —— 等待就等于子代理，那已经存在了）。
 * 2. **记**：进程内 `Map<sessionId, record>`。不建表、不加迁移：这一层的语义是「agent 自己开
 *    一段会话、跑完把结果送回去」，重启之后这些元数据没了，子会话就是一段普通会话
 *    （`/sessions` 里照样看得见、用户照样能接着用，`read_session_status` / `send_to_session`
 *    对它回 `gone`）。
 * 3. **接着说话**：{@link PeerSessionService.send} —— 与 `create` 同构的窄端口（只收 `caller`），
 *    血缘校验（只有父↔子之间能互发）与来源名解析都在这一层。
 * 4. **推**：子会话**每一段**结算之后，把这一段的结果投回父对话 —— 具体怎么投（父对话在跑就
 *    入队、空闲就唤醒、正在结算就先攒着）**不是本文件的事**，全交给 `chatRunner.deliver` 一个
 *    入口。
 *
 * ## 「推」为什么挂在「一次结算」上，而不是挂在 `create` 上
 *
 * 阶段 1 的回投写在 `create` 里（`turn.done.then(...)`）：于是只有 `create_session` 开出来的
 * **第一段**有结果回投，之后 `send_to_session` 把子会话叫起来跑的**第二段、第三段…**跑完什么
 * 都没有推回去 —— 工具文案里那句「结果跑完会自动推回来」在那条路上是假话。
 *
 * 现在只认一条规则：**一段结算 → 若这段会话是派生会话（`records` 里有它）→ 把这一段的结果
 * 投回它的父对话**。触发源用现成的 `ChatRunner.onTurnSettled`（`app.ts` 已经在那儿接交接线
 * 提问），本文件只多接一跳 {@link PeerSessionService.settleSegment} —— 不新增事件、不另立订阅。
 * 一段一次，不多不少：`create` 里那一句已经删掉，否则第一段会被投两遍。
 *
 * ## 「谁在调我」为什么靠 `bind`
 *
 * core 的 `Agent` 上没有 `conversationId`（那是宿主的财产），所以宿主在造出 agent 之后调
 * {@link PeerSessionService.bind} 记一笔 `WeakMap`（agent → conversationId），工具回调里用
 * `ctx.agent` 认领调用方。**不给 core 的 `Agent` 加字段**：那是另一个包的类型，而且是
 * 「每次一轮、用完即弃」的对象，宿主侧记一笔就够，也不会泄漏（WeakMap 跟着 agent 一起回收）。
 *
 * ## 投递：本文件只把内容交给执行者，不猜
 *
 * 见 {@link PeerSessionService.deliver}：`chatRunner.deliver(parentConversationId, { content,
 * source })`。那一个入口自己解决「agent 在不在、父对话在不在跑、在结算、要不要攒一批」四件
 * 事 —— 从前本文件靠「先 `enqueue`（拿到 `null` 说明空闲）再 `run`、`run` 抛错就记 dropped」
 * 猜出来，猜错了就是两种真事故：多起一段没有上下文的段（消息不落库），或者把一条本该落地
 * 的结果当失败丢掉。
 *
 * 于是 `resultDelivered` 的语义也跟着变了：**投递被受理就是 `delivered`**（执行者保证「迟早
 * 落地、不丢」），只有父对话不存在才 `dropped` 并出声一次。它记的是**最近一次结算**的那一笔
 * （一段一条结果，字段不攒总量）。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { Agent } from "@ai-zen/agents-core";
import type {
  PeerSessionCreateInput,
  PeerSessionCreated,
  PeerSessionPort,
  PeerSessionRejectReason,
  PeerSessionSendInput,
  PeerSessionSent,
  PeerSessionState,
  PeerSessionStatus,
} from "@ai-zen/agents-sdk";

import type {
  ChatRunParams,
  ChatTurn,
  DeliveryOutcome,
  TurnSettledFacts,
} from "../runtime/ChatRunner.js";
import type { StoredMessage } from "../storage/types.js";
import type { ConversationCreateParams, ConversationCreateResult } from "../wire/index.js";
import type { ProblemFact, RunOutcome } from "../wire/states.js";

/** 一条平级会话的进程内记录（**不落库**：重启即消失，理由见文件头） */
export interface PeerSessionRecord {
  /** 子会话的 conversationId（工具返回给模型的就是它） */
  sessionId: string;
  /** 谁开的这段会话 */
  parentConversationId: string;
  /** 可读名字：投递正文与 `read_session_status` 都用它（模型记不住 UUID） */
  label: string;
  /** 1 = 由一段对话直接发起（阶段 1 只允许这一层） */
  depth: number;
  state: Exclude<PeerSessionState, "gone">;
  /** 开跑时刻（毫秒） */
  startedAt: number;
  /**
   * **最近一次结算**的那条结果有没有送到父对话手上（`pending` = 还没结算过一次）。
   *
   * 一段一条结果：第二段、第三段结算时会被重写，所以它是「最后那一段的账」，不是累计量。
   */
  resultDelivered: "pending" | "delivered" | "dropped";
}

/** 子会话第一轮的用户输入是谁推来的（正文最前面那行注释就写它） */
const SOURCE_FROM_PARENT = "父对话";

/** 结果正文的截断长度（模型看到的正文不必比这更长） */
const RESULT_CHARS = 1000;

/**
 * 每个**父对话**同时最多能有多少个**在跑**的平级会话。
 *
 * 「在跑」= 记录上的 `state === "running"`；`idle` / `failed` / `aborted` 都不占名额（那几段已经
 * 收工了，用户要接着用它们与本限额无关）。超出了就是一条结构化拒绝 `too_many_peers`：让模型先
 * 等一批跑完、或者把活分给更少的会话，比让它一口气开 20 段把端点和额度烧光要好。
 *
 * 判据只用 `records`（不新增字段、不建表）：名额这东西跟着「谁在跑」走，而「谁在跑」写在同一
 * 条记录上。
 */
const MAX_RUNNING_PEERS = 4;

/** `send_to_session` 正文注释里的来源名：`会话「<调用者的名字>」`（拼注释归 core） */
function senderSource(name: string): string {
  return `会话「${name}」`;
}

/** `read_session_status` 里那条摘要的截断长度（**绝不给全量消息**，否则模型会拿它当上下文搬运） */
const STATUS_CHARS = 300;

/** 子会话的诞生：与 `conversation.create` 处理器同一条路（草稿 + 三级模型解析） */
export interface PeerSessionConversationCreator {
  create(params: ConversationCreateParams): Promise<ConversationCreateResult>;
  /**
   * 草稿落成库里那一行。
   *
   * `ChatRunner.run` 认的是**库里那一行**（R56：没有用户消息的对话不写库），所以子会话开跑
   * 之前必须走这一道 —— 与 `conversation.send` 里那一句同义。
   */
  ensurePersisted(conversationId: string): Promise<unknown>;
}

/** 一轮的执行者（`ChatRunner` 结构上满足）：平级会话只做两件事 —— 把子会话开跑、把结果投回去 */
export interface PeerSessionRunner {
  run(params: ChatRunParams): Promise<ChatTurn>;
  /**
   * 把一条内容投给某段对话（**唯一**的投递入口）。
   *
   * 执行者负责全部判断：agent 不在就按历史复活、父对话在跑就交给那一段、正在结算就先攒着，
   * 攒够了一次性落地。**只有「那段对话不存在」才 reject** —— 调用方据此记 `dropped`。
   *
   * 回执是 {@link DeliveryOutcome}：收下了，以及**投递那一刻**对方是 `running` / `idle` /
   * `settling`（`send_to_session` 把 `state` 原样回给模型）。
   */
  deliver(
    conversationId: string,
    input: { content: AgentNS.MessageContent; source: string },
  ): Promise<DeliveryOutcome>;
}

/** 平级会话服务的依赖（窄接口：本文件不认识整个宿主） */
export interface PeerSessionServiceDeps {
  /**
   * 只读会话那一行：项目 / 助手 / 模型的口径来源，以及**名字**（`send_to_session` 的来源名
   * 用它 —— 来源名由宿主解析，不许调用方传）。
   */
  conversations: {
    get(id: string): Promise<{ id: string; workspaceId: string; agentId: string; name: string } | undefined>;
  };
  /** 子会话的诞生 */
  conversationCreator: PeerSessionConversationCreator;
  /** 读子会话最后一条助手消息（主线消息，按 seq 升序） */
  messages: { listByConversation(conversationId: string): Promise<StoredMessage[]> };
  /** 一轮的执行者 */
  chatRunner: PeerSessionRunner;
  /** 时钟（毫秒；`startedAt` 出网时转 ISO 8601） */
  now?: () => number;
  /** 出错的去处（投递失败**不许静默丢**：这条就是那一次出声） */
  onError?: (error: unknown, context: string) => void;
}

/** 一条结构化拒绝（返回结果，不抛错：模型要能读懂并改变策略） */
function rejected(reason: PeerSessionRejectReason, hint: string): PeerSessionCreated {
  return { ok: false, reason, hint };
}

/** 一轮的结局 → 记录状态（`completed` 就是「跑完了、现在闲着」） */
function stateOf(outcome: RunOutcome): Exclude<PeerSessionState, "gone"> {
  switch (outcome) {
    case "error":
      return "failed";
    case "aborted":
      return "aborted";
    default:
      return "idle";
  }
}

/** 一段消息里的纯文本（分段内容只取文本段，与自动命名同一个口径） */
function textOf(content: AgentNS.MessageContent | null | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((section) => ("text" in section && typeof section.text === "string" ? section.text : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

/** 截断到上限（超了加一个省略号：读者要知道「后面还有」） */
function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** 失败原因写成句子（`ProblemFact.message` 已经是渲染好的一句；`detail.reason` 短则附上） */
function failureReason(problem: ProblemFact | null): string {
  if (!problem) return "原因不明";
  const detail = problem.detail;
  const raw =
    detail !== null && typeof detail === "object" && typeof (detail as { reason?: unknown }).reason === "string"
      ? (detail as { reason: string }).reason
      : undefined;
  return raw && raw.length > 0 ? `${problem.message}（${clip(raw, 200)}）` : problem.message;
}

export class PeerSessionService implements PeerSessionPort {
  private readonly records = new Map<string, PeerSessionRecord>();
  /**
   * 「这个 agent 是哪段会话的」—— 宿主在造出 agent 之后登记（见 {@link bind}）。
   *
   * 键用 `object` 而不是 `Agent`：工厂那一侧拿到的是宿主自己的 `ChatAgent` 表面（测试里甚至是
   * 替身），而工具那一侧给的是 core 的 `Agent`。两者是同一个对象，能当 `WeakMap` 的键就行 ——
   * 它不跟着任何东西泄漏（agent 用完即弃，键跟着回收）。
   */
  private readonly identities = new WeakMap<object, string>();
  /** 缺省名字的序号（`会话 1` / `会话 2` …） */
  private labelSeq = 0;

  private readonly deps: PeerSessionServiceDeps;

  constructor(deps: PeerSessionServiceDeps) {
    this.deps = deps;
  }

  /**
   * 登记「这个 agent 是哪段会话的」。
   *
   * 由 agent 工厂在造出 agent 之后调用（`app.ts` 的 `defaultAgentFactory`）：core 的 `Agent`
   * 上没有 `conversationId`，而工具只拿得到 `ctx.agent` —— 认领调用方就靠这一笔。
   */
  bind(agent: object, conversationId: string): void {
    this.identities.set(agent, conversationId);
  }

  /** 取某个 `sessionId` 此刻的记录（只给用例与排查看；业务读取走 {@link status}） */
  record(sessionId: string): PeerSessionRecord | undefined {
    return this.records.get(sessionId);
  }

  /**
   * 这段会话是不是「派生会话」—— 即由一段对话开出来的子会话（本进程内还认得的那一段）。
   *
   * 判据只有 `records` 这一处（进程内记录，不落库）：重启之后子会话就是一段普通会话，
   * 这里会答 `false`，它于是回到「用户会话」那一套（越线时问用户）。
   *
   * 宿主拿它做两件事：① 装配 agent 时决定压缩方式（派生会话自动压，用户会话问用户）；
   * ② 一轮结算之后决定要不要挂交接问题（派生会话不问）。
   */
  isPeerSession(conversationId: string): boolean {
    return this.records.has(conversationId);
  }

  /**
   * 开一段平级会话：建会话 → 落真行 → 开跑 → **立刻**回 `{ sessionId, label }`。
   *
   * 三种失败是**结构化拒绝**（返回结果，不抛错）：调用方自己已经是平级会话（`depth_exceeded`，
   * 防无限分身）、这个父对话手头已经在跑的平级会话到了 {@link MAX_RUNNING_PEERS} 个
   * （`too_many_peers`）、子会话三级解析拿不到模型（`model_unresolved`）。其余错误照抛 —— 那是
   * 接线或环境出了真问题，编一个「拒绝」给模型反而误导它。
   */
  async create(input: PeerSessionCreateInput): Promise<PeerSessionCreated> {
    const parentConversationId = this.identityOf(input.caller);
    const parent = await this.deps.conversations.get(parentConversationId);
    if (!parent) {
      // 父对话已经不在了（被删）：没有可投递的去处，也没有可继承的项目 / 助手
      throw new Error(
        `Cannot open a peer session: conversation "${parentConversationId}" no longer exists`,
      );
    }

    // 1. 深度守卫（只有一层）：一个平级会话不许再开平级会话
    const own = this.records.get(parentConversationId);
    if (own && own.depth >= 1) {
      return rejected(
        "depth_exceeded",
        "This conversation is itself a peer session, and peer sessions cannot open further peer " +
          "sessions (one level only). Do the work here instead, or report back and let the " +
          "conversation that started this one spawn it.",
      );
    }

    // 2. 并发限额：这个父对话手头**在跑**的平级会话满了就不建（在 `conversationCreator.create`
    //    之前判：拒绝不许留下副作用 —— 一段建出来又跑不了的会话比一条拒绝糟得多）
    const running = this.runningPeersOf(parentConversationId);
    if (running >= MAX_RUNNING_PEERS) {
      return rejected(
        "too_many_peers",
        `This conversation already has ${MAX_RUNNING_PEERS} peer sessions running at the same ` +
          "time. Wait for some of them to finish (their results are pushed back to me), or give " +
          "the work to fewer sessions instead of opening another one.",
      );
    }

    // 3. 子会话：与 `conversation.create` 同一条路（`agentId` 缺省 = 父对话那一个，模型走三级解析）
    let created: ConversationCreateResult;
    try {
      created = await this.deps.conversationCreator.create({
        workspaceId: parent.workspaceId,
        agentId: input.agentId ?? parent.agentId,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      });
    } catch (error) {
      if (isModelUnresolved(error)) {
        return rejected(
          "model_unresolved",
          "No model could be resolved for that peer session (no session override, no modelId on " +
            "the agent definition, no global default model). Pass `modelId`, or pass an `agentId` " +
            "that has a model bound.",
        );
      }
      throw error;
    }

    const sessionId = created.conversation.id;
    // 4. 草稿落成真行：`chatRunner.run` 只认库里那一行（R56）
    await this.deps.conversationCreator.ensurePersisted(sessionId);

    // 5. 先记账再开跑（`state: "running"` / `resultDelivered: "pending"`）：跑完的投递要靠它
    const record: PeerSessionRecord = {
      sessionId,
      parentConversationId,
      label: input.label ?? this.nextLabel(),
      depth: (own?.depth ?? 0) + 1,
      state: "running",
      startedAt: this.now(),
      resultDelivered: "pending",
    };
    this.records.set(sessionId, record);

    // 6. 开跑（受理即回）：子会话第一句的 source 写「父对话」，正文最前面那行注释由 core 加。
    //    这里**不挂**任何跟这一轮结果的东西：回投跟着结算走（见 `settleSegment`），不是跟着
    //    `create` 走 —— 否则第一段会被投两遍（`onTurnSettled` 那一路已经投了一次）。
    try {
      await this.deps.chatRunner.run({
        conversationId: sessionId,
        input: { content: input.prompt },
        source: SOURCE_FROM_PARENT,
      });
    } catch (error) {
      record.state = "failed";
      record.resultDelivered = "dropped";
      this.onError(error, "平级会话开跑失败");
      throw error;
    }

    // 7. 就这么回（结果由这一段自己的结算负责推回来：`ChatRunner.onTurnSettled` → `settleSegment`）
    return { ok: true, sessionId, label: record.label };
  }

  /**
   * 问一段平级会话的状态。
   *
   * 查不到记录就是 `gone`（**不抛错**：模型不该因为查了一个删掉的 / 重启前的会话而断掉这一轮）。
   * 记录存在时多给两格：可读名字与最后一条助手消息的截断摘要（~300 字，绝不给全量）。
   */
  async status(input: { caller: Agent; sessionId: string }): Promise<PeerSessionStatus> {
    const record = this.records.get(input.sessionId);
    if (!record) return { state: "gone" };

    const lastMessage = clip(await this.lastAssistantText(record.sessionId), STATUS_CHARS);
    return {
      state: record.state,
      label: record.label,
      startedAt: new Date(record.startedAt).toISOString(),
      ...(lastMessage.length > 0 ? { lastMessage } : {}),
    };
  }

  /**
   * **一段结算** → 若这段会话是派生会话，就把这一段的结果投回它的父对话。
   *
   * 由 `app.ts` 那条已有的 `onTurnSettled` 一跳进来（与交接线提问并列，
   * `void this.peerSessions.settleSegment(facts)`）：触发源就是 `ChatRunner` 结算时本来就会报的
   * 那一条，**不新增事件、不另立订阅**。
   *
   * 四步，顺序不能换：
   *   1. `records` 里没有这段会话 → 直接返回（它不是派生会话：用户会话、以及**父对话自己**那一段
   *      都走这一支 —— 父不是 peer，它的结算本来就不该回投给任何人）；
   *   2. 是 peer → 按这一段结局改记录状态（`idle` / `failed` / `aborted`，用 `stateOf`）；
   *   3. 读子会话最后一条助手消息、截断，失败 / 中止时正文里写明原因（用句子，不甩错误栈）；
   *   4. 投递：**一句 `chatRunner.deliver`**。父对话在跑、空闲、正在结算、agent 还在不在，
   *      都不是本文件要判断的事（那些判断只有一个地方该做，理由见文件头「投递」那一段）。
   *
   * ## 为什么**不**按 `facts.source` 过滤
   *
   * 派生会话的段有两种叫法：`create_session` 起的第一段（`source: "父对话"`）与之后被投递叫醒
   * 的自起段（`source` 是投递方给的来源名）。只认「不是用户发的」会漏掉前者，只认自起段会漏掉
   * 后者；而「该不该回投」的真判据只有一个 —— **这段会话在不在 `records` 里**。来源不参与判断。
   *
   * ## 这条链会不会自己循环（必须想清楚的那一条）
   *
   * 会走到回投的段只有「派生会话的段」。三种情形都收得住：
   *
   *   - **深度只有一层**：peer 不能再开 peer（`create` 的 `depth_exceeded`），所以「子 → 父 →
   *     祖父」最多两跳；最后一跳那段会话不在 `records` 里，不会继续回投 —— 链子自己断在那里。
   *   - **父 ↔ 子之间可以来回**：父 `send_to_session` → 子跑完回投 → 父被唤醒 → 父再
   *     `send_to_session` …… 这**不是机制自激**：每一轮都要模型主动发一次工具调用，是模型自己
   *     的选择，不是结算钩子自己生出来的。所以这里**不做预算 / 熔断**（多一层限制会误伤
   *     「接着干」这个正当用法）。
   *   - 回投把**父对话**叫起来的那一段结算时，`records` 里没有父对话 → 第一步就返回，不会二次
   *     回投（这就是「父被唤醒的那一段不能当成需要回投的段」这条要求落成代码的地方）。
   *
   * `resultDelivered` 跟着改成「受理即 `delivered`」：执行者保证这一条迟早落地（在跑的段取走、
   * 正在结算就攒到结算之后一起投、agent 不在就按历史复活），所以本文件没有「投不进去」这个
   * 状态可记 —— 除了**父对话不存在**（那一条是真的没有去处，记 `dropped` 并出声一次）。
   *
   * 回执（`DeliveryOutcome`）在这里**不记**：它描述的是「投递那一刻父对话是什么状态」，那是给
   * `send_to_session` 回给模型看的信息；结果回投的场景下没有谁要读它（父对话在不在跑不影响
   * 「这一条会不会落地」）。**丢掉不看是有意为之**，不是忘了。
   *
   * `source` 就是正文那行注释里的来源，**label 原样**（`补测试` / 会话 1）：拼注释归 core 的
   * `inboxEntryContent`，本文件不自己拼那一行 —— 否则壳里壳外两种写法迟早分叉。这里**不套**
   * 「会话「…」」：缺省 label 本身就是 `会话 N`，再套一层引号与「会话」前缀，模型读到的就是
   * 「来自 会话「会话 1」 自动推送」这种套娃话。（`send_to_session` 那一路的调用者是**另一段
   * 会话**而不是「这个子会话的结果」，所以它套了那一层，见 {@link senderSource}。）
   */
  async settleSegment(facts: TurnSettledFacts): Promise<void> {
    // ① 不是派生会话（用户会话 / 父对话自己那一段）：这段结算与回投无关
    const record = this.records.get(facts.conversationId);
    if (!record) return;

    // ② 先按结局改状态（`idle` / `failed` / `aborted`）：这一段已经收工了
    record.state = stateOf(facts.outcome);

    try {
      await this.deps.chatRunner.deliver(record.parentConversationId, {
        content: await this.resultBody(record, facts.outcome, facts.problem),
        source: record.label,
      });
      // 受理 = 迟早落地（攒批、复活都由执行者兜着）：不必等它跑完，也不必再试一次
      record.resultDelivered = "delivered";
    } catch (error) {
      // 唯一会走到这里的情形是父对话已经不存在：记 `dropped` 并出声一次（不重试、不补投）
      record.resultDelivered = "dropped";
      this.onError(error, "平级会话的结果没能投递给父对话");
    }
  }

  /** 投递正文：失败 / 中止时先说清原因，再附上子会话最后说的话（都截断） */
  private async resultBody(
    record: PeerSessionRecord,
    outcome: RunOutcome,
    problem: ProblemFact | null,
  ): Promise<string> {
    const summary = clip(await this.lastAssistantText(record.sessionId), RESULT_CHARS);
    const head =
      outcome === "error"
        ? `子会话失败了：${failureReason(problem)}`
        : outcome === "aborted"
          ? "子会话被中止了，下面是它停下之前说的最后一句话"
          : null;
    if (head === null) return summary.length > 0 ? summary : "子会话跑完了，但没有留下任何正文。";
    return summary.length > 0 ? `${head}\n\n${summary}` : `${head}（它没有留下任何正文）。`;
  }

  /** 子会话最后一条**有正文的**助手消息（工具消息、占位都不算） */
  private async lastAssistantText(conversationId: string): Promise<string> {
    const rows = await this.deps.messages.listByConversation(conversationId);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.role !== AgentNS.Role.Assistant) continue;
      const text = textOf(row.content);
      if (text.trim().length > 0) return text;
    }
    return "";
  }

  /**
   * 跟一段平级会话**接着说话**（`send_to_session`）。
   *
   * 与 `create` / `status` 同构的窄端口：**只收 `caller`**，不收 `label` 也不收来源名 —— 来源名
   * 由宿主解析（见 {@link senderSource}），模型 / 调用方说什么都不算数。
   *
   * ## 血缘校验就在这一层
   *
   * 「谁是谁的父」只写在 `records` 里（进程内，不落库），`AgentRegistry` 与 `Agent` 上都没有
   * 这个事实，所以判断只能在这一层。两条合法关系：
   *
   *   - **我是它的父**：`records.get(sessionId).parentConversationId === 我`；
   *   - **它是我的父**：我自己那条记录的 `parentConversationId === sessionId`（父对话是普通
   *     会话，它自己**不在** `records` 里 —— 所以这一句要靠我自己那条记录来答，不能反过来查）。
   *
   * 其余一律 `not_allowed`：**平级之间不许互发**（两段同父的子会话互不知道对方存在，让它们通
   * 话等于凭空造出一张没人负责的图），自己发给自己也不行。查不到目标记录、且它不是我的父 →
   * `gone`。两种拒绝都是**返回结果**，不抛错：模型要能按字段分支。
   *
   * ## 已知边界：`records` 不落库，所以重启之后一律 `gone`
   *
   * 宿主重启之后 `records` 是空的，`send_to_session` 对任何 id 都答 `gone`（那段会话作为普通
   * 会话还在库里，用户仍旧能接管它、接着说话）。跨重启的稳定语义（孤儿、补投）留给阶段 3 的
   * `peer_sessions` 表 —— 本文件不偷偷加表。
   */
  async send(input: PeerSessionSendInput): Promise<PeerSessionSent> {
    const callerConversationId = this.identityOf(input.caller);
    const rejection = this.rejectionOf(callerConversationId, input.sessionId);
    // 两种拒绝都是返回结果（不抛错）：模型要能按字段分支自己改变策略
    if (rejection) return { ok: false, reason: rejection };

    const source = senderSource(await this.nameOf(callerConversationId));
    const outcome = await this.deps.chatRunner.deliver(input.sessionId, {
      content: input.content,
      source,
    });
    // `state` 原样回给工具（`running` 排在它这一轮末尾 / `idle` 会把它叫起来 / `settling` 先攒着）
    return { ok: true, state: outcome.state };
  }

  /**
   * 没血缘时的拒绝原因（`undefined` = 这一条可以发）。
   *
   * 顺序不能换：**先看「它是我的父」**（那一条只能靠我自己那条记录答 —— 父对话是普通会话，
   * 它自己不在 `records` 里），再看目标在不在 `records` 里（不在 → `gone`），最后才判
   * 「我是它的父」。
   */
  private rejectionOf(
    callerConversationId: string,
    sessionId: string,
  ): "gone" | "not_allowed" | undefined {
    // 它是我的父
    if (this.records.get(callerConversationId)?.parentConversationId === sessionId) return undefined;
    // 查不到这条记录：不是我的父，也不是我知道的任何平级会话
    if (!this.records.has(sessionId)) return "gone";
    // 我是它的父；平级之间、自己发给自己都在这一支被挡下
    return this.records.get(sessionId)?.parentConversationId === callerConversationId
      ? undefined
      : "not_allowed";
  }

  /**
   * 调用方的可读名字（正文注释里那一句「来自 会话「…」」）。
   *
   * 自己就是平级会话 → 用它自己的 `label`（模型认识的那个名字）；否则用会话行上的 `name`
   * （用户给这段会话起的名字）。两者都是**宿主的事实**，不进工具参数。
   */
  private async nameOf(conversationId: string): Promise<string> {
    const own = this.records.get(conversationId);
    if (own) return own.label;
    const row = await this.deps.conversations.get(conversationId);
    if (!row) {
      // 会话行都没了：这条消息没有可信的署名（编一个名字出来只会让目标误会来源）
      throw new Error(
        `Cannot send to a peer session: conversation "${conversationId}" no longer exists`,
      );
    }
    return row.name;
  }

  /** 这个父对话手头**在跑**的平级会话有几个（限额的判据：只看 `records`） */
  private runningPeersOf(parentConversationId: string): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.parentConversationId !== parentConversationId) continue;
      if (record.state === "running") count += 1;
    }
    return count;
  }

  /** 调用方是哪段会话的（没登记过就是接线漏了：编一个会话 id 出来只会更糟） */
  private identityOf(caller: Agent): string {
    const conversationId = this.identities.get(caller);
    if (!conversationId) {
      throw new Error(
        "Cannot open a peer session: this agent is not bound to any conversation " +
          "(the host must call PeerSessionService.bind(agent, conversationId) when it builds one)",
      );
    }
    return conversationId;
  }

  private nextLabel(): string {
    this.labelSeq += 1;
    return `会话 ${this.labelSeq}`;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private onError(error: unknown, context: string): void {
    this.deps.onError?.(error, context);
  }
}

/**
 * 这次失败是不是「三级解析拿不到模型」。
 *
 * 判据是 `ConversationService.create` 的两条模型失败：解析不出来与解析出的模型不在配置里，
 * 它们都是 `config_invalid`（文案键 `error.modelUnresolved`）；点名要的模型不存在则是
 * `not_found` + `params.entity === "model"`。**只看码、不看文案**：文案会翻译。
 */
function isModelUnresolved(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const params = (error as { params?: unknown }).params;
  if (code === "config_invalid") return true;
  return (
    code === "not_found" &&
    params !== null &&
    typeof params === "object" &&
    (params as { entity?: unknown }).entity === "model"
  );
}
