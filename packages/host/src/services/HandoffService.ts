/**
 * 交接服务：把「上下文要满了」这件事办成一份写进项目的文档，以及（按选择）一段新对话。
 *
 * 对应能力编号：F-D2（三种选择）、F-D3 / D18（迁移＝开新对话，旧的完整保留）、
 * F-D4（只产文档不换会话，可反复打磨）、F-D5（一步完成）、F-D6 / D19（文档写进
 * `<cwd>/.ai-zen/handoffs/`）、F-D7（降级要说明；取消＝回到交接前，不重试不报错）、
 * D22（交接在对话停下之后触发，不在流式中途）。
 *
 * 三处刻意的分工：
 *
 * 1. **写文档那一步交给 SDK**（`HandoffService`）：模板来自磁盘上的 `handoff` Skill
 *    （读不到才用 `FALLBACK_HANDOFF_TEMPLATE`）、`self` 失败降级 `summary`、取消时回退
 *    都已在那里实现。本文件通过一个窄接口 {@link HandoffExecutor} 调它，于是用例可以在
 *    不连模型的前提下验证「降级要说明」「取消不报错」这些产品行为。
 * 2. **换会话那一步在宿主**（D18）：SDK 的 `migrate()` 换的是**同一个 agent 的内存历史**，
 *    而我们的产品口径是「旧的完整保留 + 开一段新对话」。所以本文件只调 `handoff()` 产文档，
 *    再自己开新对话、把交接摘要作为它的第一条消息写进库。
 * 3. **降级与取消是两种结果**：降级是成功（文档在，只是执行者退了一档），要说明；取消是
 *    「什么都没发生」，回 `handoff_declined`（不是失败），不重试、不留半个文档。
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
import type { Logger, ModelParams } from "@ai-zen/agents-sdk";
import {
  completeOnce,
  HandoffAbortedError,
  HandoffService as SdkHandoffService,
} from "@ai-zen/agents-sdk";
import type { HandoffMode, SdkAgent } from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language } from "../i18n/index.js";
import type { AgentFactory, ChatAgent, ChatEventEmitter } from "../runtime/ChatRunner.js";
import type { RunsView } from "../runtime/RunRegistry.js";
import type { ScopeRegistry } from "../runtime/ScopeRegistry.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { Conversation, WorkspaceRow } from "../storage/types.js";
import type { ConversationRepository } from "../storage/ConversationRepository.js";
import { HostError } from "../wire/errors.js";
import type {
  ConversationCreateParams,
  ConversationCreateResult,
  ConversationGetParams,
  ConversationGetResult,
  ConversationView,
  HandoffDocument,
  HandoffDocumentInfo,
  HandoffListDocumentsParams,
  HandoffListDocumentsResult,
  HandoffStartParams,
  HandoffStartResult,
  HandoffThen,
  ProblemFact,
} from "../wire/index.js";
import { toAgentMessage } from "./MessageService.js";
import type { NoticeService } from "./NoticeService.js";

/** 交接文档落点：`<cwd>/.ai-zen/handoffs`（PRD D19） */
export function handoffDirFor(cwd: string): string {
  return join(cwd, ".ai-zen", "handoffs");
}

/** 新对话开场摘要取多长（交接文档的前若干字符，够模型认出「这是接着上一段的」） */
const SUMMARY_EXCERPT_CHARS = 800;

/** 交接问题答完 / 交接做完之后推进状态需要的窄接口（结构上 `QuestionRepository` 满足） */
export interface QuestionMarker {
  get(id: string): Promise<unknown>;
  update(
    id: string,
    patch: { state?: string; answer?: unknown; answeredAt?: number | null; updatedAt: number },
  ): Promise<number>;
}

/** 借 / 还 Scope 的窄接口（结构上 `ScopeRegistry` 满足） */
export interface ScopeBorrower {
  acquire(workspaceId: string): Promise<Awaited<ReturnType<ScopeRegistry["acquire"]>>>;
  release(workspaceId: string): void;
}

