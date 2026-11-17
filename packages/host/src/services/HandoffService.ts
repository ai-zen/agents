/**
 * 交接服务：把「这段对话装不下了」这件事办成一份写进项目的文档，以及（按选择）后面接着的那段。
 *
 * 对应能力编号：F-D2（三种选择）、F-D3 / D18（交接之后接着走）、F-D4（只产文档，可反复打磨）、
 * F-D5（一步完成）、F-D6 / D19（文档写进 `<cwd>/.ai-zen/handoffs/`）、F-D7（降级要说明；
 * 取消＝回到交接前，不重试不报错）、D22（交接在对话停下之后触发，不在流式中途）。
 *
 * ## 谁写这份文档：自交接与独立交接
 *
 * - **自交接**（`mode: "self"`）：**这一段对话自己的驱动者**接着写。宿主把一条交接指令投进它的
 *   队列（`source: { kind: "system", label: "handoff" }`），它取走这一批就开写 —— 上下文完整、
 *   能用工具核实真实状态，产出质量最好。
 * - **独立交接**（`mode: "summary"`）：另起一个**一次性驱动者**，拿当前记忆的副本去写，跑完即散。
 *   便宜、确定，也是自交接写不出来时**单向降级**的目标（反向永远不发生）。
 *
 * 自交接期间这一段处于**交接态**（`ChatRunner.beginHandoff`）：写文档那一趟的消息**不落库**
 * （它们马上要随旧记忆一起被替掉），但事件照推 —— 用户得看得见它在写（PLAN §5.3）。
 *
 * ## 这个服务不等完成，除了它自己那一趟
 *
 * `start()` 是一个 RPC 的入口，它只回「已经开始」（`{ started: true }`）：写文档要跑一阵，让
 * 回执憋在那里等于把「一次运行的产出」重新发明一遍。剩下的那一趟在本文件的私有方法里跑完，
 * 结果通过**通知**（完成 / 降级 / 取消 / 失败，PRD 4.9）与 `conversation.changed` 的
 * `memory_replaced`（提交与回滚各一条）告知。
 *
 * ## 四条结局，一处收尾
 *
 * 成功 / 降级 / 失败 / 取消都从 `runToEnd` 的 `finally` 出去：`endHandoff` 摘牌，再推一条
 * `memory_replaced`。收尾只有这样一处 —— 漏一条这段对话就一直挂着交接态（那条标记只管
 * 「不写库」，但该摘的牌不该留着）。
 *
 * ## 「写完了没有」看工具结果，不看状态
 *
 * 判定不订阅状态事件，也不看模型说的话：硬事实有两样 —— **那次写文档的工具调用的结果**，
 * 以及**盘上那个文件够不够长**（{@link HandoffService} 的 `watchDocumentWrite` 与
 * `documentReady`）。
 *
 * ## 只在空闲时发起：不按住谁，也不替谁放行
 *
 * `start()` 的入口判据只有一条：**那段对话此刻是 `idle`**。忙 / 暂停 / 没有 agent 一律当场拒
 * （`HostError("busy")`，`detail.reason = "not_idle"`），让调用方自己挑个空的时候再来。
 * 于是整趟交接既不必按暂停、也不必放行：它闲着 → 投一条指令 → 它自己变忙、自己写完 → 宿主
 * 按工具结果判「写完了没有」→ 提交。别人的话在它忙的时候进来就排在待办里，跑完之后被取走
 * 还是留在那儿都无所谓 —— 记忆随后整段被替换，什么都留不下。
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
import type { Logger, ModelParams } from "@ai-zen/agents-sdk";
import {
  completeOnce,
  FALLBACK_HANDOFF_TEMPLATE,
  HANDOFF_SKILL_ID,
  HandoffAbortedError,
  HandoffService as SdkHandoffService,
  readSkill,
} from "@ai-zen/agents-sdk";
import type { HandoffMode, SdkAgent } from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language, MessageKey } from "../i18n/index.js";
import type { AgentFactory, ChatAgent, ChatEventEmitter } from "../runtime/ChatRunner.js";
import type { ScopeRegistry } from "../runtime/ScopeRegistry.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { Conversation, WorkspaceRow } from "../storage/types.js";
import type { ConversationRepository } from "../storage/ConversationRepository.js";
import { HostError } from "../wire/errors.js";
import type {
  CompactionMode,
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
  NoticeLevel,
} from "../wire/index.js";
import { toAgentMessage } from "./MessageService.js";
import type { NoticeService } from "./NoticeService.js";

/** 交接文档落点：`<cwd>/.ai-zen/handoffs`（PRD D19） */
export function handoffDirFor(cwd: string): string {
  return join(cwd, ".ai-zen", "handoffs");
}

