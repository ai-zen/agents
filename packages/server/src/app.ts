/**
 * `ServerApp` —— 单根对象：把零件接成一台真能跑、能被连的服务（architecture §3 / §4）。
 *
 * 这个文件的边界是三件事：
 *
 *   1. **组装**：按对象图的顺序 `new` 出依赖（库 → 仓储 → 配置 → 运行时 → 服务 → 接线），
 *      每一层都靠构造参数注入；没有模块级单例、没有反射扫描、不读进程工作目录。
 *   2. **启停**：`start()` 决定监听在哪、把**实际**地址写进发现文件；`stop()` 对称地拆回去
 *      （摘发现文件、断连接、关上传、回收 Scope、关库）。
 *   3. **判据**：什么时候「什么都不欠了」可以退出（PRD L4 / 裁定 R53），以及启动时
 *      「这台机器上是不是已经有人在服务」（单实例，architecture §2）。
 *
 * 方法实现不在这里：每个域的 handler 在 `handlers/`，由 {@link createHandlers} 拼成一张表交给
 * `WsHub`。本文件只给它们提供持有者（服务、运行时、配置、时钟）与几个只有它才接得起来的钩子：
 *   - **配置生效**（`ConfigApplyPort`）：改完配置要回收受影响的 Scope（F-E2）并发一条通知（F-F9）；
 *   - **Scope 装配**（`ScopeRegistry` 的工厂）：能力目录由 `DiscoveryService` 按 cwd 算好（R54/L9）；
 *   - **退出判据**（`checkExit`）：连接数、在跑的轮次、Scope 三个来源都收敛到一处。
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AgentRepository, ConfigManager } from "@ai-zen/agents-sdk";
import type { AppConfig, HandoffService, ReasoningPresets } from "@ai-zen/agents-sdk";

import { resolveListenTarget, resolvePaths } from "./config.js";
import type { ListenTarget, ServerPaths } from "./config.js";
import { createCapabilities, createHandlers } from "./handlers/index.js";
import type { HandlerDeps } from "./handlers/index.js";
import type { Language } from "./i18n/index.js";
import {
  clearServerFile,
  createLocalCredential,
  createTokenVerifier,
  readServerFile,
  UploadReceiver,
  writeServerFile,
  WsHub,
} from "./net/index.js";
import type { HandlerTable, HubLogger, ServerFileInfo } from "./net/index.js";
import {
  ChatRunner,
  createSdkAgentFactory,
  createWorkspaceScopeFactory,
  RunRegistry,
  ScopeRegistry,
  systemClock,
} from "./runtime/index.js";
import type { AgentBuildContext, AgentFactory, Clock, ScopeFactory } from "./runtime/index.js";
import { ConversationStateRegistry } from "./runtime/ConversationStateRegistry.js";
import { TransientRunner, cwdOfTransientScopeKey, transientAgentFactoryFrom } from "./runtime/TransientRunner.js";
import {
  ConversationService,
  CredentialService,
  MessageService,
  SearchService,
  WorkspaceService,
} from "./services/index.js";
import { AgentService } from "./services/AgentService.js";
import { AssetService } from "./services/AssetService.js";
import { AutoNaming } from "./services/AutoNaming.js";
import { CompletionService } from "./services/CompletionService.js";
import { ConfigService } from "./services/ConfigService.js";
import type { ConfigApplyChange, ConfigApplyOutcome, ConfigApplyPort } from "./services/ConfigService.js";
import { DiscoveryService } from "./services/DiscoveryService.js";
import { HandoffService as HandoffDocumentsService } from "./services/HandoffService.js";
import { ModelService } from "./services/ModelService.js";
import { NoticeService, createEventLocalizer } from "./services/NoticeService.js";
import { QuestionService, createConversationGuardProbe } from "./services/QuestionService.js";
import {
  AssetRepository,
  ConversationRepository,
  CredentialRepository,
  Database,
  MessageRepository,
  NoticeRepository,
  QuestionRepository,
  WorkspaceRepository,
  migrate,
} from "./storage/index.js";
import type { CapabilityView, ServerUpgradeResult } from "./wire/index.js";
import type { EventMap, EventName } from "./wire/events.js";

// ---------------------------------------------------------------------------
// 选项与事实
// ---------------------------------------------------------------------------

/** 配置文件放在数据根下（`<dataRoot>/config.json`，裁定 R13）：SDK 的 `ConfigManager` 以它为边界 */
const CONFIG_FILE_NAME = "config.json";