/** 对话视图的窄接口（结构上 `ConversationService` 满足：开新对话、取旧对话的完整形状） */
export interface HandoffConversationPort {
  create(params: ConversationCreateParams): Promise<ConversationCreateResult>;
  get(params: ConversationGetParams): Promise<ConversationGetResult>;
  /**
   * 把刚 `create` 出来的对话落成真行（R56：首次发消息时才写 `conversations`）。
   *
   * 交接开的新对话第一条就是宿主写的摘要，于是它（与普通对话的首发一样）马上就有行。
   */
  ensurePersisted(conversationId: string): Promise<unknown>;
}

/** 取消交接（用户按了取消）。与「交接失败」分开：前者回到交接前，后者要说明原因。 */
export class HandoffCancelledError extends Error {
  constructor() {
    super("handoff cancelled");
    this.name = "HandoffCancelledError";
  }
}

/** 一次交接写文档的那一步要什么 */
export interface HandoffExecutionInput {
  /** 这一轮装配出来的 agent（历史已经装进去了） */
  agent: ChatAgent;
  /** 文档目录（绝对路径） */
  handoffDir: string;
  /** 请求的执行者 */
  mode: HandoffMode;
  promptTokens?: number;
  handoffTokens?: number;
}

/** 写文档的结果：文件在哪、**实际**用了哪个执行者（可能被降级） */
export interface HandoffExecutionResult {
  path: string;
  usedMode: HandoffMode;
}

/**
 * 写文档那一步的抽象。
 *
 * 默认实现走 SDK（{@link createSdkHandoffExecutor}）；用例注入替身即可验证「降级」
 * 「取消」这些路径，而不必真连模型。
 */
export type HandoffExecutor = (input: HandoffExecutionInput) => Promise<HandoffExecutionResult>;

/** `completeOnce` 吃的那种客户端（类型直接从 SDK 的签名里取，不自己 import 第三方类型） */
export type SummaryModelClient = Parameters<typeof completeOnce>[0]["client"];

export interface SdkHandoffExecutorOptions {
  /** `handoff` Skill 的查找目录（优先级从高到低）；没给就用 SDK 的兜底模板 */
  skillDirs?: string[];
  /** `summary` 模式用的客户端 / 模型 / 参数（不给就用 agent 自己的） */
  client?: SummaryModelClient;
  model?: string;
  modelConfig?: ModelParams;
  /** SDK 那边的日志口（读不到 Skill、self 降级都会在那里留一条） */
  logger?: Logger;
}

/** 按 cwd 造一个 SDK 的交接服务（接线层给 `createSdkAgentFactory` 的 `handoff` 注入点用） */
export function createSdkHandoffService(
  cwd: string,
  options: SdkHandoffExecutorOptions = {},
): SdkHandoffService {
  return new SdkHandoffService({
    handoffDir: handoffDirFor(cwd),
    skillDirs: options.skillDirs ?? [],
    client: options.client,
    model: options.model,
    modelConfig: options.modelConfig,
    logger: options.logger,
  });
}

/**
 * 默认执行者：把一次交接交给 SDK。
 *
 * 两件 SDK 事实在这里被翻译成本服务的词汇：
 *   - `HandoffAbortedError`（用户取消）→ {@link HandoffCancelledError}（取消不是失败）；
 *   - 返回的 `mode` 是**实际**用的那一档，降级时与请求的不同（F-D7 要说明的就是它）。
 */
export function createSdkHandoffExecutor(
  options: SdkHandoffExecutorOptions = {},
): HandoffExecutor {
  return async (input: HandoffExecutionInput): Promise<HandoffExecutionResult> => {
    const service = new SdkHandoffService({
      handoffDir: input.handoffDir,
      skillDirs: options.skillDirs ?? [],
      client: options.client,
      model: options.model,
      modelConfig: options.modelConfig,
      logger: options.logger,
    });
    try {
      const context = await service.handoff({
        agent: input.agent as unknown as SdkAgent,
        mode: input.mode,
        promptTokens: input.promptTokens,
        handoffTokens: input.handoffTokens,
      });
      return { path: context.handoffPath, usedMode: context.mode };
    } catch (error) {
      if (error instanceof HandoffAbortedError) throw new HandoffCancelledError();
      throw error;
    }
  };
}

