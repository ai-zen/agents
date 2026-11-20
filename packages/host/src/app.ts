/**
 * `HostApp` —— 单根对象：把零件接成一台真能跑、能被连的服务（PLAN §3 / §4）。
 *
 * 这个文件的边界是两件事：
 *
 *   1. **组装**：按对象图的顺序 `new` 出依赖（仓储 → 运行时 → 服务 → 投递 → 接线），每一层都
 *      靠构造参数注入；不读进程工作目录。
 *   2. **启停**：`start()` 决定监听在哪、把**实际**地址写进发现文件；`stop()` 对称地拆回去
 *      （摘发现文件 → 销毁 Scope → 断连接 → 清上传 → 关库 → 关日志，PLAN §4）。启动时还要判
 *      「这台机器上是不是已经有人在服务」（单实例，PLAN §8）。
 *
 * 方法实现不在这里：每个域的 handler 在 `handlers/`，由 {@link createHandlers} 拼成一张表交给
 * `WsHub`。本文件只给它们提供持有者（服务、运行时、配置、时钟）与几个只有它才接得起来的钩子：
 *   - **配置生效**（`ConfigApplyPort`）：改完配置要刷新受影响的 Scope（F-E2）并发一条通知（F-F9）；
 *   - **Scope 装配**（`ScopeRegistry` 的工厂）：能力目录由 `DiscoveryService` 按 cwd 算好（R54/L9）；
 *   - **变闲那一拍**（`ChatRunner.onIdle`）：兑现待交接、判交接线、起名（PLAN §5.2）。
 *
 * 这里没有退出判据：宿主不因为没人连着而收尾（PRD 4.12：关掉宿主是用户的显式动作，
 * 就是 `host.shutdown` 那条路）。收尾本身在 {@link HostApp.doStop}，它只由显式请求触发。
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AgentNS } from "@ai-zen/agents-core";
import { FileLogger } from "@ai-zen/agents-logger";
import type { LogRecord, LogSink } from "@ai-zen/agents-logger";
import { AgentRepository, ConfigManager } from "@ai-zen/agents-sdk";
import type {
  AppConfig,
  ConfigRecoveredHandler,
  HandoffService,
  ReasoningPresets,
} from "@ai-zen/agents-sdk";

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
  ScopeRegistry,
  systemClock,
} from "./runtime/index.js";
import type {
  AgentBuildContext,
  AgentFactory,
  Clock,
  HandoffProvider,
  ScopeFactory,
} from "./runtime/index.js";
import { SessionDrafts } from "./runtime/SessionDrafts.js";
import {
  TransientRunner,
  cwdOfTransientScopeKey,
  transientAgentFactoryFrom,
} from "./runtime/TransientRunner.js";
import {
  SessionService,
  CredentialService,
  MessageService,
  SearchService,
  WorkspaceService,
} from "./services/index.js";
import type { SessionRuntimePort } from "./services/index.js";
import { AgentService } from "./services/AgentService.js";
import { AssetService } from "./services/AssetService.js";
import { AutoNaming } from "./services/AutoNaming.js";
import { CompletionService } from "./services/CompletionService.js";
import { ConfigService } from "./services/ConfigService.js";
import type {
  ConfigApplyChange,
  ConfigApplyOutcome,
  ConfigApplyPort,
} from "./services/ConfigService.js";
import { DiscoveryService } from "./services/DiscoveryService.js";
import {
  createSdkHandoffService,
  HandoffDocumentService,
} from "./services/HandoffDocumentService.js";
import { ModelService } from "./services/ModelService.js";
import { NoticeService, createEventLocalizer } from "./services/NoticeService.js";
import { PeerSessionService } from "./services/PeerSessionService.js";
import { QuestionService, createSessionGuardProbe } from "./services/QuestionService.js";
import {
  AssetRepository,
  SessionRepository,
  CredentialRepository,
  Database,
  MessageRepository,
  NoticeRepository,
  WorkspaceRepository,
  migrate,
} from "./storage/index.js";
import { InboxRepository } from "./storage/InboxRepository.js";
import type { HostUpgradeResult } from "./wire/index.js";
import type { EventMap, EventName } from "./wire/events.js";

// ---------------------------------------------------------------------------
// 选项与事实
// ---------------------------------------------------------------------------

/** 读不到包元数据时的版本号（服务照常能跑，只是升级判定拿不到真版本） */
const FALLBACK_VERSION = "0.0.0";

/** 宿主日志的文件名（落在宿主那一格：`<dataRoot>/logs/host/host.log`） */
const HOST_LOG_FILE_NAME = "host.log";

/** 通知模块自己那一格日志的来源标签：只在这个来源上挂「不转通知」这条规则 */
const NOTICE_SOURCE = "notice";

/**
 * SDK 那一格日志的来源标签（行上的来源说「谁写的」）：grep `sdk` 就能把「库里面的事」
 * （发现、配置降级、MCP 连接、交接）从宿主自己的流水里摘出来。与 `ws` / `notice` 同一种用法。
 */
const SDK_SOURCE = "sdk";

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

/**
 * 进程为什么收尾。
 *
 * 只有一种：用户（或 `host.upgrade` / 版本自检、信号处理器）显式要求。
 */
export type ExitReason = "requested";

/** 收尾那一刻的事实（判断依据 + 为什么退） */
export interface ExitFacts {
  reason: ExitReason;
  /** 那一刻还有几条连接 */
  connections: number;
  /** 收尾那一刻还持有几个 Workspace Scope（接下来 `disposeAll` 会把它们全部销毁）—— 只是记账 */
  scopes: number;
}

