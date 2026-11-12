/**
 * `ServerApp` —— 单根对象：把零件接成一个真能跑的服务（architecture §3 / §4）。
 *
 * 这个文件的边界只有三件事：
 *
 *   1. **组装**：按 object graph 的顺序构造依赖（库 → 仓储 → 配置 → 运行时 → 服务 → 接线），
 *      每一层都靠构造参数注入，没有任何模块级单例、没有反射扫描、不读进程工作目录。
 *   2. **接线**：把服务与运行时**已经实现**的方法注册进 handler 表（`ws` 那一层只管分发），
 *      以及删除这类跨层动作的补齐（删对话 → 让运行时忘掉 + 按引用清素材；删项目 → 回收 Scope）。
 *   3. **启停**：监听 → 用**实际**地址写发现文件；退出 → 摘发现文件 + 关连接 + 关库。
 *      退出判据见 {@link ServerApp.checkExit}（PRD L4 / 裁定 R53）。
 *
 * 业务判断不在这里：方法体只做「取值 → 交给服务 → 取结果」，`runner` 里没有一条
 * 「业务上该怎么算」的分支。唯一在这层做的是**拼装**（把几个来源的事实拼成一份现场快照），
 * 那属于「谁持有这些事实」的接线问题。
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { addUsage, sumUsage, ZERO_USAGE } from "@ai-zen/agents-core";
import type { AgentNS } from "@ai-zen/agents-core";
import { ConfigManager } from "@ai-zen/agents-sdk";
import type { AppConfig, HandoffService, ReasoningPresets } from "@ai-zen/agents-sdk";

import { resolveListenTarget, resolvePaths } from "./config.js";
import type { ListenTarget, ServerPaths } from "./config.js";
import { render, type Language } from "./i18n/index.js";
import {
  clearServerFile,
  createLocalCredential,
  createTokenVerifier,
  UploadReceiver,
  writeServerFile,
  WsHub,
} from "./net/index.js";
import type { HandlerTable, HubLogger } from "./net/index.js";
import {
  ChatRunner,
  createSdkAgentFactory,
  createWorkspaceScopeFactory,
  RunRegistry,
  ScopeRegistry,
  systemClock,
} from "./runtime/index.js";
import { ConversationStateRegistry } from "./runtime/ConversationStateRegistry.js";
import type { AgentBuildContext, AgentFactory, Clock, ScopeFactory } from "./runtime/index.js";
import {
  ConversationService,
  CredentialService,
  MessageService,
  SearchService,
  WorkspaceService,
} from "./services/index.js";
import { AssetService } from "./services/AssetService.js";
import {
  AssetRepository,
  ConversationRepository,
  CredentialRepository,
  Database,
  MessageRepository,
  QuestionRepository,
  WorkspaceRepository,
  migrate,
} from "./storage/index.js";
import { PROTOCOL_VERSION } from "./wire/index.js";
import type {
  AttachmentOutcome,
  CapabilityView,
  ContextState,
  ConversationState,
  ProblemFact,
  RunState,
  UsageSnapshot,
  WorkspaceRemoveParams,
} from "./wire/index.js";

// ---------------------------------------------------------------------------
// 选项与事实
// ---------------------------------------------------------------------------

/** 配置文件放在数据根下（`<dataRoot>/config.json`，R13）：SDK 的 `ConfigManager` 以它为唯一边界 */
const CONFIG_FILE_NAME = "config.json";

/** 读不到包元数据时的版本号（服务照常能跑，只是升级判定拿不到真版本） */
const FALLBACK_VERSION = "0.0.0";

/** 退出判据的巡检间隔缺省值：连接断开没有回调，靠它兜住「最后一条连接走了」 */
const DEFAULT_EXIT_CHECK_INTERVAL_MS = 1000;

/** 收尾时清发现文件失败不改变结论（进程都要退了，日志里留一笔就够） */
const QUIET_LOGGER: HubLogger = { warn: () => undefined, error: () => undefined };

/** 进程为什么会走到「什么都不欠了」 */
export type ExitReason = "idle" | "requested";

/** 退出那一刻的事实（判断依据 + 为什么退） */
export interface ExitFacts {
  reason: ExitReason;
  /** 那一刻还有几条连接（`idle` 时为 0） */
  connections: number;
  /** 那一刻还在跑的轮次数（`idle` 时为 0） */
  runs: number;
  /** 那一刻还持有几个 Workspace Scope（`idle` 时为 0） */
  scopes: number;
}