/** 新对话开场摘要取多长（交接文档的前若干字符，够模型认出「这是接着上一段的」） */
const SUMMARY_EXCERPT_CHARS = 800;

/**
 * 「文档算写出来了」的下限（字节）。
 *
 * 比这更小的多半是模型写了个开头就收尾了（同一道坎在 SDK 侧也这么量）。它不是产品质量的判据，
 * 只是「到底有没有落盘、写完没有」的最低限度。
 */
const MIN_HANDOFF_BYTES = 400;

/** 写文档用的那个工具名（SDK 的 `WriteTool`：参数里是 `path` 与 `content`） */
const WRITE_TOOL_NAME = "write";

/**
 * 等那次写文档的工具结果最多等多久（毫秒）。
 *
 * 等的是「那次工具调用跑完了」这一件事实，不是「这一批收口了」。它必须有尽头：模型完全可以
 * 只回一句「写好了」而根本没调工具 —— 那时永远不会有一次工具结果到来，而这一段还按着、
 * 这一趟还挂在 `inFlight` 里，没有尽头就是永久停车。到点按「这次没写出来」处置（重试一次，
 * 仍不成立就降级）。给得宽是因为写一份长文档本身就要几分钟。
 */
const HANDOFF_WRITE_WAIT_MS = 5 * 60 * 1000;

/** 交接问题答完 / 交接做完之后推进状态需要的窄接口（结构上 `QuestionRepository` 满足） */
export interface QuestionMarker {
  get(id: string): Promise<unknown>;
  update(
    id: string,
    patch: { state?: string; answer?: unknown; answeredAt?: number | null; updatedAt: number },
  ): Promise<number>;
}

/**
 * 取 Scope 的口子（结构上 `ScopeRegistry` 满足）：幂等 get-or-create。
 *
 * 没有「归还」：那个一次性驱动者用完不还，项目的 Scope 活到显式 dispose / 进程退出 ——
 * 它带着 MCP 连接，下一次（或这一段对话）还能直接复用。
 */
export interface ScopeProvider {
  create(workspaceId: string): Promise<Awaited<ReturnType<ScopeRegistry["create"]>>>;
}

/**
 * 交接要的那两个口（`ChatRunner` 结构上满足）。
 *
 * `beginHandoff` / `endHandoff` 是交接态的两个开关：交接期间那段的消息**只跳过写库、事件照推**。
 * `deliver` 是投递唯一的入口 —— 自交接的指令从这里进去，**不给 `mayStart`**：自交接写的是
 * **已经活着**的那个驱动者，交接不是复活死对话的路径（没有驱动者就降级到独立交接）。
 */
export interface HandoffRunnerPort {
  beginHandoff(conversationId: string): void;
  endHandoff(conversationId: string): void;
  deliver(
    conversationId: string,
    input: { content: AgentNS.MessageContent; source: AgentNS.MessageSource },
  ): Promise<{ userMessageId: string }>;
}

/**
 * 「这一段此刻挂着谁」的口（结构上 `AgentRegistry` 满足）。
 *
 * 两处用到它：入口判据读它报的那一格（不是 `idle` 就不发起），自交接要的是**同一个驱动者**。
 */
export interface HandoffAgentHolder {
  get(conversationId: string): ChatAgent | undefined;
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
  /**
   * 把「这段会话被压过」记到会话行上（`compactedAt` / `compactionMode`）。
   *
   * 交接开新对话（D18）就是这条路径：它与派生会话的自压（插件里的 `auto`）是两种来源，
   * 所以标记要写得能区分（这里一律 `manual`）。
   */
  markCompacted(conversationId: string, mode: CompactionMode): Promise<void>;
}

