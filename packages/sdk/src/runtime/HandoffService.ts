import { promises as fs } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { AgentError, AgentNS, Message } from "@ai-zen/agents-core";
import type OpenAI from "openai";
import { SILENT_LOG, type LogSink } from "../shared/logger.js";
import { readSkill } from "../scope/plugins/skills/discover.js";
import { FALLBACK_HANDOFF_TEMPLATE, HANDOFF_SKILL_ID } from "../config/factory-skills.js";
import { completeOnce } from "./completeOnce.js";
import { HandoffGuardPlugin, HANDOFF_SOURCE_LABEL } from "./HandoffGuardPlugin.js";
import type { SelfHandoffOutcome, SelfHandoffWatch } from "./HandoffGuardPlugin.js";
import { WRITE_TOOL_NAME } from "../scope/plugins/builtin/WriteTool.js";
import type { SdkAgent } from "./SdkAgent.js";

/**
 * 交接文档的执行者。
 *
 * - `self`：**原 agent 在自己的会话里**停工后写（默认）。上下文完整、可用工具核实真实状态，
 *   产出质量最好；代价是多 1~2 次全量输入。
 * - `summary`：一次独立的模型调用，把序列化后的历史摘要成交接文档（无工具、无原会话上下文）。
 *   便宜、确定，但保真度低——它是**逃生模式**，也是 `self` 没写出来时的单向降级目标
 *   （`self` 那一回合自己出错的（端点 4xx、超时）不降级：那种事换个执行者也不会成）。
 */
export type HandoffMode = "self" | "summary";

/**
 * 换记忆之后的旧历史怎么处置。
 *
 * - `omit`（默认）：旧消息标 `omit: true` 留在 `agent.messages` 里（仍可回看，不再发给模型），
 *   模板那几条不标；
 * - `prune`：物理剔除旧消息，只留 `definition.messages`（系统提示等模板）。
 *
 * 两种算出来的都是「**同一份形状**」：模板 + 交接断点（`role: system` + `hidden` + 只带路径）。
 * 宿主的落库方式决定了它用哪种 —— 它把旧记忆整段挂成另一段存档会话，所以那一条路用 `prune`。
 */
export type MigrationStrategy = "omit" | "prune";

/**
 * 交接被调用方取消（`AbortSignal` 触发）。
 *
 * 单独成类型而不是复用 `Error`，原因有两个：
 *   - 调用方（如 TUI）要把「用户按了 Ctrl+C」与「交接真的失败了」区分开 ——
 *     前者应静默收尾并提示「已取消」，后者才该报错；
 *   - 它**不可降级**：`self` 被取消后绝不能退到 `summary` 再跑一遍。
 *     把「用户中止」当成「模型没写出文档」，会白白多烧一次全量输入。
 */
export class HandoffAbortedError extends Error {
  constructor() {
    super("Handoff cancelled");
    this.name = "HandoffAbortedError";
  }
}

/**
 * 错误是否来自取消。
 *
 * 两条路径都要认：
 *   - 调用方传了 `signal` 且已 `aborted`（`agent.abort()` 就是这种情况 ——
 *     它**不抛错**，core 层把消息标记成 Aborted 后正常返回）；
 *   - OpenAI SDK 在请求被 abort 时抛的 `APIUserAbortError`（`name` 为 `AbortError`）。
 */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === "AbortError" || name === "APIUserAbortError";
}

/**
 * 让一件承诺与取消信号赛跑：信号响了就用给定的那个值作答。
 *
 * 返回的 `stop()` 要把监听摧掉 —— 调用方的 signal 可能活得比这一趟长得多。没有信号时那条
 * 承诺永不落定，赛跑就等于等另一头。
 */
function abortRace<T>(
  signal: AbortSignal | undefined,
  whenAborted: T,
): { raced: Promise<T>; stop: () => void } {
  let stop = () => undefined as void;
  const raced = new Promise<T>((resolve) => {
    if (!signal) return;
    const onAbort = () => resolve(whenAborted);
    signal.addEventListener("abort", onAbort, { once: true });
    stop = () => signal.removeEventListener("abort", onAbort);
  });
  return { raced, stop };
}

/**
 * 一次交接的完整上下文 —— 贯穿「交接前 → 写文档 → 交接后」，供钩子与调用方使用。
 */
export interface HandoffContext {
  /** 当前会话 Agent（这一趟只在它的会话里再投一条指令，不换会话） */
  agent: SdkAgent;
  /** **实际**使用的执行者（`self` 失败降级后会是 `summary`） */
  mode: HandoffMode;
  /** 调用方请求的执行者 */
  requestedMode: HandoffMode;
  /** 交接文档绝对路径 */
  handoffPath: string;
  /** 交接文档正文：仅 `summary` 模式由模型返回；`self` 模式不读盘，故为 undefined */
  handoffDoc?: string;
  /** 生成文档所用模型名 */
  model: string;
  /** 当前 prompt token 用量（自动迁移时由插件提供；手动触发可省略） */
  promptTokens?: number;
  /** 上下文阈值（自动迁移时由插件提供；手动触发可省略） */
  handoffTokens?: number;
  /** 交接前消息总数 */
  messageCountBefore: number;
  /** 序列化后的历史（仅 `summary` 模式填充；`self` 模式为空串） */
  historyText: string;
}

