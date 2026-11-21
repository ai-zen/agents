import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { FileLogger } from "@ai-zen/agents-logger";
import { AgentRepository, ConfigManager, Scope, allInOne } from "@ai-zen/agents-sdk";
import type { AppConfig } from "@ai-zen/agents-sdk";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";

import { createBus } from "./infra/bus.js";
import { openDatabase } from "./infra/db.js";
import { HostError } from "./infra/errors.js";
import { clearHostFile, isProcessAlive, readHostFile, writeHostFile } from "./infra/hostFile.js";
import { hostPaths, resolveDataRoot, type HostPaths } from "./infra/paths.js";
import { resolveHostVersion } from "./infra/version.js";
import { Delivery } from "./modules/agent/delivery.js";
import { inboxTable } from "./modules/agent/inbox.js";
import { AgentRegistry } from "./modules/agent/registry.js";
import type { HostApiDeps } from "./modules/api/deps.js";
import { createAppRouter } from "./modules/api/router.js";
import { connectionParams } from "./modules/api/trpc.js";
import { AssetService } from "./modules/asset/service.js";
import { assetTable, sessionAssetTable } from "./modules/asset/table.js";
import { AgentDefinitionService } from "./modules/config/agents.js";
import { Discovery } from "./modules/config/discovery.js";
import type { ConfigEvent } from "./modules/config/events.js";
import { GeneralConfig } from "./modules/config/general.js";
import { HostSettings } from "./modules/config/hostSettings.js";
import { McpConfig } from "./modules/config/mcp.js";
import { ModelService } from "./modules/config/models.js";
import { Connections } from "./modules/connection/registry.js";
import { ensureLocalToken } from "./modules/credential/local.js";
import { CredentialService } from "./modules/credential/service.js";
import { credentialTable } from "./modules/credential/table.js";
import type { HostEvent } from "./modules/events.js";
import { HandoffService, createSdkHandoff } from "./modules/handoff/service.js";
import { createTranslator } from "./modules/i18n/index.js";
import { NoticeService } from "./modules/notice/service.js";
import { noticeTable } from "./modules/notice/table.js";
import { QuestionRegistry } from "./modules/question/registry.js";
import { ScopeRegistry } from "./modules/scope/registry.js";
import { SearchService } from "./modules/search/service.js";
import { searchTable } from "./modules/search/table.js";
import { messageTable } from "./modules/session/messages.js";
import { SessionService } from "./modules/session/service.js";
import { sessionTable } from "./modules/session/table.js";
import { workspaceTable } from "./modules/workspace/table.js";
import { WorkspaceService } from "./modules/workspace/service.js";

/** 本机实例只监听回环；对外实例监听所有网卡，那台机器外的客户端凭凭证连进来 */
const LOOPBACK = "127.0.0.1";
const PUBLIC = "0.0.0.0";

export interface HostAppDeps {
  /** 库、配置、日志、助手定义都在它下面 */
  readonly dataRoot: string;
  /** 配置的读写入口（`config.json` 与它同目录的那几个文件） */
  readonly manager: ConfigManager;
  /** 启动时读到的那一份配置 */
  readonly current: AppConfig;
  /**
   * 端口，来自启动参数那一档。
   *
   * 缺席的含义是「启动参数没有给」，不是「随便挑一个」：三档优先级是启动参数 >
   * `<数据根>/host.json` > 默认值，只有这一档允许 `0`（由系统分配）。
   */
  readonly port?: number;
  /** 监听地址，覆盖 `local` 推出的那个 */
  readonly host?: string;
  /** 本机实例：只监听回环，并把本机凭证写进 `<数据根>/run/token` */
  readonly local: boolean;
}

/** 启动参数里与装配有关的那几格；数据根与配置仍然由 `open()` 自己读 */
export interface HostAppOpenOptions {
  /** 见 `HostAppDeps.port` */
  readonly port?: number;
  /** 见 `HostAppDeps.host` */
  readonly host?: string;
  /** 见 `HostAppDeps.local`，缺省 `true` */
  readonly local?: boolean;
}

/**
 * 这一侧的两件事互斥：要么本进程在监听，要么这台机器上已经有宿主在监听，这里只记下它连哪儿。
 *
 * 用一个联合而不是「server 可能为空」，是为了让每一处用到它的人都得说明自己站在哪一边：
 * 「已经有别人在服务」时没有端口可绑，也不该去碰 `run/token` 与发现文件。
 */
type Listening =
  | { readonly on: "self"; readonly server: WebSocketServer; readonly ready: Promise<void> }
  | { readonly on: "elsewhere"; readonly host: string; readonly port: number };

/**
 * 唯一装配根：只有这个文件同时 import 多个模块。它自己没有业务 —— 构造顺序就是依赖顺序，
 * 对外只有启停、地址与「这个进程有没有真的在监听」。
 */