/**
 * 「真的退出」这个动作。
 *
 * 进程退不退是件不可逆的事，所以做成注入点：生产缺省 `process.exit(0)`，
 * 用例注入一个记账函数，从而能验证「判据在什么时刻成立」而不真的把测试进程送走。
 */
export type ExitHook = (facts: ExitFacts) => void | Promise<void>;

/** 组装 `ServerApp` 的入参 */
export interface ServerAppOptions {
  /** 数据根（缺省 `AI_ZEN_DIR`，再缺省 `~/.ai-zen`，PRD F-J4） */
  aiZenDir?: string;
  /** 启动参数给的端口（优先级最高，D25） */
  port?: number;
  /** 配置文件里的端口（第二优先，D25） */
  configPort?: number;
  /** 本地实例只监听回环（PRD A6）；缺省 `true` */
  local?: boolean;
  /** 服务端版本；缺省读包元数据 */
  version?: string;
  /** 造 agent 的工厂；缺省按 SDK 口径装配（用例注入假 agent，不必连模型） */
  createAgent?: AgentFactory;
  /** 造 Scope 的工厂；缺省按 SDK 口径装配（用例可以给不带能力的空 Scope） */
  createScope?: ScopeFactory;
  /** Scope 空闲回收时长（PRD D28 缺省 10 分钟；用例调小以免真等） */
  scopeIdleTimeoutMs?: number;
  /** 交接服务（W4 才有）；未注入时不装交接插件，只记一条 warn（裁定 R50） */
  handoff?: (context: AgentBuildContext) => HandoffService | undefined;
  /** 时钟（Scope 回收计时与用例里的时间推进） */
  clock?: Clock;
  /** 退出判据的巡检间隔；`0` 表示关掉巡检（只靠回收与轮次结算触发） */
  exitCheckIntervalMs?: number;
  /** 真退出时做什么；缺省 `process.exit(0)` */
  exit?: ExitHook;
  /** 能力清单（PRD F-E5；内容归 W4-G，本轮缺省为空） */
  capabilities?: () => CapabilityView[];
  /** 连接未声明语言时的缺省语言（PRD D8） */
  defaultLanguage?: Language;
  /** 日志口（连接事件与内部错误） */
  logger?: HubLogger;
}

// ---------------------------------------------------------------------------
// 包版本
// ---------------------------------------------------------------------------

/**
 * 服务端版本：读本包的 `package.json`。
 *
 * 相对 `import.meta.url` 找而不是读进程工作目录：服务端是常驻后台进程，工作目录由启动方式
 * 决定（`src/app.ts` 与 `dist/app.js` 的上一级都是包根，两种形态都能读到同一份）。
 */
export function resolveServerVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.trim() !== "") {
      return parsed.version.trim();
    }
  } catch {
    // 包元数据读不到不影响服务本身：升级判定拿不到真版本而已
  }
  return FALLBACK_VERSION;
}

// ---------------------------------------------------------------------------
// ServerApp
// ---------------------------------------------------------------------------

export class ServerApp {
  // ---- 基础设施 ----
  readonly paths: ServerPaths;
  readonly db: Database;
  readonly configManager: ConfigManager;
  readonly workspaces: WorkspaceRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly assets: AssetRepository;
  readonly questions: QuestionRepository;
  readonly credentials: CredentialRepository;

  // ---- 运行时 ----
  readonly scopeRegistry: ScopeRegistry;
  readonly runRegistry: RunRegistry;
  readonly conversationStates: ConversationStateRegistry;
  readonly chatRunner: ChatRunner;

  // ---- 服务 ----
  readonly assetService: AssetService;
  readonly workspaceService: WorkspaceService;
  readonly conversationService: ConversationService;
  readonly messageService: MessageService;
  readonly searchService: SearchService;
  readonly credentialService: CredentialService;

  // ---- 接入 ----
  readonly uploads: UploadReceiver;
  readonly hub: WsHub;
  readonly handlers: HandlerTable;

  /** 服务端版本（`hello` 与 `server.version` 报的那一个） */
  readonly version: string;
  /** 进程启动时刻（ISO 8601） */
  readonly startedAt: string;
  /** 是不是本地实例（PRD A6：决定监听范围与要不要发本地凭证交付文件） */
  readonly local: boolean;