/** 取消交接（用户按了取消 / 中断）。与「交接失败」分开：前者回到交接前，后者要说明原因。 */
export class HandoffCancelledError extends Error {
  constructor() {
    super("handoff cancelled");
    this.name = "HandoffCancelledError";
  }
}

/** 一次交接写文档的那一步要什么 */
export interface HandoffExecutionInput {
  /** 这一次装配出来的驱动者 agent（历史已经装进去了） */
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
 * 「取消」这些路径，而不必真连模型。自交接不走它 —— 那条路的驱动者是**这段对话自己的**
 * 那一个（见 {@link HandoffService} 的 `writeBySelfHandoff`）。
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

/** 发一条通知要什么（语气 + 文案键 + 参数 + 持续秒数） */
interface HandoffNotice {
  level: NoticeLevel;
  code: MessageKey;
  params?: Record<string, unknown>;
  duration?: number | null;
}

/** 一次交接的环境（`start` 收下它之后由后台那一趟跑完） */
interface HandoffRun {
  conversation: Conversation;
  mode: HandoffMode;
  then: HandoffThen;
  questionId: string | undefined;
  language: Language;
}

/**
 * 一次「写文档」的结局。
 *
 * 只看两样：那次写文档的工具调用的结果（`written` / `interrupted`）、驱动者还在不在（`gone`）。
 * `missing` 是「等不到那次工具结果」—— 模型没调写工具、或调了别的工具名、或干脆只回了一句话。
 * 模型自己说了什么一概不看：话不是事实。
 */
type WriteOutcome = "written" | "missing" | "interrupted" | "gone";

/**
 * 工具参数里的目标路径（解析不出来就是 `undefined`：那一次调用本来也没写出去）。
 *
 * 判据取**参数**而不是模型的话 —— 参数是那次调用的输入，模型的话只是它自己的说法。
 */
function argumentPath(argumentsJson: string | undefined): string | undefined {
  if (!argumentsJson) return undefined;
  try {
    const parsed = JSON.parse(argumentsJson) as { path?: unknown };
    return typeof parsed?.path === "string" ? parsed.path : undefined;
  } catch {
    return undefined;
  }
}

export interface HandoffServiceDeps {
  conversations: ConversationRepository;
  workspaces: WorkspaceRepository;
  messages: MessageRepository;
  /** 开新对话 / 取旧对话的完整形状 */
  conversationViews: HandoffConversationPort;
  /** 取 Scope 装配 agent（幂等 get-or-create；用完不还，活到显式 dispose / 进程退出） */
  scopes: ScopeProvider;
  /** 装配 agent 的工厂（与 `ChatRunner` 用同一个；跑完即弃，D28） */
  createAgent: AgentFactory;
  /** 写文档那一步（独立交接）；缺省走 SDK */
  execute?: HandoffExecutor;
  /**
   * 活着的 agent 的持有者（`AgentRegistry.get`）。
   *
   * 两处用到它：入口判据读它报的那一格（不是 `idle` 就不发起），自交接要的则是它手上那个
   * 「同一个驱动者」。不注入时「没有 agent」那条入口判据永远成立（一律拒）。
   */
  agents?: HandoffAgentHolder;
  /** 交接态与投递的口（`ChatRunner`）；不注入时自交接降级到独立交接 */
  runner?: HandoffRunnerPort;
  /** 答完之后把那条问题标成已答（`handoff.start` 直接调用时用得上） */
  questions?: QuestionMarker;
  /** 通知通道（写好了 / 降级了 / 取消了 / 没走通，PRD 4.9） */
  notices?: NoticeService;
  emit?: ChatEventEmitter;
  /** 交接文档模板用的 Skill 目录（自交接的指令与缺省执行者都用它） */
  skillDirs?: string[];
  /** 后台那一趟里不该打断主流程的差错（落日志用）；不注入就不记 */
  onError?: (error: unknown, context: string) => void;
  now?: () => number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 请求的执行者是 SDK 认的那两档之一吗 */
function isHandoffMode(value: string): value is HandoffMode {
  return value === "self" || value === "summary";
}

/** 交接之后做什么：只产文档 / 顺带开一段新对话（F-D4 / F-D5） */
function isHandoffThen(value: string): value is HandoffThen {
  return value === "document_only" || value === "new_conversation";
}

export class HandoffService {
  private readonly conversations: ConversationRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly messages: MessageRepository;
  private readonly conversationViews: HandoffConversationPort;
  private readonly scopes: ScopeProvider;
  private readonly createAgent: AgentFactory;
  private readonly execute: HandoffExecutor;
  private readonly agents?: HandoffAgentHolder;
  private readonly runner?: HandoffRunnerPort;
  private readonly questions?: QuestionMarker;
  private readonly notices?: NoticeService;
  private readonly emit?: ChatEventEmitter;
  private readonly skillDirs: string[];
  private readonly onError?: (error: unknown, context: string) => void;
  private readonly now: () => number;
  /**
   * 哪几段对话正有一趟交接在跑（同一段不并排放两趟）。
   *
   * 两趟会互相摘牌：先收尾的那一趟一摘牌，后一趟写出来的东西就开始落库了 ——
   * 那正是「交接期间不落库」要防的。走得到的路只有两条：两个窗口同时点交接；一个窗口答了
   * 那道题触发了交接（那时它已变忙，入口判据会先拒），另一个窗口又发了一次 `handoff.start`。
   */
  private readonly inFlight = new Set<string>();

