/**
 * 平级会话服务（阶段 1）—— 一段对话里的模型**开另一段对话**，那边跑完把结果**推送回**发起者。
 *
 * 对应技术方案 `.ai-zen/plans/20261115-peer-sessions.md` 的阶段 1：只有「建 → 跑 → 推回 →
 * 被唤醒」这条最小闭环，没有 `send_to_session`、没有并发限额、没有超时、不落库、没有 UI 标记。
 *
 * ## 三件它负责的事
 *
 * 1. **建**：按 `conversation.create` 同一条路开一段会话（草稿 → 落真行），拿到 conversationId
 *    就是 `sessionId`，立刻开跑并**立刻返回**（不等结果 —— 等待就等于子代理，那已经存在了）。
 * 2. **记**：进程内 `Map<sessionId, record>`。不建表、不加迁移：阶段 1 的语义是「agent 自己开
 *    一段会话、跑完把结果送回去」，重启之后这些元数据没了，子会话就是一段普通会话
 *    （`/sessions` 里照样看得见、用户照样能接着用，`read_session_status` 对它回 `gone`）。
 * 3. **推**：子会话结算之后，把结果投回父对话 —— 父对话在跑就入队（`enqueue`），空闲就
 *    **唤醒**（`run`，起一轮真 turn，模型自己接着干）。
 *
 * ## 「谁在调我」为什么靠 `bind`
 *
 * core 的 `Agent` 上没有 `conversationId`（那是宿主的财产），所以宿主在造出 agent 之后调
 * {@link PeerSessionService.bind} 记一笔 `WeakMap`（agent → conversationId），工具回调里用
 * `ctx.agent` 认领调用方。**不给 core 的 `Agent` 加字段**：那是另一个包的类型，而且是
 * 「每次一轮、用完即弃」的对象，宿主侧记一笔就够，也不会泄漏（WeakMap 跟着 agent 一起回收）。
 *
 * ## 投递的并发与竞态（本文件唯一的新机制）
 *
 * 见 {@link PeerSessionService.deliver}：`enqueue` 拿到的回执说「父对话正在跑，条目会在它这一轮
 * 里落地」；`null` 说明父对话空闲，于是 `run()` 起一轮 —— 那就是唤醒。`run()` 抛错（收尾竞态
 * 的 `busy`、父对话被删的 `not_found`）只记 `dropped` 并出声，**不重试、不补投**（阶段 2 的事）。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { Agent } from "@ai-zen/agents-core";
import type {
  PeerSessionCreateInput,
  PeerSessionCreated,
  PeerSessionPort,
  PeerSessionRejectReason,
  PeerSessionState,
  PeerSessionStatus,
} from "@ai-zen/agents-sdk";

import type { ChatRunParams, ChatTurn, QueuedTurn } from "../runtime/ChatRunner.js";
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
  /** 结果有没有送到父对话手上 */
  resultDelivered: "pending" | "delivered" | "dropped";
}

/** 子会话第一轮的用户输入是谁推来的（正文最前面那行注释就写它） */
const SOURCE_FROM_PARENT = "父对话";

/** 结果正文的截断长度（模型看到的正文不必比这更长） */
const RESULT_CHARS = 1000;

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

/** 一轮的执行者（`ChatRunner` 结构上满足；两件只有它知道的事：跑中入队、空闲开一轮） */
export interface PeerSessionRunner {
  run(params: ChatRunParams): Promise<ChatTurn>;
  enqueue(params: ChatRunParams): Promise<QueuedTurn | null>;
}

/** 平级会话服务的依赖（窄接口：本文件不认识整个宿主） */
export interface PeerSessionServiceDeps {
  /** 只读父对话那一行：项目 / 助手 / 模型的口径来源 */
  conversations: {
    get(id: string): Promise<{ id: string; workspaceId: string; agentId: string } | undefined>;
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
   * 开一段平级会话：建会话 → 落真行 → 开跑 → **立刻**回 `{ sessionId, label }`。
   *
   * 两种失败是**结构化拒绝**（返回结果，不抛错）：调用方自己已经是平级会话（`depth_exceeded`，
   * 防无限分身）、子会话三级解析拿不到模型（`model_unresolved`）。其余错误照抛 —— 那是接线或
   * 环境出了真问题，编一个「拒绝」给模型反而误导它。
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

    // 2. 子会话：与 `conversation.create` 同一条路（`agentId` 缺省 = 父对话那一个，模型走三级解析）
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
    // 3. 草稿落成真行：`chatRunner.run` 只认库里那一行（R56）
    await this.deps.conversationCreator.ensurePersisted(sessionId);

    // 4. 先记账再开跑（`state: "running"` / `resultDelivered: "pending"`）：跑完的投递要靠它
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

    // 5. 开跑（受理即回）：子会话第一句的 source 写「父对话」，正文最前面那行注释由 core 加
    let turn: ChatTurn;
    try {
      turn = await this.deps.chatRunner.run({
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

    // 6. 跑完就投递（这一条只会发生一次：唤醒预算天然是 1）
    void turn.done.then(
      (settlement) => this.deliver(record, settlement.outcome, settlement.problem),
      (error: unknown) => {
        record.state = "failed";
        record.resultDelivered = "dropped";
        this.onError(error, "平级会话结算失败");
      },
    );

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
   * 把子会话的结果投回父对话（**唯一的新机制**）。
   *
   * 三步，顺序不能换：
   *   1. 先按结局改状态（`idle` / `failed` / `aborted`）；
   *   2. 读子会话最后一条助手消息、截断，失败 / 中止时正文里写明原因（用句子，不甩错误栈）；
   *   3. 投递：先 `enqueue`（父对话在跑 = 条目会落进它这一轮），拿到 `null` 说明空闲，于是
   *      `run()` **唤醒**它；`run()` 抛错（收尾竞态 / 父对话被删）记 `dropped` 并出声一次，
   *      不重试、不补投（阶段 2）。
   *
   * `source` 就是正文那行注释里的来源（`会话「<label>」`）：拼注释归 core 的
   * `inboxEntryContent`，本文件不自己拼那一行 —— 否则壳里壳外两种写法迟早分叉。
   */
  private async deliver(
    record: PeerSessionRecord,
    outcome: RunOutcome,
    problem: ProblemFact | null,
  ): Promise<void> {
    record.state = stateOf(outcome);

    const params: ChatRunParams = {
      conversationId: record.parentConversationId,
      input: { content: await this.resultBody(record, outcome, problem) },
      source: `会话「${record.label}」`,
    };

    try {
      const queued = await this.deps.chatRunner.enqueue(params);
      if (queued) {
        // 父对话正在跑：这一条会在它这一轮里落地（不新起一轮，也不打断它）
        record.resultDelivered = "delivered";
        return;
      }
      // 父对话空闲：起一轮真 turn —— 这就是「自动唤醒」，模型自己接着干
      await this.deps.chatRunner.run(params);
      record.resultDelivered = "delivered";
    } catch (error) {
      // 投递链上的任何失误都只落在这一处：记 `dropped` 并出声一次（不重试、不补投 —— 阶段 2）
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