/** 交接服务构造参数 */
export interface HandoffServiceOptions {
  /**
   * 交接文档目录（绝对路径推荐）。
   * 默认按进程 cwd 推导为 `<cwd>/.ai-zen/handoffs`；多工作区场景请显式传入，勿依赖默认值。
   */
  handoffDir?: string;
  /** 默认执行者，默认 `self`（可被 `handoff()` / `migrate()` 的参数覆盖） */
  mode?: HandoffMode;
  /** 换记忆之后的旧历史怎么处置，默认 `omit`（可被 `migrate()` 的参数覆盖） */
  strategy?: MigrationStrategy;
  /** 查找 `handoff` Skill 的目录列表（优先级从高到低）；为空则直接用兜底模板 */
  skillDirs?: string[];
  /** `summary` 模式所用客户端（可选；未传则回退到 agent.client） */
  client?: OpenAI;
  /** `summary` 模式所用模型名（可选；未传则回退到 agent.model） */
  model?: string;
  /** `summary` 模式所用模型参数（可选；未传则回退到 agent.modelConfig） */
  modelConfig?: Record<string, unknown>;
  /**
   * 交接文档有效性阈值（字节），默认 **400**（`PRD.md` 3.6 / 4.5：写出来不到 400 字节算没写出来）。
   *
   * 只看文件大小，不读内容 —— 「写出来了没有」不需要读懂它写了什么。
   */
  minHandoffBytes?: number;
  /** 交接回合开始前触发（此时 `agent.messages` 仍是完整旧历史）。抛错就让这一次交接失败 */
  onBeforeHandoff?: (ctx: HandoffContext) => void | Promise<void>;
  /**
   * 交接文档写好后触发（换记忆还没发生：记忆由 `migrate()` 算、由 {@link commitMemory} 落地）。
   * 抛错就让这一次交接失败。
   */
  onHandoff?: (ctx: HandoffContext) => void | Promise<void>;
  /**
   * 换记忆完成之后触发（`migrate()` 的最后一拍：记忆已经换上 —— 是 SDK 自己换的还是接缝落的，
   * 这里不区分）。`handoff()` 不叫它：那一路不换记忆。抛错就让这一次交接失败。
   */
  onMigrated?: (ctx: HandoffContext) => void | Promise<void>;
  /**
   * **落库的接缝**：`migrate()` 把算好的记忆交给它，由调用方落库。
   *
   * 它**不改变记忆长什么样**：哪些旧消息留、哪些标 `omit`、断点消息的形状（`role: system` + `hidden` + 正文只带路径）、文档够不够长（不到 `minHandoffBytes` 算没写出来）—— 全在
   * `migrate()` 这一处算完（`PRD.md` 4.5）。接缝只决定「这份记忆落在哪儿」：
   *   - **不注入**：SDK 自己把它换到 `agent.messages` 上 —— 外部使用者走的就是这条；
   *   - **注入**：SDK 一个字节都不动 `agent.messages`，由调用方落到库、落到内存（宿主走这条）。
   */
  commitMemory?: (commit: MemoryCommit) => void | Promise<void>;
  /** 可注入日志（可选）：不注入就什么都不写（库缺省沉默） */
  logger?: LogSink;
}

/** 交给 {@link HandoffServiceOptions.commitMemory} 的那一份 */
export interface MemoryCommit {
  /** 换完之后这段记忆**就是**这一份（开头那几条系统提示原样在里面，末尾一条交接断点） */
  memory: AgentNS.Message[];
  /** 这份记忆指向的那份交接文档（断点消息里带的就是它） */
  handoffPath: string;
  /** **实际**用的执行者（`self` 降级之后会是 `summary`） */
  mode: HandoffMode;
}

/** `handoff()` 参数 */
export interface HandoffParams {
  agent: SdkAgent;
  /** 本次执行者（覆盖构造时的默认值） */
  mode?: HandoffMode;
  /** 当前 prompt token 用量（可选，仅透传给钩子） */
  promptTokens?: number;
  /** 上下文阈值（可选，仅透传给钩子） */
  handoffTokens?: number;
  /**
   * 取消信号（可选）。触发后交接**立即停止且不降级**，抛 {@link HandoffAbortedError}。
   *
   * 这是**唯一**的取消入口（服务自己不持有句柄）：
   *   - `summary`：直接作为 `chat.completions.create` 的 RequestOptions 传下去，
   *     请求会真的被中断（否则该请求根本无从取消）；
   *   - `self`：指令是投进 agent 队列的，没法直接中断，所以每跨过一个阶段主动查一次。
   */
  signal?: AbortSignal;
}

/** `migrate()` 参数：`handoff()` 那一份 + 这一趟用哪种策略 */
export interface MigrateParams extends HandoffParams {
  /** 本趟换记忆用哪种策略（覆盖构造时的默认值） */
  strategy?: MigrationStrategy;
}

