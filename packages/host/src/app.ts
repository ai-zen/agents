/**
 * `HostApp` —— 单根对象：把零件接成一台真能跑、能被连的服务（architecture §3 / §4）。
 *
 * 这个文件的边界是三件事：
 *
 *   1. **组装**：按对象图的顺序 `new` 出依赖（库 → 仓储 → 配置 → 运行时 → 服务 → 接线），
 *      每一层都靠构造参数注入；没有模块级单例、没有反射扫描、不读进程工作目录。
 *   2. **启停**：`start()` 决定监听在哪、把**实际**地址写进发现文件；`stop()` 对称地拆回去
 *      （摘发现文件、断连接、关上传、销毁 Scope、关库）。
 *   3. **判据**：什么时候「什么都不欠了」可以退出（PRD L4 / 裁定 R53），以及启动时
 *      「这台机器上是不是已经有人在服务」（单实例，architecture §2）。
 *
 * 方法实现不在这里：每个域的 handler 在 `handlers/`，由 {@link createHandlers} 拼成一张表交给
 * `WsHub`。本文件只给它们提供持有者（服务、运行时、配置、时钟）与几个只有它才接得起来的钩子：
 *   - **配置生效**（`ConfigApplyPort`）：改完配置要刷新受影响的 Scope（F-E2）并发一条通知（F-F9）；
 *   - **Scope 装配**（`ScopeRegistry` 的工厂）：能力目录由 `DiscoveryService` 按 cwd 算好（R54/L9）；
 *   - **退出判据**（`checkExit`）：连接数与在跑的轮次两个来源都收敛到一处。
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AgentRepository, ConfigManager } from "@ai-zen/agents-sdk";
import type { AppConfig, ConfigRecoveredHandler, HandoffService, ReasoningPresets } from "@ai-zen/agents-sdk";

import { readHostSettings, resolveListenTarget, resolvePaths } from "./config.js";
import type { ListenTarget, HostPaths } from "./config.js";
import { createHandlers } from "./handlers/index.js";
import type { HandlerDeps } from "./handlers/index.js";
import { DEFAULT_LANGUAGE, normalizeLanguage } from "./i18n/index.js";
import type { Language } from "./i18n/index.js";
import {
  clearHostFile,
  createLocalCredential,
  createTokenVerifier,
  readHostFile,
  UploadReceiver,
  writeHostFile,
  WsHub,
} from "./net/index.js";
import type { HandlerTable, HubLogger, HostFileInfo } from "./net/index.js";
import {
  AgentRegistry,
  ChatRunner,
  createSdkAgentFactory,
  createWorkspaceScopeFactory,
  RunRegistry,
  ScopeRegistry,
  systemClock,
} from "./runtime/index.js";
import type {
  AgentBuildContext,
  AgentFactory,
  Clock,
  HandoffProvider,
  ScopeFactory,
  TurnSettledFacts,
} from "./runtime/index.js";
import { ConversationDrafts } from "./runtime/ConversationDrafts.js";
import { TransientRunner, cwdOfTransientScopeKey, transientAgentFactoryFrom } from "./runtime/TransientRunner.js";
import {
  ConversationService,
  CredentialService,
  MessageService,
  SearchService,
  WorkspaceService,
} from "./services/index.js";
import type { ConversationRuntimePort } from "./services/index.js";
import { AgentService } from "./services/AgentService.js";
import { AssetService } from "./services/AssetService.js";
import { AutoNaming } from "./services/AutoNaming.js";
import { CompletionService } from "./services/CompletionService.js";
import { ConfigService } from "./services/ConfigService.js";
import type { ConfigApplyChange, ConfigApplyOutcome, ConfigApplyPort } from "./services/ConfigService.js";
import { DiscoveryService } from "./services/DiscoveryService.js";
import { createSdkHandoffService, HandoffService as HandoffDocumentsService } from "./services/HandoffService.js";
import { Logger } from "./services/Logger.js";
import { ModelService } from "./services/ModelService.js";
import { NoticeService, createEventLocalizer } from "./services/NoticeService.js";
import { PeerSessionService } from "./services/PeerSessionService.js";
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
import type { HostUpgradeResult } from "./wire/index.js";
import type { EventMap, EventName } from "./wire/events.js";

// ---------------------------------------------------------------------------
// 选项与事实
// ---------------------------------------------------------------------------

/** 读不到包元数据时的版本号（服务照常能跑，只是升级判定拿不到真版本） */
const FALLBACK_VERSION = "0.0.0";

/** 配置生效那条通知留几秒（F-F9：一次改动合成一条，一秒级的提示归 `info`） */
const APPLIED_NOTICE_SECONDS = 3;

/** 版本自检的缺省间隔（D4 / F-E3：低频就够，磁盘上的版本不会一秒一变） */
const VERSION_CHECK_INTERVAL_MS = 30_000;

/**
 * 起一个低频定时器，返回取消函数。
 *
 * 缺省实现是 `setInterval(...).unref()`：这个定时器不该成为「进程为什么还没退」的原因。
 * 做成注入点是因为用例不可能真等 30 秒（假定时器又会把真套接字的关闭路径拖住）。
 */
export type RepeatTimer = (task: () => void, everyMs: number) => () => void;

