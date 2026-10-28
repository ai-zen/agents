import { promises as fs } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { AgentNS, Message } from "@ai-zen/agents-core";
import type OpenAI from "openai";
import { getLogger, type Logger } from "../shared/logger.js";
import { readSkill } from "../scope/plugins/skills/discover.js";
import { FALLBACK_HANDOFF_TEMPLATE, HANDOFF_SKILL_ID } from "../config/factory-skills.js";
import { HandoffGuardPlugin } from "./HandoffGuardPlugin.js";
import type { SdkAgent } from "./SdkAgent.js";

/**
 * 交接文档的执行者。
 *
 * - `self`：**原 agent 在自己的会话里**停工后写（默认）。上下文完整、可用工具核实真实状态，
 *   产出质量最好；代价是多 1~2 次全量输入。
 * - `summary`：一次独立的模型调用，把序列化后的历史摘要成交接文档（无工具、无原会话上下文）。
 *   便宜、确定，但保真度低——它是**逃生模式**，也是 `self` 失败时的单向降级目标。
 */
export type HandoffMode = "self" | "summary";

/**
 * 迁移后的历史处理策略。
 *
 * - `omit`（默认）：历史消息标记 `omit: true`，仍留在 `agent.messages` 可审计/回放，但不再发给模型；
 * - `prune`：物理剔除历史，只保留 `definition.messages`（系统提示等模板）+ 交接断点。
 */
export type MigrationStrategy = "omit" | "prune";

/**
 * 交接被调用方取消（`AbortSignal` 触发）。
 *
 * 单独成类型而不是复用 `Error`，原因有两个：
 *   - 调用方（如 TUI）要把「用户按了 Ctrl+C」与「交接真的失败了」区分开 ——
 *     前者应静默收尾并提示「已取消」，后者才该报错；
 *   - 它**不可降级**：`self` 被取消后绝不能退到 `summary` 再跑一遍。
 *     把「用户中止」当成「模型没写出文档」，会白白多烧一轮全量输入。
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
 * 一次交接的完整上下文 —— 贯穿「交接前 → 写文档 → 迁移后」，供钩子与调用方使用。
 */
export interface HandoffContext {
  /** 当前对话 Agent（引用不变，仅替换消息列表） */
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
  /** 本次是否会在交接后开新会话（`migrate()` 为 true，`handoff()` 为 false）。钩子据此区分两种语义 */
  migrating: boolean;
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
  /** 默认执行者，默认 `self`（可被 `handoff()/migrate()` 的参数覆盖） */
  mode?: HandoffMode;
  /** 迁移后历史处理策略，默认 `omit`（可被 `migrate()` 的参数覆盖） */
  strategy?: MigrationStrategy;
  /** 查找 `handoff` Skill 的目录列表（优先级从高到低）；为空则直接用兜底模板 */
  skillDirs?: string[];
  /** `summary` 模式所用客户端（可选；未传则回退到 agent.client） */
  client?: OpenAI;
  /** `summary` 模式所用模型名（可选；未传则回退到 agent.model） */
  model?: string;
  /** `summary` 模式所用模型参数（可选；未传则回退到 agent.modelConfig） */
  modelConfig?: Record<string, unknown>;
  /** 交接文档有效性阈值（字节），默认 400。低于此值视为「没写出来」 */
  minHandoffBytes?: number;
  /** 交接回合开始前触发（此时 `agent.messages` 仍是完整旧历史） */
  onBeforeHandoff?: (ctx: HandoffContext) => void | Promise<void>;
  /** 交接文档写好后、迁移（清历史）之前触发 */
  onHandoff?: (ctx: HandoffContext) => void | Promise<void>;
  /** 迁移完成后触发（此时交接断点已注入 `agent.messages`） */
  onMigrated?: (ctx: HandoffContext) => void | Promise<void>;
  /** 可注入日志（可选，默认使用全局单例） */
  logger?: Logger;
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
  /** 会话 id（可选，用于交接文件名，便于回溯） */
  conversationId?: string;
  /**
   * 取消信号（可选）。触发后交接**立即停止且不降级**，抛 {@link HandoffAbortedError}。
   *
   * 两种执行者都要认它：
   *   - `summary`：直接作为 `chat.completions.create` 的 RequestOptions 传下去，
   *     请求会真的被中断（否则该请求根本无从取消）；
   *   - `self`：`agent.abort()` 不抛错，所以每个 `send()` 之后要主动检查 `aborted`。
   */
  signal?: AbortSignal;
}

