/**
 * 交接文档服务：把「这段会话装不下了」这件事办成一份写进项目的文档，以及（按选择）后面接着的那段。
 *
 * 名字里那个 Document 是故意的：SDK 也有一个 `HandoffService`（写文档、算新记忆的是它），
 * 而本文件是**宿主那一侧**的事 —— 入口判据、`tx` 落库、两条事件、闸开关。两个同名不同事的东西
 * 混在一个名字里，读代码的人很快就会以为「换记忆」是这里算的。
 *
 * 对应能力编号：F-D2（三种选择）、F-D3 / D18（交接之后接着走）、F-D4（只产文档，可反复打磨）、
 * F-D5（一步完成）、F-D6 / D19（文档写进 `<cwd>/.ai-zen/handoffs/`）、F-D7（降级要说明；
 * 取消＝回到交接前，不重试不报错）、D22（交接在会话停下之后触发，不在流式中途）。
 *
 * ## 谁写这份文档：两种执行者，一个实现
 *
 * - **自交接**（`mode: "self"`）：**这一段会话自己的 agent**接着写 —— 上下文完整、能用工具核实
 *   真实状态，产出质量最好。
 * - **独立摘要**（`mode: "summary"`）：一次独立的模型调用，拿这段记忆去写，没有工具。便宜、确定，
 *   也是自交接写不出来时**单向降级**的目标（反向永远不发生）。
 *
 * 两种都在 SDK 的交接服务里（`handoff()` → `runSelfHandoff()`），宿主只把它要的那个 agent 交过去。
 * 自交接期间这一段处于**交接态**（`ChatRunner.beginHandoff`）：写文档那一趟的消息**不落库**
 * （它们马上要随旧记忆一起被替掉），但事件照推 —— 用户得看得见它在写（PLAN §5.3）。
 *
 * ## 这个服务不等完成，除了它自己那一趟
 *
 * `start()` 是一个 RPC 的入口，它只回「已经开始」（`{ started: true }`）：写文档要跑一阵，让
 * 回执憋在那里等于把「一次运行的产出」重新发明一遍。剩下的那一趟在本文件的私有方法里跑完，
 * 结果通过**通知**（完成 / 降级 / 取消 / 失败，PRD 4.9）与 `session.changed` 的
 * `memory_replaced`（提交与回滚各一条）告知。
 *
 * ## 四条结局，一处收尾
 *
 * 成功 / 降级 / 失败 / 取消都从 `runToEnd` 的 `finally` 出去：`endHandoff` 摘牌、开闸（取消不开），
 * 回滚那条还推一条 `memory_replaced`。收尾只有这样一处 —— 漏一条这段会话就一直挂着交接态
 * （那条标记只管「不写库」，但该摘的牌不该留着）。
 *
 * ## 提交点之后：换记忆，不是换会话（PRD 4.5）
 *
 * 文档落在盘上（`describeDocument` 从磁盘取大小与写入时刻）就是**提交点**。从那里往后：
 *
 *   1. **旧记忆成为另一段会话**：新插一行 `sessions`（名字 `已存档_<原名>`，项目 / 助手 /
 *      模型 / 思考档位以及两条阈值、自动交接开关、血缘**照抄**，创建时刻是交接那一刻），
 *      把原会话的全部消息行改挂到它名下；
 *   2. **原会话换记忆**：把 **SDK 算好的那份记忆**写到原会话名下（系统提示那几条 + 一条
 *      `role: system` + `hidden`、正文只带文档路径的断点消息，就是 SDK 给的那一份）；内存里
 *      `agent.messages` **原地**换成同一份（不重建 agent、不动它的队列与两个开关：
 *      换记忆不等于换人）；
 *   3. **两条事件**：先 `memory_replaced`（这段的记忆换过了），再 `created`（那段 `已存档_…`
 *      出现了）。
 *
 * **分工是死的**（`PRD.md` 4.5「谁算记忆、谁落库」）：
 *
 * - 「换完之后记忆长什么样」**只有 SDK 一处算** —— 哪些旧消息留（`omit` / `prune`）、断点消息的
 *   形状、文档够不够长（不到 400 字节算没写出来）全在 SDK 的 `HandoffService.migrate()` 里算完，
 *   外部使用者用 SDK 时也是同一份；
 * - 宿主**只做「把这份记忆落到库」**：就是本文件那个 `tx`（`SessionRepository.replaceMemory`）
 *   加两条事件。断点消息就是 SDK 算出来的那一条，这里不自己拼。
 *
 * 1 与 2 的落库部分在一个 `tx` 里，所以崩在中间也不会留下「旧的已存档、新的没上岗」的第三种状态；
 * 失败则整批回滚，一段存档会话都不留。
 *
 * **两条路都注入同一份落库回调**：手动的（`execute()` → `memoryCommitter()`）与自动交接的
 * （`createSdkHandoffService()` 造的那个服务）都是这一份 —— 于是平级会话越线自动交班时，记忆真的
 * 会换、闸真的会开（`AutoMigratePlugin` → `migrate()` → 这个回调）。
 *
 * ## 写文档那一趟不在这里
 *
 * 「谁写、怎么写、写不出来怎么退一档」全在 SDK 的交接服务里，判据也在那边 —— 它用的是那次写
 * 文档的工具调用的输入与结果，不订阅状态、不等空闲、不设计时器。宿主这边只剩两件事：把这一段
 * 此刻那个 agent 交给它，以及**在它说文档写好了那一拍换记忆**（`onHandoff` 钩子 →
 * `HandoffExecutionInput.onWritten`）。
 *
 * ## 只在能立刻接手时发起：不按住谁，也不替谁放行
 *
 * `start()` 的入口判据只有一处：`ChatRunner.canHandoffNow` 报的那四条（没有 agent / 手上有活 /
 * 输出闸关着 / 已经在交），拒因就是它报的那一个词。于是整趟交接既不必按暂停、也不必放行：
 * 它闲着 → SDK 投一条指令 → 它自己变忙、自己写完 → 提交。
 *
 * ## 闸的开关各归各家
 *
 * **关闸**在交接那一批的批头（SDK 的守卫插件知道「这批带交接指令」）；**开闸**在这里的收口
 * （只有宿主知道「记忆换完了」）。所以 `runToEnd` 的收尾自己开闸：成功与失败都开 —— 进来时
 * 闸必然是开的（入口判据会拒 `output_paused`），所以不需要记「原来开着还是关着」那套；
 * **取消不开**：用户按了中断，闸是 `abort` 关上的，回滚之后就得保持暂停。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { AgentNS, Message } from "@ai-zen/agents-core";
import type { Logger, ModelParams } from "@ai-zen/agents-sdk";
import {
  completeOnce,
  HandoffAbortedError,
  HandoffService as SdkHandoffService,
} from "@ai-zen/agents-sdk";
import type { HandoffMode, MemoryCommit, SdkAgent } from "@ai-zen/agents-sdk";

import { DEFAULT_LANGUAGE, render } from "../i18n/index.js";
import type { Language, MessageKey } from "../i18n/index.js";
import type { ChatAgent, ChatEventEmitter, HandoffAvailability } from "../runtime/ChatRunner.js";
import { toRow } from "../runtime/ChatRunner.js";
import type { MessageRepository } from "../storage/MessageRepository.js";
import type { WorkspaceRepository } from "../storage/WorkspaceRepository.js";
import type { Session, WorkspaceRow } from "../storage/types.js";
import type { SessionRepository } from "../storage/SessionRepository.js";
import { HostError } from "../wire/errors.js";
import type {
  CompactionMode,
  SessionCreateParams,
  SessionCreateResult,
  SessionGetParams,
  SessionGetResult,
  SessionView,
  HandoffDocument,
  HandoffDocumentInfo,
  HandoffListDocumentsParams,
  HandoffListDocumentsResult,
  HandoffStartParams,
  HandoffStartResult,
  HandoffThen,
  NoticeLevel,
} from "../wire/index.js";
import type { NoticeService } from "./NoticeService.js";

/** 交接文档落点：`<cwd>/.ai-zen/handoffs`（PRD D19） */
export function handoffDirFor(cwd: string): string {
  return join(cwd, ".ai-zen", "handoffs");
}