  private readonly options: ServerAppOptions;
  private readonly clock: Clock;
  private readonly logger: HubLogger;
  private readonly exitHook: ExitHook;
  private readonly exitIntervalMs: number;

  /** 当前阶段：造好 / 在监听 / 已收尾 */
  private phase: "created" | "running" | "stopped" = "created";
  private listening: ListenTarget | null = null;
  /** 收尾只做一次（`server.shutdown`、巡检、显式 `shutdown()` 都可能先到） */
  private closing: Promise<ExitFacts> | null = null;
  private stopWatch: (() => void) | null = null;
  private checking = false;
  /** 这条进程至少服务过一条连接：没有它，刚起来的进程会在客户端连上来之前就判自己该退 */
  private served = false;
  private stopAllRecycled: (() => void) | null = null;
  /** 思考策略表快照（装配 agent 时要把档位名展开成参数，而那一层是同步的） */
  private presets: ReasoningPresets | null = null;

  private constructor(
    options: ServerAppOptions,
    paths: ServerPaths,
    db: Database,
    configManager: ConfigManager,
  ) {
    this.options = options;
    this.paths = paths;
    this.db = db;
    this.configManager = configManager;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? QUIET_LOGGER;
    this.exitHook = options.exit ?? defaultExit;
    this.exitIntervalMs = options.exitCheckIntervalMs ?? DEFAULT_EXIT_CHECK_INTERVAL_MS;
    this.version = options.version ?? resolveServerVersion();
    this.startedAt = new Date(this.clock.now()).toISOString();
    this.local = options.local ?? true;

    // ---- 1. 仓储（只做 SQL，不含业务） ----
    this.workspaces = new WorkspaceRepository(db);
    this.conversations = new ConversationRepository(db);
    this.messages = new MessageRepository(db);
    this.assets = new AssetRepository(db);
    this.questions = new QuestionRepository(db);
    this.credentials = new CredentialRepository(db);

    // ---- 2. 运行时：Scope 的持有、轮次占位、每段对话的进程内状态 ----
    this.scopeRegistry = new ScopeRegistry({
      createScope: options.createScope ?? this.defaultScopeFactory(),
      idleTimeoutMs: options.scopeIdleTimeoutMs,
      clock: this.clock,
      onError: (error, workspaceId) => {
        this.logger.error("回收 Scope 失败", { workspaceId, error: describeError(error) });
      },
    });
    this.runRegistry = new RunRegistry({ clock: this.clock });
    this.conversationStates = new ConversationStateRegistry({ runs: this.runRegistry });

    // ---- 3. 素材（上传落定与「素材 id → 内容段」） ----
    this.assetService = new AssetService({
      assets: this.assets,
      paths,
      resolveModelContext: (modelId) => this.resolveModelContext(modelId),
      onProblem: (problem, context) => {
        this.logger.warn(context, { problem: problem.message, detail: problem.detail });
      },
    });

    // ---- 4. 一轮的执行者 ----
    this.chatRunner = new ChatRunner({
      messages: this.messages,
      conversations: this.conversations,
      scopes: this.scopeRegistry,
      runs: this.runRegistry,
      createAgent: options.createAgent ?? this.defaultAgentFactory(),
      emit: (name, payload) => this.hub.push(name, payload),
      clock: this.clock,
      prepareAttachments: (context) => this.assetService.prepareAttachments(context),
      onError: (error, context) => {
        this.logger.error("一轮对话写库失败", { context, error: describeError(error) });
      },
    });

    // ---- 5. 服务层（薄服务，运行时通过窄接口注进来） ----
    this.workspaceService = new WorkspaceService({
      workspaces: this.workspaces,
      conversations: this.conversations,
      messages: this.messages,
      assets: this.assets,
      runtime: this.conversationStates,
      now: () => this.clock.now(),
    });
    this.conversationService = new ConversationService({
      conversations: this.conversations,
      messages: this.messages,
      workspaces: this.workspaces,
      assets: this.assets,
      questions: this.questions,
      configManager: this.configManager,
      runtime: this.conversationStates,
      now: () => this.clock.now(),
    });
    this.messageService = new MessageService({
      conversations: this.conversations,
      messages: this.messages,
    });
    this.searchService = new SearchService({
      conversations: this.conversations,
      messages: this.messages,
      summarize: (rows) => this.conversationService.summarize(rows),
    });
    this.credentialService = new CredentialService({
      credentials: this.credentials,
      now: () => this.clock.now(),
    });

    // ---- 6. 上传接收（同一条 WS 上的二进制分帧） ----
    this.uploads = new UploadReceiver({
      assetsDir: paths.assetsDir,
      finalize: (request) => this.assetService.finalizeUpload(request),
      onError: (error, context) => {
        this.logger.warn("上传收尾失败", { context, error: describeError(error) });
      },
    });

    // ---- 7. 接线：一条 WebSocket 上的分发与推送 ----
    this.handlers = this.buildHandlers();
    const target = resolveListenTarget({
      port: options.port,
      configPort: options.configPort,
      local: this.local,
    });
    this.hub = new WsHub({
      host: target.host,
      port: target.port,
      verifyToken: this.buildVerifier(),
      handlers: this.handlers,
      uploads: this.uploads,
      serverVersion: this.version,
      startedAt: this.startedAt,
      capabilities: () => options.capabilities?.() ?? [],
      defaultLanguage: options.defaultLanguage,
      clock: () => this.clock.now(),
      logger: this.logger,
    });
  }

