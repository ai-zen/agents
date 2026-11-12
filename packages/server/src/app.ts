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
 * 方法实现不在这里：`server.*` / `workspace.*` / `conversation.*` / `message.*` / `search.*`
 * / `credential.*` 的 handler 在 `handlers/`，由 {@link createHandlers} 拼成一张表交给 `WsHub`。
 * 本文件只给它们提供持有者（服务、运行时、配置、时钟）与一个收尾入口。
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ConfigManager } from "@ai-zen/agents-sdk";
import type { AppConfig, HandoffService, ReasoningPresets } from "@ai-zen/agents-sdk";

import { resolveListenTarget, resolvePaths } from "./config.js";
import type { ListenTarget, ServerPaths } from "./config.js";
import { createHandlers } from "./handlers/index.js";
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
import type { CapabilityView } from "./wire/index.js";

// ---------------------------------------------------------------------------
// 选项与事实
// ---------------------------------------------------------------------------

/** 配置文件放在数据根下（`<dataRoot>/config.json`，裁定 R13）：SDK 的 `ConfigManager` 以它为边界 */
const CONFIG_FILE_NAME = "config.json";

/** 读不到包元数据时的版本号（服务照常能跑，只是升级判定拿不到真版本） */
const FALLBACK_VERSION = "0.0.0";

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
  /** 交接服务（W4 才有）；未注入时不装交接插件，只记一条 warn（裁定 R50） */
  handoff?: (context: AgentBuildContext) => HandoffService | undefined;
  /** 时钟（Scope 回收计时与用例里的时间推进） */
  clock?: Clock;
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
  /** 方法名 → 实现（`handlers/createHandlers` 拼出来的那张表） */
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

    // ---- 7. 接线：方法表 + 一条 WebSocket ----
    this.handlers = createHandlers(this.handlerDeps());
    const target = this.resolveTarget();
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
   * 触发源只有两个，都不另起计时器（A10：计时器只有一处，即 `ScopeRegistry` 里那份空闲计时）：
   *   - `ScopeRegistry.onAllRecycled`：Scope 全部拆完那一刻；
   *   - 每轮结算（`onTurnSettled`）：最后一件欠着的事可能是刚跑完的这一轮。
   *
   * 两个防止误退的口子：
   *   1. **还没被用过**时不判（刚起来的进程在等第一个客户端，这时「没有连接」是常态）；
   *   2. 只在自己监听中判断（造好未启动、挂靠别人、已收尾时都不判）。
   */
  async checkExit(): Promise<void> {
    if (this.phase !== "running" || this.checking) return;
    this.checking = true;
    try {
      if (this.hub.connectionInfos().length > 0) {
        this.served = true;
        return;
      }
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
      capabilities: () => this.options.capabilities?.() ?? [],
      workspaces: this.workspaceService,
      conversations: this.conversationService,
      messages: this.messageService,
      search: this.searchService,
      credentials: this.credentialService,
      assets: this.assetService,
      runner: this.chatRunner,
      scopes: this.scopeRegistry,
      readConfig: () => this.readConfig(),
      refreshThinkingPresets: async () => {
        this.presets = await this.configManager.readReasoningPresets();
      },
      now: () => this.nowIso(),
      requestStop: () => this.requestStop(),
      onTurnSettled: () => {
        void this.checkExit();
      },
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