export class HostApp {
  /**
   * 装配完、还没开始监听的宿主。
   *
   * 装配的入口是异步的，因为配置要先从磁盘上读一次，而读到之前没有 `AppConfig` 可以往下传；
   * 构造器不能 await，所以「读数据根、读配置」这两步留在这里，其余全部在构造器里按顺序接。
   */
  static async open(options: HostAppOpenOptions = {}): Promise<HostApp> {
    const dataRoot = resolveDataRoot();
    const manager = new ConfigManager(join(dataRoot, "config.json"));
    const bootstrapped = await manager.bootstrap();
    return new HostApp({
      dataRoot,
      manager,
      current: bootstrapped.config,
      port: options.port,
      host: options.host,
      local: options.local ?? true,
    });
  }

  private readonly paths: HostPaths;
  private readonly db: DatabaseSync;
  private readonly log: FileLogger;
  private readonly general: GeneralConfig;
  private readonly credentials: CredentialService;
  private readonly agents: AgentRegistry;
  private readonly scopes: ScopeRegistry;
  private readonly connections: Connections;
  /**
   * 监听这一侧。
   *
   * 绑端口在构造这一刻就发生，不留到 `start()`：绑端口的失败是一个 `error` 事件，事件在没人
   * 接的时候会让进程直接退出 —— 那时错误信息还在，但已经不是「启动失败，端口被占用」了。
   */
  private readonly listening: Listening;
  private readonly startedAt: string;

  /** 本机实例（只监听回环、写本机凭证）还是对外实例 */
  readonly local: boolean;
  /** 本包的版本号：发现文件与 `agents-host version` 报的是同一个 */
  readonly version: string;