  /**
   * 造一个 `ServerApp`（不监听）。
   *
   * 建库与迁移在这里做完：迁移失败时把库关掉再抛，避免留下一个开着 worker 的坏实例。
   */
  static async create(options: ServerAppOptions = {}): Promise<ServerApp> {
    const paths = resolvePaths(options.aiZenDir);
    await mkdir(paths.dataRoot, { recursive: true });
    await mkdir(paths.runDir, { recursive: true });
    await mkdir(paths.assetsDir, { recursive: true });

    const db = new Database(paths.dbFile);
    try {
      await migrate(db);
    } catch (error) {
      await db.close();
      throw error;
    }

    const configManager = new ConfigManager(join(paths.dataRoot, CONFIG_FILE_NAME));
    // SDK 口径的首次初始化：目录 + config.json + 默认助手 + 子 Agent + mcp.json + 出厂 Skill
    // + 思考策略表。已有文件不覆盖（用户自定义的助手定义 `custom: true` 原样保留）。
    await configManager.bootstrap();

    return new ServerApp(options, paths, db, configManager);
  }

  // -------------------------------------------------------------------------
  // 启停
  // -------------------------------------------------------------------------

  /** 当前是否在监听 */
  get running(): boolean {
    return this.phase === "running";
  }

  /** 实际监听地址（`port: 0` 时是系统分配的那个；没在监听时为 `null`） */
  get address(): ListenTarget | null {
    return this.listening;
  }

  /**
   * 开始监听。
   *
   * 顺序是「本地凭证 → 监听 → 按**实际**地址写发现文件」：客户端读的是发现文件里的端口，
   * 端口被占退回临时端口时启动参数里的那个数已经不是真的了。
   */
  async start(): Promise<ListenTarget> {
    if (this.phase === "running") throw new Error("ServerApp 已经在监听");
    if (this.phase === "stopped") throw new Error("ServerApp 已收尾，不能再启动");

    // 本地实例的凭证交付：客户端首次连接时直接取这份（PRD A5 / architecture §2）
    if (this.local) await createLocalCredential(this.db, this.paths);
    this.presets = await this.configManager.readReasoningPresets();

    const bound = await this.hub.listen();
    const actual = this.hub.address() ?? bound;
    await writeServerFile(this.paths, {
      pid: process.pid,
      host: actual.host,
      port: actual.port,
      version: this.version,
      local: this.local,
      startedAt: this.startedAt,
    });

    this.listening = actual;
    this.phase = "running";
    this.stopAllRecycled = this.scopeRegistry.onAllRecycled(() => {
      void this.checkExit();
    });
    this.startExitWatch();
    return actual;
  }

  /**
   * 收尾：摘发现文件 → 断连接 → 关库 → 交棒给「真的退出」。
   *
   * 幂等：`server.shutdown`、退出巡检、信号处理器都可能先到，只有第一次真的做事。
   */
  shutdown(reason: ExitReason = "requested"): Promise<ExitFacts> {
    this.closing ??= this.doShutdown(reason);
    return this.closing;
  }