/** 读不到包元数据时的版本号（服务照常能跑，只是升级判定拿不到真版本） */
const FALLBACK_VERSION = "0.0.0";

/** 配置生效那条通知留几秒（F-F9：一次改动合成一条，一秒级的提示归 `info`） */
const APPLIED_NOTICE_SECONDS = 3;

/** 收尾时清发现文件失败不改变结论（进程都要退了，留一笔日志就够） */
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
 * 进程退不退是不可逆的事，所以做成注入点：生产缺省 `process.exit(0)`，
 * 用例注入一个记账函数，从而能验证「判据在什么时刻成立」而不把测试进程送走。
 */
export type ExitHook = (facts: ExitFacts) => void | Promise<void>;

/** 组装 `ServerApp` 的入参 */
export interface ServerAppOptions {
  /** 数据根（缺省 `AI_ZEN_DIR`，再缺省 `~/.ai-zen`，PRD F-J4） */
  aiZenDir?: string;
  /** 启动参数给的端口（优先级最高，D25）；`0` 表示让系统分配（用例与冒烟用） */
  port?: number;
  /** 配置文件里的端口（第二优先，D25） */
  configPort?: number;
  /** 显式指定监听地址（优先级高于 `local` 推出的那个） */
  host?: string;
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
  /** 交接服务（SDK 口径，装交接线插件用）；未注入时不装插件并推一条警告通知（裁定 R50） */
  handoff?: (context: AgentBuildContext) => HandoffService | undefined;
  /** 时钟（Scope 回收计时与用例里的时间推进） */
  clock?: Clock;
  /** 真退出时做什么；缺省 `process.exit(0)` */
  exit?: ExitHook;
  /** 能力清单（PRD F-E5）；缺省用 `handlers/capabilities.ts` 里那份与契约同步的清单 */
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
  return readDiskVersion() ?? FALLBACK_VERSION;
}

/**
 * 磁盘上的版本号：读本包的 `package.json`；读不到（或格式不对）返回 `null`。
 *
 * 升级判定（D4 / F-E3）要的就是「磁盘上现在是哪个版本」，所以这里与服务端版本共用
 * 同一处读法，`null` 与 `"0.0.0"` 不混：前者是「不知道」，后者是「真的读到了 0.0.0」。
 */