const startRepeatTimer: RepeatTimer = (task, everyMs) => {
  const timer = setInterval(task, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};

/** 进程为什么会走到「什么都不欠了」 */
export type ExitReason = "idle" | "requested";

/** 退出那一刻的事实（判断依据 + 为什么退） */
export interface ExitFacts {
  reason: ExitReason;
  /** 那一刻还有几条连接（`idle` 时为 0） */
  connections: number;
  /** 那一刻还在跑的轮次数（`idle` 时为 0） */
  runs: number;
  /**
   * 收尾那一刻还持有几个 Workspace Scope（接下来 `disposeAll` 会把它们全部销毁）。
   *
   * 它**不是**判据，`idle` 时也可以大于 0：手里还剩 Scope 不代表还欠活。
   */
  scopes: number;
}

/**
 * 「真的退出」这个动作。
 *
 * 进程退不退是不可逆的事，所以做成注入点：生产缺省 `process.exit(0)`，
 * 用例注入一个记账函数，从而能验证「判据在什么时刻成立」而不把测试进程送走。
 */
export type ExitHook = (facts: ExitFacts) => void | Promise<void>;

/** 组装 `HostApp` 的入参 */
export interface HostAppOptions {
  /** 数据根（缺省 `AI_ZEN_DIR`，再缺省 `~/.ai-zen`，PRD F-J4） */
  aiZenDir?: string;
  /** 启动参数给的端口（优先级最高，D25）；`0` 表示让系统分配（用例与冒烟用） */
  port?: number;
  /**
   * 配置文件（`<dataRoot>/host.json`）里的端口（第二优先，D25）。
   *
   * 不传时由 `create()` 自己读那份文件（裁定 R67）；显式传了就以传入的为准
   * （命令行已经读过一次，不必再读）。
   */
  configPort?: number;
  /** 显式指定监听地址（优先级高于 `local` 推出的那个） */
  host?: string;
  /** 本地实例只监听回环（PRD A6）；缺省 `true` */
  local?: boolean;
  /** 宿主版本；缺省读包元数据 */
  version?: string;
  /** 造 agent 的工厂；缺省按 SDK 口径装配（用例注入假 agent，不必连模型） */
  createAgent?: AgentFactory;
  /** 造 Scope 的工厂；缺省按 SDK 口径装配（用例可以给不带能力的空 Scope） */
  createScope?: ScopeFactory;
  /** 交接服务（SDK 口径，装交接线插件用）；未注入时不装插件并推一条警告通知（裁定 R50） */
  handoff?: (context: AgentBuildContext) => HandoffService | undefined;
  /** 时钟（轮次回收、退出判据与用例里的时间推进） */
  clock?: Clock;
  /** 真退出时做什么；缺省 `process.exit(0)` */
  exit?: ExitHook;
  /** 连接未声明语言时的缺省语言（PRD D8）；不给时用配置里的 `language`，再缺省英文 */
  defaultLanguage?: Language;
  /** 日志口（连接事件与内部错误）；缺省写到 `<dataRoot>/logs/host.log` 并按大小轮转 */
  logger?: HubLogger;
  /** 读磁盘上的版本号（D4 / F-E3 的自检要比它）；缺省读本包 `package.json` */
  diskVersion?: () => string | null;
  /** 版本自检的间隔（毫秒），缺省 30 秒；用例调小以免真等 */
  versionCheckIntervalMs?: number;
  /** 起低频定时器的方式（缺省 `setInterval` + `unref`）；用例注入自己的，从而不必真等 30 秒 */
  startVersionTimer?: RepeatTimer;
}

// ---------------------------------------------------------------------------
// 包版本
// ---------------------------------------------------------------------------

/**
 * 宿主版本：读本包的 `package.json`。
 *
 * 相对 `import.meta.url` 找而不是读进程工作目录：宿主是常驻后台进程，工作目录由启动方式
 * 决定（`src/app.ts` 与 `dist/app.js` 的上一级都是包根，两种形态都能读到同一份）。
 */
export function resolveHostVersion(): string {
  return readDiskVersion() ?? FALLBACK_VERSION;
}

/**
 * 磁盘上的版本号：读本包的 `package.json`；读不到（或格式不对）返回 `null`。
 *
 * 升级判定（D4 / F-E3）要的就是「磁盘上现在是哪个版本」，所以这里与宿主版本共用
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
// 配置文件恢复出厂的通知口
// ---------------------------------------------------------------------------

/**
 * 配置文件坏了被恢复出厂时的通知口（D32）。
 *
 * `host.json` 与 `config.json` 的首次读都在通知服务之前（端口要在开库之前定下来，
 * `bootstrap()` 在造对象之前），装配期发生的恢复先攒在这里；`HostApp` 造好之后 `attach()`
 * 接上真正的通知，攒下的补发完，此后每恢复一次当场发一次。
 */
class ConfigRecoverySpool {
  private readonly queued: string[] = [];
  private sink: ConfigRecoveredHandler | null = null;

  /** 交给 `readHostSettings` / `ConfigManager` 的那个回调 */
  readonly onRecovered: ConfigRecoveredHandler = (path) => {
    if (this.sink !== null) return this.sink(path);
    this.queued.push(path);
  };

  /** 接上通知口，并把攒下的那些补发完 */
  async attach(sink: ConfigRecoveredHandler): Promise<void> {
    this.sink = sink;
    for (const path of this.queued.splice(0)) await sink(path);
  }
}

// ---------------------------------------------------------------------------
// HostApp
// ---------------------------------------------------------------------------

export class HostApp {
  // ---- 基础设施 ----
  readonly paths: HostPaths;
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
  /** agent 的持有者（`AgentRegistry`）：`scope.dispose` 撞上还活着的 agent 就是问它 */
  readonly agentRegistry: AgentRegistry;
  readonly runRegistry: RunRegistry;
  /**
   * 服务层要的两件运行时事实：忙不忙、删掉之后的中止。
   *
   * 模型与思考档位不在这里 —— 它们在会话行上。
   */
  readonly conversationRuntime: ConversationRuntimePort;
  /** 还没发过第一条消息的对话（R56：`create` 只发 id 与身份，首次 `send` 才落库） */
  readonly conversationDrafts: ConversationDrafts;
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
  /**
   * 平级会话（阶段 1）：模型在一段对话里开另一段对话，那边跑完把结果推回来。
   *
   * 记录只活在进程内（不建表）：重启之后子会话就是一段普通会话，这里查不到它。
   */
  readonly peerSessions: PeerSessionService;
  readonly autoNaming: AutoNaming;

  // ---- 接入 ----
  readonly uploads: UploadReceiver;
  readonly hub: WsHub;
  /** 方法名 → 实现（`handlers/createHandlers` 拼出来的那张表） */
  readonly handlers: HandlerTable;

  /** 宿主版本（`hello` 与 `host.version` 报的那一个） */
  readonly version: string;
  /** 进程启动时刻（ISO 8601） */
  readonly startedAt: string;
  /** 是不是本地实例（PRD A6：决定监听范围与要不要发本地凭证交付文件） */
  readonly local: boolean;

  private readonly options: HostAppOptions;
  private readonly clock: Clock;
  private readonly logger: HubLogger;
  /** 自己拥有的文件日志（注入了外部 logger 时为 `null`：那份不归本对象关） */
  private readonly fileLogger: Logger | null;
  private readonly exitHook: ExitHook;
  /** 磁盘版本的读法（D4 / F-E3 自检用；用例换成假实现） */
  private readonly readDiskVersion: () => string | null;
  /** 版本自检的间隔与定时器句柄（`stop()` 里清掉，不留悬挂定时器） */
  private readonly versionCheckIntervalMs: number;
  private readonly startVersionTimer: RepeatTimer;
  /** 取消自检定时器（`null` 表示现在没有在跑） */
  private stopVersionTimer: (() => void) | null = null;
  /** 配置文件给出的端口（第二优先；`undefined` 表示这一档没说话） */
  private readonly configPort: number | undefined;

  /** 当前阶段：造好 / 自己监听中 / 挂靠已有实例 / 已收尾 */
  private phase: "created" | "running" | "attached" | "stopped" = "created";
  private listening: ListenTarget | null = null;
  /** 发现文件是不是这一份进程写的（挂靠别人的实例时不能去删它） */
  private ownsHostFile = false;
  /** 收尾只做一次（`host.shutdown`、判据、显式 `stop()` 都可能先到） */
  private closing: Promise<ExitFacts> | null = null;
  /** 「真的退出」只交棒一次 */
  private exited = false;
  private checking = false;
  /** 这条进程至少被用过一次：没有它，刚起来的进程会在第一个客户端连上来之前就判自己该退 */
  private served = false;
  /** 思考策略表快照（装配 agent 时要把档位名展开成参数，而那一层是同步的） */
  private presets: ReasoningPresets | null = null;
  /** 推送入口（造好之前为 `null`：这时没有任何连接可推） */
  private hubForPush: WsHub | null = null;
  /** 交接服务（SDK 口径）：给了就装交接线插件（R59） */
  private readonly handoffProvider: HandoffProvider;
  /** R50 的那条警告只说一次（描述的是装配能力，不是某一轮的错） */
  private handoffWarningSent = false;

  private constructor(
    options: HostAppOptions,
    paths: HostPaths,
    db: Database,
    configManager: ConfigManager,
    configPort: number | undefined,
    logger: HubLogger,
  ) {
    this.options = options;
    this.paths = paths;
    this.db = db;
    this.configManager = configManager;
    this.clock = options.clock ?? systemClock;
    this.logger = logger;
    this.fileLogger = logger instanceof Logger ? logger : null;
    this.exitHook = options.exit ?? defaultExit;
    this.version = options.version ?? resolveHostVersion();
    this.readDiskVersion = options.diskVersion ?? readDiskVersion;
    this.versionCheckIntervalMs = options.versionCheckIntervalMs ?? VERSION_CHECK_INTERVAL_MS;
    this.startVersionTimer = options.startVersionTimer ?? startRepeatTimer;
    this.configPort = configPort;
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

    // ---- 2. 运行时：Scope 的持有、轮次占位、服务层要的窄接口 ----
    // 工厂包一层再交给注册表：它要读发现服务算好的能力目录，而那一层比 Scope 先造好
    const injectedScopeFactory = options.createScope;
    this.scopeRegistry = new ScopeRegistry({
      createScope: injectedScopeFactory ?? ((key) => this.defaultScopeFactory()(key)),
      // 「这个 Scope 上还活着哪几段对话」只有 `AgentRegistry` 知道（它在下面几行才造好）：
      // 这里给一个现读的入口，`dispose` 被叫到时才问
      liveConversations: (workspaceId) => this.agentRegistry.conversationIds(workspaceId),
      onError: (error, workspaceId) => {
        this.logger.error("销毁 Scope 失败", { workspaceId, error: describeError(error) });
      },
    });
    this.runRegistry = new RunRegistry({ clock: this.clock });
    this.conversationRuntime = this.createConversationRuntime();
    this.conversationDrafts = new ConversationDrafts();
    // 交接服务：入参优先，缺省按 cwd 造一个真的（R59：不再因为「没注入」就不装交接插件）
    this.handoffProvider = options.handoff ?? this.defaultHandoffProvider();

    // ---- 3. 素材（上传落定、厂商 file_id 缓存、「素材 id → 内容段」、`__asset_id` 两端的解析） ----
    this.assetService = new AssetService({
      assets: this.assets,
      // 厂商 file_id 的缓存：这个端点上有就复用，换端点了就内联，都没有才上传
      vendorFiles: this.assets,
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
      // 删完项目之后：关系行已经随外键没了，归零的素材由素材层删行 + 删文件
      sweepAssets: (assetIds) => this.assetService.sweepUnreferenced(assetIds),
      runtime: this.conversationRuntime,
      now: () => this.clock.now(),
    });
    this.conversationService = new ConversationService({
      conversations: this.conversations,
      messages: this.messages,
      workspaces: this.workspaces,
      assets: this.assets,
      // 撤回 / 删对话之后同一件事：引用归零的素材才删字节
      sweepAssets: (assetIds) => this.assetService.sweepUnreferenced(assetIds),
      questions: this.questions,
      configManager: this.configManager,
      runtime: this.conversationRuntime,
      drafts: this.conversationDrafts,
      // 多端在线同步（L5 / D22）：改名/置顶/撤回/删除之后对方窗口得知道去拉
      emit: (name, payload) => this.emitEvent(name, payload),
      // 助手那两格事实（名字 / 能不能跑）：判定在 AgentService，「能不能跑」要看模型 / 端点 / 密钥
      describeAgent: (agentId) => this.agentService.describe(agentId),
      now: () => this.clock.now(),
    });
    this.messageService = new MessageService({
      conversations: this.conversations,
      messages: this.messages,
      // 刚建出来、还没发过消息的对话在库里没有行（R56）：读消息/现场时按草稿认它
      drafts: this.conversationDrafts,
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
    // 平级会话：建会话归 `ConversationService`（与 `conversation.create` 同一条路），开跑与唤醒归
    // `ChatRunner`。后者在 §7 才造出来，所以这里只闭包住 `this`：两个动作都是「调用那一刻才去拿」
    // （与 `createConversationRuntime` 里 `forget` 的晚绑定同一个理由）。
    this.peerSessions = new PeerSessionService({
      conversations: this.conversations,
      conversationCreator: this.conversationService,
      messages: this.messages,
      chatRunner: {
        run: (params) => this.chatRunner.run(params),
        enqueue: (params) => this.chatRunner.enqueue(params),
      },
      now: () => this.clock.now(),
      // 结果没送到父对话**不许静默丢**：这一处就是那一次出声（阶段 1 不补投）
      onError: (error, context) => {
        this.logger.error("平级会话出错", { context, error: describeError(error) });
      },
    });
    // agent 工厂只造一次：交接回合与普通对话用同一个（普通对话的 agent 常驻，装配一次跨轮复用；
    // 交接回合自己一行一装配、跑完即弃）
    const createAgent = options.createAgent ?? this.defaultAgentFactory();
    // agent 的持有者：「agent 从哪来」唯一的入口。它内部先要 Scope（幂等），
    // 于是 Scope → Agent 的依赖顺序写在代码里，而不是靠调用方记得先要 Scope
    this.agentRegistry = new AgentRegistry({
      scopes: this.scopeRegistry,
      createAgent,
      // 「这段对话有没有在跑一轮」只有 `RunRegistry` 一处（`markStale` 判空闲 / 在跑用它）
      runs: this.runRegistry,
    });
    this.noticeService = new NoticeService({
      notices: this.notices,
      emit: (name, payload) => this.emitEvent(name, payload),
      now: () => this.clock.now(),
    });
    // PRD F-J2：warn / error 也上通知（永久）。日志口子比通知服务先造出来（早造的服务也要能记），
    // 所以在这里后接一次；回环由 Logger 自己的重入标记挡住。
    this.fileLogger?.setNotifier(async (level, summary) => {
      await this.noticeService.log(level, summary);
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
    // 配置改完的「生效」一跳：刷新 Scope（重读配置 + 重新发现，MCP 连接跟着对账）+ 合成一条通知
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
      agents: this.agentRegistry,
      emit: (name, payload) => this.emitEvent(name, payload),
      clock: this.clock,
      prepareAttachments: (context) => this.assetService.prepareAttachments(context),
      // 历史里的 `__asset_id` 每轮发送前按当前模型还原（换模型 / 重启之后历史里的图还能发）
      prepareHistory: (context) => this.assetService.resolveHistory(context),
      // 用户消息落库那一刻扫 content 里的 `__asset_id`，记成关系行（`conversation_assets`）
      linkMessageAssets: (context) => this.assetService.linkMessageAssets(context),
      // 结算时按这段会话行上的模型取交接线（`setModel` 之后就是新模型的阈值）
      defaultLanguage: options.defaultLanguage ?? DEFAULT_LANGUAGE,
      // R59：一轮结算之后宿主自己判断要不要问交接线的问题（D22：在对话停下之后）
      onTurnSettled: (facts) => {
        void this.askHandoffAfterSettle(facts);
      },
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
      // `asset.begin` 带 sha256 时先问一句：同一段对话里同一张图只存一份、只传一次
      findExisting: (input) => this.assetService.findExistingAsset(input),
      // 草稿对话（R56）在第一次带图上传时就落库：素材行按 `conversationId` 挂外键，
      // 所以落库这一步挪到 `asset.begin`（与「第一次 send」同义，`ensurePersisted` 自己幂等）
      ensureConversation: async (conversationId, language) => {
        await this.conversationService.ensurePersisted(conversationId, language);
      },
      onError: (error, context) => {
        this.logger.warn("上传收尾失败", { context, error: describeError(error) });
      },
    });

    // ---- 9. 接线：方法表 + 一条 WebSocket ----
    this.handlers = createHandlers(this.handlerDeps());
    const target = this.resolveTarget();
    this.hub = new WsHub({
      host: target.host,
      port: target.port,
      verifyToken: this.buildVerifier(),
      handlers: this.handlers,
      uploads: this.uploads,
      hostVersion: this.version,
      startedAt: this.startedAt,
      // 连接没带语言时用配置里的缺省语言（再缺省英文，D8 / R58）；配置可变，所以每一跳现读
      defaultLanguage: options.defaultLanguage ?? (() => this.configuredLanguage()),
      // 通知与问题里的句子按收件人那条连接的语言重新渲染一次（D8）
      localizeEvent: createEventLocalizer(),
      // 连接数变化是退出判据的一个触发源（A10：不另起计时器）
      onConnectionsChanged: () => {
        void this.checkExit();
      },
      clock: () => this.clock.now(),
      logger: this.fileLogger?.withSource("ws") ?? this.logger,
    });
    this.hubForPush = this.hub;
  }

  /**
   * 报一条「配置文件坏了、已恢复出厂」（D32）。
   *
   * 恢复动作本身在读到坏文件那一刻就做完了（写回 + 用出厂配置），这里只负责让用户知道
   * 自己被重置过 —— warning 是 PRD F-J2 要求上通知栏的那一档。
   */
  private async noticeRecoveredConfig(path: string): Promise<void> {
    await this.noticeService.create({
      level: "warning",
      code: "notice.configRecovered",
      params: { path },
      duration: null,
    });
  }

  /**
   * 造一个 `HostApp`（不监听）。
   *
   * 顺序上先读配置文件、再开库：端口写得不对（`config_invalid`）时连库都不必建
   * （裁定 R67：显式给出的非法端口报错，不静默回落）。建库与迁移失败时把库关掉再抛，
   * 避免留下一个开着 worker 的坏实例。
   */
  static async create(options: HostAppOptions = {}): Promise<HostApp> {
    const paths = resolvePaths(options.aiZenDir);
    // 配置文件坏了就恢复出厂（D32）：恢复过的文件名先攒着，等通知服务起来再补一条 warning
    const recoveries = new ConfigRecoverySpool();
    // D25 的中间那一档：只在这一档真的要被用到时才读（参数给了就不必读，坏文件也不该拦住显式端口）
    const configPort =
      options.configPort ??
      (options.port === undefined ? (await readHostSettings(paths, recoveries.onRecovered)).port : undefined);

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

    const configManager = new ConfigManager(paths.configFile, recoveries.onRecovered);
    // SDK 口径的首次初始化：目录 + config.json + 默认助手 + 子 Agent + mcp.json + 出厂 Skill
    // + 思考策略表。已有文件不覆盖（用户自定义的助手定义 `custom: true` 原样保留）。
    await configManager.bootstrap();

    const logging = resolveLogger(options, paths);
    let app: HostApp;
    try {
      app = new HostApp(options, paths, db, configManager, configPort, logging.logger);
    } catch (error) {
      // 构造途中的抛出（端口不合法、接线造不出来）也要把库关掉：worker 线程不该被漏下
      await db.close();
      await logging.own?.close();
      throw error;
    }
    // 通知服务就位了：装配期恢复过出厂的那几份配置各补一条 warning
    await recoveries.attach((path) => app.noticeRecoveredConfig(path));
    return app;
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
   *      本进程不重复监听 —— 同一个数据根起两个进程会各写一份 `host.json`，客户端连谁都不对。
   *      陈旧的（pid 已死、或文件坏了）清掉再起。
   *   2. 自己起：本地实例先备好凭证交付文件 → 监听 → 按**实际**地址写发现文件。客户端读的是
   *      发现文件里的端口，端口被占退回临时端口时启动参数里的那个数已经不是真的了。
   */
  async start(): Promise<ListenTarget> {
    if (this.phase === "running" || this.phase === "attached") {
      throw new Error("HostApp 已经在服务");
    }
    if (this.phase === "stopped") throw new Error("HostApp 已收尾，不能再启动");

    const existing = await this.detectRunningInstance();
    if (existing !== null) {
      this.listening = { host: existing.host, port: existing.port };
      this.phase = "attached";
      this.logger.warn("已有宿主在运行，本进程不重复监听", existing);
      return this.listening;
    }

    // 本地实例的凭证交付：客户端首次连接时直接取这份（PRD A5 / architecture §2）
    if (this.local) await createLocalCredential(this.db, this.paths);
    this.presets = await this.configManager.readReasoningPresets();

    const bound = await this.hub.listen();
    const actual = this.hub.address() ?? bound;
    await writeHostFile(this.paths, {
      pid: process.pid,
      host: actual.host,
      port: actual.port,
      version: this.version,
      local: this.local,
      startedAt: this.startedAt,
    });

    this.listening = actual;
    this.ownsHostFile = true;
    this.phase = "running";
    this.startVersionCheck();
    this.logInfo("宿主开始监听", {
      host: actual.host,
      port: actual.port,
      version: this.version,
      logFile: this.fileLogger?.filePath ?? null,
    });
    return actual;
  }

  /**
   * 收尾：对称于 `start()` —— 摘发现文件 → 销毁 Scope → 断连接 → 关上传 → 关库。
   *
   * 幂等：`host.shutdown`、判据、信号处理器都可能先到，只有第一次真的做事。
   * 挂靠别人的实例时不摘发现文件（那份不属于本进程）。
   */
  stop(reason: ExitReason = "requested"): Promise<ExitFacts> {
    this.closing ??= this.doStop(reason);
    return this.closing;
  }

  /** 收尾 + 交棒给「真的退出」（判据成立、`host.shutdown`、信号处理器走这条） */
  async shutdown(reason: ExitReason = "requested"): Promise<ExitFacts> {
    const facts = await this.stop(reason);
    if (!this.exited) {
      this.exited = true;
      await this.exitHook(facts);
    }
    return facts;
  }

  /**
   * 退出判据（PRD L4 / 裁定 R53）：没有连接、没有在跑的轮次 —— 这个进程就没有存在意义了。
   *
   * 触发源只有两个，都不另起计时器：
   *   - 每轮结算（`onTurnSettled`）：最后一件欠着的事可能是刚跑完的这一轮；
   *   - `WsHub.onConnectionsChanged`：最后一条连接走了。
   *
   * 判据只剩「连接」与「在跑的轮次」两条：连接的开关是一个**明确事件**，不是计时器，而
   * 「有人连着 / 有一轮在跑」才是「这个进程还有用」的判据。手里还持有 Scope 不构成欠活 ——
   * 它们的存在意义就是服务连接，最后一个客户端走了就显式收尾
   * （`shutdown` → `doStop` → `disposeAll`，Scope 与 MCP 连接一起拆）然后退出。
   *
   * 两个防止误退的口子：
   *   1. **还没被真正用过**时不判：只有握过手（凭证被接受）的连接才算「有人用过它」，
   *      刚起来的进程与端口扫描器留下的空连接都不该把宿主送走；
   *   2. 只在自己监听中判断（造好未启动、挂靠别人、已收尾时都不判）。
   */
  async checkExit(): Promise<void> {
    if (this.phase !== "running" || this.checking) return;
    this.checking = true;
    try {
      if (this.hub.connectionInfos().length > 0) return;
      if (!this.served) return;
      // 还有一轮在跑：不能把它掐死，等这一轮结算后由 `onTurnSettled` 再判一次
      if (this.runRegistry.size() > 0) return;
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
      // 收尾那一刻还持有着几个 Scope（接下来 `disposeAll` 会把它们全部销毁）
      scopes: this.scopeRegistry.workspaceIds().length,
    };

    const ownsHostFile = this.ownsHostFile;
    this.phase = "stopped";
    this.ownsHostFile = false;
    this.listening = null;
    this.stopVersionCheck();

    if (ownsHostFile) {
      try {
        await clearHostFile(this.paths);
      } catch (error) {
        this.logger.warn("清理发现文件失败", { error: describeError(error) });
      }
    }
    // Scope 一起拆掉：MCP 连接是它持有的，进程退出之后没有别人会替它关（D28 同生共死）。
    // `disposeAll` 不拒绝（收尾时「还有 agent 活着」不是要挡住销毁的理由）
    try {
      await this.scopeRegistry.disposeAll();
    } catch (error) {
      this.logger.warn("收尾时销毁 Scope 失败", { error: describeError(error) });
    }
    await this.hub.close();
    // 关上传：还没结束的分片按 `begin` 记的临时文件清掉，不留垃圾在 assets/ 下
    try {
      await this.uploads.dispose();
    } catch (error) {
      this.logger.warn("收尾时清理上传失败", { error: describeError(error) });
    }
    await this.db.close();
    // 最后关日志：前面每一步的失败都要能落盘，收尾完再 flush 并关流（PRD F-J2）
    this.logInfo("宿主已收尾", { reason, connections: facts.connections });
    await this.fileLogger?.close();
    return facts;
  }

  // -------------------------------------------------------------------------
  // 升级自检（D4 / F-E3）
  // -------------------------------------------------------------------------

  /**
   * 起一个低频自检：磁盘上的版本号变了（且已经是新的）就收尾退出，由启动方式重拉。
   *
   * 这个定时器不是退出判据的触发源（判据只看连接与在跑的轮次），
   * 它只把「包已经换了」这个事实变成一次重启。缺省的启动方式带 `unref()`：
   * 只有它还在跑时，也不该拦住进程退出。
   */
  private startVersionCheck(): void {
    if (this.stopVersionTimer !== null) return;
    this.stopVersionTimer = this.startVersionTimer(() => {
      void this.checkDiskVersion();
    }, this.versionCheckIntervalMs);
  }

  /** 清掉自检定时器（`stop()` 里调：用例会断言退出后没有悬挂定时器） */
  private stopVersionCheck(): void {
    if (this.stopVersionTimer === null) return;
    this.stopVersionTimer();
    this.stopVersionTimer = null;
  }

  /**
   * 比一次磁盘版本与运行版本。
   *
   * 三条前提都成立才重启：磁盘读得出来、与正在跑的不是同一个版本、且磁盘上的那个**更新**
   * （回退不算升级，重启只会把用户拉回旧版本）。重启前推一条通知：进程会走，界面上得有个交代。
   */
  private async checkDiskVersion(): Promise<void> {
    if (this.phase !== "running") return;
    const disk = this.readDiskVersion();
    if (disk === null) return;
    if (compareVersions(disk, this.version) <= 0) return;

    this.stopVersionCheck();
    this.logInfo("磁盘上的版本已经是新的，安排一次重启", {
      running: this.version,
      disk,
    });
    try {
      await this.noticeService.create({
        level: "info",
        code: "notice.upgradeRestarting",
        params: { version: disk },
        duration: null,
      });
    } catch (error) {
      this.logger.warn("推升级重启的通知失败", { error: describeError(error) });
    }
    await this.shutdown("requested");
  }

  /**
   * 启动时的单实例自查（architecture §2：发现文件是「这台机器上谁在服务」的唯一真相）。
   *
   * 三种情况分开处理：
   *   - 没有文件：没人服务，正常起；
   *   - 文件在、pid 活着：有人服务，返回它的地址（调用方据此挂靠）；
   *   - 文件在、pid 已死（或文件坏了）：留在那儿只会让客户端连一个不存在的进程，清掉再起。
   */
  private async detectRunningInstance(): Promise<HostFileInfo | null> {
    let info: HostFileInfo | null;
    try {
      info = await readHostFile(this.paths);
    } catch (error) {
      // 坏文件与「文件不在」必须分开看：坏的那份拦不住启动，但要清掉，否则每次启动都撞它
      this.logger.warn("发现文件不可用，先清掉再起", { error: describeError(error) });
      await clearHostFile(this.paths).catch(() => undefined);
      return null;
    }
    if (info === null) return null;
    // 同一个进程里再起一个（宿主把宿主当库用）时，那份记录本来就是我们自己的
    if (info.pid === process.pid || isProcessAlive(info.pid)) return info;

    try {
      await clearHostFile(this.paths);
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
      workspaces: this.workspaceService,
      conversations: this.conversationService,
      messages: this.messageService,
      search: this.searchService,
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
      // 多端在线同步（L5 / D22）：删项目带走的那几段对话也要推 `deleted`
      emit: (name, payload) => this.emitEvent(name, payload),
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
      upgrade: (params) => this.upgradeHost(params),
      // 从磁盘重载（F-E1 / R63）：走配置服务那条「生效」路（刷新 Scope + 合成一条通知）；
      // 思考策略表是启动时的快照，重载时一并重读（否则改完档位表要等 setThinking 才生效）
      reload: async () => {
        const report = await this.configService.reload();
        this.presets = await this.configManager.readReasoningPresets();
        return report;
      },
    };
  }

  /**
   * `host.shutdown` 的收尾请求。
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
      configPort: this.configPort,
      local: this.local,
    });
    return {
      host: this.options.host ?? target.host,
      port: this.options.port === 0 ? 0 : target.port,
    };
  }

  /** 缺省的 Scope 工厂：按 SDK 口径装能力，能力目录由发现服务按 cwd 算好（R54 / L9） */
  private defaultScopeFactory(): ScopeFactory {
    // 一次 create 只算一遍路径：四个目录同属「这个 cwd 的能力布局」
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
      // 平级会话的两个工具（`create_session` / `read_session_status`）靠这个端口落地
      peerSessions: this.peerSessions,
    });
  }

  /** 缺省的 agent 工厂：SDK 口径装配（硬线、子 Agent 递归、交接线、工具刷新） */
  private defaultAgentFactory(): AgentFactory {
    const assembled = createSdkAgentFactory({
      handoff: (context) => this.handoffFor(context),
      // 档位名 → 参数补丁要用思考策略表；配置变更后会重读，所以这里给一个现读入口
      thinkingPresets: () => this.presets,
    });
    return async (context) => {
      const agent = await assembled(context);
      // 「这个 agent 是哪段会话的」只能由宿主记：core 的 `Agent` 上没有 `conversationId`，
      // 而平级会话的工具只拿得到 `ctx.agent`（不给 core 加字段，这里记一笔就够了）
      this.peerSessions.bind(agent, context.conversationId);
      return agent;
    };
  }

  /**
   * 这一轮用哪个交接服务（R59：交接插件真的装上，不再因为「没注入」而整体不装）。
   *
   * 缺省实现按这一轮 Scope 的 cwd 造一个 SDK 交接服务（文档写进项目，D19）。拿不到时
   * 说一声（R50：不静默）——这条警告描述的是装配能力，所以一个进程只说一次。
   */
  private handoffFor(context: AgentBuildContext): ReturnType<HandoffProvider> {
    const service = this.handoffProvider(context);
    if (service) return service;
    if (!this.handoffWarningSent) {
      this.handoffWarningSent = true;
      void this.notifyMissingHandoff();
    }
    return undefined;
  }

  /** 缺省的交接服务：按这一轮的 cwd 造 SDK 口径的那个（文档落 `<cwd>/.ai-zen/handoffs`） */
  private defaultHandoffProvider(): HandoffProvider {
    return (context) =>
      createSdkHandoffService(context.scope.cwd, {
        // 模板来自磁盘上的 `handoff` Skill（F-D6）；读不到时 SDK 自己回退到内置模板
        skillDirs: this.discoveryService.scopeAbilityPaths(context.scope.cwd).skillsPaths,
      });
  }

  /**
   * 一轮结算之后：到了交接线就在对话停下之后问用户（R59 / F-D2 / D22）。
   *
   * 前提任缺一条都不问：模型配了交接线且这一轮真的越过了它、这一轮是用户本人叫起来的、
   * 对话已经停下（不在流式中途）、没有已挂着的交接问题（多端看到的是同一行）。
   * 问与答之后的事都归 `QuestionService`。
   */
  private async askHandoffAfterSettle(facts: TurnSettledFacts): Promise<void> {
    // 自动推送叫起来的轮次没有人在看这条连接：给一段没人盯着的对话挂交接问题是噪音。
    // 要问就等用户自己说话那一轮（那一轮结算时报的就是 `"user"`）。
    if (facts.source !== "user") return;
    if (facts.handoffTokens <= 0) return;
    if (facts.promptTokens < facts.handoffTokens) return;
    if (this.runRegistry.isRunning(facts.conversationId)) return;
    try {
      const pending = await this.questionService.list({
        conversationId: facts.conversationId,
        state: "pending",
      });
      if (pending.questions.some((question) => question.kind === "handoff")) return;
      await this.questionService.askHandoff(
        {
          conversationId: facts.conversationId,
          promptTokens: facts.promptTokens,
          handoffTokens: facts.handoffTokens,
        },
        facts.language,
      );
    } catch (error) {
      // 问不出口不影响已经结算的这一轮：记一笔日志，下一轮还有机会
      this.logger.warn("交接线提问失败", {
        conversationId: facts.conversationId,
        error: describeError(error),
      });
    }
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
   * 服务层要的那个窄接口（`ConversationRuntimePort`）。
   *
   * `forget` 指向 `ChatRunner.forget`（中止在跑的轮次、清掉这一轮的内存现场）。它只能晚绑定：
   * 服务比执行者先造出来，所以这里闭包住 `this`，调用那一刻才去拿 `chatRunner`。
   */
  private createConversationRuntime(): ConversationRuntimePort {
    return {
      isRunning: (conversationId) => this.runRegistry.isRunning(conversationId),
      // 活跃会话列表那一格：注册表只知道「谁在跑 + 什么时候开始的」，这里照它报，
      // 不自己算一个「看起来像在跑」的第二真相
      runState: (conversationId) => {
        const run = this.runRegistry.summary(conversationId);
        return run ? { status: "running", startedAt: run.startedAt } : null;
      },
      forget: (conversationId) => {
        this.chatRunner.forget(conversationId);
      },
    };
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

  /** 读配置（`config.json` 坏了由 SDK 恢复出厂，D32） */
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
   * 记一条普通信息（生命周期事件这类）。
   *
   * 注入了外部 logger 时它就是 `HubLogger`（只有 warn / error），所以这条走文件日志那一侧；
   * 没有文件日志时什么也不做。
   */
  private logInfo(message: string, detail?: unknown): void {
    this.fileLogger?.info(message, detail);
  }

  /**
   * 连接没声明语言时用哪一种（PRD D8 / 裁定 R58）。
   *
   * 真相在 `config.json` 的 `language`（可经 `config.setDefaults` 改），所以每一跳都现读；
   * 配置读不出来或没写这个字段时回落英文 —— 语言这件事不该让握手失败。
   */
  private async configuredLanguage(): Promise<Language> {
    try {
      const config = await this.configManager.read();
      return normalizeLanguage(config.language);
    } catch {
      return DEFAULT_LANGUAGE;
    }
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
   * 把「配置变了」这件事办成两件具体的事：刷新受影响的能力、合成一条通知。
   *
   * 配置改动的本质是「磁盘上几个 json 变了」——**不拆任何 Scope**：对已经建好的那个调一次
   * `Scope.refresh()`（重读配置 + 各插件重新发现，MCP 连接跟着对账），实例还是同一个，
   * 正在跑的那一轮也不会被抽掉能力（R52）。
   */
  private createApplyPort(): ConfigApplyPort {
    return {
      apply: async (change: ConfigApplyChange): Promise<ConfigApplyOutcome> => {
        const refreshedWorkspaceIds = await this.refreshScopesFor(change);
        const notice = await this.noticeService.create({
          level: "info",
          code: "notice.settingsApplied",
          duration: APPLIED_NOTICE_SECONDS,
        });
        return { refreshedWorkspaceIds, noticeId: notice.id };
      },
    };
  }

  /**
   * 刷新配置改动涉及的、**已经存在**的 Scope（就地刷，不重建），并换掉受影响的 agent。
   *
   * 刷哪些按改动范围定：只改了某个项目的 MCP（`workspace` 作用域）→ 只刷那几个项目现有的
   * Scope；其余改动（端点 / 模型 / 上限 / 用户级 MCP）影响所有 Scope → 现存的全都刷。
   * 没有的跳过：不为刷新去创建一个 Scope（下一段对话 `create` 时会按新配置建）。
   *
   * 为什么刷完还要 `markStale`：`Scope.refresh()` 刷得动能力（工具、MCP），刷**不**动已经建好的
   * 模型客户端 —— `createModel(scope.config, …)` 是装配那一刻读的。agent 现在又是常驻的（装配
   * 一次用很多段），不显式换掉的话“改了配置就生效”就不再成立。所以对每个目标 workspace 打一次
   * 陈旧标记：空闲的 agent 当场销毁，在跑的那一段由 `ChatRunner` 在结算时销毁，下一段重新装配。
   */
  private async refreshScopesFor(change: ConfigApplyChange): Promise<string[]> {
    const existing = this.scopeRegistry.workspaceIds();
    const wanted =
      change.mcp && !change.config && change.workspaceIds.length > 0
        ? change.workspaceIds
        : existing;
    const targets = wanted.filter((workspaceId) => existing.includes(workspaceId));
    for (const workspaceId of targets) {
      await this.scopeRegistry.refreshWorkspace(workspaceId);
      // 能力已经换新的了；手里还拿着旧模型客户端的 agent 也一起换掉（这就是本单“配置改动
      // 最迟下一段生效”的全部机关，见 `AgentRegistry.markStale`）
      const pending = this.agentRegistry.markStale(workspaceId);
      if (pending.length > 0) {
        this.logInfo("配置生效：正在跑的那几段结算之后换掉 agent", {
          workspaceId,
          conversationIds: pending,
        });
      }
    }
    return targets;
  }

  // -------------------------------------------------------------------------
  // 升级（D4 / F-E3）
  // -------------------------------------------------------------------------

  /**
   * `host.upgrade`：比一次「磁盘上的版本」与「正在跑的版本」。
   *
   * 三种结论（契约里的 `HostUpgradeState`）：磁盘读不出来 → `not_available`；两个版本一样
   * 且没有要求别的目标 → `already_latest`；磁盘已经是新的（或请求的目标版本已落盘）→
   * `restart_scheduled`，随后安排一次收尾：进程退出后由启动方式重新拉起（宿主不自己装包，
   * D4）。
   */
  private async upgradeHost(params: { targetVersion?: string }): Promise<HostUpgradeResult> {
    const diskVersion = this.readDiskVersion();
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

/** 造一个 `HostApp`（`index.ts` 的 `createHost` 就是它） */
export function createHost(options: HostAppOptions = {}): Promise<HostApp> {
  return HostApp.create(options);
}

/** 缺省的退出动作：把进程送走（用例注入自己的 `exit` 时不会走到这里） */
const defaultExit: ExitHook = () => {
  process.exit(0);
};

/**
 * 日志口子：注入了就用注入的，否则造一个写 `<dataRoot>/logs/host.log` 的文件日志（PRD F-J2）。
 *
 * `own` 标的是「这份日志归本对象关」：注入进来的那份归注入方管，收尾时不能替它关。
 */
function resolveLogger(
  options: HostAppOptions,
  paths: HostPaths,
): { logger: HubLogger; own: Logger | null } {
  if (options.logger !== undefined) return { logger: options.logger, own: null };
  const logger = new Logger({ dir: paths.logsDir });
  return { logger, own: logger };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 那个 pid 还活着吗。
 *
 * `process.kill(pid, 0)` 不真的发信号，只做存在性探测：`ESRCH` 表示没有这个进程；
 * `EPERM` 表示进程在、只是不归我们管（照样算活着）—— 后一种正是「别的用户起的宿主」。
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

/**
 * 比两个版本号（`1.2.0` 与 `1.10.0`）：返回 `<0` 表示左边旧、`0` 相同、`>0` 左边新。
 *
 * 按 `.` 切段逐段比，两段都是数字时按数字比（`1.10.0` 比 `1.9.0` 新）；不是数字的段
 * （`alpha` 这种预发布标记）按字符串比。够用的理由：升级自检只回答「磁盘上的是不是比我新」，
 * 不排序、不解析 semver 的完整规则。
 */
export function compareVersions(left: string, right: string): number {
  const partsOf = (version: string): string[] => version.trim().split(/[.-]/);
  const leftParts = partsOf(left);
  const rightParts = partsOf(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? "0";
    const b = rightParts[index] ?? "0";
    const aNumber = Number(a);
    const bNumber = Number(b);
    const bothNumeric = Number.isFinite(aNumber) && Number.isFinite(bNumber) && a !== "" && b !== "";
    if (bothNumeric) {
      if (aNumber !== bNumber) return aNumber < bNumber ? -1 : 1;
      continue;
    }
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}