  private async doShutdown(reason: ExitReason): Promise<ExitFacts> {
    const facts: ExitFacts = {
      reason,
      connections: this.hub.connectionInfos().length,
      runs: this.runRegistry.size(),
      scopes: this.scopeRegistry.size(),
    };

    this.phase = "stopped";
    this.stopExitWatch();
    this.stopAllRecycled?.();
    this.stopAllRecycled = null;

    try {
      await clearServerFile(this.paths);
    } catch (error) {
      this.logger.warn("清理发现文件失败", { error: describeError(error) });
    }
    // Scope 一起拆掉：MCP 连接是它持有的，进程退出之后没有别人会替它关（D28 同生共死）
    try {
      await this.scopeRegistry.recycleAll();
    } catch (error) {
      this.logger.warn("收尾时回收 Scope 失败", { error: describeError(error) });
    }
    await this.hub.close();
    await this.db.close();
    await this.exitHook(facts);
    return facts;
  }

  /**
   * 退出判据（PRD L4 / 裁定 R53）：没有连接、没有在跑的轮次、Scope 全部回收 —— 什么都不欠了。
   *
   * 两个防止误退的口子：
   *   1. **还没服务过任何连接**时不判（刚起的进程在等第一个客户端，这时「没有连接」是常态）；
   *   2. 只在监听中判断（造好未启动、已收尾时都不判）。
   */
  private async checkExit(): Promise<void> {
    if (this.phase !== "running" || this.checking) return;
    this.checking = true;
    try {
      this.observe();
      if (!this.served) return;
      if (this.hub.connectionInfos().length > 0) return;
      if (this.runRegistry.size() > 0) return;
      if (this.scopeRegistry.size() > 0) return;
      await this.shutdown("idle");
    } finally {
      this.checking = false;
    }
  }

  /** 记下「这条进程已经被用过」：连上来过一条连接就够了 */
  private observe(): void {
    if (!this.served && this.hub.connectionInfos().length > 0) this.served = true;
  }

  private startExitWatch(): void {
    if (this.exitIntervalMs <= 0) return;
    const timer = setInterval(() => {
      void this.checkExit();
    }, this.exitIntervalMs);
    // 巡检不该单独把进程钉住：真要退出时由判据自己发起
    timer.unref?.();
    this.stopWatch = () => clearInterval(timer);
  }

  private stopExitWatch(): void {
    this.stopWatch?.();
    this.stopWatch = null;
  }

  // -------------------------------------------------------------------------
  // 工厂（缺省的 SDK 装配）
  // -------------------------------------------------------------------------

  /** 缺省的 Scope 工厂：按 SDK 口径装能力（MCP 的 5 层链与各层目录归 W4-G） */
  private defaultScopeFactory(): ScopeFactory {
    return createWorkspaceScopeFactory({
      resolveWorkspace: async (workspaceId) => {
        const row = await this.workspaces.get(workspaceId);
        return row ? { cwd: row.cwd } : undefined;
      },
      getConfig: () => this.configManager.read(),
      agentsDir: join(this.configManager.basePath, "agents"),
    });
  }

  /** 缺省的 agent 工厂：SDK 口径装配（硬线、子 Agent 递归、交接线、工具刷新） */
  private defaultAgentFactory(): AgentFactory {
    if (!this.options.handoff) {
      // R50：没有交接服务就不装交接插件，但装配处要说一声，不让它悄悄消失
      this.logger.warn("交接服务未注入：本轮不装交接插件（R50），交接能力由 W4 补", {
        layer: "createSdkAgentFactory",
      });
    }
    return createSdkAgentFactory({
      handoff: this.options.handoff,
      resolveModelId: (context) =>
        this.conversationStates.getModelOverride(context.conversationId) ?? undefined,
      resolveModelParams: (context) => this.thinkingParams(context),
    });
  }

  /**
   * 这段对话临时调的思考档位 → 请求参数（PRD F-B6 / R41：写进去的是参数）。
   *
   * 这一跳必须同步（agent 工厂的注入点就是同步的），所以档位表用启动时读到的快照；
   * 政策表是出厂资产，进程生命周期内不变，用快照是安全的。
   */
  private thinkingParams(context: AgentBuildContext): Record<string, unknown> | undefined {
    const level = this.conversationStates.getThinkingOverride(context.conversationId);
    if (level === null) return undefined;
    const modelId =
      this.conversationStates.getModelOverride(context.conversationId) ?? context.modelId;
    const model = context.scope.config.models.find((candidate) => candidate.id === modelId);
    const presetName = model?.reasoningPreset;
    const preset = presetName ? this.presets?.[presetName] : undefined;
    return preset?.levels[level];
  }