/** `migrate()` 参数 */
export interface MigrateParams extends HandoffParams {
  /** 本次迁移的历史处理策略（覆盖构造时的默认值） */
  strategy?: MigrationStrategy;
}

/**
 * 任务交接服务。
 *
 * 职责分层（这是本模块唯一的设计主线）：
 *   - `handoff()`：**只产出交接文档**（停工 → 写文档 → 校验 → 失败降级），不动会话；
 *   - `migrate()`：`handoff()` 之后清历史并开新会话（原「任务迁移」语义）。
 *
 * 模板的唯一真相源是 `handoff` Skill（`SKILL.md`）；代码只负责
 * 「读正文 → 注入 → 校验文件 → 读不到时用兜底模板」，不持有第二份章节清单。
 *
 * 重入：`handoff()` 与 `migrate()` 共用 `busy` 标志。交接回合本身也是一次 `send()`，
 * 若不在 busy 期间让 `AutoMigratePlugin` / `ContextGuardPlugin` 让行，就会「交接触发迁移、
 * 迁移再触发交接」无限递归，或在最满的时刻被护栏直接击杀。
 */
export class HandoffService {
  /** 交接文档兜底模板（仅在读不到 Skill 时使用） */
  static readonly FALLBACK_TEMPLATE = FALLBACK_HANDOFF_TEMPLATE;

  private readonly handoffDirPath: string;
  private readonly defaultMode: HandoffMode;
  private readonly defaultStrategy: MigrationStrategy;
  private readonly skillDirs: string[];
  private readonly client?: OpenAI;
  private readonly model?: string;
  private readonly modelConfig?: Record<string, unknown>;
  private readonly minHandoffBytes: number;
  private readonly onBeforeHandoff?: HandoffServiceOptions["onBeforeHandoff"];
  private readonly onHandoff?: HandoffServiceOptions["onHandoff"];
  private readonly onMigrated?: HandoffServiceOptions["onMigrated"];
  private readonly logger: Logger;

  /** 交接/迁移进行中标志（插件据此让行） */
  private _busy = false;
  /** 交接回合的工具守卫（同一实例复用 + arm/disarm，避免插件数组无限增长） */
  private guard?: HandoffGuardPlugin;
  /** 已注册过守卫的 agent（每个 agent 只 use 一次） */
  private readonly guardedAgents = new WeakSet<object>();

  constructor(options: HandoffServiceOptions = {}) {
    const {
      handoffDir,
      mode,
      strategy,
      skillDirs,
      client,
      model,
      modelConfig,
      minHandoffBytes,
      onBeforeHandoff,
      onHandoff,
      onMigrated,
      logger,
    } = options;

    this.handoffDirPath = resolvePath(handoffDir ?? join(process.cwd(), ".ai-zen", "handoffs"));
    this.defaultMode = mode ?? "self";
    this.defaultStrategy = strategy ?? "omit";
    this.skillDirs = skillDirs ?? [];
    this.client = client;
    this.model = model;
    this.modelConfig = modelConfig;
    this.minHandoffBytes = minHandoffBytes ?? 400;
    this.onBeforeHandoff = onBeforeHandoff;
    this.onHandoff = onHandoff;
    this.onMigrated = onMigrated;
    this.logger = logger ?? getLogger();
  }