/**
 * 任务交接服务。
 *
 * 职责只有一件：`handoff()` —— **只产出交接文档**（停工 → 写文档 → 失败降级），不动会话。
 * 换记忆（开新会话、旧历史成存档、断点消息）全在宿主那一侧：那是一个库事务，SDK 不认识库。
 *
 * 模板的唯一真相源是 `handoff` Skill（`SKILL.md`）；代码只负责
 * 「读正文 → 注入 → 读不到时用兜底模板」，不持有第二份章节清单。
 *
 * ## `handingOff` 只说「这一趟自己在跑」，不是「这段会话在交接」
 *
 * 「这段会话正在交接」那份事实由宿主持有（`ChatRunner.beginHandoff` / `endHandoff`：它决定
 * 这段的消息落不落库、对外报哪一格），SDK 这一层根本不认识会话，也就不该有自己的那本账。
 * 这里的 `handingOff` 只回答一件事：**本服务这一趟是不是已经在跑**（防重入 + 让护栏插件
 * 让行）。自重入是真会发生的：自交接就是「往同一个 agent 里再投一条指令」（`push`），它跑完
 * 那一段照样落回闲 —— 不在 `handingOff` 期间让 `AutoMigratePlugin` / `ContextGuardPlugin`
 * 让行，就会「交接触发自动交接、自动交接再触发交接」无限递归，或在最满的时刻被护栏直接拒掉。
 *
 * ## 取消只认调用方递进来的 `signal`
 *
 * 服务自己不持有取消句柄（没有 `busy` 时代的 `abort()`）：谁启动这一趟，谁手里的 `signal`
 * 就是它的取消口；这一趟被取消后一律回到交接前的状态（见 {@link HandoffService.restoreBeforeHandoff}）。
 */
export class HandoffService {
  /** 交接文档兜底模板（仅在读不到 Skill 时使用） */
  static readonly FALLBACK_TEMPLATE = FALLBACK_HANDOFF_TEMPLATE;

  private readonly handoffDirPath: string;
  private readonly defaultMode: HandoffMode;
  private readonly defaultStrategy: MigrationStrategy;
  private readonly minHandoffBytes: number;
  private readonly skillDirs: string[];
  private readonly client?: OpenAI;
  private readonly model?: string;
  private readonly modelConfig?: Record<string, unknown>;
  private readonly onBeforeHandoff?: HandoffServiceOptions["onBeforeHandoff"];
  private readonly onHandoff?: HandoffServiceOptions["onHandoff"];
  private readonly onMigrated?: HandoffServiceOptions["onMigrated"];
  private readonly commitMemory?: HandoffServiceOptions["commitMemory"];
  private readonly logger: LogSink;

  /**
   * 这一趟交接是不是本服务自己在跑（防重入 + 插件让行）。
   *
   * 不是「这段会话在交接」：那份事实由宿主持有（见类注释）。
   */
  private _handingOff = false;
  /** 交接回合的工具守卫（同一实例复用 + arm/disarm，避免插件数组无限增长） */
  private guard?: HandoffGuardPlugin;
  /** 已注册过守卫的 agent（每个 agent 只 use 一次） */
  private readonly guardedAgents = new WeakSet<object>();

  constructor(options: HandoffServiceOptions = {}) {
    const {
      handoffDir,
      mode,
      strategy,
      minHandoffBytes,
      skillDirs,
      client,
      model,
      modelConfig,
      onBeforeHandoff,
      onHandoff,
      onMigrated,
      commitMemory,
      logger,
    } = options;

    this.handoffDirPath = resolvePath(handoffDir ?? join(process.cwd(), ".ai-zen", "handoffs"));
    this.defaultMode = mode ?? "self";
    this.defaultStrategy = strategy ?? "omit";
    // 400 字节是文档里的数（`PRD.md` 3.6 / 4.5），不在这里再发明一个
    this.minHandoffBytes = minHandoffBytes ?? 400;
    this.skillDirs = skillDirs ?? [];
    this.client = client;
    this.model = model;
    this.modelConfig = modelConfig;
    this.onBeforeHandoff = onBeforeHandoff;
    this.onHandoff = onHandoff;
    this.onMigrated = onMigrated;
    this.commitMemory = commitMemory;
    this.logger = logger ?? SILENT_LOG;
  }

  /** 这一趟交接是不是本服务自己在跑（`AutoMigratePlugin` / `ContextGuardPlugin` 据此让行） */
  get handingOff(): boolean {
    return this._handingOff;
  }

  /** 交接文档目录 */
  get handoffDir(): string {
    return this.handoffDirPath;
  }

  // ==================================================================
  // 静态纯工具（供上层复用 / 单测）
  // ==================================================================