  /** 素材转换要的实发模型与端点（F-H7 的判定依据：模型能不能看图、端点有没有 Files API） */
  private async resolveModelContext(
    modelId: string | null,
  ): Promise<{ model: AppConfig["models"][number] | null; endpoint: AppConfig["endpoints"][number] | null }> {
    const config = await this.readConfig();
    const model = modelId === null ? undefined : config.models.find((item) => item.id === modelId);
    const endpoint = model
      ? config.endpoints.find((item) => item.id === model.endpointId)
      : undefined;
    return { model: model ?? null, endpoint: endpoint ?? null };
  }

  /** 读配置；坏了就是 `config_invalid`（服务层读配置时也是这个口径） */
  private async readConfig(): Promise<AppConfig> {
    return await this.configManager.read();
  }

  /** 凭证校验：顺手记下「这条进程被用过」（握手成功即算） */
  private buildVerifier() {
    const verifier = createTokenVerifier(this.db);
    return {
      verify: async (token: string) => {
        const verified = await verifier.verify(token);
        if (verified !== null) this.served = true;
        return verified;
      },
    };
  }

  // -------------------------------------------------------------------------
  // handler 表
  // -------------------------------------------------------------------------

  /**
   * 方法名 → 实现。只注册**已有实现者**的方法（服务与运行时能提供的那一批）。
   *
   * 配置 / 助手 / 模型 / 通知 / 问题 / 交接 / 补全 / 素材的 handler 壳与临时对话归 W4，
   * 这里不注册：接线层会回 `unsupported`（R11 定下的码，意思是「方法名有，但这个服务端没实现」）。
   */
  private buildHandlers(): HandlerTable {
    return {
      // ---- 进程与握手 ----
      "server.version": () => ({
        version: this.version,
        protocolVersion: PROTOCOL_VERSION,
        startedAt: this.startedAt,
        pid: process.pid,
      }),
      "server.capabilities": () => ({ capabilities: this.options.capabilities?.() ?? [] }),
      "server.shutdown": () => {
        // 回包要先写出去（客户端得知道「受理了」），收尾放在下一轮事件循环
        setTimeout(() => {
          void this.shutdown("requested");
        }, 0);
        return { accepted: true };
      },
      "server.usage": async (context) => await this.usage(context.params),

      // ---- 项目 ----
      "workspace.list": async (context) => await this.workspaceService.list(context.params),
      "workspace.create": async (context) => await this.workspaceService.create(context.params),
      "workspace.get": async (context) => await this.workspaceService.get(context.params),
      "workspace.rename": async (context) => await this.workspaceService.rename(context.params),
      "workspace.remove": async (context) => await this.removeWorkspace(context.params),

      // ---- 对话 ----
      "conversation.list": async (context) => await this.conversationService.list(context.params),
      "conversation.create": async (context) =>
        await this.conversationService.create(context.params),
      "conversation.get": async (context) => await this.conversationService.get(context.params),
      "conversation.state": async (context) => ({
        state: await this.conversationState(context.params.conversationId),
      }),
      "conversation.rename": async (context) =>
        await this.conversationService.rename(context.params),
      "conversation.pin": async (context) => await this.conversationService.pin(context.params),
      "conversation.delete": async (context) => await this.removeConversation(context.params),
      "conversation.send": async (context) => await this.sendTurn(
        context.params.conversationId,
        context.params.input,
        context.connection.language,
      ),
      "conversation.abort": async (context) => {
        const aborted = this.chatRunner.abort(context.params.conversationId, context.params.reason);
        return { aborted, run: await this.runStateOf(context.params.conversationId) };
      },
      "conversation.revert": async (context) =>
        await this.conversationService.revert(context.params),
      "conversation.setModel": async (context) =>
        await this.conversationService.setModel(context.params),
      "conversation.setThinking": async (context) => {
        // 档位表先刷新一次再改：改完读回的「展开后的参数」要用当前表
        this.presets = await this.configManager.readReasoningPresets();
        return await this.conversationService.setThinking(context.params);
      },

      // ---- 消息 ----
      "message.list": async (context) => await this.messageService.list(context.params),

      // ---- 搜索 ----
      "search.conversations": async (context) =>
        await this.searchService.conversations(context.params),
      "search.messages": async (context) => await this.searchService.messages(context.params),

      // ---- 凭证 ----
      "credential.list": async () => await this.credentialService.list(),
      "credential.create": async (context) =>
        await this.credentialService.create(context.params),
      "credential.revoke": async (context) =>
        await this.credentialService.revoke(context.params),
    };
  }