  /** 是否正在交接/迁移（`AutoMigratePlugin` / `ContextGuardPlugin` 据此让行） */
  get busy(): boolean {
    return this._busy;
  }

  /** 交接文档目录 */
  get handoffDir(): string {
    return this.handoffDirPath;
  }

  // ==================================================================
  // 静态纯工具（供上层复用 / 单测）
  // ==================================================================

  /**
   * 交接文件名：`<YYYYMMDD-HHmmss>-<会话id前8位>.md`（本地时间，便于人眼归档）。
   */
  static createHandoffFileName(date: Date = new Date(), conversationId?: string): string {
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
      `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
    const suffix = conversationId ? `-${conversationId.slice(0, 8)}` : "";
    return `${stamp}${suffix}.md`;
  }

  /**
   * 拼装「本轮交接」指令：`[Skill 正文] + [本次交接参数]`。
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
      "You are now to write a task handoff document for this conversation. The following handoff rules are mandatory.",
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
   * 生成迁移后追加的「交接断点」消息（role=user）：只给路径，让接手方自己 read。
   *
   * 为什么不内联全文：接手方第一次真正需要的是「去哪里取交接」，读一次文件的输入成本
   * 与内联全文相当，但内联会让每条请求都携带全文；路径方案把成本推迟到真正需要时。
   */
  static createPostMessages(handoffPath: string): AgentNS.Message[] {
    const content = [
      "The previous conversation has been handed off, the handoff document is saved at:",
      handoffPath,
      "",
      "Read that file first with the read tool, and once you understand the context and the unfinished work, continue helping the user with the task.",
    ].join("\n");

    return [Message.User(content)];
  }

  /** 序列化消息为 `[role]: content` 文本（仅 `summary` 模式使用） */
  static serializeMessages(messages: AgentNS.Message[]): string {
    return messages
      .map((m) => {
        const role = m.role ?? "unknown";
        const content =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content);
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
   * 用户可继续让 agent 打磨这份文档（重写同一路径即可）。
   */
  async handoff(params: HandoffParams): Promise<HandoffContext> {
    return this.withBusy(() => this.runCatchingAbort(params, false));
  }

  /**
   * 交接 + 开新会话（`/migrate`、自动迁移）。
   *
   * 策略（`strategy`）：
   *   - `omit`（默认）：历史标记 `omit: true`（保留可审计），末尾追加交接断点；
   *   - `prune`：物理剔除历史，只留 `definition.messages` + 交接断点。
   */
  async migrate(params: MigrateParams): Promise<HandoffContext> {
    return this.withBusy(async () => {
      const ctx = await this.runCatchingAbort(params, true);
      const { agent } = ctx;
      const strategy = params.strategy ?? this.defaultStrategy;
      const breakpointMessages = HandoffService.createPostMessages(ctx.handoffPath);

      if (strategy === "prune") {
        // 浅拷贝模板消息，避免污染 definition.messages 引用的对象
        agent.messages = [...agent.definition.messages, ...breakpointMessages];
      } else {
        const preserveCount = Math.min(
          agent.definition.messages.length,
          agent.messages.length,
        );
        agent.messages = [
          ...agent.messages.map((m, i) => ({
            ...m,
            omit: i >= preserveCount ? true : m.omit,
          })),
          ...breakpointMessages,
        ];
      }

      await this.safeHook(this.onMigrated, ctx);
      return ctx;
    });
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /** 串行化 + 防重入：交接与迁移共用同一把锁 */
  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    if (this._busy) throw new Error("A handoff is already in progress, wait for it to finish");
    this._busy = true;
    try {
      return await fn();
    } finally {
      this._busy = false;
    }
  }

  /**
   * 把底层各种「取消」形态统一成 {@link HandoffAbortedError}。
   *
   * 取消可能从三处冒上来：`self` 回合后的主动检查（已是 HandoffAbortedError）、
   * `summary` 请求被 abort 时 OpenAI SDK 抛的 `APIUserAbortError`、以及
   * `readSkillContent` 这类前置 await 期间被取消。调用方只需要认一个类型。
   */
  private async runCatchingAbort(
    params: HandoffParams,
    migrating: boolean,
  ): Promise<HandoffContext> {
    try {
      return await this.runHandoff(params, migrating);
    } catch (err) {
      if (err instanceof HandoffAbortedError) throw err;
      if (isAbortError(err, params.signal)) throw new HandoffAbortedError();
      throw err;
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
   * 留着半成品更糟 —— 下一轮接手方会把不完整的内容当成真实交接读进去。
   */
  private async discardPartialFile(path: string, existedBefore: boolean): Promise<void> {
    if (existedBefore) return;
    try {
      await fs.unlink(path);
    } catch {
      /* 文件本就没写出来：忽略 */
    }
  }

  private async runHandoff(
    params: HandoffParams,
    migrating: boolean,
  ): Promise<HandoffContext> {
    const { agent, promptTokens, handoffTokens, conversationId, signal } = params;
    const requestedMode = params.mode ?? this.defaultMode;
    const handoffPath = join(
      this.handoffDirPath,
      HandoffService.createHandoffFileName(new Date(), conversationId),
    );
    const model = this.model ?? agent.model;
    const messageCountBefore = agent.messages.length;

    // 迁移前上下文（不含文档，语义固定）
    const beforeCtx: HandoffContext = {
      agent,
      mode: requestedMode,
      requestedMode,
      handoffPath,
      model,
      promptTokens,
      handoffTokens,
      migrating,
      messageCountBefore,
      historyText: "",
    };
    await this.safeHook(this.onBeforeHandoff, beforeCtx);
    this.throwIfAborted(signal);

    // ---- 执行者：self 优先，失败/不可用则单向降级 summary ----
    let mode = requestedMode;
    let handoffDoc: string | undefined;
    let historyText = "";

    if (mode === "self" && !this.supportsSelfHandoff(agent)) {
      this.logger.warn(
        "[handoff] agent has no write tool or send capability, falling back to standalone summary mode",
      );
      mode = "summary";
    }

    if (mode === "self") {
      const ok = await this.runSelfHandoff(agent, handoffPath, signal);
      if (!ok) {
        this.logger.warn("[handoff] self handoff failed, falling back to standalone summary mode");
        mode = "summary";
      }
    }

    if (mode === "summary") {
      historyText = HandoffService.serializeMessages(
        agent.messages.filter((m) => !m.omit),
      );
      handoffDoc = await this.generateSummary(agent, historyText, handoffPath, signal);
      await this.writeHandoffFile(handoffPath, handoffDoc);
    }

    // 最后一道取消点：即使两步都跑完，只要期间被取消就不能算成功
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
      migrating,
      messageCountBefore,
      historyText,
    };

    await this.safeHook(this.onHandoff, ctx);
    return ctx;
  }

  /** 自交接是否可用：需要 `write` 工具 + `send` 能力 */
  private supportsSelfHandoff(agent: SdkAgent): boolean {
    if (typeof agent.send !== "function") return false;
    return Boolean(agent.tools?.some((tool) => tool.function?.name === "write"));
  }

  /**
   * 自交接回合：让原 agent 停工、核实、写文档，并校验文件确实落盘。
   *
   * 失败判定（任一成立即视为失败，交由上层单向降级 summary）：
   *   - 文件不存在 / 小于阈值；
   *   - 模型/工具链抛错（例如没有权限、被护栏中断）。
   *
   * **取消不算失败**：`signal` 已触发时抛 {@link HandoffAbortedError}，既不走
   * 「文件没写好→重试一次」也不降级 summary。 这条分支必须显式写：
   * `agent.abort()` 不抛错（core 把消息标记为 Aborted 后正常返回），否则「用户
   * 按了 Ctrl+C」会被下面的文件校验误判成「模型没写出文档」，于是重试一轮、再降级
   * 一轮 —— 用户以为取消了，实际多烧了两轮全量输入。
   */
  private async runSelfHandoff(
    agent: SdkAgent,
    handoffPath: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const guard = this.ensureGuard(agent);
    const skillContent = await this.readSkillContent();
    const cwd = (agent as { scope?: { cwd?: string } }).scope?.cwd ?? process.cwd();
    // 取消时只删本次新建的文件，不碰本已存在的同名文件
    const existedBefore = await this.fileExists(handoffPath);

    /*
     * 清空 lastUsage 再开跑：
     *   - 护栏（ContextGuardPlugin）在每轮请求前用 lastUsage 判定严重超限，
     *     而交接恰好发生在上下文最满的时刻；
     *   - AutoMigratePlugin 也会读它。busy 已能让两者让行，这里再清一次是纵深防御。
     * 交接回合结束后 lastUsage 由本轮真实响应用量回填，无需恢复旧值。
     */
    agent.lastUsage = undefined;
    guard.arm(handoffPath, cwd);

    try {
      await agent.send(
        HandoffService.createHandoffInstruction({
          skillContent,
          handoffPath,
          toolsAvailable: true,
        }),
      );
      // `agent.abort()` 不抛错，必须主动检查（见方法注释）
      this.throwIfAborted(signal);

      if (await this.isHandoffFileReady(handoffPath)) return true;

      this.logger.warn(`[handoff] handoff document missing or too small, retrying once: ${handoffPath}`);
      await agent.send(
        [
          `The handoff document does not exist or is too small to deliver: ${handoffPath}`,
          "Use the write tool right now to write the **complete** handoff document to that path (use the path exactly as given) and do nothing else.",
        ].join("\n"),
      );
      this.throwIfAborted(signal);

      return await this.isHandoffFileReady(handoffPath);
    } catch (err: any) {
      if (isAbortError(err, signal)) {
        await this.discardPartialFile(handoffPath, existedBefore);
        throw new HandoffAbortedError();
      }
      this.logger.error(`[handoff] self handoff round failed: ${err?.message ?? err}`);
      return false;
    } finally {
      guard.disarm();
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

    // `signal` 走 RequestOptions（第二参数），与 `core/Agent.ts` 调用模型时一致：
    // 放在 body 里不会被 OpenAI SDK 当成取消信号。
    const response = await client.chat.completions.create(
      {
        model,
        ...(modelConfig ?? {}),
        messages: [
          {
            role: "system",
            content: HandoffService.createHandoffInstruction({
              skillContent,
              handoffPath,
              toolsAvailable: false,
            }),
          },
          { role: "user", content: historyText },
        ],
      },
      signal ? { signal } : undefined,
    );

    const handoffDoc = response.choices[0]?.message?.content;
    if (!handoffDoc || !handoffDoc.trim()) {
      throw new Error("Failed to generate the handoff document");
    }
    return handoffDoc;
  }

  /** 落盘（仅 `summary` 模式需要；`self` 模式由 agent 的 write 工具完成） */
  private async writeHandoffFile(handoffPath: string, content: string): Promise<void> {
    await fs.mkdir(dirname(handoffPath), { recursive: true });
    await fs.writeFile(handoffPath, content, "utf-8");
  }

  /** 交接文档是否可用：文件存在且不小于阈值（不读内容，避免二次读取） */  private async isHandoffFileReady(handoffPath: string): Promise<boolean> {
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

  /** 钩子容错：抛错只记录，不中断交接（与既有迁移钩子语义一致） */
  private async safeHook(
    hook: ((ctx: HandoffContext) => void | Promise<void>) | undefined,
    ctx: HandoffContext,
  ): Promise<void> {
    if (!hook) return;
    try {
      await hook(ctx);
    } catch (err: any) {
      this.logger.error(`[handoff] hook execution failed: ${err?.message ?? err}`);
    }
  }
}