export function readDiskVersion(): string | null {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.version === "string" && parsed.version.trim() !== "") {
      return parsed.version.trim();
    }
  } catch {
    // 包元数据读不到不影响服务本身：升级判定拿不到真版本而已
  }
  return null;
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
  readonly notices: NoticeRepository;
  readonly questions: QuestionRepository;
  readonly credentials: CredentialRepository;

  // ---- 运行时 ----
  readonly scopeRegistry: ScopeRegistry;
  readonly runRegistry: RunRegistry;
  readonly conversationStates: ConversationStateRegistry;
  readonly chatRunner: ChatRunner;
  readonly transientRunner: TransientRunner;

  // ---- 服务 ----
  readonly assetService: AssetService;
  readonly workspaceService: WorkspaceService;
  readonly conversationService: ConversationService;
  readonly messageService: MessageService;
  readonly searchService: SearchService;
  readonly credentialService: CredentialService;
  readonly discoveryService: DiscoveryService;
  readonly configService: ConfigService;
  readonly agentService: AgentService;
  readonly modelService: ModelService;
  readonly completionService: CompletionService;
  readonly noticeService: NoticeService;
  readonly questionService: QuestionService;
  readonly handoffService: HandoffDocumentsService;
  readonly autoNaming: AutoNaming;

  // ---- 接入 ----
  readonly uploads: UploadReceiver;
  readonly hub: WsHub;
  /** 方法名 → 实现（`handlers/createHandlers` 拼出来的那张表） */
  readonly handlers: HandlerTable;

  /** 服务端版本（`hello` 与 `server.version` 报的那一个） */
  readonly version: string;
  /** 能力清单（PRD F-E5：帮助页与指令菜单按它渲染） */
  readonly capabilities: () => CapabilityView[];
  /** 进程启动时刻（ISO 8601） */
  readonly startedAt: string;
  /** 是不是本地实例（PRD A6：决定监听范围与要不要发本地凭证交付文件） */
  readonly local: boolean;

  private readonly options: ServerAppOptions;
  private readonly clock: Clock;
  private readonly logger: HubLogger;
  private readonly exitHook: ExitHook;

  /** 当前阶段：造好 / 自己监听中 / 挂靠已有实例 / 已收尾 */
  private phase: "created" | "running" | "attached" | "stopped" = "created";
  private listening: ListenTarget | null = null;
  /** 发现文件是不是这一份进程写的（挂靠别人的实例时不能去删它） */
  private ownsServerFile = false;
  /** 收尾只做一次（`server.shutdown`、判据、显式 `stop()` 都可能先到） */
  private closing: Promise<ExitFacts> | null = null;
  /** 「真的退出」只交棒一次 */
  private exited = false;
  private checking = false;
  /** 这条进程至少被用过一次：没有它，刚起来的进程会在第一个客户端连上来之前就判自己该退 */
  private served = false;
  private stopAllRecycled: (() => void) | null = null;
  /** 思考策略表快照（装配 agent 时要把档位名展开成参数，而那一层是同步的） */
  private presets: ReasoningPresets | null = null;
  /** 推送入口（造好之前为 `null`：这时没有任何连接可推） */
  private hubForPush: WsHub | null = null;
  /** R50 的那条警告只说一次（描述的是装配能力，不是某一轮的错） */
  private handoffWarningSent = false;

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
    this.version = options.version ?? resolveServerVersion();
    this.startedAt = new Date(this.clock.now()).toISOString();
    this.local = options.local ?? true;

    // ---- 1. 仓储（只做 SQL，不含业务） ----
    this.workspaces = new WorkspaceRepository(db);
    this.conversations = new ConversationRepository(db);
    this.messages = new MessageRepository(db);
    this.assets = new AssetRepository(db);
    this.notices = new NoticeRepository(db);
    this.questions = new QuestionRepository(db);
    this.credentials = new CredentialRepository(db);

    /** 助手与子 Agent 的定义仓储（配置层与助手/模型/配置三个服务共用同一份目录） */
    const agentRepository = new AgentRepository(join(configManager.basePath, "agents"));
    const subAgentRepository = new AgentRepository(join(configManager.basePath, "sub-agents"));
    /** 按 workspaceId 取 cwd：发现、补全、配置三个服务都要同一份口径 */
    const findWorkspace = async (workspaceId: string) => {
      const row = await this.workspaces.get(workspaceId);
      return row ? { cwd: row.cwd } : undefined;
    };

    // ---- 2. 运行时：Scope 的持有、轮次占位、每段对话的进程内状态 ----
    // 工厂包一层再交给注册表：它要读发现服务算好的能力目录，而那一层比 Scope 先造好
    const injectedScopeFactory = options.createScope;
    this.scopeRegistry = new ScopeRegistry({
      createScope: injectedScopeFactory ?? ((key) => this.defaultScopeFactory()(key)),
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

    // ---- 4. 服务层（薄服务，运行时通过窄接口注进来） ----
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

    // ---- 5. 配置、发现、模型、助手、补全 ----
    this.discoveryService = new DiscoveryService({
      configManager: this.configManager,
      findWorkspace,
    });
    this.modelService = new ModelService({
      configManager: this.configManager,
      agents: agentRepository,
    });
    this.agentService = new AgentService({
      configManager: this.configManager,
      agents: agentRepository,
      subAgents: subAgentRepository,
      now: () => this.clock.now(),
    });
    this.completionService = new CompletionService({ findWorkspace });

    // ---- 6. 通知、问题、交接、自动命名（它们互相引用，都靠注入） ----
    // agent 工厂只造一次：交接回合与普通对话用同一个（跑完即弃，D28）
    const createAgent = options.createAgent ?? this.defaultAgentFactory();
    this.noticeService = new NoticeService({
      notices: this.notices,
      emit: (name, payload) => this.emitEvent(name, payload),
      now: () => this.clock.now(),
    });
    this.handoffService = new HandoffDocumentsService({
      conversations: this.conversations,
      workspaces: this.workspaces,
      messages: this.messages,
      conversationViews: this.conversationService,
      scopes: this.scopeRegistry,
      createAgent,
      runs: this.runRegistry,
      questions: this.questions,
      notices: this.noticeService,
      emit: (name, payload) => this.emitEvent(name, payload),
      now: () => this.clock.now(),
    });
    this.questionService = new QuestionService({
      questions: this.questions,
      runs: this.runRegistry,
      // 硬线跟着模型走（D27），与 `conversation.state` 里那份阈值同一个口径
      guard: createConversationGuardProbe({
        conversations: this.conversations,
        messages: this.messages,
        configManager: this.configManager,
      }),
      handoff: this.handoffService,
      emit: (name, payload) => this.emitEvent(name, payload),
      now: () => this.clock.now(),
    });
    this.autoNaming = new AutoNaming({
      conversations: this.conversations,
      messages: this.messages,
      configManager: this.configManager,
      notices: this.noticeService,
      emit: (name, payload) => this.emitEvent(name, payload),
      now: () => this.clock.now(),
    });
    // 配置改完的「生效」一跳：回收 Scope（重连 MCP）+ 合成一条通知（F-E2 / F-F9）
    this.configService = new ConfigService({
      configManager: this.configManager,
      models: this.modelService,
      discovery: this.discoveryService,
      agents: agentRepository,
      findWorkspace,
      apply: this.createApplyPort(),
      now: () => this.clock.now(),
    });

    // ---- 7. 一轮的执行者（普通对话与临时对话共用同一份 agent 工厂） ----
    this.chatRunner = new ChatRunner({
      messages: this.messages,
      conversations: this.conversations,
      scopes: this.scopeRegistry,
      runs: this.runRegistry,
      createAgent,
      emit: (name, payload) => this.emitEvent(name, payload),
      clock: this.clock,
      prepareAttachments: (context) => this.assetService.prepareAttachments(context),
      onError: (error, context) => {
        this.logger.error("一轮对话写库失败", { context, error: describeError(error) });
      },
    });
    // 临时对话：不落库、不推流式事件，一次返回（D3 / R1 / R49）；Scope 仍按目录去借
    this.transientRunner = new TransientRunner({
      scopes: this.scopeRegistry,
      createAgent: transientAgentFactoryFrom(createAgent),
      configManager: this.configManager,
      now: () => this.clock.now(),
    });

    // ---- 8. 上传接收（同一条 WS 上的二进制分帧） ----
    this.uploads = new UploadReceiver({
      assetsDir: paths.assetsDir,
      finalize: (request) => this.assetService.finalizeUpload(request),
      onError: (error, context) => {
        this.logger.warn("上传收尾失败", { context, error: describeError(error) });
      },
    });

    // ---- 9. 接线：方法表 + 一条 WebSocket ----
    this.handlers = createHandlers(this.handlerDeps());
    const target = this.resolveTarget();
    this.capabilities = options.capabilities ?? (() => createCapabilities());
    this.hub = new WsHub({
      host: target.host,
      port: target.port,
      verifyToken: this.buildVerifier(),
      handlers: this.handlers,
      uploads: this.uploads,
      serverVersion: this.version,
      startedAt: this.startedAt,
      capabilities: () => this.capabilities(),
      defaultLanguage: options.defaultLanguage,
      // 通知与问题里的句子按收件人那条连接的语言重新渲染一次（D8）
      localizeEvent: createEventLocalizer(),
      // 连接数变化是退出判据的一个触发源（A10：不另起计时器）
      onConnectionsChanged: () => {
        void this.checkExit();
      },
      clock: () => this.clock.now(),
      logger: this.logger,
    });
    this.hubForPush = this.hub;
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

  /** 本进程是否在自己监听 */
  get running(): boolean {
    return this.phase === "running";
  }

  /** 是不是挂靠在「已经在运行」的那个实例上（本进程没监听） */
  get attached(): boolean {
    return this.phase === "attached";
  }

  /** 服务地址（`port: 0` 时是系统分配的那个；没在服务时为 `null`） */
  get address(): ListenTarget | null {
    return this.listening;
  }

  /**
   * 开始服务。
   *
   * 两步顺序是有意的：
   *   1. **先看这台机器上是不是已经有人在服务**（发现文件是唯一真相）。活着就挂靠它的地址，
   *      本进程不重复监听 —— 同一个数据根起两个进程会各写一份 `server.json`，客户端连谁都不对。
   *      陈旧的（pid 已死、或文件坏了）清掉再起。
   *   2. 自己起：本地实例先备好凭证交付文件 → 监听 → 按**实际**地址写发现文件。客户端读的是
   *      发现文件里的端口，端口被占退回临时端口时启动参数里的那个数已经不是真的了。
   */
  async start(): Promise<ListenTarget> {
    if (this.phase === "running" || this.phase === "attached") {
      throw new Error("ServerApp 已经在服务");
    }
    if (this.phase === "stopped") throw new Error("ServerApp 已收尾，不能再启动");

    const existing = await this.detectRunningInstance();
    if (existing !== null) {
      this.listening = { host: existing.host, port: existing.port };
      this.phase = "attached";
      this.logger.warn("已有服务端在运行，本进程不重复监听", existing);
      return this.listening;
    }

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
    this.ownsServerFile = true;
    this.phase = "running";
    this.stopAllRecycled = this.scopeRegistry.onAllRecycled(() => {
      void this.checkExit();
    });
    return actual;
  }

  /**
   * 收尾：对称于 `start()` —— 摘发现文件 → 回收 Scope → 断连接 → 关上传 → 关库。
   *
   * 幂等：`server.shutdown`、判据、信号处理器都可能先到，只有第一次真的做事。
   * 挂靠别人的实例时不摘发现文件（那份不属于本进程）。
   */
  stop(reason: ExitReason = "requested"): Promise<ExitFacts> {
    this.closing ??= this.doStop(reason);
    return this.closing;
  }

  /** 收尾 + 交棒给「真的退出」（判据成立、`server.shutdown`、信号处理器走这条） */
  async shutdown(reason: ExitReason = "requested"): Promise<ExitFacts> {
    const facts = await this.stop(reason);
    if (!this.exited) {
      this.exited = true;
      await this.exitHook(facts);
    }
    return facts;
  }

  /**
   * 退出判据（PRD L4 / 裁定 R53）：没有连接、没有在跑的轮次、Scope 全部回收 —— 什么都不欠了。
   *
   * 触发源有三个，都不另起计时器（A10：计时器只有一处，即 `ScopeRegistry` 里那份空闲计时）：
   *   - `ScopeRegistry.onAllRecycled`：Scope 全部拆完那一刻；
   *   - 每轮结算（`onTurnSettled`）：最后一件欠着的事可能是刚跑完的这一轮；
   *   - `WsHub.onConnectionsChanged`：最后一条连接走了。
   *
   * 两个防止误退的口子：
   *   1. **还没被真正用过**时不判：只有握过手（凭证被接受）的连接才算「有人用过它」，
   *      刚起来的进程与端口扫描器留下的空连接都不该把服务端送走；
   *   2. 只在自己监听中判断（造好未启动、挂靠别人、已收尾时都不判）。
   */
  async checkExit(): Promise<void> {
    if (this.phase !== "running" || this.checking) return;
    this.checking = true;
    try {
      if (this.hub.connectionInfos().length > 0) return;
      if (!this.served) return;
      if (this.runRegistry.size() > 0) return;
      if (this.scopeRegistry.size() > 0) return;
      await this.shutdown("idle");
    } finally {
      this.checking = false;
    }
  }

  private async doStop(reason: ExitReason): Promise<ExitFacts> {
    const facts: ExitFacts = {
      reason,
      connections: this.hub.connectionInfos().length,
      runs: this.runRegistry.size(),
      scopes: this.scopeRegistry.size(),
    };

    const ownsServerFile = this.ownsServerFile;
    this.phase = "stopped";
    this.ownsServerFile = false;
    this.listening = null;
    this.stopAllRecycled?.();
    this.stopAllRecycled = null;

    if (ownsServerFile) {
      try {
        await clearServerFile(this.paths);
      } catch (error) {
        this.logger.warn("清理发现文件失败", { error: describeError(error) });
      }
    }
    // Scope 一起拆掉：MCP 连接是它持有的，进程退出之后没有别人会替它关（D28 同生共死）
    try {
      await this.scopeRegistry.recycleAll();
    } catch (error) {
      this.logger.warn("收尾时回收 Scope 失败", { error: describeError(error) });
    }
    await this.hub.close();
    // 关上传：还没结束的分片按 `begin` 记的临时文件清掉，不留垃圾在 assets/ 下
    try {
      await this.uploads.dispose();
    } catch (error) {
      this.logger.warn("收尾时清理上传失败", { error: describeError(error) });
    }
    await this.db.close();
    return facts;
  }

  /**
   * 启动时的单实例自查（architecture §2：发现文件是「这台机器上谁在服务」的唯一真相）。
   *
   * 三种情况分开处理：
   *   - 没有文件：没人服务，正常起；
   *   - 文件在、pid 活着：有人服务，返回它的地址（调用方据此挂靠）；
   *   - 文件在、pid 已死（或文件坏了）：留在那儿只会让客户端连一个不存在的进程，清掉再起。
   */
  private async detectRunningInstance(): Promise<ServerFileInfo | null> {
    let info: ServerFileInfo | null;
    try {
      info = await readServerFile(this.paths);
    } catch (error) {
      // 坏文件与「文件不在」必须分开看：坏的那份拦不住启动，但要清掉，否则每次启动都撞它
      this.logger.warn("发现文件不可用，先清掉再起", { error: describeError(error) });
      await clearServerFile(this.paths).catch(() => undefined);
      return null;
    }
    if (info === null) return null;
    // 同一个进程里再起一个（宿主把服务端当库用）时，那份记录本来就是我们自己的
    if (info.pid === process.pid || isProcessAlive(info.pid)) return info;

    try {
      await clearServerFile(this.paths);
      this.logger.warn("清掉陈旧的发现文件（那个进程已经不在了）", { pid: info.pid });
    } catch (error) {
      this.logger.warn("清理陈旧发现文件失败", { error: describeError(error) });
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // handler 的注入点
  // -------------------------------------------------------------------------

  /** 把持有者交给 handler 层：它只拿引用，不 new 任何东西 */
  private handlerDeps(): HandlerDeps {
    return {
      version: this.version,
      startedAt: this.startedAt,
      capabilities: () => this.capabilities(),
      workspaces: this.workspaceService,
      conversations: this.conversationService,
      messages: this.messageService,
      search: this.searchService,
      credentials: this.credentialService,
      assets: this.assetService,
      config: this.configService,
      agents: this.agentService,
      models: this.modelService,
      completion: this.completionService,
      notices: this.noticeService,
      questions: this.questionService,
      handoff: this.handoffService,
      runner: this.chatRunner,
      scopes: this.scopeRegistry,
      transient: this.transientRunner,
      readConfig: () => this.readConfig(),
      refreshThinkingPresets: async () => {
        this.presets = await this.configManager.readReasoningPresets();
      },
      now: () => this.nowIso(),
      requestStop: () => this.requestStop(),
      onTurnSettled: () => {
        void this.checkExit();
      },
      // D23：有挡着的问题（交接确认、不可撤销动作确认）就不受理这一轮
      assertSendable: async (conversationId) => {
        await this.questionService.assertSendable(conversationId);
      },
      // D2：一轮结算后起一次自动命名（幂等：条件不成立时它自己什么都不做）
      autoNameAfterTurn: async (conversationId, language) => {
        await this.autoNaming.afterTurn(conversationId, language);
      },
      onHookError: (error, hook) => {
        this.logger.warn("结算后的钩子失败", { hook, error: describeError(error) });
      },
      // 现场快照里的问题：`conversation.state` 要能一次给出「现在有没有东西在等回答」（D22 / L5）
      questionsFor: async (conversationId) =>
        (await this.questionService.list({ conversationId })).questions,
      upgrade: (params) => this.upgradeServer(params),
    };
  }

  /**
   * `server.shutdown` 的收尾请求。
   *
   * 收尾放在下一轮事件循环：回包要先把「受理了」写出去，客户端才知道它没白点。
   */
  private requestStop(): void {
    setTimeout(() => {
      void this.shutdown("requested");
    }, 0);
  }

  // -------------------------------------------------------------------------
  // 工厂（缺省的 SDK 装配）
  // -------------------------------------------------------------------------

  /** 监听地址：`local` 推默认地址，显式 `host` 覆盖它；`port: 0` 原样交给系统分配 */
  private resolveTarget(): ListenTarget {
    const target = resolveListenTarget({
      port: this.options.port,
      configPort: this.options.configPort,
      local: this.local,
    });
    return {
      host: this.options.host ?? target.host,
      port: this.options.port === 0 ? 0 : target.port,
    };
  }

  /** 缺省的 Scope 工厂：按 SDK 口径装能力，能力目录由发现服务按 cwd 算好（R54 / L9） */
  private defaultScopeFactory(): ScopeFactory {
    // 一次 acquire 只算一遍路径：四个目录同属「这个 cwd 的能力布局」
    const abilityPaths = (cwd: string) => this.discoveryService.scopeAbilityPaths(cwd);
    return createWorkspaceScopeFactory({
      // 两个来源：Workspace（按 id 查库）与临时对话（键里带着 cwd，D3「只借 Scope」）
      resolveWorkspace: async (key) => {
        const transientCwd = cwdOfTransientScopeKey(key);
        if (transientCwd !== null) return { cwd: transientCwd };
        const row = await this.workspaces.get(key);
        return row ? { cwd: row.cwd } : undefined;
      },
      getConfig: () => this.configManager.read(),
      agentsDir: this.discoveryService.agentsDir,
      skillsPaths: (cwd) => abilityPaths(cwd).skillsPaths,
      toolsPaths: (cwd) => abilityPaths(cwd).toolsPaths,
      subAgentsPaths: (cwd) => abilityPaths(cwd).subAgentsPaths,
      mcpPaths: (cwd) => abilityPaths(cwd).mcpPaths,
    });
  }

  /** 缺省的 agent 工厂：SDK 口径装配（硬线、子 Agent 递归、交接线、工具刷新） */
  private defaultAgentFactory(): AgentFactory {
    const assembled = createSdkAgentFactory({
      handoff: this.options.handoff,
      resolveModelId: (context) =>
        this.conversationStates.getModelOverride(context.conversationId) ?? undefined,
      resolveModelParams: (context) => this.thinkingParams(context),
    });
    if (this.options.handoff) return assembled;

    // R50：没有交接服务就不装交接插件，但第一次装配 agent 时要说一声（不静默）。
    // 一次进程只说一次：这话描述的是装配能力，不是某一轮的错。
    return async (context) => {
      if (!this.handoffWarningSent) {
        this.handoffWarningSent = true;
        void this.notifyMissingHandoff();
      }
      return await assembled(context);
    };
  }

  /** R50 的那一条警告：交接插件没装时至少让人在通知栏里看到 */
  private async notifyMissingHandoff(): Promise<void> {
    try {
      await this.noticeService.create({
        level: "warning",
        code: "notice.logWarning",
        params: { summary: "handoff plugin not installed (no handoff service injected)" },
        duration: null,
      });
    } catch (error) {
      this.logger.warn("推交接插件缺失的警告失败", { error: describeError(error) });
    }
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
  ): Promise<{
    model: AppConfig["models"][number] | null;
    endpoint: AppConfig["endpoints"][number] | null;
  }> {
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

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /**
   * 推送一个事件（`NoticeService` / `QuestionService` / `ChatRunner` 共用同一个出口）。
   *
   * 造好接线层之前没有连接可推，这时的事件只写库不外发（重连之后客户端自己拉，L5）。
   */
  private emitEvent<E extends EventName>(name: E, payload: EventMap[E]): void {
    if (this.hubForPush === null) return;
    this.hubForPush.push(name, payload);
  }

  // -------------------------------------------------------------------------
  // 配置生效（F-E2 / F-F9）
  // -------------------------------------------------------------------------

  /**
   * 把「配置变了」这件事办成两件具体的事：回收受影响的能力、合成一条通知。
   *
   * 回收的粒度按改动范围分：只改了某个项目的 MCP（`workspace` 作用域）→ 只拆那个项目的
   * Scope；其余改动（端点 / 模型 / 上限 / 用户级 MCP）影响所有 Scope → 全部回收。
   * `recycleAll` 对正被持有的 Scope 是「打完标记等它释放」，所以报告里的 id 是
   * 「将会重建的那些」—— 正在跑的那一轮不会在写到一半时被抽掉能力（R52）。
   */
  private createApplyPort(): ConfigApplyPort {
    return {
      apply: async (change: ConfigApplyChange): Promise<ConfigApplyOutcome> => {
        const recycledWorkspaceIds = await this.recycleScopesFor(change);
        const notice = await this.noticeService.create({
          level: "info",
          code: "notice.settingsApplied",
          duration: APPLIED_NOTICE_SECONDS,
        });
        return { recycledWorkspaceIds, noticeId: notice.id };
      },
    };
  }

  private async recycleScopesFor(change: ConfigApplyChange): Promise<string[]> {
    const held = this.scopeRegistry.workspaceIds();
    if (change.mcp && !change.config && change.workspaceIds.length > 0) {
      const targets = change.workspaceIds.filter((id) => held.includes(id));
      for (const workspaceId of targets) await this.scopeRegistry.disposeWorkspace(workspaceId);
      return targets;
    }
    await this.scopeRegistry.recycleAll();
    return held;
  }

  // -------------------------------------------------------------------------
  // 升级（D4 / F-E3）
  // -------------------------------------------------------------------------

  /**
   * `server.upgrade`：比一次「磁盘上的版本」与「正在跑的版本」。
   *
   * 三种结论（契约里的 `ServerUpgradeState`）：磁盘读不出来 → `not_available`；两个版本一样
   * 且没有要求别的目标 → `already_latest`；磁盘已经是新的（或请求的目标版本已落盘）→
   * `restart_scheduled`，随后安排一次收尾：进程退出后由启动方式重新拉起（服务端不自己装包，
   * D4）。
   */
  private async upgradeServer(params: { targetVersion?: string }): Promise<ServerUpgradeResult> {
    const diskVersion = readDiskVersion();
    const asked =
      typeof params.targetVersion === "string" && params.targetVersion.trim() !== ""
        ? params.targetVersion.trim()
        : null;
    if (diskVersion === null) {
      return {
        state: "not_available",
        currentVersion: this.version,
        diskVersion: null,
        targetVersion: asked,
      };
    }
    const target = asked ?? diskVersion;
    if (diskVersion === this.version && asked === null) {
      return {
        state: "already_latest",
        currentVersion: this.version,
        diskVersion,
        targetVersion: target,
      };
    }
    if (target !== diskVersion) {
      // 要的那个版本还没落到磁盘上：升级本身没完成，这时候重启只会回到旧版本
      return {
        state: "not_available",
        currentVersion: this.version,
        diskVersion,
        targetVersion: target,
      };
    }
    if (target === this.version) {
      return {
        state: "already_latest",
        currentVersion: this.version,
        diskVersion,
        targetVersion: target,
      };
    }
    setTimeout(() => {
      void this.shutdown("requested");
    }, 0);
    return {
      state: "restart_scheduled",
      currentVersion: this.version,
      diskVersion,
      targetVersion: target,
    };
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
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 那个 pid 还活着吗。
 *
 * `process.kill(pid, 0)` 不真的发信号，只做存在性探测：`ESRCH` 表示没有这个进程；
 * `EPERM` 表示进程在、只是不归我们管（照样算活着）—— 后一种正是「别的用户起的服务端」。
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}