export interface HandoffServiceDeps {
  conversations: ConversationRepository;
  workspaces: WorkspaceRepository;
  messages: MessageRepository;
  /** 开新对话 / 取旧对话的完整形状 */
  conversationViews: HandoffConversationPort;
  /** 借 Scope 装配 agent（与一轮对话共用同一份 Scope 计数） */
  scopes: ScopeBorrower;
  /** 装配 agent 的工厂（与 `ChatRunner` 用同一个；跑完即弃，D28） */
  createAgent: AgentFactory;
  /** 写文档那一步；缺省走 SDK */
  execute?: HandoffExecutor;
  /** 「这段对话正在跑一轮」的唯一真相（D22：交接在对话停下之后触发） */
  runs?: RunsView;
  /** 答完之后把那条问题标成已答（`handoff.start` 直接调用时用得上） */
  questions?: QuestionMarker;
  /** 通知通道（「文档写好了」这条提示，F-I8） */
  notices?: NoticeService;
  emit?: ChatEventEmitter;
  /** 交接文档模板用的 Skill 目录（给缺省执行者用） */
  skillDirs?: string[];
  now?: () => number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 请求的执行者是 SDK 认的那两档之一吗 */
function isHandoffMode(value: string): value is HandoffMode {
  return value === "self" || value === "summary";
}

/** 交接之后做什么：只产文档 / 顺带开新对话（F-D4 / F-D5） */
function isHandoffThen(value: string): value is HandoffThen {
  return value === "document_only" || value === "new_conversation";
}

export class HandoffService {
  private readonly conversations: ConversationRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly messages: MessageRepository;
  private readonly conversationViews: HandoffConversationPort;
  private readonly scopes: ScopeBorrower;
  private readonly createAgent: AgentFactory;
  private readonly execute: HandoffExecutor;
  private readonly runs?: RunsView;
  private readonly questions?: QuestionMarker;
  private readonly notices?: NoticeService;
  private readonly emit?: ChatEventEmitter;
  private readonly now: () => number;

  constructor(deps: HandoffServiceDeps) {
    this.conversations = deps.conversations;
    this.workspaces = deps.workspaces;
    this.messages = deps.messages;
    this.conversationViews = deps.conversationViews;
    this.scopes = deps.scopes;
    this.createAgent = deps.createAgent;
    this.execute = deps.execute ?? createSdkHandoffExecutor({ skillDirs: deps.skillDirs });
    this.runs = deps.runs;
    this.questions = deps.questions;
    this.notices = deps.notices;
    this.emit = deps.emit;
    this.now = deps.now ?? Date.now;
  }