/**
 * 「真的退出」这个动作。
 *
 * 进程退不退是不可逆的事，所以做成注入点：生产缺省 `process.exit(0)`，
 * 用例注入一个记账函数，从而能验证收尾事实与交棒次数而不把测试进程送走。
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
  /** 本地实例只监听回环（PLAN A6）；缺省 `true` */
  local?: boolean;
  /** 宿主版本；缺省读包元数据 */
  version?: string;
  /** 造 agent 的工厂；缺省按 SDK 口径装配（用例注入假 agent，不必连模型） */
  createAgent?: AgentFactory;
  /** 造 Scope 的工厂；缺省按 SDK 口径装配（用例可以给不带能力的空 Scope） */
  createScope?: ScopeFactory;
  /**
   * 交接服务（SDK 口径，装交接线插件用）。缺省按这次装配的 cwd 造一个真的；它拿不到时才不装
   * 插件，并推一条警告通知（R50）。
   */
  handoff?: (context: AgentBuildContext) => HandoffService | undefined;
  /** 时钟（收尾事实里的时刻、版本自检与用例里的时间推进） */
  clock?: Clock;
  /** 真退出时做什么；缺省 `process.exit(0)` */
  exit?: ExitHook;
  /** 连接未声明语言时的缺省语言（PRD D8）；不给时用配置里的 `language`，再缺省英文 */
  defaultLanguage?: Language;
  /** 日志口（连接事件与内部错误）；缺省写到 `<dataRoot>/logs/host/host.log` 并按大小轮转 */
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
  readonly sessions: SessionRepository;
  readonly messages: MessageRepository;
  readonly assets: AssetRepository;
  readonly notices: NoticeRepository;
  /** inbox 里还没被取走的那些条目（PRD 1.2 / 4.12）：`ChatRunner` 的三条事件写它、装配时读它 */
  readonly inbox: InboxRepository;
  readonly credentials: CredentialRepository;

  // ---- 运行时 ----
  readonly scopeRegistry: ScopeRegistry;
  /** agent 的持有者（`AgentRegistry`）：`scope.dispose` 撞上还活着的 agent 就是问它 */
  readonly agentRegistry: AgentRegistry;
  /**
   * 服务层要的运行时窄接口（`SessionRuntimePort`）：忙闲与两道闸现读、删掉之后丢现场，以及换模型 /
   * 换思考档位那一手要的「手上有没有活」与「让空闲的 agent 退役」。
   *
   * 模型与思考档位不在这里 —— 它们在会话行上。
   */
  readonly sessionRuntime: SessionRuntimePort;
  /** 还没发过第一条消息的会话（R56：`create` 只发 id 与身份，首次 `send` 才落库） */
  readonly sessionDrafts: SessionDrafts;
  readonly chatRunner: ChatRunner;
  readonly transientRunner: TransientRunner;

  // ---- 服务 ----
  readonly assetService: AssetService;
  readonly workspaceService: WorkspaceService;
  readonly sessionService: SessionService;
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
  readonly handoffService: HandoffDocumentService;
  /**
   * 平级会话：模型在一段会话里开另一段会话，之后还能接着跟它说话。
   *
   * 它自己只在进程内留一个可读名（`label`）：血缘与会话本身都在库里，重启之后照样认得。
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
  /** 是不是本地实例（PLAN A6：决定监听范围与要不要发本地凭证交付文件） */
  readonly local: boolean;

  private readonly options: HostAppOptions;
  private readonly clock: Clock;
  private readonly logger: HubLogger;
  /** 自己拥有的文件日志（注入了外部 logger 时为 `null`：那份不归本对象关） */
  private readonly fileLogger: FileLogger | null;
  /** 通知模块自己那一格日志（`source: "notice"`）：它写出去的东西不再转通知 */
  private readonly noticeLogger: LogSink;
  /** 注入 SDK 的那一格日志（`source: "sdk"`）：每处 `new ConfigManager` / `new AgentRepository`
   *  / Scope 装配 / 交接服务 / agent 工厂都用这一份 —— 一处定、一条链路到底 */
  private readonly sdkLogger: LogSink;
  /** 日志记录往通知那一侧转发的位置（容器，通知服务造好之后才接上） */
  private readonly logRecords: LogRecordRelay;
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
  /** 收尾只做一次（`host.shutdown` 与显式 `stop()` 都可能先到） */
  private closing: Promise<ExitFacts> | null = null;
  /** 「真的退出」只交棒一次 */
  private exited = false;
  /** 思考策略表快照（装配 agent 时要把档位名展开成参数，而那一层是同步的） */
  private presets: ReasoningPresets | null = null;
  /** 推送入口（造好之前为 `null`：这时没有任何连接可推） */
  private hubForPush: WsHub | null = null;
  /** 交接服务的来源（注入优先，缺省 `defaultHandoffProvider`）：有它才装交接线插件（R59） */
  private readonly handoffProvider: HandoffProvider;
  /** R50 的那条警告只说一次（描述的是装配能力，不是某一次发送的错） */
  private handoffWarningSent = false;

  private constructor(
    options: HostAppOptions,
    paths: HostPaths,
    db: Database,
    configManager: ConfigManager,
    configPort: number | undefined,
    logging: ResolvedLogging,
  ) {
    this.options = options;
    this.paths = paths;
    this.db = db;
    this.configManager = configManager;
    this.clock = options.clock ?? systemClock;
    this.logger = logging.logger;
    this.fileLogger = logging.fileLogger;
    this.logRecords = logging.records;
    this.sdkLogger = logging.sdkLogger;
    this.noticeLogger = logging.fileLogger?.withSource(NOTICE_SOURCE) ?? {
      // 注入了外部 logger 时那份只有 warn / error（`HubLogger`）：缺的 info 补一个空实现
      info: () => undefined,
      warn: (message, detail) => this.logger.warn(message, detail),
      error: (message, detail) => this.logger.error(message, detail),
    };
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
    this.sessions = new SessionRepository(db);
    this.messages = new MessageRepository(db);
    this.assets = new AssetRepository(db);
    this.notices = new NoticeRepository(db);
    this.inbox = new InboxRepository(db);
    this.credentials = new CredentialRepository(db);

    /** 助手与 subagent 的定义仓储（配置层与助手/模型/配置三个服务共用同一份目录） */
    const agentRepository = new AgentRepository(
      join(configManager.basePath, "agents"),
      logging.sdkLogger,
    );
    const subAgentRepository = new AgentRepository(
      join(configManager.basePath, "sub-agents"),
      logging.sdkLogger,
    );
    /** 按 workspaceId 取 cwd：发现、补全、配置三个服务都要同一份口径 */
    const findWorkspace = async (workspaceId: string) => {
      const row = await this.workspaces.get(workspaceId);
      return row ? { cwd: row.cwd } : undefined;
    };

    // ---- 2. 运行时：Scope 的持有、服务层要的窄接口 ----
    // 工厂包一层再交给注册表：它要读发现服务算好的能力目录，而那一层比 Scope 先造好
    const injectedScopeFactory = options.createScope;
    this.scopeRegistry = new ScopeRegistry({
      createScope: injectedScopeFactory ?? ((key) => this.defaultScopeFactory()(key)),
      // 「这个 Scope 上还活着哪几段会话」只有 `AgentRegistry` 知道（它在下面几行才造好）：
      // 这里给一个现读的入口，`dispose` 被叫到时才问
      liveSessions: (workspaceId) => this.agentRegistry.sessionIds(workspaceId),
      onError: (error, workspaceId) => {
        this.logger.error("销毁 Scope 失败", { workspaceId, error: describeError(error) });
      },
    });
    this.sessionRuntime = this.createSessionRuntime();
    this.sessionDrafts = new SessionDrafts();
    // 交接服务：注入优先，缺省按 cwd 造一个真的（R59）
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
      sessions: this.sessions,
      messages: this.messages,
      assets: this.assets,
      // 删完项目之后：关系行已经随外键没了，归零的素材由素材层删行 + 删文件
      sweepAssets: (assetIds) => this.assetService.sweepUnreferenced(assetIds),
      runtime: this.sessionRuntime,
      now: () => this.clock.now(),
    });
    this.sessionService = new SessionService({
      sessions: this.sessions,
      messages: this.messages,
      workspaces: this.workspaces,
      assets: this.assets,
      // 缺省造的助手定义仓储：`list()` 跳过读不出来的定义时那几句进 `sdk` 那一格
      logger: this.sdkLogger,
      // 撤回 / 删会话之后同一件事：引用归零的素材才删字节
      sweepAssets: (assetIds) => this.assetService.sweepUnreferenced(assetIds),
      // 侧栏那个「有没有题挂着」的圆点：题在内存里，所以问 `QuestionService`（不查表）。
      // `questionService` 在本节之后才造出来，所以这里闭包一步（调用那一刻才去拿）
      questions: {
        countPending: (sessionId) => this.questionService.countPending(sessionId),
      },
      configManager: this.configManager,
      runtime: this.sessionRuntime,
      drafts: this.sessionDrafts,
      // 多端在线同步（L5 / D22）：改名/置顶/撤回/删除之后对方窗口得知道去拉
      emit: (name, payload) => this.emitEvent(name, payload),
      // 助手那两格事实（名字 / 能不能跑）：判定在 AgentService，「能不能跑」要看模型 / 端点 / 密钥
      describeAgent: (agentId) => this.agentService.describe(agentId),
      now: () => this.clock.now(),
    });
    this.messageService = new MessageService({
      sessions: this.sessions,
      messages: this.messages,
      // 刚建出来、还没发过消息的会话在库里没有行（R56）：读消息/现场时按草稿认它
      drafts: this.sessionDrafts,
      // 列表读取只有一个来源：活着读内存，死了读库（PLAN §7）。`chatRunner` 在 §7 才造出来，
      // 所以这里只闭包一步（调用那一刻才去拿）
      live: {
        messagesOf: (sessionId, options) => this.chatRunner.messagesOf(sessionId, options),
      },
    });
    this.searchService = new SearchService({
      sessions: this.sessions,
      messages: this.messages,
      summarize: (rows) => this.sessionService.summarize(rows),
    });
    this.credentialService = new CredentialService({
      credentials: this.credentials,
      now: () => this.clock.now(),
    });

    // ---- 5. 配置、发现、模型、助手、补全 ----
    this.discoveryService = new DiscoveryService({
      configManager: this.configManager,
      findWorkspace,
      logger: this.sdkLogger,
    });
    this.modelService = new ModelService({
      configManager: this.configManager,
      agents: agentRepository,
    });
    this.agentService = new AgentService({
      configManager: this.configManager,
      agents: agentRepository,
      subAgents: subAgentRepository,
      logger: this.sdkLogger,
      now: () => this.clock.now(),
    });
    this.completionService = new CompletionService({ findWorkspace });

    // ---- 6. 平级会话、agent 持有者、通知、问题、交接、自动命名（它们互相引用，都靠注入） ----
    // 平级会话：建会话归 `SessionService`（与 `session.create` 同一条路），第一句与之后
    // 每一句都走 `ChatRunner.deliver`（一个入口）。后者在 §7 才造出来，所以这里只闭包住 `this`：
    // 两个口都是「调用那一刻才去拿」（与 `createSessionRuntime` 里 `forget` 的晚绑定同一个理由）。
    this.peerSessions = new PeerSessionService({
      sessions: this.sessions,
      sessionCreator: this.sessionService,
      messages: this.messages,
      chatRunner: {
        // 复活：创建者显式叫醒它（`create` 里那一句），与投递正交
        start: (sessionId) => this.chatRunner.start(sessionId),
        deliver: (sessionId, input) => this.chatRunner.deliver(sessionId, input),
        // 四件事现读：平级会话那边只留可读名（什么都不存，存了就要有人同步两份）
        state: (sessionId) => this.chatRunner.state(sessionId),
        // 摘要也现读：`read_session_status` 要的「最近一句」就是那一段 `agent.messages` 的尾巴
        // （不查库：状态与摘要必须同一刻、同一来源）
        messagesOf: (sessionId) => this.chatRunner.messagesOf(sessionId),
      },
    });
    // agent 工厂只造一次：常驻会话（装配一次跨多次投递复用）与一次性会话（用完即弃）都用它
    const createAgent = options.createAgent ?? this.defaultAgentFactory();
    // agent 的持有者：「agent 从哪来」唯一的入口。它内部先要 Scope（幂等），
    // 于是 Scope → Agent 的依赖顺序写在代码里，而不是靠调用方记得先要 Scope
    this.agentRegistry = new AgentRegistry({
      scopes: this.scopeRegistry,
      createAgent,
      // 每做一次生灭决定就记一笔（`reason` 是闭集，见 `AgentLifecycleReason`）：落到文件日志的
      // 信息级 —— 是诊断用的流水，不是给用户看的事件。
      onLifecycle: (event) => {
        this.logInfo("agent 生灭", event);
      },
    });
    this.noticeService = new NoticeService({
      notices: this.notices,
      emit: (name, payload) => this.emitEvent(name, payload),
      now: () => this.clock.now(),
      // 通知模块自己的失败记在 `source: "notice"` 那一格：那个来源不转通知，环就断在这儿
      logger: this.noticeLogger,
    });
    // PRD F-J2：warn / error 也上通知。日志比通知服务先造出来（早造的服务也要能记），
    // 所以在这里接上；判据与环的断法都在 `shouldNotifyFromLog` 那一条里。
    this.logRecords.attach((record) => this.forwardLogRecord(record));
    this.handoffService = new HandoffDocumentService({
      sessions: this.sessions,
      workspaces: this.workspaces,
      messages: this.messages,
      sessionViews: this.sessionService,
      // 自交接的 agent：这一段现在挂着谁（忙 / 闲 / 暂停由它自己报）
      agents: { get: (sessionId) => this.agentRegistry.get(sessionId) },
      // 判据与交接态：能不能接手（`canHandoffNow`）+ 挂牌 / 摘牌。挂牌期间只跳过写库、事件照推
      // （写文档那条指令由 SDK 直接投给 agent）。
      // `chatRunner` 在 §7 才造出来，所以这里闭包住 `this`，调用那一刻才去拿（同一个理由：
      // 平级会话那两个口也是这么接的）
      runner: {
        // 「能不能立刻接手这一批」只有一处判据（四条，在 `ChatRunner` 里）
        canHandoffNow: (sessionId) => this.chatRunner.canHandoffNow(sessionId),
        beginHandoff: (sessionId) => this.chatRunner.beginHandoff(sessionId),
        endHandoff: (sessionId) => this.chatRunner.endHandoff(sessionId),
      },
      notices: this.noticeService,
      emit: (name, payload) => this.emitEvent(name, payload),
      // 交接文档的模板来自磁盘上的 `handoff` Skill（F-D6）：与 SDK 插件同一份目录口径 ——
      // 项目里放一份同名 Skill 就能覆盖全局那份。一个服务服务所有项目的会话，所以给的是
      // 「cwd → 目录清单」；不给的话生产上会一直用 SDK 的内置兜底模板。
      skillDirs: (cwd) => this.discoveryService.scopeAbilityPaths(cwd).skillsPaths,
      // 后台那一趟里不该打断交接的差错（通知没写进去、提交之后开新会话失败）落日志
      onError: (error, context) => {
        this.logger.error("交接出错", { context, error: describeError(error) });
      },
      // 缺省执行者（SDK 的交接服务）自己那几句也进 `sdk` 那一格
      logger: this.sdkLogger,
      now: () => this.clock.now(),
    });
    this.questionService = new QuestionService({
      // 会话行：待交接那一格与自动交接开关都写在它上面；题本身不落库（PRD 4.10）
      sessions: this.sessions,
      // 「能不能立刻交接」只有一处判据（`ChatRunner.canHandoffNow`）：能就当场交接，不能就留待交接
      availability: {
        canHandoffNow: (sessionId) => this.chatRunner.canHandoffNow(sessionId),
      },
      // 硬线跟着模型走（D27）
      guard: createSessionGuardProbe({
        sessions: this.sessions,
        messages: this.messages,
        configManager: this.configManager,
      }),
      handoff: this.handoffService,
      emit: (name, payload) => this.emitEvent(name, payload),
      now: () => this.clock.now(),
    });
    this.autoNaming = new AutoNaming({
      sessions: this.sessions,
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

    // ---- 7. 投递的执行者（普通会话与一次性会话共用同一份 agent 工厂） ----
    this.chatRunner = new ChatRunner({
      messages: this.messages,
      sessions: {
        // 读那一行（身份 / 项目 / 模型与档位）：投递判「会话在不在」、装配读事实
        get: (id) => this.sessions.get(id),
        // 草稿 → 真行：只有 `start` 会走到（`session.send` 自己那一句在 handler 里）
        ensurePersisted: (id) => this.sessionService.ensurePersisted(id),
      },
      scopes: this.scopeRegistry,
      agents: this.agentRegistry,
      emit: (name, payload) => this.emitEvent(name, payload),
      clock: this.clock,
      // 历史里的 `__asset_id` 每次装配前按当前模型还原（换模型 / 重启之后历史里的图还能发）
      prepareHistory: (context) => this.assetService.resolveHistory(context),
      // 用户消息落库那一刻扫 content 里的 `__asset_id`，记成关系行（`session_assets`）
      linkMessageAssets: (context) => this.assetService.linkMessageAssets(context),
      // inbox 里还没被取走的条目：`inboxAdded` / `inboxTaken` / `inboxCleared` 逐条实时写这张
      // 表，装配出新 agent 之后按顺序读回来放回队列（PRD 1.2 / 4.12：关掉再打开，那几句还在）
      inbox: this.inbox,
      // 变闲那一拍：读一次当下事实 —— 上一次答完留下的待交接先兑现（能就交接），再看要不要
      // 问交接线、要不要起个名字。这一跳不带「刚刚发生了什么」（结果、结论），就是「此刻它闲了」
      onIdle: (sessionId) => {
        void this.handoffOnIdle(sessionId);
        this.autoNameOnIdle(sessionId);
      },
      // 没有 agent 了那一拍：只有**真的没了**（`terminated`：core 的 `stopped` / `killed`、
      // 投递撞上已关的门；`forgotten`：会话被删）才让挂在上面的题跟着没（PRD 4.10）。
      //
      // `retired` 什么都不做：退役不是「这段没了」，那是换个 agent 接着干（改配置 / 改模型 /
      // 改思考档 / 装配事实变化），题与待交接必须原样留着 —— 清掉它们等于用户改了个模型就丢了
      // 正在等的那道题。重建由下一次投递自己完成（`AgentRegistry.acquire`）。
      // 不推事件 —— 那件事由 `session.changed` 的 `agent_gone` 说（PRD 4.10）
      onDead: (sessionId, kind) => {
        if (kind === "retired") return;
        void this.questionService.dropSession(sessionId).catch((error: unknown) => {
          this.logger.warn("清掉死会话上的题失败", {
            sessionId,
            kind,
            error: describeError(error),
          });
        });
      },
      onError: (error, context) => {
        this.logger.error("宿主写库失败", { context, error: describeError(error) });
      },
    });
    // 一次性会话：不落库、不推流式事件，一次返回（D3 / R1 / R49）；Scope 仍按目录去借
    this.transientRunner = new TransientRunner({
      scopes: this.scopeRegistry,
      createAgent: transientAgentFactoryFrom(createAgent),
      configManager: this.configManager,
    });

    // ---- 8. 上传接收（同一条 WS 上的二进制分帧） ----
    this.uploads = new UploadReceiver({
      assetsDir: paths.assetsDir,
      finalize: (request) => this.assetService.finalizeUpload(request),
      // `asset.begin` 带 sha256 时先问一句：同一份字节只存一份、只传一次（按摘要全局去重）
      findExisting: (input) => this.assetService.findExistingAsset(input),
      // 草稿会话（R56）在第一次带图上传时就落库：素材行按 `sessionId` 挂外键，
      // 所以落库这一步挪到 `asset.begin`（与「第一次 send」同义，`ensurePersisted` 自己幂等）
      ensureSession: async (sessionId) => {
        await this.sessionService.ensurePersisted(sessionId);
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
      (options.port === undefined
        ? (await readHostSettings(paths, recoveries.onRecovered)).port
        : undefined);

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

    const logging = resolveLogger(options, paths);
    const configManager = new ConfigManager(
      paths.configFile,
      recoveries.onRecovered,
      logging.sdkLogger,
    );
    // SDK 口径的首次初始化：目录 + config.json + 默认助手 + subagent + mcp.json + 出厂 Skill
    // + 思考策略表。已有文件不覆盖（用户自定义的助手定义 `custom: true` 原样保留）。
    await configManager.bootstrap();

    let app: HostApp;
    try {
      app = new HostApp(options, paths, db, configManager, configPort, logging);
    } catch (error) {
      // 构造途中的抛出（端口不合法、接线造不出来）也要把库关掉：worker 线程不该被漏下
      await db.close();
      await logging.fileLogger?.close();
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
   *   2. 自己起：本地实例先备好凭证交付文件 → 监听 → 按**实际**地址写发现文件 —— 客户端读的是
   *      发现文件里的端口（`port: 0` 时那一个是系统分配的，启动参数里的 `0` 不是真的）。
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

    // 本地实例的凭证交付：客户端首次连接时直接取这份（PLAN A5 / §8）
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
   * 收尾：对称于 `start()` —— 摘发现文件 → 销毁 Scope → 断连接 → 清上传 → 关库 → 关日志。
   *
   * 幂等：`host.shutdown`、信号处理器、升级与版本自检都可能先到，只有第一次真的做事。
   * 挂靠别人的实例时不摘发现文件（那份不属于本进程）。
   */
  stop(reason: ExitReason = "requested"): Promise<ExitFacts> {
    this.closing ??= this.doStop(reason);
    return this.closing;
  }

  /** 收尾 + 交棒给「真的退出」（`host.shutdown`、信号处理器、升级重启走这条） */
  async shutdown(reason: ExitReason = "requested"): Promise<ExitFacts> {
    const facts = await this.stop(reason);
    if (!this.exited) {
      this.exited = true;
      await this.exitHook(facts);
    }
    return facts;
  }

  private async doStop(reason: ExitReason): Promise<ExitFacts> {
    const facts: ExitFacts = {
      reason,
      connections: this.hub.connectionInfos().length,
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
    // Scope 一起拆掉：MCP 连接是它持有的，进程退出之后没有别的 agent 会替它关（D28 同生共死）。
    //
    // agent 这一步是「杀掉」而不是「丢引用」：进程要退了，没人会来读那些结果，硬着陆更快 ——
    // 也正因此不 await。先 `markShuttingDown()`，因为接下来那批 kill 会把存量作废，而库里的
    // inbox 行要留着：关掉再打开，那几句还在等（PRD 1.2 / 4.12）。
    this.chatRunner.markShuttingDown();
    this.agentRegistry.disposeAll();
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
   * 它只把「包已经换了」这个事实变成一次重启（宿主不自己装包，D4）。缺省实现带 `unref()`：
   * 它不该成为「进程为什么还没退」的原因。
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
   * 两个条件都成立才重启：磁盘读得出来、且磁盘上的那个**更新**（回退不算升级，重启只会把用户
   * 拉回旧版本）。重启前推一条通知：进程会走，界面上得有个交代。
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
   * 启动时的单实例自查（PLAN §8：发现文件是「这台机器上谁在服务」的唯一真相）。
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
      sessions: this.sessionService,
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
      refreshThinkingPresets: async () => {
        this.presets = await this.configManager.readReasoningPresets();
      },
      now: () => this.nowIso(),
      // `session.abort` 的 `reason` 只落日志（core 的 `abort()` 不收原因）
      log: (message, detail) => this.logInfo(message, detail),
      requestStop: () => this.requestStop(),
      // 多端在线同步（L5 / D22）：删项目带走的那几段会话也要推 `deleted`
      emit: (name, payload) => this.emitEvent(name, payload),
      // D23：有挡着的问题（交接确认、不可撤销动作确认）就不收这一句
      assertSendable: async (sessionId) => {
        await this.questionService.assertSendable(sessionId);
      },
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
   * 收尾推迟到当前事件循环之后再跑：回包要先把「受理了」写出去，客户端才知道它没白点。
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
      // 两个来源：Workspace（按 id 查库）与一次性会话（键里带着 cwd，D3「只借 Scope」）
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
      // 能力发现的日志口：四个读盘的插件（用户工具 / Skill / MCP / subagent）都往这一格写
      logger: this.sdkLogger,
      // 平级会话的两个工具（`create_session` / `read_session_status`）靠这个端口落地
      peerSessions: this.peerSessions,
    });
  }

  /** 缺省的 agent 工厂：SDK 口径装配（硬线、subagent 递归、交接线、工具刷新） */
  private defaultAgentFactory(): AgentFactory {
    const assembled = createSdkAgentFactory({
      handoff: (context) => this.handoffFor(context),
      // SDK 侧的两处出口（交接插件迁移失败、按 id 读助手定义读不出来）进 `sdk` 那一格
      logger: this.sdkLogger,
      // 档位名 → 参数补丁要用思考策略表；配置变更后会重读，所以这里给一个现读入口
      thinkingPresets: () => this.presets,
      // 压缩的归一规则按**会话行上的自动交接开关**分（读库，不读进程内记录）：开着的那一段
      // （平级会话）没人盯着它，越线就自己压；关着的那一段（用户建的）把「要不要压」交还给宿主
      // 的提问路径（{@link askHandoffOnIdle}）。开关是会话行上的列，所以那条判断重启也不变形。
      wantsAutoHandoff: (context) => this.autoHandoffOf(context.sessionId),
      // 插件压完记一笔：会话行上写 `auto`（`manual` 那条由 `HandoffDocumentService` 自己写）
      onCompacted: (context, mode) => this.sessionService.markCompacted(context.sessionId, mode),
      // 自动交接的收口（成功/失败都到这儿，取消不到）：把闸开回来。
      // 自动那条路没有 `runToEnd` 那样的收尾，而开闸只在宿主交接收口做（PLAN §5.3）
      // —— 漏了这一格，平级会话越一次线就再也不取件。
      onHandoffSettled: (context) => {
        this.handoffService.settleAutoHandoff(context.sessionId);
      },
    });
    return async (context) => {
      const agent = await assembled(context);
      // 「这个 agent 是哪段会话的」只能由宿主记：core 的 `Agent` 上没有 `sessionId`，
      // 而平级会话的工具只拿得到 `ctx.agent`（不给 core 加字段，这里记一笔就够了）
      this.peerSessions.bind(agent, context.sessionId);
      return agent;
    };
  }

  /**
   * 这一次装配用哪个交接服务（R59：交接插件真的装上，不再因为「没注入」而整体不装）。
   *
   * 缺省实现按这次装配的 Scope 的 cwd 造一个 SDK 交接服务（文档写进项目，D19）。拿不到时
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

  /**
   * 缺省的交接服务：按这次装配的 cwd 造 SDK 口径的那个（文档落 `<cwd>/.ai-zen/handoffs`）。
   *
   * `context.scope.cwd` 就是这一段所属项目的 `workspaces.cwd`（`ScopeRegistry` 按项目行装配），
   * 它只用来算**文档落点**：`<cwd>/.ai-zen/handoffs`。新记忆长什么样不靠它，那由 SDK 那一处
   * 算（PLAN §5.3）。
   */
  private defaultHandoffProvider(): HandoffProvider {
    return (context) =>
      createSdkHandoffService(context.scope.cwd, {
        // 模板来自磁盘上的 `handoff` Skill（F-D6）；读不到时 SDK 自己回退到内置模板
        skillDirs: this.discoveryService.scopeAbilityPaths(context.scope.cwd).skillsPaths,
        // **自动交接那条路的落库接缝**：与手动那条（`runToEnd`）注入的是同一份回调。
        // 有了它，平级会话越线自动交班时记忆真的会换（旧记忆成存档会话、原会话换上断点）、
        // 闸也真的会开 —— 记忆长什么样仍是 SDK 那一处算（PRD 4.5）
        commitMemory: this.handoffService.memoryCommitter(context.sessionId),
        // SDK 交接服务自己的那几句（读不到 Skill、`self` 降级）进宿主日志的 `sdk` 那一格
        logger: this.sdkLogger,
      });
  }

  /**
   * 这一段的自动交接开关（`sessions.autoHandoff` 那一列）：读库，不读进程内记录。
   *
   * `true` = 开（平级会话那一侧：撞线自己交班、不问）；`false` = 关（用户建的那一侧：装不下
   * 时问一次）。会话行没了就当关：没有这一段可问。
   */
  private async autoHandoffOf(sessionId: string): Promise<boolean> {
    const row = await this.sessions.get(sessionId);
    return row?.autoHandoff === true;
  }

  /**
   * 变闲那一拍的两件事，**有先后**（PLAN §5.2 / §5.3）：
   *
   * 1. 上一次答完留下的待交接（`pendingHandoff`）现在能兑现就兑现 —— 那时这段不闲，所以没交接；
   * 2. 兑现了就不再问交接线（已经在交接，没理由再问一道）；没兑现（没事 / 仍然接不了）就照旧问。
   *
   * 两件事都只读当下事实：不传「上一次回答的结果」进来。
   */
  private async handoffOnIdle(sessionId: string): Promise<void> {
    const started = await this.runPendingHandoff(sessionId);
    if (started) return;
    await this.askHandoffOnIdle(sessionId);
  }

  /**
   * 兑现会话行上的待交接（`pendingHandoff`）：答完交接题时这段不闲，于是把 mode 记在这里，
   * 等下一次变闲再做（PLAN §5.2）。
   *
   * 读一次 `canHandoffNow`（全仓唯一一份判据）：
   *   - **能** → `handoff.start`，起来之后再清掉那一格；
   *   - **不能** → 原样留着，下一次变闲再看（这里不报错、不发通知：它不是用户动作，
   *     只是一段会话自己的进度）。
   *
   * 清在 start **之后**：「能」是现读的，从读到 start 之间那几微秒里它可能又忙起来 ——
   * 那时 start 会拒（`busy`），待交接那一格必须还在，否则用户答的那一下就被悄悄丢了。
   *
   * @returns 这一拍真的开始了交接
   */
  private async runPendingHandoff(sessionId: string): Promise<boolean> {
    try {
      const mode = await this.questionService.readPendingHandoff(sessionId);
      if (mode === null) return false;
      const availability = this.chatRunner.canHandoffNow(sessionId);
      if (!availability.ok) return false;

      await this.handoffService.start(
        { sessionId, mode, then: "new_session" },
        this.options.defaultLanguage ?? DEFAULT_LANGUAGE,
      );
      // 起来了才清：交接之后的进度（写到哪、降级、失败）走通知，这一格没有第二件事要说
      await this.questionService.writePendingHandoff(sessionId, null);
      return true;
    } catch (error) {
      this.logger.warn("待交接没有跑起来", { sessionId, error: describeError(error) });
      return false;
    }
  }

  /**
   * 变闲那一拍：到了交接线就问用户（R59 / F-D2 / D22）。
   *
   * **全部读当下事实** —— 没有任何「刚刚发生了什么」的东西传进来：这一步不带结果、不带用量、
   * 不带「谁发起的」。四条前提，任缺一条都不问：
   *
   * 1. 自动交接开关是关的（会话行上那一列）：开着的那一段（平级会话）撞线自己交班，不问；
   * 2. 这段会话现在那个 agent 的历史里，最后一条带用量的助手消息越过交接线了（拿不到就不问：
   *    没有用量就没有“越线”这回事）；
   * 3. 交接线先看会话行上的覆盖值（`handoffThreshold`），没有就看**会话行上的模型**
   *    （`setModel` 之后就是新模型的阈值），`0` 表示这条线关着；
   * 4. 已经挂着一道交接题就不问（多端看到的是同一道）。
   *
   * 问与答之后的事都归 `QuestionService`；问不出口只记日志（不重试，也不影响别的）。
   */
  private async askHandoffOnIdle(sessionId: string): Promise<void> {
    const agent = this.agentRegistry.get(sessionId);
    if (!agent) return;
    const promptTokens = lastPromptTokens(agent.messages);
    if (promptTokens === null) return;

    try {
      const session = await this.sessions.get(sessionId);
      if (!session) return;
      // 开关开着的那一段不问：它自己压（PRD 4.5）
      if (session.autoHandoff) return;
      const config = await this.readConfig();
      const model = config.models.find((item) => item.id === session.modelId);
      // 会话行上的覆盖值优先（`null` = 跟模型走）
      const handoffTokens = session.handoffThreshold ?? model?.tokenThresholds.handoff ?? 0;
      if (handoffTokens <= 0) return;
      if (promptTokens < handoffTokens) return;

      const pending = await this.questionService.list({ sessionId });
      // 只看**还挂着**的那一道：已经答过的题留在对象里（多端要看到「答了 + 谁答的」），
      // 它不算「已经挂着一道交接题」
      if (
        pending.questions.some(
          (question) => question.kind === "handoff" && question.state === "pending",
        )
      ) {
        return;
      }

      await this.questionService.askHandoff(
        { sessionId, promptTokens, handoffTokens },
        this.options.defaultLanguage ?? DEFAULT_LANGUAGE,
      );
    } catch (error) {
      this.logger.warn("交接线提问失败", {
        sessionId,
        error: describeError(error),
      });
    }
  }

  /**
   * 变闲那一拍：给这段会话起一次名字（D2）。
   *
   * `AutoNaming.nameIfUnnamed` 自己是幂等的（条件不成立就什么都不做，之后它自己会停），
   * 所以这里不必先判什么。起不出名只记日志：名字是锦上添花，不该给用户留一条失败提示。
   */
  private autoNameOnIdle(sessionId: string): void {
    void this.autoNaming
      .nameIfUnnamed(sessionId, this.options.defaultLanguage ?? DEFAULT_LANGUAGE)
      .catch((error: unknown) => {
        this.logger.warn("自动命名失败", { sessionId, error: describeError(error) });
      });
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
      // 通知推不出去是通知模块自己的事：落它那一格（那个来源不转通知，不会再弹一次）
      this.noticeLogger.warn("推交接插件缺失的警告失败", { error: describeError(error) });
    }
  }

  /**
   * 服务层要的那个窄接口（`SessionRuntimePort`）。
   *
   * 前两件是**现读**（`ChatRunner.state`）：这一段此刻那四件事、队里还压着几条。删掉之后
   * 的现场清理指向 `ChatRunner.forget`（摘桥 + agent 硬着陆）。换模型 / 换思考档位那一手要的
   * 两件也在这一格里：**手上有没有活**（`AgentRegistry.get` 拿到那个 agent，只读 `state`）与
   * **让这一段空闲的 agent 退役**（`AgentRegistry.invalidateSession`）。
   *
   * 全都只能晚绑定：服务比执行者先造出来，所以这里闭包住 `this`，调用那一刻才去拿它。
   */
  private createSessionRuntime(): SessionRuntimePort {
    return {
      // 四件事原样给出去（`status` / `inputPaused` / `outputPaused` / `alive`），侧栏那一段用的就是它
      presence: (sessionId) => this.chatRunner.state(sessionId),
      inboxPending: (sessionId) => this.chatRunner.state(sessionId).inbox.length,
      forget: (sessionId) => {
        this.chatRunner.forget(sessionId);
      },
      // 没有 agent（死的）回 `null`：那种会话也能换模型（没有人手上那批活可打岔）
      agentState: (sessionId) => this.agentRegistry.get(sessionId)?.state ?? null,
      invalidateAgent: (sessionId) => {
        this.agentRegistry.invalidateSession(sessionId);
      },
    };
  }

  /** 素材转换要的实发模型与端点（F-H7 的判定依据：模型能不能看图、端点有没有 Files API） */
  private async resolveModelContext(modelId: string | null): Promise<{
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

  /** 凭证校验（凭证被接受就算这条连接过了手） */
  private buildVerifier() {
    return createTokenVerifier(this.db);
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /**
   * 一条日志记录 → 一条通知（PRD F-J2 / D1）。
   *
   * 转发来的那条**不入库、不重放**（`origin: "log"` + `persist: false`）：只推给当时在线的
   * 连接，所以 `notice.list` 里永远看不到它。发不出去也得有人知道：落一句到通知模块那一格，
   * 那一句带着 `source: "notice"`，被判据挡住 —— 环在第一跳就断。
   */
  private forwardLogRecord(record: LogRecord): void {
    if (!shouldNotifyFromLog(record)) return;
    void this.createNoticeFromRecord(record);
  }

  private async createNoticeFromRecord(record: LogRecord): Promise<void> {
    try {
      await this.noticeService.create({
        level: record.level === "warn" ? "warning" : "error",
        code: record.level === "warn" ? "notice.logWarning" : "notice.logError",
        params: { summary: record.message },
        duration: null,
        origin: "log",
        persist: false,
      });
    } catch (error) {
      // 通知发不出去本身也是「通知失败」：记在通知模块那一格里，环就断在这儿
      this.noticeLogger.error("日志转通知失败", {
        level: record.level,
        message: record.message,
        error: describeError(error),
      });
    }
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
   * 配置读不出来或没写这个字段时回落 `DEFAULT_LANGUAGE` —— 语言这件事不该让握手失败，
   * 但失败要留一行（`WsHub.resolveDefaultLanguage()` 读同一份配置、也是这么做的）。
   */
  private async configuredLanguage(): Promise<Language> {
    try {
      const config = await this.configManager.read();
      return normalizeLanguage(config.language);
    } catch (error) {
      this.logger.warn("读缺省语言失败，回落到缺省值", { error: describeError(error) });
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
   * 正在干活的 agent 也不会被抽掉能力（R52）。
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
   * 没有的跳过：不为刷新去创建一个 Scope（下一段会话 `create` 时会按新配置建）。
   *
   * 为什么刷完还要 `invalidate`：`Scope.refresh()` 刷得动能力（工具、MCP），刷**不**动已经建好的
   * 模型客户端 —— `createModel(scope.config, …)` 是装配那一刻读的。agent 现在又是常驻的（装配
   * 一次用很多次），不显式换掉的话“改了配置就生效”就不再成立。所以对每个目标 workspace 调一次
   * `invalidate`：闲着的 agent 当场退役，正忙的那几个由 `ChatRunner` 在它们变闲时退役。
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
      // 能力已经换新的了；手里还拿着旧模型客户端的 agent 也一起换掉（`createModel` 是装配
      // 那一刻读的，见 `AgentRegistry.invalidate`）
      const pending = this.agentRegistry.invalidate(workspaceId);
      if (pending.length > 0) {
        this.logInfo("配置生效：正忙的那几段变闲之后换掉 agent", {
          workspaceId,
          sessionIds: pending,
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
   * 三种结论（契约里的 `HostUpgradeState`）：磁盘读不出来、或要的那个版本还没落盘 →
   * `not_available`；目标版本已落盘但不是新的 → `already_latest`；落盘且比在跑的新 →
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

/** 造一个 `HostApp`（`index.ts` 把它再导出给别的进程） */
export function createHost(options: HostAppOptions = {}): Promise<HostApp> {
  return HostApp.create(options);
}

/** 缺省的退出动作：把进程送走（用例注入自己的 `exit` 时不会走到这里） */
const defaultExit: ExitHook = () => {
  process.exit(0);
};

/**
 * 日志记录的转发口（`onRecord` 的接线位置）。
 *
 * 文件日志比通知服务先造出来 —— 早造的那几个服务也要能记日志 —— 而「记录变成通知」要用到
 * 通知服务，所以这里留一个可后接的位置：接上之前写出来的记录只落文件。
 */
class LogRecordRelay {
  private target: ((record: LogRecord) => void) | null = null;

  attach(target: ((record: LogRecord) => void) | null): void {
    this.target = target;
  }

  forward(record: LogRecord): void {
    this.target?.(record);
  }
}

/** `resolveLogger()` 的四件产物：对外口子、本对象拥有的文件日志、记录的转发口、SDK 那一格 */
interface ResolvedLogging {
  logger: HubLogger;
  /** 自己拥有的文件日志（注入了外部 logger 时为 `null`：那份不归本对象关） */
  fileLogger: FileLogger | null;
  records: LogRecordRelay;
  /** 注入 SDK 的那份日志（`withSource("sdk")`）：每处构造 SDK 对象时都用这一份 */
  sdkLogger: LogSink;
}

/**
 * 日志口子：注入了就用注入的，否则造一个写 `<dataRoot>/logs/host/host.log` 的文件日志（PRD F-J2）。
 *
 * 落点是**宿主那一格**（`paths.hostLogsDir`）而不是 `logs/`：`logs/` 只是各进程子目录的父层，
 * 一格只归一个进程写（CLI 写 `logs/cli/`，将来的桌面端写 `logs/desktop/`）。
 */
function resolveLogger(options: HostAppOptions, paths: HostPaths): ResolvedLogging {
  const records = new LogRecordRelay();
  if (options.logger !== undefined) {
    const { logger } = options;
    return {
      logger,
      fileLogger: null,
      records,
      // 注入了外部 logger 时那份只有 warn / error（`HubLogger`）：缺的 `info` 补一个空实现
      // —— SDK 的 info 是「加载了什么」这类观测，不该退回标准输出
      sdkLogger: {
        info: () => undefined,
        warn: (message, detail) => logger.warn(message, detail),
        error: (message, detail) => logger.error(message, detail),
      },
    };
  }
  const fileLogger = new FileLogger({
    file: join(paths.hostLogsDir, HOST_LOG_FILE_NAME),
    onRecord: (record) => records.forward(record),
  });
  return { logger: fileLogger, fileLogger, records, sdkLogger: fileLogger.withSource(SDK_SOURCE) };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 「这条日志记录要不要转成一条通知」—— 全仓唯一的一条判据（D1）。
 *
 * 判据只有一条：`warn` / `error` 转通知，`info` 不转；例外是通知模块自己打的日志 —— 它带着
 * `source: "notice"`，转发它就会「通知失败 → 日志 → 通知」绕成环。
 *
 * 为什么不用一个「正在发通知」的布尔位：来源字段是**可检查**的。`host.log` 里那条
 * `source=notice` 的 ERROR 本身就是「这条为什么没上通知」的答案，而一个正在被置位的布尔量
 * 下完就还原了，事后什么也读不出来。
 */
export function shouldNotifyFromLog(record: LogRecord): boolean {
  if (record.level === "info") return false;
  return record.source !== NOTICE_SOURCE;
}

/**
 * 这段会话现在那个 agent 身上，最后一条**带用量的助手消息**的 `prompt_tokens`。
 *
 * 为什么读活的 agent 而不是库：库里的行是它的快照，写盘有节流；「此刻上下文多满」这件事
 * 只有它自己知道。`prompt_tokens` 是最近一次请求发出去的那个数 —— 交接线按它比（PRD D27）。
 *
 * 拿不到（没有助手消息 / 没有任何一条带用量）就回 `null`：没有用量就没有「越线」这回事，
 * 调用方据此不问。
 */
export function lastPromptTokens(messages: readonly AgentNS.Message[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== AgentNS.Role.Assistant) continue;
    const usage = message.usage;
    if (usage) return usage.prompt_tokens;
  }
  return null;
}

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
 * 按 `.` / `-` 切段逐段比，两段都是数字时按数字比（`1.10.0` 比 `1.9.0` 新）；不是数字的段
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
    const bothNumeric =
      Number.isFinite(aNumber) && Number.isFinite(bNumber) && a !== "" && b !== "";
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