/** 新会话开场摘要取多长（交接文档的前若干字符，够模型认出「这是接着上一段的」） */
const SUMMARY_EXCERPT_CHARS = 800;

/** 存档那段会话的名字前缀（PRD 4.5：名字是 `已存档_<原名>`） */
const ARCHIVED_NAME_PREFIX = "已存档_";

/**
 * 交接要的那几个口（`ChatRunner` 结构上满足）。
 *
 * - `canHandoffNow`：**能不能立刻接手这一批**（全仓只有一份判据，在 `ChatRunner` 那边）；
 * - `beginHandoff` / `endHandoff`：交接态的两个开关：交接期间那段的消息**只跳过写库、事件照推**。
 *
 * 投递不在这里：写文档那条指令由 SDK 直接投给它要的那个 agent，宿主不居中转发。
 */
export interface HandoffRunnerPort {
  canHandoffNow(sessionId: string): HandoffAvailability;
  beginHandoff(sessionId: string): void;
  endHandoff(sessionId: string): void;
}

/**
 * 「这一段此刻挂着谁」的口（结构上 `AgentRegistry` 满足）。
 *
 * 自交接要的是**同一个 agent**：`agent.messages` 就是这段会话的记忆本身，换记忆要原地换它。
 */
export interface HandoffAgentHolder {
  get(sessionId: string): ChatAgent | undefined;
}