  constructor(deps: HandoffServiceDeps) {
    this.conversations = deps.conversations;
    this.workspaces = deps.workspaces;
    this.messages = deps.messages;
    this.conversationViews = deps.conversationViews;
    this.scopes = deps.scopes;
    this.createAgent = deps.createAgent;
    this.execute = deps.execute ?? createSdkHandoffExecutor({ skillDirs: deps.skillDirs });
    this.agents = deps.agents;
    this.runner = deps.runner;
    this.questions = deps.questions;
    this.notices = deps.notices;
    this.emit = deps.emit;
    this.skillDirs = deps.skillDirs ?? [];
    this.onError = deps.onError;
    this.now = deps.now ?? Date.now;
  }

  /**
   * 开始一次交接（PRD F-D2 / F-D3 / F-D4 / F-D5 / 4.5）。
   *
   * 入口判据：**这段对话此刻闲着、且闸没挂**（`agent.state === "idle"` 且 `!agent.paused`）。
   * 忙 / 暂停 / 没有 agent 一律当场拒（`HostError("busy")`，`detail.reason = "not_idle"`）——
   * 非空闲就不让它跑，调用方自己挑个空的时候再来。不编排「先叫停、再按住、等变闲、再放行」这些花样：
   * 它闲着就够了，整趟交接不需要暂停，也不需要放行。
   *
   * 两样分开判：`state` 说「它手上有没有活」（忙 / 闲），`paused` 说「闸挂着没有」——
   * 闸挂着时投进来的指令只会排队，等 resume 之后突然自己跑起来。
   *
   * 过了判据之后三步，然后立刻返回：
   *   1. **挂牌**（`beginHandoff`）——这一趟写出来的消息不落库，但事件照推；
   *   2. 登记 `inFlight`（同一段不并排放两趟）；
   *   3. 起一趟后台的活把它跑完（写 → 提交或回滚 → 摘牌 → 告知）。
   *
   * 回执只有「已经开始」（{@link HandoffStartResult}）：文档路径、有没有降级、成功还是取消，
   * 走通知与 `conversation.changed`。
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

    // 同一段不并排放两趟（见 {@link inFlight}）
    if (this.inFlight.has(conversation.id)) {
      throw new HostError("busy", {
        detail: { conversationId: conversation.id, reason: "handoff_in_progress" },
      });
    }

    // 入口判据：闲下来且闸没挂才让跑。忙 / 暂停时手上的活还没完（待办里也可能压着别人的话），
    // 这时候投交接指令只能排在它后面；没有 agent 更是没有人可写。三种都是「等它闲了再来」
    const agent = this.agents?.get(conversation.id);
    if (!agent || agent.state !== "idle" || agent.paused) {
      throw new HostError("busy", {
        detail: { conversationId: conversation.id, reason: "not_idle" },
      });
    }

    this.runner?.beginHandoff(conversation.id);
    this.inFlight.add(conversation.id);

    // 后台跑完那一趟：本方法不等它（它要是抛出来，只可能是写库这类不该打扰回执的差错）
    void this.runToEnd({
      conversation,
      mode: params.mode,
      then: params.then,
      questionId: params.questionId,
      language,
    });

    return { started: true };
  }

  /**
   * 这一趟交接（后台）：写文档 → 提交或回滚 → 摘牌 → 告知。
   *
   * **不抛**：四条结局（成功 / 降级 / 失败 / 取消）各自有一条出口，都从这里过。摘牌只有
   * `finally` 那一处 —— 漏一条这段对话就一直挂着交接态。
   */
  private async runToEnd(run: HandoffRun): Promise<void> {
    const { conversation } = run;
    // 写文档那一趟之前记下长度：它写在这个驱动者的记忆里，而这批话不属于这段对话的记忆
    const driver = run.mode === "self" ? this.agents?.get(conversation.id) : undefined;
    const memoryBefore = driver?.messages.length ?? 0;

    try {
      const workspace = await this.requireWorkspace(conversation.workspaceId);
      const handoffDir = handoffDirFor(workspace.cwd);
      const executed =
        run.mode === "self"
          ? await this.writeBySelfHandoff(conversation, handoffDir)
          : // 独立交接：另起一次性驱动者，拿记忆副本去写（保持原样）
            await this.writeByIndependent(conversation, handoffDir, run.mode);

      // 提交点：文档已经在盘上、够长。这里之后发生什么都不再回滚（PRD 4.5）
      const document = await this.describeDocument(executed.path, executed.usedMode);
      await this.afterCommit({ run, document, usedMode: executed.usedMode });
    } catch (error) {
      await this.rollback({ run, error, driver, memoryBefore });
    } finally {
      // 写文档那一趟说的话不属于这段对话（PRD 4.5：下一代接的是活，不是「关于交接的那场对话」）
      this.restoreMemory(driver, memoryBefore);
      // 收尾只有一处：摘牌。四条路都从这里过去
      this.inFlight.delete(conversation.id);
      this.runner?.endHandoff(conversation.id);
      // 提交与回滚都推一条「记忆换过了」：客户端据此 `message.list` 全量整段替换，
      // 把那些只在内存里的写作痕迹清掉（PLAN §5.3）
      this.emit?.("conversation.changed", {
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId ?? null,
        change: "memory_replaced",
        at: iso(this.now()),
      });
    }
  }