  // -------------------------------------------------------------------------
  // handler 的跨层补齐
  // -------------------------------------------------------------------------

  /**
   * `conversation.send`：受理一轮，把素材挂到落库后的那条用户消息上，回两个 id（L6 / F-I12）。
   *
   * 附件结局里的句子是在素材层（不知道收件人是谁）按默认语言渲染的，这里按**这条连接**的
   * 语言重渲染一次再出网（D8：存码不存句子）。
   */
  private async sendTurn(
    conversationId: string,
    input: { content: AgentNS.MessageContent; assetIds?: string[] },
    language: Language,
  ) {
    const turn = await this.chatRunner.run({ conversationId, input });
    const assetIds = input.assetIds ?? [];
    if (assetIds.length > 0) {
      // 上传早于消息落库（PRD D5 / F-H8）：受理之后立刻把素材行挂到用户消息上
      await this.assetService.linkToMessage(assetIds, turn.userMessageId);
    }
    // 一轮结算之后重新看一眼能不能退出（这一轮可能是最后一件欠着的事）
    void turn.done.then(
      () => this.checkExit(),
      () => this.checkExit(),
    );
    this.presets = await this.configManager.readReasoningPresets();

    return {
      userMessageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      attachments: turn.attachments.map((outcome) => localizeOutcome(outcome, language)),
      acceptedAt: turn.acceptedAt,
    };
  }

  /**
   * `conversation.delete`：删掉这段对话，再补齐两件只有单根知道的事（R33 / R43）。
   *
   *   1. 运行时的这一轮现场要丢掉（`ChatRunner.forget`：正在跑就先让它停）；
   *   2. `assets/` 下的文件按引用清掉（服务层只算清单，删文件是素材层的事）。
   */
  private async removeConversation(params: { conversationId: string; dryRun?: boolean }) {
    const report = await this.conversationService.delete(params);
    if (params.dryRun !== true && report.removed) {
      this.chatRunner.forget(params.conversationId);
      await this.assetService.removeFiles(report.assetPaths);
    }
    return { removed: report.removed, consequences: report.consequences };
  }

  /**
   * `workspace.remove`：删项目要连带回收它的 Scope（architecture §4 三因之二，R43）。
   *
   * 顺序：先记下名下有哪些对话（删完就问不出来了）→ 服务层删行（顺带让运行时忘掉临时覆盖）
   * → 逐段对话丢掉轮次现场 → 回收 Scope（MCP 连接在这里断开）→ 清素材文件。
   */
  private async removeWorkspace(params: WorkspaceRemoveParams) {
    const doomed =
      params.dryRun === true ? [] : await this.conversations.listByWorkspace(params.workspaceId);

    const report = await this.workspaceService.remove(params);
    if (params.dryRun !== true && report.removed) {
      for (const conversation of doomed) this.chatRunner.forget(conversation.id);
      await this.scopeRegistry.disposeWorkspace(params.workspaceId);
      await this.assetService.removeFiles(report.assetPaths);
    }
    return { removed: report.removed, consequences: report.consequences };
  }

  // -------------------------------------------------------------------------
  // 现场快照
  // -------------------------------------------------------------------------

  /** 这一轮现在的运行状态；没有在跑的一轮时是「空闲」（`conversation.abort` 与 `state` 共用） */
  private async runStateOf(conversationId: string): Promise<RunState> {
    const turn = this.chatRunner.turn(conversationId);
    if (turn) return turn.runState();
    const messages = await this.messageService.list({ conversationId });
    const usage = usageOfMessages(messages.messages, this.nowIso());
    return idleRunState(conversationId, usage);
  }