  /**
   * 开始一次交接（PRD F-D2 / F-D3 / F-D4 / F-D5）。
   *
   * 顺序：确认对话停下 → 借 Scope 装配 agent 并装入历史 → 写文档 →（按 `then`）开新对话。
   * 「对话正在跑」直接 `busy`：交接回合本身就是一次模型调用，插在流式中途会把这一轮的
   * 消息数组改到一半（D22 明确交接在停下之后触发）。
   */
  async start(
    params: HandoffStartParams,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<HandoffStartResult> {
    const conversation = await this.requireConversation(params.conversationId);
    if (!isHandoffMode(params.mode)) {
      throw new HostError("invalid_params", {
        params: { field: "mode" },
        detail: { field: "mode", value: params.mode, allowed: ["self", "summary"] },
      });
    }
    if (!isHandoffThen(params.then)) {
      throw new HostError("invalid_params", {
        params: { field: "then" },
        detail: {
          field: "then",
          value: params.then,
          allowed: ["document_only", "new_conversation"],
        },
      });
    }
    if (this.runs?.isRunning(conversation.id) === true) {
      throw new HostError("busy", {
        detail: { conversationId: conversation.id, action: "handoff" },
      });
    }

    const workspace = await this.requireWorkspace(conversation.workspaceId);
    const handoffDir = handoffDirFor(workspace.cwd);
    const executed = await this.runHandoffRound(conversation, handoffDir, params.mode, language);
    const document = await this.describeDocument(executed.path, executed.usedMode);

    const degraded = executed.usedMode !== params.mode;
    const problem = degraded ? degradeFact(params.mode, executed.usedMode, language) : null;

    let newConversationId: string | null = null;
    if (params.then === "new_conversation") {
      newConversationId = await this.openFollowUpConversation(conversation, document, language);
    }
    if (params.questionId !== undefined) {
      await this.markQuestionAnswered(params.questionId, executed.usedMode);
    }
    if (this.notices) {
      await this.notices.create(
        {
          level: "info",
          code: "notice.handoffWritten",
          params: { path: document.path },
          duration: 8,
          conversationId: conversation.id,
        },
        language,
      );
    }

    const view = (await this.conversationViews.get({ conversationId: conversation.id })).conversation;
    return {
      document,
      requestedMode: params.mode,
      usedMode: executed.usedMode,
      degraded,
      problem,
      conversation: view,
      newConversationId,
    };
  }

  /**
   * 项目里已有的交接文档（PRD F-D6：写进项目，可反复打磨同一份）。
   *
   * 目录不存在就是「这个项目还没有交接过文档」—— 回空列表，不报错（第一次交接之前本来就
   * 没有这个目录）。按修改时间倒序：最近交出来的那份在列表最上面。
   */
  async listDocuments(params: HandoffListDocumentsParams): Promise<HandoffListDocumentsResult> {
    const workspace = await this.requireWorkspace(params.workspaceId);
    const dir = handoffDirFor(workspace.cwd);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return { documents: [] };
    }

    const documents: HandoffDocumentInfo[] = [];
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const path = join(dir, name);
      try {
        const stat = await fs.stat(path);
        if (!stat.isFile()) continue;
        documents.push({
          path,
          name,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch {
        // 读不到的条目跳过：列文档不该因为一个坏文件整页报错
        continue;
      }
    }
    documents.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    return { documents };
  }

  /** 装配 agent、把历史装进去、交给执行者写文档（Scope 用完就当轮归还，D28） */
  private async runHandoffRound(
    conversation: Conversation,
    handoffDir: string,
    mode: HandoffMode,
    language: Language,
  ): Promise<HandoffExecutionResult> {
    const scope = await this.scopes.acquire(conversation.workspaceId);
    try {
      const history = await this.loadHistory(conversation.id);
      const agent = await this.createAgent({
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        agentId: conversation.agentId,
        modelId: conversation.modelId,
        // 交接回合用的是与普通一轮同一个 agent 口径（会话级模型与档位）
        thinkingLevel: conversation.thinkingLevel,
        scope,
        history,
      });
      // 历史逐条追加：agent 里已经有系统提示（来自助手定义），这里补上这段对话说过的话
      for (const message of history) agent.append(message);
      return await this.execute({ agent, handoffDir, mode });
    } catch (error) {
      throw this.toHostError(error, conversation.id, language);
    } finally {
      this.scopes.release(conversation.workspaceId);
    }
  }

  /** 这一轮交给 agent 的历史：库里还在上下文里的那些（`omit` 的不发） */
  private async loadHistory(conversationId: string): Promise<AgentNS.Message[]> {
    const rows = await this.messages.listByConversation(conversationId);
    return rows.filter((row) => !row.omit).map((row) => toAgentMessage(row));
  }

  /** 文件事实：大小与写入时刻都从磁盘取，不由执行者自己报（它可能是模型） */
  private async describeDocument(path: string, mode: HandoffMode): Promise<HandoffDocument> {
    try {
      const stat = await fs.stat(path);
      return { path, bytes: stat.size, writtenAt: iso(stat.mtimeMs), mode };
    } catch (error) {
      throw new HostError("internal", {
        messageKey: "error.handoffFailed",
        params: { reason: "the handoff document is not on disk" },
        detail: { path, reason: "document_missing" },
        cause: error,
      });
    }
  }

  /**
   * 开一段新对话（PRD D18 / D19）。
   *
   * 身份与旧的那段完全一致（同 Workspace、同助手、同模型），旧对话一行都不动。第一条消息
   * 是**宿主注入**的交接摘要（`hidden`：不是用户打的字，界面上可以折起来），系统提示仍由
   * 助手定义提供 —— 接手的那一轮装配 agent 时会自然带上。
   */
  private async openFollowUpConversation(
    conversation: Conversation,
    document: HandoffDocument,
    language: Language,
  ): Promise<string> {
    const created = await this.conversationViews.create({
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
      modelId: conversation.modelId,
    });
    if (!created.conversation) {
      // 交接开新对话给的是已有项目（`workspaceId`），不会走到「目录待登记」那条路
      throw new HostError("internal", {
        detail: { reason: "conversation_not_created", workspaceId: conversation.workspaceId },
      });
    }
    const newConversationId = created.conversation.id;
    // 摘要写得进库的前提是这段对话已经有行了（R56：消息的外键指向 `conversations`）
    await this.conversationViews.ensurePersisted(newConversationId);

    const summary = await this.excerpt(document.path);
    const content = render(language, "handoff.newConversationSummary", {
      path: document.path,
      summary,
    });
    const message = new Message({
      role: AgentNS.Role.System,
      content,
      status: AgentNS.MessageStatus.Completed,
      hidden: true,
    });
    const createdAt = this.now();
    await this.messages.upsert({
      id: message.id,
      conversationId: newConversationId,
      role: AgentNS.Role.System as string,
      status: AgentNS.MessageStatus.Completed as string,
      omit: false,
      content,
      data: { hidden: true },
      createdAt,
    });

    this.emit?.("conversation.changed", {
      conversationId: newConversationId,
      workspaceId: conversation.workspaceId,
      change: "created",
      messageCount: 1,
      at: iso(createdAt),
    });
    this.emit?.("conversation.changed", {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      change: "settings_changed",
      messageCount: null,
      at: iso(createdAt),
    });
    return newConversationId;
  }

  /** 交接文档的摘要片段（读不出来就给空串：新对话仍然指向文档路径） */
  private async excerpt(path: string): Promise<string> {
    try {
      const text = await fs.readFile(path, "utf-8");
      return text.length > SUMMARY_EXCERPT_CHARS ? text.slice(0, SUMMARY_EXCERPT_CHARS) : text;
    } catch {
      return "";
    }
  }

  /**
   * 把「用户刚答的那道题」标成已答。
   *
   * `question.answer` 那条路径上已经答过了，这里只对「客户端直接调 `handoff.start` 并带上
   * questionId」的情形起作用；已经是终态的行不动（多端同时到达时不让状态来回跳）。
   */
  private async markQuestionAnswered(questionId: string, mode: HandoffMode): Promise<void> {
    if (!this.questions) return;
    const row = await this.questions.get(questionId);
    if (!row || (row as { state?: unknown }).state !== "pending") return;
    const at = this.now();
    await this.questions.update(questionId, {
      state: "answered",
      answer: { value: mode, answeredBy: null },
      answeredAt: at,
      updatedAt: at,
    });
  }

  /** 执行者 / SDK 抛出的东西收敛成宿主的错误：取消是「不交接」，其余是「没走通」 */
  private toHostError(error: unknown, conversationId: string, language: Language): HostError {
    if (HostError.is(error)) return error;
    if (error instanceof HandoffCancelledError) {
      return new HostError("handoff_declined", {
        detail: { conversationId, reason: "cancelled" },
      });
    }
    const reason = error instanceof Error ? error.message : String(error);
    return new HostError("internal", {
      messageKey: "error.handoffFailed",
      params: { reason },
      detail: { conversationId, reason, message: render(language, "error.handoffFailed", { reason }) },
      cause: error,
    });
  }

  private async requireConversation(conversationId: string): Promise<Conversation> {
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    const row = id.length === 0 ? undefined : await this.conversations.get(id);
    if (!row) {
      throw new HostError("not_found", {
        params: { entity: "conversation" },
        detail: { conversationId },
      });
    }
    return row;
  }

  private async requireWorkspace(workspaceId: string): Promise<WorkspaceRow> {
    const id = typeof workspaceId === "string" ? workspaceId.trim() : "";
    const row = id.length === 0 ? undefined : await this.workspaces.get(id);
    if (!row) {
      throw new HostError("not_found", {
        params: { entity: "workspace" },
        detail: { workspaceId },
      });
    }
    return row;
  }
}

/** 降级的说明（F-D7）：退到了哪一档、为什么 —— 两样都要给，缺一样用户就只能猜 */
function degradeFact(
  requestedMode: HandoffMode,
  usedMode: HandoffMode,
  language: Language,
): ProblemFact {
  const reason = render(language, "handoff.degradeReason.fallback");
  const params = { mode: usedMode, reason };
  return {
    code: "handoff.degraded",
    messageKey: "handoff.degraded",
    params,
    message: render(language, "handoff.degraded", params),
    detail: { requestedMode, usedMode },
  };
}