  /**
   * 提交之后要做的那几件（文档在盘上，记忆已经算换过了）。
   *
   * 顺序是先说「写好了」再说后面接什么：降级的那条提示必须让人看见，否则用户以为自交接成功了。
   * 这一步里的失败**不回滚**（提交之后就不能撤），只记一条日志。
   */
  private async afterCommit(input: {
    run: HandoffRun;
    document: HandoffDocument;
    usedMode: HandoffMode;
  }): Promise<void> {
    const { run, document, usedMode } = input;
    const degraded = usedMode !== run.mode;
    try {
      if (degraded) {
        // 降级要说明（F-D7）：退到了哪一档、为什么 —— 两样都给，缺一样用户就只能猜
        await this.notify(run, {
          level: "warning",
          code: "handoff.degraded",
          params: {
            mode: usedMode,
            reason: render(run.language, "handoff.degradeReason.fallback"),
          },
          duration: null,
        });
      }
      await this.notify(run, {
        level: "info",
        code: "notice.handoffWritten",
        params: { path: document.path },
        // 一条「写好了」的提示停留几秒就够，它说的是「刚刚发生了什么」
        duration: 8,
      });
      // 后面接什么（D18 / F-D5）：开新对话这一步自己会推一条 `conversation.changed(created)`
      if (run.then === "new_conversation") {
        await this.openFollowUpConversation(run.conversation, document, run.language);
      }
      if (run.questionId !== undefined) {
        await this.markQuestionAnswered(run.questionId, usedMode);
      }
    } catch (error) {
      this.onError?.(error, "handoff-after-commit");
    }
  }