  /**
   * 一段对话的现场（PRD L5：重连先拉状态）。
   *
   * 拼装顺序：视图（身份 / 思考档 / 目录）→ 运行状态（在跑就用这一轮自己的快照）→
   * 用量（在跑用这一轮，空闲就用库里消息求和）→ 上下文阈值（跟模型走）。
   *
   * 两处暂时是空数组，因为它们的持有者还没来：`questions`（问题对象归 W4-H）、
   * `statusBlocks`（状态栏的块归 W4，PRD F-I6）。已在 `docs/plan-questions.md` 记下。
   */
  private async conversationState(conversationId: string): Promise<ConversationState> {
    const now = this.nowIso();
    const { conversation } = await this.conversationService.get({ conversationId });
    const turn = this.chatRunner.turn(conversationId);
    const messages = await this.messageService.list({ conversationId });
    const usage = turn ? turn.runState().usage : usageOfMessages(messages.messages, now);
    const config = await this.readConfig();
    const model = config.models.find((item) => item.id === conversation.model.modelId);

    return {
      conversationId,
      run: turn ? turn.runState() : idleRunState(conversationId, usage),
      context: contextOf(messages.messages, model),
      thinking: conversation.thinking,
      usage,
      questions: [],
      statusBlocks: [],
      updatedAt: now,
    };
  }

  /**
   * `server.usage`：按对话 / 项目 / 整机给一份用量（PRD F-I5）。
   *
   * 三个范围的差别只在「取哪些对话的消息」；求和用的是 core 的 `sumUsage`
   * （它把消息自身用量与子 Agent 用量一起算，与计费同口径）。
   */
  private async usage(params: { conversationId?: string; workspaceId?: string }) {
    const now = this.nowIso();
    const conversationIds = await this.conversationIdsOf(params);
    const collected: AgentNS.Message[] = [];
    for (const conversationId of conversationIds) {
      const page = await this.messageService.list({ conversationId });
      collected.push(...page.messages);
    }
    const scope =
      params.conversationId !== undefined
        ? "conversation"
        : params.workspaceId !== undefined
          ? "workspace"
          : "server";
    return { scope, usage: usageOfMessages(collected, now) } as const;
  }

  private async conversationIdsOf(params: {
    conversationId?: string;
    workspaceId?: string;
  }): Promise<string[]> {
    if (params.conversationId !== undefined) return [params.conversationId];
    const rows =
      params.workspaceId === undefined
        ? await this.conversations.list()
        : await this.conversations.listByWorkspace(params.workspaceId);
    return rows.map((row) => row.id);
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }
}

// ---------------------------------------------------------------------------
// 单根之外的入口
// ---------------------------------------------------------------------------

/** 造一个 `ServerApp`（`index.ts` 的 `createServer` 就是它） */
export function createServer(options: ServerAppOptions = {}): Promise<ServerApp> {
  return ServerApp.create(options);
}

/** 缺省的退出动作：把进程送走（用例注入自己的 `exit` 时不会走到这里） */
const defaultExit: ExitHook = () => {
  process.exit(0);
};

// ---------------------------------------------------------------------------
// 纯函数：拼装与本地化
// ---------------------------------------------------------------------------

/** 空闲的现场：没有在跑的一轮，但历史用量还在 */
function idleRunState(conversationId: string, usage: UsageSnapshot): RunState {
  return {
    conversationId,
    status: "idle",
    assistantMessageId: null,
    startedAt: null,
    settledAt: null,
    generation: null,
    outcome: null,
    problem: null,
    subagents: [],
    usage,
  };
}

/**
 * 一批消息的用量快照。
 *
 * `total` 与 `subAgent` 用 core 的口径求和；`turn` 在「没有一轮在跑」时是零值
 * （没有这一轮这件事，就是零）；速率同理。
 */
function usageOfMessages(messages: readonly AgentNS.Message[], now: string): UsageSnapshot {
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
 * 阈值跟着模型走，模型在配置里被删掉时两条线都是 0（「没有阈值」而不是「阈值为零就超了」）。
 */
function contextOf(
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

/** 一个附件结局的句子按这条连接的语言重渲染（码与参数不动，D8） */
function localizeOutcome(outcome: AttachmentOutcome, language: Language): AttachmentOutcome {
  if (outcome.problem === null) return outcome;
  const problem: ProblemFact = {
    ...outcome.problem,
    message: render(language, outcome.problem.messageKey, outcome.problem.params),
  };
  return { ...outcome, problem };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}