/** 会话视图的窄接口（结构上 `SessionService` 满足：开新会话、取旧会话的完整形状） */
export interface HandoffSessionPort {
  create(params: SessionCreateParams): Promise<SessionCreateResult>;
  get(params: SessionGetParams): Promise<SessionGetResult>;
  /**
   * 把刚 `create` 出来的会话落成真行（R56：首次发消息时才写 `sessions`）。
   *
   * 交接开的新会话第一条就是宿主写的摘要，于是它（与普通会话的首发一样）马上就有行。
   */
  ensurePersisted(sessionId: string): Promise<unknown>;
  /**
   * 把「这段会话被压过」记到会话行上（`compactedAt` / `compactionMode`）。
   *
   * 交接开新会话（D18）就是这条路径：它与派生会话的自压（插件里的 `auto`）是两种来源，
   * 所以标记要写得能区分（这里一律 `manual`）。
   */
  markCompacted(sessionId: string, mode: CompactionMode): Promise<void>;
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
  /**
   * 这一次的 agent：**这一段会话此刻那个 agent**。
   *
   * 它的 `messages` 就是这段会话的记忆本身 —— 自交接由它接着写，独立摘要拿它去问模型。
   */
  agent: ChatAgent;
  /** 文档目录（绝对路径） */
  handoffDir: string;
  /** 请求的执行者 */
  mode: HandoffMode;
  /**
   * `handoff` Skill 的查找目录（优先级从高到低），按这一次交接的项目目录现算。
   *
   * 跟着**每一次**交接给、不跟着执行者构造时定：一个执行者服务所有项目的会话，构造时定死
   * 一份目录就会一直用内置兜底模板（项目里那份同名 Skill 永远读不到）。
   */
  skillDirs: string[];
  promptTokens?: number;
  handoffTokens?: number;
  /**
   * **落库的接缝**（SDK 的 `commitMemory`）：SDK 算好的那份记忆交给它，由宿主落到库。
   *
   * 它在 SDK 那次调用**内部**发生（`migrate()` 的最后一拍），于是「文档写好 → 记忆算好 → 落库」
   * 中间没有缝；`execute()` 返回之后宿主不再自己提交。抛出去就是这一趟失败（记忆由 `runToEnd`
   * 回滚，SDK 会把错原样交回来）。
   */
  commitMemory?: (commit: MemoryCommit) => void | Promise<void>;
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
 * 「取消」这些路径，而不必真连模型。两种执行者都从这一个口进：交给 SDK 的是**这一段会话
 * 此刻那个 agent**（自交接由它接着写，独立摘要拿它的记忆去问模型）。
 */
export type HandoffExecutor = (input: HandoffExecutionInput) => Promise<HandoffExecutionResult>;

/** `completeOnce` 吃的那种客户端（类型直接从 SDK 的签名里取，不自己 import 第三方类型） */
export type SummaryModelClient = Parameters<typeof completeOnce>[0]["client"];

/** 「summary」那一跳的客户端 / 模型 / 参数与日志口（两种入口共用这一份形状） */
export interface SdkHandoffExecutorOptions {
  /** `summary` 模式用的客户端 / 模型 / 参数（不给就用 agent 自己的） */
  client?: SummaryModelClient;
  model?: string;
  modelConfig?: ModelParams;
  /** SDK 那边的日志口（读不到 Skill、self 降级都会在那里留一条） */
  logger?: Logger;
}

/** 造 SDK 交接服务（插件那一路）还要一份模板目录：它是按 cwd 造出来的那一个 */
export interface SdkHandoffServiceOptions extends SdkHandoffExecutorOptions {
  /** `handoff` Skill 的查找目录（优先级从高到低）；没给就用 SDK 的兜底模板 */
  skillDirs?: string[];
  /**
   * 落库的接缝（SDK 的 `commitMemory`）：自动交接那条路的记忆就是从这里落进库的。
   *
   * 与手动那条路（`HandoffDocumentService.memoryCommitter`）注入的是**同一份回调** —— 记忆长什么样
   * 只有 SDK 那一处算，宿主只决定它落在哪儿（`PRD.md` 4.5）。
   */
  commitMemory?: (commit: MemoryCommit) => void | Promise<void>;
}

/**
 * 按 cwd 造一个 SDK 的交接服务（接线层给 `createSdkAgentFactory` 的 `handoff` 注入点用）。
 *
 * 那个 `cwd` 只用来算**文档落点**（`handoffDirFor(cwd)`）—— 新记忆长什么样不靠它：换完的记忆是
 * 「系统提示 + 断点」两截，没有 cwd 消息。两桩宿主事实在这里定下：
 *   - `strategy: "prune"`：宿主把旧记忆整段挂成另一段存档会话，原会话这边就该腾空（只留系统提示
 *     + 断点）。`omit` 那一路会把旧消息留在同一个数组里，与「改挂到存档名下」对不上；
 *   - `commitMemory`：**自动交接那条路真的会换记忆**，就靠这一格；不给就只剩 SDK 自己改内存。
 */
export function createSdkHandoffService(
  cwd: string,
  options: SdkHandoffServiceOptions = {},
): SdkHandoffService {
  return new SdkHandoffService({
    handoffDir: handoffDirFor(cwd),
    strategy: "prune",
    skillDirs: options.skillDirs ?? [],
    client: options.client,
    model: options.model,
    modelConfig: options.modelConfig,
    logger: options.logger,
    ...(options.commitMemory === undefined ? {} : { commitMemory: options.commitMemory }),
  });
}

/**
 * 默认执行者：把一次交接交给 SDK。
 *
 * 两件 SDK 事实在这里被翻译成本服务的词汇：
 *   - `HandoffAbortedError`（用户取消）→ {@link HandoffCancelledError}（取消不是失败）；
 *   - 返回的 `mode` 是**实际**用的那一档，降级时与请求的不同（F-D7 要说明的就是它）。
 */
export function createSdkHandoffExecutor(options: SdkHandoffExecutorOptions = {}): HandoffExecutor {
  return async (input: HandoffExecutionInput): Promise<HandoffExecutionResult> => {
    const commitMemory = input.commitMemory;
    const service = new SdkHandoffService({
      handoffDir: input.handoffDir,
      // 宿主把旧记忆整段挂成另一段存档会话，所以原会话这边腾空（只留系统提示 + 断点）
      strategy: "prune",
      skillDirs: input.skillDirs,
      client: options.client,
      model: options.model,
      modelConfig: options.modelConfig,
      logger: options.logger,
      // 换记忆就落在这一格：SDK 算好那份记忆之后交给宿主落库（它返回之后这里不再自己提交）
      ...(commitMemory === undefined ? {} : { commitMemory }),
    });
    try {
      // `migrate()` 而不是 `handoff()`：交接就是「写文档 + 换记忆」，只产文档的那一路是
      // 外部使用者自己选不换的（`handoff()`），宿主这条永远是两半
      const context = await service.migrate({
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
  session: Session;
  mode: HandoffMode;
  then: HandoffThen;
  language: Language;
}

export interface HandoffDocumentServiceDeps {
  sessions: SessionRepository;
  workspaces: WorkspaceRepository;
  messages: MessageRepository;
  /** 开新会话 / 取旧会话的完整形状 */
  sessionViews: HandoffSessionPort;
  /** 写文档那一步（两种执行者都从这里进）；缺省走 SDK */
  execute?: HandoffExecutor;
  /**
   * 活着的 agent 的持有者（`AgentRegistry.get`）。
   *
   * 换记忆要的是它手上那个**同一个 agent** —— `agent.messages` 就是这段会话的记忆本身，换记忆
   * 要原地换它；收口开闸也是开在它身上。所以它是必填依赖：没有它就没有可换的记忆。
   *
   * 「能不能立刻接手」那条判据不在这里读（它读的是同一个 agent 的四条事实，收在
   * `ChatRunner.canHandoffNow` 那一处）。
   */
  agents: HandoffAgentHolder;
  /**
   * 交接态与判据的口（`ChatRunner`）。
   *
   * 入口判据（`canHandoffNow`）与两个交接态开关（`beginHandoff` / `endHandoff`）都从这一个口进
   * —— 「能不能接手」与「这段在不在交接」只有一份事实，不存第二份。
   */
  runner: HandoffRunnerPort;
  /** 通知通道（写好了 / 降级了 / 取消了 / 没走通，PRD 4.9） */
  notices?: NoticeService;
  emit?: ChatEventEmitter;
  /**
   * `handoff` Skill 的查找目录：**按这次交接的项目目录现算**（`cwd → 目录清单`）。
   *
   * 与 SDK 插件（`createSdkAgentFactory` 的 `handoff` 注入点）同一份口径：项目里放一份同名 Skill
   * 就能覆盖全局那份。这里是函数而不是一份固定清单：一个服务服务所有项目的会话，构造时定死
   * 一份目录就只能一直用 SDK 的内置兜底模板。不给就是「只有兜底模板」。
   */
  skillDirs?: (cwd: string) => string[];
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

/** 交接之后做什么：只产文档 / 顺带开一段新会话（F-D4 / F-D5） */
function isHandoffThen(value: string): value is HandoffThen {
  return value === "document_only" || value === "new_session";
}

/**
 * 「agent 没了」这一个失败事实（会话被删 / 被硬杀）。
 *
 * 它不是「文档没写出来」：那一段已经不在了，而换记忆换的正是它的 `messages`。
 */
function driverGone(sessionId: string): HostError {
  return new HostError("internal", {
    messageKey: "error.handoffFailed",
    params: { reason: "the driver went away" },
    detail: { sessionId, reason: "driver_gone" },
  });
}

/**
 * 「文档没交回来」这一个失败事实：执行者跑完了，却一次都没叫 `onWritten`。
 *
 * 它不是「文档不在盘上」（那是 `describeDocument` 的 `document_missing`）：这一条说的是执行者
 * 根本没把「写完了」那一拍交回来 —— 没换记忆、也没得可换，这一趟按失败收尾。
 */
function documentNotReturned(sessionId: string): HostError {
  return new HostError("internal", {
    messageKey: "error.handoffFailed",
    params: { reason: "the handoff document never came back" },
    detail: { sessionId, reason: "document_not_returned" },
  });
}

/**
 * 这段记忆里的**系统提示**（`agent.messages` 开头那几条，由助手定义在装配时带进来）。
 *
 * 判据是「开头连续的、不隐藏的 `system` 消息」：交接断点也是 `role: system`，但它是 `hidden`
 * 的 —— 它不是系统提示，是上一代留下的路标，换记忆时不该被当作提示留下来。
 */
function systemPromptOf(messages: readonly AgentNS.Message[]): AgentNS.Message[] {
  const prompt: AgentNS.Message[] = [];
  for (const message of messages) {
    if (message.role !== AgentNS.Role.System || message.hidden === true) break;
    prompt.push(message);
  }
  return prompt;
}

export class HandoffDocumentService {
  private readonly sessions: SessionRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly messages: MessageRepository;
  private readonly sessionViews: HandoffSessionPort;
  private readonly execute: HandoffExecutor;
  private readonly agents: HandoffAgentHolder;
  private readonly runner: HandoffRunnerPort;
  private readonly notices?: NoticeService;
  private readonly emit?: ChatEventEmitter;
  private readonly skillDirs: (cwd: string) => string[];
  private readonly onError?: (error: unknown, context: string) => void;
  private readonly now: () => number;
  /**
   * 哪几段会话正有一趟交接在跑（同一段不并排放两趟）。
   *
   * 两趟会互相摘牌：先收尾的那一趟一摘牌，后一趟写出来的东西就开始落库了 ——
   * 那正是「交接期间不落库」要防的。走得到的路只有两条：两个窗口同时点交接；一个窗口答了
   * 那道题触发了交接（那时它已变忙，入口判据会先拒），另一个窗口又发了一次 `handoff.start`。
   */
  private readonly inFlight = new Set<string>();

  constructor(deps: HandoffDocumentServiceDeps) {
    this.sessions = deps.sessions;
    this.workspaces = deps.workspaces;
    this.messages = deps.messages;
    this.sessionViews = deps.sessionViews;
    this.execute = deps.execute ?? createSdkHandoffExecutor();
    this.agents = deps.agents;
    this.runner = deps.runner;
    this.notices = deps.notices;
    this.emit = deps.emit;
    this.skillDirs = deps.skillDirs ?? (() => []);
    this.onError = deps.onError;
    this.now = deps.now ?? Date.now;
  }

  /**
   * 开始一次交接（PRD F-D2 / F-D3 / F-D4 / F-D5 / 4.5）。
   *
   * 入口判据：**能不能立刻接手这一批** —— 就是 {@link HandoffRunnerPort.canHandoffNow} 报的那四条
   * （没有 agent `no_agent` / 手上有活 `working` / 输出闸关着 `output_paused` / 已经在交
   * `handoff_in_progress`），否则拒 `HostError("busy")`，`detail.reason` 就是它报的那一个词。
   * 不编排「先叫停、再按住、等变闲、再放行」这些花样：能接手就够了，整趟交接不需要暂停，
   * 也不需要放行。
   *
   * 过了判据之后三步，然后立刻返回：
   *   1. **挂牌**（`beginHandoff`）——这一趟写出来的消息不落库，但事件照推；它还顺手推一条
   *      `session.changed(handoff_started)`，让界面直说「正在交接」；
   *   2. 登记 `inFlight`（同一段不并排放两趟）；
   *   3. 起一趟后台的活把它跑完（写 → 提交或回滚 → 摘牌 → 开闸 → 告知）。
   *
   * 回执只有「已经开始」（{@link HandoffStartResult}）：文档路径、有没有降级、成功还是取消，
   * 走通知与 `session.changed`。
   */
  async start(
    params: HandoffStartParams,
    language: Language = DEFAULT_LANGUAGE,
  ): Promise<HandoffStartResult> {
    const session = await this.requireSession(params.sessionId);
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
          allowed: ["document_only", "new_session"],
        },
      });
    }

    // 同一段不并排放两趟（见 {@link inFlight}）
    if (this.inFlight.has(session.id)) {
      throw new HostError("busy", {
        detail: { sessionId: session.id, reason: "handoff_in_progress" },
      });
    }

    // 入口判据：**能不能立刻接手这一批**（四条，全仓只有这一处判据）。拒因原样报给调用方：
    // 没有 agent / 手上有活 / 输出闸关着 / 已经在交 —— 四种都是「等它行了再来」
    const available = this.runner.canHandoffNow(session.id);
    if (!available.ok) {
      throw new HostError("busy", {
        detail: { sessionId: session.id, reason: available.reason },
      });
    }

    this.runner.beginHandoff(session.id);
    this.inFlight.add(session.id);

    // 后台跑完那一趟：本方法不等它（它要是抛出来，只可能是写库这类不该打扰回执的差错）
    void this.runToEnd({
      session,
      mode: params.mode,
      then: params.then,
      language,
    });

    return { started: true };
  }

  /**
   * 这一趟交接（后台）：写文档 **+ 换记忆**（两半都在 `execute()` 里）→ 提交或回滚 → 摘牌 → 开闸 → 告知。
   *
   * **不抛**：四条结局（成功 / 降级 / 失败 / 取消）各自有一条出口，都从这里过。摘牌与开闸只有
   * `finally` 那一处 —— 漏一条这段会话就一直挂着交接态、一直不收件。
   *
   * 两个布尔各说一件事：
   *   - `committed`：记忆已经落过库（落库接缝里置上）。它之后不能再把记忆截回交接前
   *     （那时 `agent.messages` 已经是新的一份，再截就是把刚换上的剪掉）；
   *   - `cancelled`：用户把它叫停了。它决定收口开不开闸（见 `finally`）。
   */
  private async runToEnd(run: HandoffRun): Promise<void> {
    const { session } = run;
    const driver = this.agents.get(session.id);
    // 写文档那一趟之前记下长度：它写在这个 agent 的记忆里，而这批话不属于这段会话的记忆
    const memoryBefore = driver === undefined ? 0 : driver.messages.length;
    let committed = false;
    let cancelled = false;
    /** 提交点拿到的那份文档（只有落库那一拍会给） */
    let document: HandoffDocument | undefined;

    try {
      // 入口判据刚放行过，这一段转身就没了（会话被删 / 被硬杀）：没有 agent 就没有「同一个
      // agent」可写、也没有记忆可换，这一趟按失败收尾（记忆本来就是交接前的那一份）
      if (driver === undefined) throw driverGone(session.id);

      const workspace = await this.requireWorkspace(session.workspaceId);
      const handoffDir = handoffDirFor(workspace.cwd);
      // 模板目录按这次交接的项目目录现算（与 SDK 插件同一份口径）
      const skillDirs = this.skillDirs(workspace.cwd);
      // 落库接缝（两条路共用的那一个）：SDK 算好记忆就交给它，这里只把它落到库
      const memoryCommitter = this.memoryCommitter(session.id);
      // 写文档 + 换记忆都交给 SDK：它拿这个 agent 去写（自交接）或拿这段记忆去摘要（独立摘要），
      // 降级方向、记忆长什么样都由它自己算（PRD 4.5）。宿主这一侧只剩「落到库」
      const executed = await this.execute({
        agent: driver,
        handoffDir,
        mode: run.mode,
        skillDirs,
        commitMemory: async (commit) => {
          // 文件事实从磁盘取（大小与写入时刻不由执行者自己报：它可能是模型）
          document = await this.describeDocument(commit.handoffPath, commit.mode);
          // 记忆：旧记忆成为另一段会话，原会话换上 SDK 算好的那一份
          await this.commitMemory({ session, driver, memory: commit.memory, document });
          committed = true;
        },
      });

      // 执行者跑完了却一次都没落过库：文档没交回来（这一趟不算成）
      if (!committed || document === undefined) throw documentNotReturned(session.id);

      await this.afterCommit({ run, document, usedMode: executed.usedMode });
    } catch (error) {
      cancelled = error instanceof HandoffCancelledError;
      await this.rollback({ run, error });
    } finally {
      // 没提交才把写文档那一趟从记忆里截掉（它从未落库）；提交之后记忆就是新的一份了
      if (!committed) {
        this.restoreMemory(driver, memoryBefore);
        // 回滚也推一条「记忆换过了」：客户端据此整段重拉，把那些只在内存里的写作痕迹清掉
        this.emitMemoryReplaced(session);
      }
      // 收尾只有一处：摘牌。四条路都从这里过去
      this.inFlight.delete(session.id);
      this.runner.endHandoff(session.id);
      // 开闸也在收口这一处（只有宿主知道「记忆换完了」）：成功与失败都开 —— 进来时那道闸必然
      // 是开的（入口判据会拒 `output_paused`），所以这里不需要记「原来开着还是关着」。
      // **取消不开**：用户按了中断，闸是 `abort` 关上的，回滚之后就该保持暂停（PRD 4.4）。
      if (!cancelled) driver?.resumeOutput();
    }
  }

  /**
   * 造一份**落库接缝**（SDK 的 `commitMemory`），两条路注入的是同一份：
   *
   *   - 手动 / 答题那条：`runToEnd()` 把它交给 `execute()`；
   *   - 自动交接那条：`createSdkHandoffService()` 把它交给 SDK 服务（平级会话越线时，
   *     `AutoMigratePlugin` → `migrate()` → 它）。
   *
   * 它**只决定记忆落在哪儿**（记忆长什么样是 SDK 算的，`PRD.md` 4.5）：agent 与会话行按 id 现读，
   * 因为这两个都可能在这一趟期间没了（会话被删 / agent 被硬杀）—— 那时没有可换的记忆，
   * 报一个失败事实上去。
   */
  memoryCommitter(sessionId: string): (commit: MemoryCommit) => Promise<void> {
    return async (commit) => {
      const session = await this.sessions.get(sessionId);
      const driver = this.agents.get(sessionId);
      if (!session || !driver) throw driverGone(sessionId);
      const document = await this.describeDocument(commit.handoffPath, commit.mode);
      await this.commitMemory({ session, driver, memory: commit.memory, document });
    };
  }

  /**
   * 把 **SDK 算好的那份记忆**落到库（宿主只做这一步，`PRD.md` 4.5）。
   *
   * 三步顺序是死的：
   *   1. 库里一个批次（`SessionRepository.replaceMemory`）：插存档会话行 + 把旧消息行改挂
   *      过去 + 原会话写上新记忆的那几条行；
   *   2. 内存里**原地**换成同一份（不重建 agent、不动它的队列与两个开关 —— 换记忆不等于换人）；
   *   3. 推两条 `session.changed`：这段的记忆换过了、那段 `已存档_…` 出现了。
   *
   * **哪些行要写**：新记忆开头那几条**不隐藏的 system 消息**是助手定义带来的系统提示，它们不是
   * 库里的行（创建会话时也不写它们），所以跳过；其余每一条都按原样写成行 —— 宿主用的策略是
   * `prune`，于是那一条就是 SDK 算出来的断点消息（`role: system` + `hidden` + 只带路径）。
   *
   * 第 1 步失败就什么都不算换过（`runToEnd` 那边走回滚）：库里仍是交接前那一份、一段存档会话
   * 都不留 —— 那个 `tx` 要么整批成，要么整批不成。
   */
  private async commitMemory(input: {
    session: Session;
    driver: ChatAgent;
    /** SDK 算好的那份记忆（含开头那几条系统提示） */
    memory: readonly AgentNS.Message[];
    document: HandoffDocument;
  }): Promise<void> {
    const { session, driver, memory, document } = input;
    const at = this.now();
    const archivedId = randomUUID();
    // 系统提示：开头连续的、不隐藏的 system 消息（定义带来的，不落库）。断点也是 `role: system`，
    // 但它 `hidden` —— 它不是提示，是上一代留下的路标。
    const promptLength = systemPromptOf(memory).length;
    const rows = memory.slice(promptLength).map((message) => toRow(message, session.id, at));

    await this.sessions.replaceMemory({
      sessionId: session.id,
      // 存档那段：项目 / 助手 / 模型 / 思考档位，**以及两条阈值、自动交接开关、血缘**都照抄原会话，
      // 只有 id / 名字 / 创建时刻是新的（它就是交接那一刻生成的，所以按自己的时间排在列表里）
      archived: {
        id: archivedId,
        workspaceId: session.workspaceId,
        name: `${ARCHIVED_NAME_PREFIX}${session.name}`,
        agentId: session.agentId,
        modelId: session.modelId,
        thinkingLevel: session.thinkingLevel,
        // 两条阈值照抄数值（不重算、也不重新解析模型）：存档段就是原会话当时那个样子
        handoffThreshold: session.handoffThreshold,
        guardThreshold: session.guardThreshold,
        // 开关也照抄：它说的是「装不下时谁来拿主意」，跟着这段会话走，不跟着记忆走
        autoHandoff: session.autoHandoff,
        // 血缘照抄 = 交接不产生新身份：它还是同一条命的前半段，不是「模型开出来的兄弟」
        lineage: session.lineage,
        createdAt: at,
      },
      // 写回原会话的就是 SDK 算好的那几条（断点消息也是它给的那一条，这里不再自己拼一条）
      memory: rows,
    });

    // 内存侧同步：**原地**换成同一份（`agent.messages` 是这段会话的记忆本身，不重建 agent）；
    // 用的是 SDK 算好的整个数组（它已经带上了系统提示），所以这里不拼第二遍
    driver.messages.splice(0, driver.messages.length, ...memory);

    // 先说「这段的记忆换过了」，再说「那段已存档的出现了」
    this.emitMemoryReplaced(session);
    this.emit?.("session.changed", {
      sessionId: archivedId,
      workspaceId: session.workspaceId,
      change: "created",
      at: iso(at),
    });
  }

  /**
   * 自动交接那一趟的**收口**（平级会话越线，插件那一路）：把输出闸开回来。
   *
   * 为什么在这儿：闸是交接那一批的批头关上的（`HandoffGuardPlugin`），而**开闸只在宿主做** ——
   * SDK 不认识「记忆换完了」这件事（`PLAN.md` §5.3）。手动那条路在 {@link runToEnd} 的收尾里开；
   * 自动那条路没有 `runToEnd`，它只有插件的两个回声（成功 / 失败）走到这里。
   *
   * 成功与失败都开（失败之后这一段还得能收件），**取消不开**：那是用户按的停 —— 插件在取消那条路上
   * 一个回声都不发，所以这里也就不会被叫到。
   */
  settleAutoHandoff(sessionId: string): void {
    this.agents.get(sessionId)?.resumeOutput();
  }

  /** 推一条「这段的记忆换过了」（提交与回滚各推一次：客户端据此整段重拉消息） */
  private emitMemoryReplaced(session: Session): void {
    this.emit?.("session.changed", {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      change: "memory_replaced",
      at: iso(this.now()),
    });
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
      // 后面接什么（D18 / F-D5）：开新会话这一步自己会推一条 `session.changed(created)`
      if (run.then === "new_session") {
        await this.openFollowUpSession(run.session, document, run.language);
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
   *   - **失败**（模型没写出来、盘写不进去、agent 没了）：说明原因，记忆同样回到交接前。
   *
   * 这里**不碰库**：写文档那一趟从未落库，一条 `tx` 也没跑过，所以库里本来就是交接前那一份
   * （也不会多出一段存档会话）。截记忆与推 `memory_replaced` 在 `runToEnd` 的 `finally`。
   * 回滚**不动 inbox**：交接期间投进来的话压根没被搬过，收到什么就是什么。
   */
  private async rollback(input: { run: HandoffRun; error: unknown }): Promise<void> {
    const { run, error } = input;
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
   * 把写文档那一趟从记忆里截掉（长度回到 `runToEnd` 记下的那个位置）。
   *
   * 只有没提交的那几种情形会走到它：这批话不属于这段会话的记忆 —— 取消是「回到交接前」，
   * 失败是「压根没发生过」。提交之后不截：那时记忆已经换成新的一份了。
   */
  private restoreMemory(driver: ChatAgent | undefined, length: number): void {
    if (!driver || driver.messages.length <= length) return;
    driver.messages.splice(length);
  }

  /** 发一条通知（不注入通知通道时什么也不做；通知失败不该弄坏交接） */
  private async notify(run: HandoffRun, notice: HandoffNotice): Promise<void> {
    if (!this.notices) return;
    try {
      await this.notices.create({ ...notice, sessionId: run.session.id }, run.language);
    } catch (error) {
      this.onError?.(error, "handoff-notice");
    }
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
   * 开一段新会话（PRD D18 / D19）。
   *
   * 身份与旧的那段完全一致（同 Workspace、同助手、同模型），旧会话一行都不动。第一条消息
   * 是**宿主注入**的交接摘要（`hidden`：不是用户打的字，界面上可以折起来），系统提示仍由
   * 助手定义提供 —— 接手的那一段装配 agent 时会自然带上。
   */
  private async openFollowUpSession(
    session: Session,
    document: HandoffDocument,
    language: Language,
  ): Promise<string> {
    const created = await this.sessionViews.create({
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      modelId: session.modelId,
    });
    if (!created.session) {
      // 交接开新会话给的是已有项目（`workspaceId`），不会走到「目录待登记」那条路
      throw new HostError("internal", {
        detail: { reason: "session_not_created", workspaceId: session.workspaceId },
      });
    }
    const newSessionId = created.session.id;
    // 摘要写得进库的前提是这段会话已经有行了（R56：消息的外键指向 `sessions`）
    await this.sessionViews.ensurePersisted(newSessionId);

    // 旧的那段被压下去了：会话行上记一笔（`manual`）。这一步顺手推了旧会话的
    // `session.changed`（`settings_changed`），所以下面不再为它单独推一条。
    // 写失败不影响已经做完的交接（文档在、新会话也开了）：标记是观测事实，不是交接的一步。
    await this.sessionViews.markCompacted(session.id, "manual").catch(() => undefined);

    const summary = await this.excerpt(document.path);
    const content = render(language, "handoff.newSessionSummary", {
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
      sessionId: newSessionId,
      role: AgentNS.Role.System as string,
      status: AgentNS.MessageStatus.Completed as string,
      omit: false,
      content,
      data: { hidden: true },
      createdAt,
    });

    this.emit?.("session.changed", {
      sessionId: newSessionId,
      workspaceId: session.workspaceId,
      change: "created",
      at: iso(createdAt),
    });
    return newSessionId;
  }

  /** 交接文档的摘要片段（读不出来就给空串：新会话仍然指向文档路径） */
  private async excerpt(path: string): Promise<string> {
    try {
      const text = await fs.readFile(path, "utf-8");
      return text.length > SUMMARY_EXCERPT_CHARS ? text.slice(0, SUMMARY_EXCERPT_CHARS) : text;
    } catch {
      return "";
    }
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

  private async requireSession(sessionId: string): Promise<Session> {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    const row = id.length === 0 ? undefined : await this.sessions.get(id);
    if (!row) {
      throw new HostError("not_found", {
        params: { entity: "session" },
        detail: { sessionId },
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