  /**
   * 回滚：这段的记忆回到交接前，并告诉用户这一趟的结果。
   *
   * 两种不是一回事：
   *   - **取消**（用户按了取消，或者写着写着把它叫停了）：回到交接前，不降级、不重试、
   *     不换手 —— 留下「已换手」的假象比失败更糟（PRD 4.5）；
   *   - **失败**（模型没写出来、盘写不进去、驱动者没了）：说明原因，记忆同样回到交接前。
   *
   * 回滚**不动 inbox**：交接期间投进来的话压根没被搬过，收到什么就是什么。
   */
  private async rollback(input: {
    run: HandoffRun;
    error: unknown;
    driver: ChatAgent | undefined;
    memoryBefore: number;
  }): Promise<void> {
    const { run, error } = input;
    // 记忆回到交接前（自交接那一趟写在里面的东西截掉；它从来没落过库）
    this.restoreMemory(input.driver, input.memoryBefore);

    if (error instanceof HandoffCancelledError) {
      await this.notify(run, {
        level: "info",
        code: "error.handoffDeclined",
        duration: 8,
      });
      return;
    }

    this.onError?.(error, "handoff");
    const reason = error instanceof Error ? error.message : String(error);
    await this.notify(run, {
      level: "error",
      code: "error.handoffFailed",
      params: { reason },
      duration: null,
    });
  }

  /**
   * 自交接：**这一段对话自己的驱动者**写（PRD 4.5）。
   *
   * 不另造驱动者、不复制记忆 —— 指令从这里投进它的队列，它取走这一批就开写。
   *
   * 判定链（不订阅任何状态事件）：
   *   1. 先挂上「那次写文档的工具结果」的监听，再把指令投进去（顺序不能反）；
   *   2. 工具结果说它写了（工具名 `write` + 参数里的路径对得上）→ 再用 `documentReady` 验一次盘；
   *   3. 两道都成立才算「写完了」；不成立就同一档再问一次，两次都不行就单向降级到独立交接。
   *
   * 三条边界：
   *   - 没有驱动者就没有「同一个驱动者」这回事：单向降级到独立交接；
   *   - 投递不靠任何「先把闸打开」的前置：入口判据已经保证它此刻闲着，指令直接进它的待办；
   *   - 写不出来（工具结果等不到、盘上文件不存在或太短）也是单向降级 —— 反向永远不发生。
   *
   * 这一趟的话不落库：交接态由 `beginHandoff` 挂着（PLAN §5.3），事件照推。
   */
  private async writeBySelfHandoff(
    conversation: Conversation,
    handoffDir: string,
  ): Promise<HandoffExecutionResult> {
    const driver = this.agents?.get(conversation.id);
    const runner = this.runner;
    if (!driver || !runner) {
      return await this.writeByIndependent(conversation, handoffDir, "summary");
    }

    const path = join(handoffDir, SdkHandoffService.createHandoffFileName(this.date()));
    // 两次机会：模型常常只回一句「写好了」而文件没落盘，问一次就够（同一道坎 SDK 那边也一样）
    for (const retry of [false, true]) {
      const watched = this.watchDocumentWrite(driver, path);
      try {
        await runner.deliver(conversation.id, {
          content: await this.instruction(path, retry),
          // 这条指令是宿主注入的，不是用户说的话（`CORE.md` §3：所有 user 消息都要有来源）
          source: { kind: "system", label: "handoff" },
        });
        const outcome = await watched.written;
        // 工具结果被掐（用户把它叫停了＝放弃交接）：回到交接前，不降级也不重试
        if (outcome === "interrupted") throw new HandoffCancelledError();
        // 驱动者没了（对话被删 / 被硬杀）：不是「文档没写出来」，是这段对话已经不在了
        if (outcome === "gone") {
          throw new HostError("internal", {
            messageKey: "error.handoffFailed",
            params: { reason: "the driver went away" },
            detail: { conversationId: conversation.id, reason: "driver_gone" },
          });
        }
      } finally {
        watched.dispose();
      }
      // 落盘校验：工具结果说的是「它写了」，盘上够不够长才是事实；两道都成立才算写完了
      if (await this.documentReady(path)) return { path, usedMode: "self" };
    }
    // 写不出来：单向降级到独立交接（另起一次性驱动者 + 记忆副本）
    return await this.writeByIndependent(conversation, handoffDir, "summary");
  }