  private constructor(deps: HostAppDeps) {
    const paths = hostPaths(deps.dataRoot);
    this.paths = paths;
    this.local = deps.local;
    this.version = resolveHostVersion();
    this.startedAt = new Date().toISOString();

    // 绑端口之前先问一句「这台机器上已经有宿主在服务吗」：那个进程还活着，就不再绑端口、
    // 不写发现文件，也不重写 run/token —— 客户端的凭证正是从那儿读的
    const serving = readHostFile(this.paths.hostFile);
    const attached = serving !== undefined && isProcessAlive(serving.pid) ? serving : undefined;

    const agentsDir = paths.agents;

    this.db = openDatabase(paths.databaseFile);
    const workspaceRows = workspaceTable(this.db);
    const sessionRows = sessionTable(this.db);
    const messages = messageTable(this.db);
    const inbox = inboxTable(this.db);

    this.log = new FileLogger({ file: join(paths.logs, "host.log") });

    const configEvents = createBus<ConfigEvent>();
    const events = createBus<HostEvent>();
    const t = createTranslator(() => this.general.language());

    this.general = new GeneralConfig({
      config: deps.manager,
      current: deps.current,
      events: configEvents,
    });
    const definitions = new AgentDefinitionService({
      repository: new AgentRepository(agentsDir),
      events: configEvents,
      t,
      general: this.general,
    });
    const hostSettings = new HostSettings({ path: join(deps.dataRoot, "host.json") });
    // 模型这一版还没有 procedure 用它：先按依赖顺序接上，免得下一波以为这里没装配过而另立一份
    // 配置读法。
    new ModelService({ config: deps.manager, events: configEvents, t });
    // MCP 现在有运行期的消费者（`createScope` 里的发现），配置面那一路（`effective()`）还没有
    // procedure 用它。两者看的是同一批文件、问的是不同的问题。
    const mcp = new McpConfig({
      dataRoot: deps.dataRoot,
      homeDir: homedir(),
      events: configEvents,
      t,
      log: this.log,
    });
    const discovery = new Discovery({
      dataRoot: deps.dataRoot,
      homeDir: homedir(),
      log: this.log,
    });

    const workspaces = new WorkspaceService({ workspaces: workspaceRows, t });
    const sessions = new SessionService({ sessions: sessionRows, events, t });
    this.agents = new AgentRegistry({ sessions, workspaces, events });

    // `assets` 与 `session_assets` 的表引了 `messages`，所以只能在它之后建
    const assets = new AssetService({
      assets: assetTable(this.db),
      sessionAssets: sessionAssetTable(this.db),
      dataRoot: deps.dataRoot,
      t,
    });
    const notices = new NoticeService({ notices: noticeTable(this.db), events });
    this.credentials = new CredentialService({ credentials: credentialTable(this.db), t });
    // 本机实例把能用的那一串交付到 `run/token`：客户端因此不必手抄令牌。对外实例不写这个文件，
    // 凭证由 `agents-host token create` 造出来分发给要连的设备。
    if (this.local && attached === undefined) {
      ensureLocalToken(this.credentials, this.paths.tokenFile);
    }
    const questions = new QuestionRegistry({ events, t });
    // 全文索引的触发器指向 `messages`，所以只能在它之后建
    const search = new SearchService({ search: searchTable(this.db) });

    // 交接排在通知之后：失败那条路上它要推通知。这里给的是那个工厂而不是一份实例 ——
    // 文档落点与落库那一格都只对一段会话的一趟交接成立，实例由 `start` 每趟现造。
    const handoff = new HandoffService({
      db: this.db,
      sessions,
      workspaces,
      agents: this.agents,
      notices,
      events,
      t,
      createSdk: createSdkHandoff,
    });

    this.scopes = new ScopeRegistry({
      createScope: async (cwd) => {
        const scope = new Scope({
          getConfig: () => this.general.read(),
          agentsDir,
          cwd,
        }).use(
          ...allInOne({
            ...discovery.abilityPaths(cwd),
            // 运行期要知道「这些服务器怎么连」，与 `McpConfig.effective` 看的是同一批文件。
            // 路径只能问它要：`mcpPaths` 空着时插件连连接管理器都不建，用户写了 `mcp.json`
            // 也一个服务器都连不上，而且不报错。
            mcpPaths: mcp.paths(cwd),
            logger: this.log,
          }),
        );
        await scope.init();
        return scope;
      },
      aliveSessions: (cwd) => this.agents.aliveSessions(cwd),
      t,
      log: this.log,
    });

    // 配置面改完之后，运行期要知道。没有这一条，用户在界面上停掉一个 MCP 服务器、
    // 运行期照旧连着它，直到进程重启——「启停即时生效」就不成立。
    //
    // 助手定义的变动不走这里：它不进容器的配置，受影的是那几段会话的执行体。
    configEvents.subscribe((event) => {
      if (event.kind === "agentDefinition") return;
      void this.scopes.refreshAll();
    });

    this.connections = new Connections();

    const api: HostApiDeps = {
      sessions,
      workspaces,
      scopes: this.scopes,
      definitions,
      config: this.general,
      messages,
      inbox,
      delivery: new Delivery({ inbox }),
      agents: this.agents,
      assets,
      notices,
      questions,
      search,
      handoff,
      events,
      t,
      onError: (error, what) => this.log.error(what, { error }),
    };

    if (attached !== undefined) {
      this.listening = { on: "elsewhere", host: attached.host, port: attached.port };
      return;
    }

    // 三档优先级：启动参数 > `host.json` > 默认值。`0`（由系统分配）只有启动参数那一档放行，
    // 所以这里不能用 `||`：`0` 是给出来的值，不是没给。
    const server = new WebSocketServer({
      host: deps.host ?? (this.local ? LOOPBACK : PUBLIC),
      port: deps.port ?? hostSettings.port(),
    });
    const ready = new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });

    applyWSSHandler({
      wss: server,
      router: createAppRouter(api),
      createContext: ({ res, info }) => {
        // 每一条连接都要一串验得过的令牌。验不过就在这里止住：适配器会回一帧错误并关掉连接，
        // 而这条连接此后连方法名都问不出来。
        const presented = connectionParams.safeParse(info.connectionParams);
        if (!presented.success || this.credentials.verify(presented.data.token) === undefined) {
          throw new HostError("unauthorized", t("宿主访问令牌无效"));
        }

        const connection = this.connections.open();
        res.once("close", () => this.connections.close(connection.id));
        return { connection };
      },
    });

    this.listening = { on: "self", server, ready };
  }

  /** 等到端口真的绑上，再写下发现文件。绑不上（端口被占用等）就抛，不换端口重试 */
  async start(): Promise<void> {
    const listening = this.listening;
    // 已有宿主在服务：本进程没有端口可绑，也没有发现文件要写
    if (listening.on === "elsewhere") return;

    await listening.ready;
    writeHostFile(this.paths.hostFile, {
      pid: process.pid,
      ...this.address,
      version: this.version,
      local: this.local,
      startedAt: this.startedAt,
    });
  }

  /** 收尾：先杀执行体（它们还会写库），再断连接、拆能力容器，最后关库与日志 */
  async stop(): Promise<void> {
    this.agents.killAll();

    const listening = this.listening;
    if (listening.on === "self") {
      // 不握手：等客户端回一个 close 帧，等于给关机加一段不确定的时长
      for (const client of listening.server.clients) client.terminate();
      await new Promise<void>((resolve) => listening.server.close(() => resolve()));
      clearHostFile(this.paths.hostFile);
    }

    await this.scopes.disposeAll();
    this.connections.closeAll();
    this.db.close();
    await this.log.close();
  }

  /**
   * 实际监听的地址与端口；已有宿主在服务时是它的那一个。
   *
   * 端口可能由系统分配（启动参数给了 `0`），所以这个值只有绑定之后才知道，客户端也只能从
   * 发现文件读。
   */
  get address(): { readonly host: string; readonly port: number } {
    const listening = this.listening;
    if (listening.on === "elsewhere") return { host: listening.host, port: listening.port };

    const bound = listening.server.address() as AddressInfo;
    return { host: bound.address, port: bound.port };
  }

  /** 这个进程有没有真的在监听；`false` 表示这台机器上已经有别的宿主在服务 */
  get serving(): boolean {
    return this.listening.on === "self";
  }
}