  /**
   * 交接文件名：`<YYYYMMDD-HHmmss>.md`（本地时间，便于人眼归档）。
   *
   * 只有到秒的时间戳。同一秒内两次交接会撞名 —— 不做去重兜底：同一时刻并发交接
   * 本来就是调用方该避免的事，加随机后缀只会让文件名更难认。
   */
  static createHandoffFileName(date: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
      `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
    return `${stamp}.md`;
  }

  /**
   * 拼装「这次交接」的指令：`[Skill 正文] + [本次交接参数]`。
   *
   * 不在 Skill 正文里发明占位符（本体系没有模板变量引擎），参数一律由代码拼在后面，
   * 这样 Skill 只讲「怎么写」、代码只讲「写到哪、有什么能力」。
   */
  static createHandoffInstruction(params: {
    skillContent: string;
    handoffPath: string;
    /** 执行者是否具备工具能力（`summary` 模式为 false） */
    toolsAvailable: boolean;
  }): string {
    const { skillContent, handoffPath, toolsAvailable } = params;
    const tail = toolsAvailable
      ? [
          "Start writing now: use the write tool to put the complete document at the path given above (use the path exactly as given, do not rename it and do not move it to another directory).",
          "After writing, read it back once with the read tool to confirm it is complete, then reply with a single confirmation of no more than 40 words, **do not restate the document content**.",
        ]
      : [
          "Output the complete document body directly: no explanations, do not wrap it in a code block, the caller will persist it to disk itself.",
        ];

    return [
      "You are now to write a task handoff document for this session. The following handoff rules are mandatory.",
      "",
      "---",
      "",
      skillContent.trim(),
      "",
      "---",
      "",
      "## Handoff parameters",
      `- Handoff document absolute path: ${handoffPath}`,
      `- Tools available: ${
        toolsAvailable
          ? "yes (read / exec, etc., use them to verify the actual state)"
          : "no (you cannot inspect the disk, so for any state information always write '⚠️ Unverified', never speculate)"
      }`,
      "",
      ...tail,
    ].join("\n");
  }

  /**
   * 交接断点消息：换完记忆之后，接手的那一代看到的那一条。
   *
   * 形状是死的（`PRD.md` 3.6 / 4.5、`PLAN.md` §5.3）：`role: system` + `hidden`（不给人看，
   * 但照常进上下文）+ **正文只带文档路径**。不带全文：读的钱由需要细节的一方付，内联只会让
   * 之后每一条请求都携着全文。
   *
   * **只有这一处造它**：外部使用者用 SDK 时也是这一条，宿主落库时落的也是这一条。
   */
  static createPostMessages(handoffPath: string): AgentNS.Message[] {
    return [
      new Message({
        role: AgentNS.Role.System,
        content: handoffPath,
        status: AgentNS.MessageStatus.Completed,
        hidden: true,
      }),
    ];
  }

  /** 序列化消息为 `[role]: content` 文本（仅 `summary` 模式使用） */
  static serializeMessages(messages: AgentNS.Message[]): string {
    return messages
      .map((m) => {
        const role = m.role ?? "unknown";
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `[${role}]: ${content}`;
      })
      .join("\n\n");
  }

  // ==================================================================
  // 公开流程
  // ==================================================================

  /**
   * 只产出交接文档，**不改动会话**（`/handoff`）。
   *
   * 不清理历史：交接回合（指令 + 工具调用 + 回执）会留在 `agent.messages` 里，
   * 用户可继续让 agent 打磨这份文档（重写同一路径即可）。被取消时相反：整个交接
   * 回合从 `agent.messages` 里截掉，本次新建的文档也不留。
   */
  async handoff(params: HandoffParams): Promise<HandoffContext> {
    return this.withHandingOff(() => this.runHandoff(params));
  }

  /**
   * 交接 **+ 换记忆**（宿主的交接收口、自动交接、`/migrate`）。
   *
   * 两半，第二半是这方法存在的理由：
   *   1. 先跟 {@link handoff} 一样把文档写出来（写不出来就降级、再不行就抛）；
   *   2. 然后**算出换完之后那段记忆长什么样**（{@link planMemory}）并把它交给接缝。
   *
   * 「长什么样」只有这一处算：哪些旧消息留（`omit` / `prune`）、断点消息的形状
   * （`role: system` + `hidden` + 只带路径）、文档够不够长（不到 `minHandoffBytes` 算没写出来，在
   * `runSelfHandoff` 里判）—— 外部使用者用 SDK 时也是这一份，宿主不另写一遍（`PRD.md` 4.5）。
   *
   * 换完的记忆就是「模板（系统提示）+ 断点消息」这两截：**没有** cwd 消息 —— 目录随时问 `cwd`
   * 工具就行，不必往新记忆里塞一条（那一条只在创建会话时写一次）。
   *
   * 落点在哪儿就看有没有注入 {@link HandoffServiceOptions.commitMemory}：
   *   - **没注入**：SDK 自己把 `agent.messages` **原地**换成新记忆（外部使用者的路）。用 `splice`
   *     不换引用：同一个数组已经交出去了，换引用等于把别人的眼睛一起换掉（`CORE.md` §12）；
   *   - **注入了**：`agent.messages` 一个字节都不动，整份交给回调，由调用方落库、落内存。
   *     接缝不改变记忆长什么样，它只决定这份记忆落在哪儿。
   *
   * 换完才叫 `onMigrated`（恢复后的钩子就在这一拍：此刻记忆已经是新的那一份了）。
   */
  async migrate(params: MigrateParams): Promise<HandoffContext> {
    return this.withHandingOff(async () => {
      // 拿到 ctx 就是「已提交」：文档已经写好并通过校验，取消不再生效（见 `runHandoff`）
      const ctx = await this.runHandoff(params);
      const memory = this.planMemory(
        ctx.agent,
        ctx.handoffPath,
        params.strategy ?? this.defaultStrategy,
      );

      if (this.commitMemory) {
        // 宿主那一路：SDK 不动 `agent.messages`，落库与落内存都是调用方的事
        await this.commitMemory({ memory, handoffPath: ctx.handoffPath, mode: ctx.mode });
      } else {
        // 外部使用者那一路：原地换（`CORE.md` §12：已经交出去的数组不许换引用）
        ctx.agent.messages.splice(0, ctx.agent.messages.length, ...memory);
      }

      // 换记忆就是这一拍落下：叫完之后记忆已经是新的那一份
      await this.onMigrated?.(ctx);
      return ctx;
    });
  }

  /**
   * 换完之后那段记忆**就是**这一份 —— 全仓唯一一处算它。
   *
   * 开头是模板（`definition.messages`：系统提示那几条，它们不是旧记忆的一部分，换完还得在），
   * 末尾是交接断点（{@link createPostMessages}）—— 一条，只有它。中间那段看策略：
   *   - `prune`：一条不留（旧记忆整段腾空）；
   *   - `omit`：原样留着但标 `omit: true`（不再发给模型，仍可回看）—— 模板那几条不标。
   *
   * 两个地方都不改原对象：`omit` 那一路造的是拷贝（同一个消息对象被两处引用等于两份事实）。
   *
   * `definition` 可能根本没有 `messages`（手写的定义 / 替身）：按空模板处理，好让差错落在
   * 「模型该补的配置」上，而不是一个原生 `TypeError`。
   */
  private planMemory(
    agent: SdkAgent,
    handoffPath: string,
    strategy: MigrationStrategy,
  ): AgentNS.Message[] {
    const templateMessages = agent.definition?.messages ?? [];
    // 尾巴只有一条：断点（「旧记忆到这里为止」）
    const tail = HandoffService.createPostMessages(handoffPath);

    if (strategy === "prune") return [...templateMessages, ...tail];

    // `omit`：模板那几条（与正文长度取小，防模板比历史还长）原样留，其余标 omit
    const preserveCount = Math.min(templateMessages.length, agent.messages.length);
    return [
      ...agent.messages.map((message, index) =>
        index >= preserveCount ? { ...message, omit: true } : message,
      ),
      ...tail,
    ];
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 串行化 + 防重入：本服务同一时刻只跑一趟交接。
   *
   * 只管「这一趟自己在跑」（不是「这段会话在交接」——那份事实在宿主那里），所以不需要
   * 跨实例的锁，也不持有取消句柄：取消只认调用方递进来的 `signal`。
   */
  private async withHandingOff<T>(fn: () => Promise<T>): Promise<T> {
    if (this._handingOff)
      throw new Error("A handoff is already in progress, wait for it to finish");
    this._handingOff = true;
    try {
      return await fn();
    } finally {
      this._handingOff = false;
    }
  }

  /** 取消点检查：每跨过一个阶段就确认一次，避免取消后继续往下一步冲 */
  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new HandoffAbortedError();
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 取消后清掉半成品文档。
   *
   * 只删「本次新建」的文件：交接文件名含时间戳，正常不会撞已有文件，但调用方也
   * 可以把 `handoffDir` 指向人工目录；不管怎样都不该删掉别人的文件。
   * 留着半成品更糟 —— 下一回接手方会把不完整的内容当成真实交接读进去。
   */
  private async discardPartialFile(path: string, existedBefore: boolean): Promise<void> {
    if (existedBefore) return;
    try {
      await fs.unlink(path);
    } catch {
      /* 文件本就没写出来：忽略 */
    }
  }

  /**
   * 跑完一次交接，取消时**由本方法统一回退**。
   *
   * 为什么回退只写在这一处：取消可能从任何一个阶段冒出来（`self` 回合后的主动检查、
   * `summary` 请求被 abort、前置的 `readSkillContent`），分散到各自的 catch 里就会
   * 漏掉「文档已落盘但还没提交」这种半成品状态。这里一次拿全三件事：
   * 交接前的消息条数、文档路径、以及「文档本就不存在」这个事实。
   *
   * 取消形态有两类，都要认：{@link HandoffAbortedError}（主动检查）与底层 abort 错误
   * （OpenAI 的 `APIUserAbortError`）。调用方只需要认前者。
   *
   * **本方法不开输出闸**：开闸的时刻是「记忆换定了」，而换记忆在宿主那一侧（这一趟只产出
   * 一份文档）；SDK 拿到写文档结果时换记忆还没发生，这时候开闸会让这期间落进来的话
   * 落进即将被换掉的旧记忆。开闸由宿主在交接收口做。
   */
  private async runHandoff(params: HandoffParams): Promise<HandoffContext> {
    const { agent, promptTokens, handoffTokens, signal } = params;
    const requestedMode = params.mode ?? this.defaultMode;
    const handoffPath = join(this.handoffDirPath, HandoffService.createHandoffFileName(new Date()));
    const model = this.model ?? agent.model;
    const messageCountBefore = agent.messages.length;
    // 只删「本次新建」的文档：交接文件名含时间戳，正常不会撞已有文件，但调用方也可以
    // 把 `handoffDir` 指向人工目录，不管怎样都不该删掉别人的文件
    const existedBefore = await this.fileExists(handoffPath);

    try {
      // 交接前上下文（不含文档，语义固定）
      const beforeCtx: HandoffContext = {
        agent,
        mode: requestedMode,
        requestedMode,
        handoffPath,
        model,
        promptTokens,
        handoffTokens,
        messageCountBefore,
        historyText: "",
      };
      await this.onBeforeHandoff?.(beforeCtx);
      this.throwIfAborted(signal);

      // ---- 执行者：self 优先，不可用/没写出来才单向降级 summary ----
      // 「没写出来」以外的抛出（端点 4xx、超时、core 内部错）不从这条道走：它们原样穿到调用方
      let mode = requestedMode;
      let handoffDoc: string | undefined;
      let historyText = "";

      if (mode === "self" && !this.supportsSelfHandoff(agent)) {
        this.logger.warn(
          "[handoff] agent has no write tool or is not a resident session, falling back to standalone summary mode",
        );
        mode = "summary";
      }

      if (mode === "self") {
        const ok = await this.runSelfHandoff(agent, handoffPath, signal);
        if (!ok) {
          this.logger.warn(
            "[handoff] self handoff failed, falling back to standalone summary mode",
          );
          mode = "summary";
        }
      }

      if (mode === "summary") {
        // 这一档没有「那一批」（不投指令、不进队列），所以没人替它关闸 —— 生成摘要之前自己关。
        // 开闸同样不在这里：换记忆在宿主那一侧，由它在交接收口开（见方法注释）。
        if (!agent.isOutputPaused) agent.pauseOutput();
        historyText = HandoffService.serializeMessages(agent.messages.filter((m) => !m.omit));
        handoffDoc = await this.generateSummary(agent, historyText, handoffPath, signal);
        await this.writeHandoffFile(handoffPath, handoffDoc);
      }

      // 最后一道取消点：即使两步都跑完，只要期间被取消就不能算成功。跨过这一步就是
      // 「已提交」——之后的 `onHandoff` 钩子（宿主在那一拍换记忆）不再响应取消
      this.throwIfAborted(signal);

      const ctx: HandoffContext = {
        agent,
        mode,
        requestedMode,
        handoffPath,
        handoffDoc,
        model,
        promptTokens,
        handoffTokens,
        messageCountBefore,
        historyText,
      };

      await this.onHandoff?.(ctx);
      // 闸不开：开闸的时刻是「记忆换定了」，而那一步在宿主那一侧（见方法注释）
      return ctx;
    } catch (err) {
      if (!(err instanceof HandoffAbortedError) && !isAbortError(err, signal)) {
        throw err;
      }
      // 取消：交接回合截掉、半成品文档删掉（闸不在这里开：用户按的停由用户开，
      // 这一趟自己关的那一道由宿主在收口时按实际情形开）
      await this.restoreBeforeHandoff({ agent, messageCountBefore, handoffPath, existedBefore });
      throw new HandoffAbortedError();
    }
  }

  /**
   * 取消后回到交接前的状态：把交接回合追加的消息全部截掉，并删掉本次新建的文档。
   *
   * 为什么必须截消息：`self` 模式的交接回合是「一条几 KB 的 Skill 指令 user 消息 +
   * 工具结果 + 回执」，留在 `agent.messages` 里既让用户看到半段无关会话，也让下一次
   * 请求把它当历史再发一遍（`↑` 翻历史还会把它翻出来）。`agent.messages` 是唯一真相源，
   * 截回原长度之后，转录、历史、用量全都自动复位，不需要第二处补偿。
   */
  private async restoreBeforeHandoff(params: {
    agent: SdkAgent;
    messageCountBefore: number;
    handoffPath: string;
    existedBefore: boolean;
  }): Promise<void> {
    const { agent, messageCountBefore, handoffPath, existedBefore } = params;
    if (agent.messages.length > messageCountBefore) agent.messages.splice(messageCountBefore);
    await this.discardPartialFile(handoffPath, existedBefore);
  }

  /**
   * 自交接是否可用：需要 `write` 工具（名字只由 {@link WRITE_TOOL_NAME} 命名一次），
   * 且 agent 是**常驻**的。
   *
   * 为什么要看 `lifetime`：自交接靠「往同一个会话里投一条指令」实现，而一次性 agent
   * 开跑即关收（第二次 `push` 抛 `closed`），且跑完就死透（`CORE.md` §1）—— 它根本没
   * 有「再问一次」这种能力。
   */
  private supportsSelfHandoff(agent: SdkAgent): boolean {
    if (agent.lifetime === "one-shot") return false;
    return Boolean(agent.tools?.some((tool) => tool.function?.name === WRITE_TOOL_NAME));
  }

  /**
   * 自交接：让原 agent 停下手里的活，把文档写到那个路径上。
   *
   * ## 判据是那次写文档的工具调用
   *
   * 指令投进去之后只等两个事实，两个都来自 core 的钩子（{@link HandoffGuardPlugin}）：
   *   - 「工具名 `write` + 路径等于交接路径」的那次调用回来了 → 写完了（`onToolEnd`）；
   *   - 那一批收口了还没见到它 → 没写出来（`onOuterLoopEnd`）。
   *
   * 不看状态、不等 `idle`、不设计时器：模型可以只回一句「写好了」而一个字没写，那种情形下它
   * 连工具都没调，「这一批收口」这一拍就是结论，不必等谁到点。
   *
   * ## 门与判据挂在同一处
   *
   * `arm()` 之后守卫同时干两件事：交接期间只放行写这份文档的那次调用（别的写操作软拒，见
   * PRD 3.6），以及把上面那两个事实报回来。于是「只许写这份文档」与「写完了没有」用的是同一份
   * 输入 —— 工具参数里的路径，谁也绕不过谁。
   *
   * **只投一次**：没写出来就是没写出来，不「再问一次」。第二次投递要能跑就得先把闸开开，
   * 一开闸，这期间用户压着的件就跟着那一批一起被取走，而那一趟仍然要换记忆 —— 同一个误伤。
   * 一次投递、一次结论：闸只关一次，开闸在宿主交接收口。
   *
   * ## 判据只有一条：文档写出来了没有
   *
   * 这一次交接成不成，只看那一批里有没有出现那次写：出现了就是成了（文档在盘上），没出现就是
   * 没成。这一回合里报过的错（端点 4xx、超时、core 内部错、插件抛错）**只是「为什么没写出来」
   * 的解释**，不是判据本身 —— 模型先撞一次错、缓过来照样把文档写成的，是一次**成功的**交接，
   * 不该被那个错反过来判死。
   *
   * 于是四种情形，各自的姿势：
   *
   *   - **写出来了**：`failures` 一律不看。文档已经落盘，之后再冒的错与这一次交接无关，不该
   *     反过来把一份写好的文档判死；
   *   - **这个会话已经没了**（`gone`）：回 `false`，先于「写没写过」—— 没有可写的东西，也别为
   *     一个死掉的会话白烧一次全量输入；
   *   - **没写出来，且这一回合报过错**：那个错就是真因，**原样抛给调用方**。降级 summary 会为
   *     一次已经失败的请求再烧一次全量输入，而用户只拿到一行 warn；
   *   - **没写出来，且一个错都没报**（齐根没调写工具 / 只说了句「写好了」）：回 `false`，交上层
   *     单向降级 summary —— 那是逃生模式，一次写不成还有第二条路。
   *
   * 「这一回合报过错」这个事实 core 不从 `start()` 往外招（`Agent.start()` 的注释：一次请求挂了
   * 就是一次挂了，循环接着等下一个事件），它报成 `failed` 事件 —— 所以这一回合期间订阅它一次，
   * 只为了在「没写出来」时答得出为什么。
   *
   * **取消不算失败**：用户按了中断就抛 {@link HandoffAbortedError}，既不重试也不降级。取消的
   * 善后（删文档、截消息）不在这里做 —— 交给 {@link runHandoff} 的 catch 一处处理。
   */
  private async runSelfHandoff(
    agent: SdkAgent,
    handoffPath: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    // 已经不收件了（用户让它停）：此刻投进去只会排在队里，等放行之后突然自己跑起来 —— 这一趟当没跑成
    if (agent.isOutputPaused) return false;

    const guard = this.ensureGuard(agent);
    const skillContent = await this.readSkillContent();
    const cwd = (agent as { scope?: { cwd?: string } }).scope?.cwd ?? process.cwd();

    /*
     * 这一回合里 core 报过的错（端点 4xx / 超时 / core 内部错 / 插件抛错）。
     * 只在这个窗口里听：订阅与 `guard.arm()` 同一拍开，`finally` 里一定撕。
     */
    const failures: Error[] = [];
    const stopWatchingFailures = agent.on("failed", ({ error }) => {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    });

    /*
     * 交接期间护栏的让行由 `ContextGuardPlugin.isSuspended` 负责（接线为
     * `() => handoffService.handingOff`），这里不去改写用量数据：「谁做限制谁放宽」
     * —— 限制在护栏自己身上，放宽也必须写在护栏的选项里。
     */
    try {
      const instruction = HandoffService.createHandoffInstruction({
        skillContent,
        handoffPath,
        toolsAvailable: true,
      });

      const watch = guard.arm(handoffPath, cwd);
      const outcome = await this.pushAndWatch(agent, watch, instruction, signal);
      // `agent.abort()` 不抛错，取消要主动看一眼（见方法注释）
      this.throwIfAborted(signal);
      // 那一下被掐（用户把它叫停了）：回到交接前，不降级
      if (outcome === "interrupted") throw new HandoffAbortedError();
      // 这个会话已经不在了：没有可写的东西，也别为一个死掉的会话白烧一次全量输入
      if (outcome === "gone") return false;
      // 这一批收口了还没见到那次写：这一次交接没成，`failures` 只解释「为什么没写出来」
      if (outcome !== "written") {
        // 没写出来的真因是这一趟里报过的那个错：原样交上去，不许降级 summary 再烧一次全量输入
        if (failures.length > 0) throw failures[0];
        // 一个错都没报，模型只说了句「写好了」而一个字没写：交上层降级
        return false;
      }
      // 写出来了：这一次交接已经成，`failures` 从此一律不看（文档在盘上，之后冒的错与它无关）
      // 等这一批收口：此后这个会话的消息不再增长，要换掉的就是定了的这一份
      await this.waitRoundOver(watch, signal);
      // 写出来了没有：文件在不在、够不够长（默认 400 字节，`PRD.md` 3.6）。
      // 这一格与断点消息的形状同在 SDK 一处算 —— 宿主不再自己量一遍（`PRD.md` 4.5）。
      return await this.isHandoffFileReady(handoffPath);
    } catch (err: any) {
      // 取消不是失败：它要一路走到 {@link runHandoff} 的收尾那里（删半成品、截消息）
      if (err instanceof HandoffAbortedError) throw err;
      // agent 已经关门：不是「文档没写出来」，是「这个会话已经不在了」。降级 summary 会
      // 为一个死掉的会话白烧一次全量输入，所以直接把 `closed` 往上交（调用方该知道这件事）
      if (err instanceof AgentError && err.code === "closed") throw err;
      if (isAbortError(err, signal)) throw new HandoffAbortedError();
      // 其余一切都不是「模型没写出来」：原样抛给调用方，由它报失败（宿主 `onFailed`）
      // 并把输出闸开回来。从前这里只记一行 `logger.error` 再回 `false`，于是上层把
      // `mode` 降成 summary、再烧一次全量输入 —— 用户付两次钱，只换到一行 warn。
      throw err;
    } finally {
      stopWatchingFailures();
      guard.disarm();
    }
  }

  /**
   * 把一条指令投进它的队列，然后等这一趟的结论。
   *
   * core 只有投递（`CORE.md` §1：常驻会话只 `push`，不看返回值），所以这里投完就等钩子报回来的
   * 事实，不去问状态。关门之后 `push` 抛 `AgentError("closed")` —— 那是调用方违约，不接，
   * 让它一路走到 {@link runSelfHandoff} 的 catch（那里原样再往上交）。
   */
  private async pushAndWatch(
    agent: SdkAgent,
    watch: SelfHandoffWatch,
    content: string,
    signal?: AbortSignal,
  ): Promise<SelfHandoffOutcome> {
    // 叫起来（幂等；不 await —— 那句 promise 到死才 resolve）
    void agent.start();
    agent.push({
      content,
      priority: "low",
      // 这条指令是**宿主侧**（`/handoff` 命令、自动迁移）注入的，不是用户说的话 ——
      // 按「谁注入谁填」给它一个 system 来源（`CORE.md` §3）
      source: { kind: "system", label: HANDOFF_SOURCE_LABEL },
    });
    return await this.waitOutcome(watch, signal);
  }

  /** 等这一趟的结论；取消信号响了就按「被掐」处置（结论不会比这个更早） */
  private async waitOutcome(
    watch: SelfHandoffWatch,
    signal?: AbortSignal,
  ): Promise<SelfHandoffOutcome> {
    if (signal?.aborted) return "interrupted";
    const { raced, stop } = abortRace(signal, "interrupted" as SelfHandoffOutcome);
    try {
      return await Promise.race([watch.outcome, raced]);
    } finally {
      stop();
    }
  }

  /** 等这一批收口；取消信号响了也放行（收尾统一在 {@link runHandoff} 那一处做） */
  private async waitRoundOver(watch: SelfHandoffWatch, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const { raced, stop } = abortRace<void>(signal, undefined);
    try {
      await Promise.race([watch.over, raced]);
    } finally {
      stop();
    }
  }

  /** 独立摘要：一次模型调用，用同一份 Skill 正文作为规范 */
  private async generateSummary(
    agent: SdkAgent,
    historyText: string,
    handoffPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const client = this.client ?? agent.client;
    const model = this.model ?? agent.model;
    const modelConfig = this.modelConfig ?? agent.modelConfig;
    const skillContent = await this.readSkillContent();
    this.throwIfAborted(signal);

    // 请求体形状（system + user、modelConfig 展开、signal 走 RequestOptions）的唯一实现在
    // `completeOnce`：会话自动标题那一类「辅助小请求」走同一条路，两边不会一份带 stream、
    // 另一份不带
    const handoffDoc = await completeOnce({
      client,
      model,
      modelConfig,
      system: HandoffService.createHandoffInstruction({
        skillContent,
        handoffPath,
        toolsAvailable: false,
      }),
      user: historyText,
      signal,
    });

    if (!handoffDoc.trim()) {
      throw new Error("Failed to generate the handoff document");
    }
    return handoffDoc;
  }

  /** 落盘（仅 `summary` 模式需要；`self` 模式由 agent 的 write 工具完成） */
  private async writeHandoffFile(handoffPath: string, content: string): Promise<void> {
    await fs.mkdir(dirname(handoffPath), { recursive: true });
    await fs.writeFile(handoffPath, content, "utf-8");
  }

  /**
   * 交接文档写出来了没有：文件在、且不小于 {@link HandoffServiceOptions.minHandoffBytes}。
   *
   * 只看 `stat`，不读内容 —— 「够不够长」不需要读懂它写了什么。写了一半、模型只回了一句
   * 「写好了」而一个字没写，都在这一格里落定。
   */
  private async isHandoffFileReady(handoffPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(handoffPath);
      return stat.isFile() && stat.size >= this.minHandoffBytes;
    } catch {
      return false;
    }
  }

  /** 读取 `handoff` Skill 正文；读不到时回落到兜底模板 */
  private async readSkillContent(): Promise<string> {
    if (this.skillDirs.length > 0) {
      const skill = await readSkill(this.skillDirs, HANDOFF_SKILL_ID, { silent: true });
      if (skill?.content?.trim()) return skill.content;
    }
    this.logger.warn(
      `[handoff] ${HANDOFF_SKILL_ID} skill not found, using the built-in fallback template (paths: ${this.skillDirs.join(", ") || "none configured"})`,
    );
    return FALLBACK_HANDOFF_TEMPLATE;
  }

  /** 守卫按 agent 注册一次（`Agent.use()` 无移除 API，故复用实例 + 开关） */
  private ensureGuard(agent: SdkAgent): HandoffGuardPlugin {
    const guard = (this.guard ??= new HandoffGuardPlugin());
    if (!this.guardedAgents.has(agent)) {
      agent.use(guard);
      this.guardedAgents.add(agent);
    }
    return guard;
  }
}