  /**
   * 独立交接：另起一个**一次性驱动者**，拿当前记忆的副本去写，跑完即散。
   *
   * 它有自己的空队列，也不属于任何记忆 —— 所以与这段对话待办里的那些话无关（PRD 4.5）。
   * Scope 用完不还（D28：它与 MCP 同生共死）。
   */
  private async writeByIndependent(
    conversation: Conversation,
    handoffDir: string,
    mode: HandoffMode,
  ): Promise<HandoffExecutionResult> {
    const scope = await this.scopes.create(conversation.workspaceId);
    const history = await this.loadHistory(conversation.id);
    const agent = await this.createAgent({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
      modelId: conversation.modelId,
      // 写文档的驱动者与普通对话同一个 agent 口径（会话级模型与档位）
      thinkingLevel: conversation.thinkingLevel,
      scope,
      history,
    });
    // 历史逐条追加：agent 里已经有系统提示（来自助手定义），这里补上这段对话说过的话
    for (const message of history) agent.append(message);
    return await this.execute({ agent, handoffDir, mode });
  }

  /**
   * 订「那次写文档的工具调用跑完了」这一件事。
   *
   * 判据是**工具结果**，不是状态：工具名（`write`）与参数里的路径对得上，才算「写文档那一次」。
   * 模型的话一概不看（它能说「写好了」而一个字没写）。
   *
   * 四种结束方式：
   *   - `written`：那次调用跑完且没被掐（盘上是否真的够长，由 `documentReady` 再说一遍）；
   *   - `interrupted`：工具结果被掐，或者驱动者被叫停了（用户按了中断＝放弃交接）；
   *   - `gone`：驱动者没了（对话被删 / 被硬杀）；
   *   - `missing`：等不到（{@link HANDOFF_WRITE_WAIT_MS} 到点）—— 模型压根没调写工具。
   *
   * 先订再投递，顺序不能反：投完之后那次调用可能已经跑完了。
   */
  private watchDocumentWrite(
    agent: ChatAgent,
    path: string,
  ): { written: Promise<WriteOutcome>; dispose: () => void } {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveOutcome: (outcome: WriteOutcome) => void = () => undefined;
    const written = new Promise<WriteOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const offs: Array<() => void> = [];
    const finish = (outcome: WriteOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const off of offs.splice(0)) off();
      resolveOutcome(outcome);
    };
    timer = setTimeout(() => finish("missing"), HANDOFF_WRITE_WAIT_MS);
    // 这个上限不该成为「进程为什么还不退」的原因
    timer.unref?.();
    offs.push(
      agent.on("toolFinished", (payload) => {
        if (!this.writesDocument(payload.toolCall, path)) return;
        // 工具消息被掐 = 这一下被中断了（`abort()` 那一趟的工具结果标成 Aborted）
        finish(
          payload.result.status === AgentNS.MessageStatus.Aborted ? "interrupted" : "written",
        );
      }),
    );
    // 闸挂上就是「用户按了中断」（PRD 4.4：中断之后闸就挂着）：放弃这次交接
    offs.push(agent.on("gate:held", () => finish("interrupted")));
    offs.push(agent.on("stopped", () => finish("gone")));
    offs.push(agent.on("killed", () => finish("gone")));
    return {
      written,
      // 收尾时把监听摘干净、把上限撤掉；还没落定的那条按「这次没写出来」处置
      dispose: () => finish("missing"),
    };
  }

  /** 这一次工具调用是不是「把文档写到那个路径」（判据：工具名 + 参数里的路径） */
  private writesDocument(toolCall: AgentNS.ToolCall, path: string): boolean {
    if (toolCall.function?.name !== WRITE_TOOL_NAME) return false;
    const written = argumentPath(toolCall.function.arguments);
    return written !== undefined && resolve(written) === resolve(path);
  }

  /** 交给同一个驱动者的指令：模板来自磁盘上的 `handoff` Skill，读不到用 SDK 的兜底模板 */
  private async instruction(handoffPath: string, retry: boolean): Promise<string> {
    if (retry) {
      return [
        `The handoff document does not exist or is too small to deliver: ${handoffPath}`,
        "Use the write tool right now to write the **complete** handoff document to that path (use the path exactly as given) and do nothing else.",
      ].join("\n");
    }
    return SdkHandoffService.createHandoffInstruction({
      skillContent: await this.skillContent(),
      handoffPath,
      toolsAvailable: true,
    });
  }

  /** 磁盘上的 `handoff` Skill 正文；读不到就回退到 SDK 的兜底模板 */
  private async skillContent(): Promise<string> {
    if (this.skillDirs.length > 0) {
      const skill = await readSkill(this.skillDirs, HANDOFF_SKILL_ID, { silent: true });
      if (skill?.content?.trim()) return skill.content;
    }
    return FALLBACK_HANDOFF_TEMPLATE;
  }

  /** 文档写出来了没有：文件在、且不小于 {@link MIN_HANDOFF_BYTES}（不读内容，避免二次读取） */
  private async documentReady(path: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path);
      return stat.isFile() && stat.size >= MIN_HANDOFF_BYTES;
    } catch {
      return false;
    }
  }

  /**
   * 把写文档那一趟从记忆里截掉（长度回到 {@link HandoffRun} 记下的那个位置）。
   *
   * 三种情形都是一句话：这批话不属于这段对话的记忆 —— 提交是「随旧记忆一起被替掉」，
   * 回滚是「回到交接前」，失败是「压根没发生过」。它们本来就没落库（交接态下只跳过写库）。
   */
  private restoreMemory(driver: ChatAgent | undefined, length: number): void {
    if (!driver || driver.messages.length <= length) return;
    driver.messages.splice(length);
  }

  /** 发一条通知（不注入通知通道时什么也不做；通知失败不该弄坏交接） */
  private async notify(run: HandoffRun, notice: HandoffNotice): Promise<void> {
    if (!this.notices) return;
    try {
      await this.notices.create(
        { ...notice, conversationId: run.conversation.id },
        run.language,
      );
    } catch (error) {
      this.onError?.(error, "handoff-notice");
    }
  }

  /** 交给驱动者的历史：库里还在上下文里的那些（`omit` 的不发） */
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
   * 助手定义提供 —— 接手的那一段装配 agent 时会自然带上。
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

    // 旧的那段被压下去了：会话行上记一笔（`manual`）。这一步顺手推了旧对话的
    // `conversation.changed`（`settings_changed`），所以下面不再为它单独推一条。
    // 写失败不影响已经做完的交接（文档在、新对话也开了）：标记是观测事实，不是交接的一步。
    await this.conversationViews
      .markCompacted(conversation.id, "manual")
      .catch(() => undefined);

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

  /** 项目里已有的交接文档（PRD F-D6：写进项目，可反复打磨同一份）。 */
  async listDocuments(params: HandoffListDocumentsParams): Promise<HandoffListDocumentsResult> {
    const workspace = await this.requireWorkspace(params.workspaceId);
    const dir = handoffDirFor(workspace.cwd);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // 目录不存在就是「这个项目还没有交接过文档」—— 回空列表，不报错（第一次交接之前本来
      // 就没有这个目录）
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
    // 按修改时间倒序：最近交出来的那份在列表最上面
    documents.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    return { documents };
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

  /** 宿主时钟的 `Date`（交接文件名按秒取时间戳，SDK 的那个静态方法吃 `Date`） */
  private date(): Date {
    return new Date(this.now());
  }
}
