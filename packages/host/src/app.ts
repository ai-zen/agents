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
import { Delivery } from "./modules/agent/delivery.js";
import { inboxTable } from "./modules/agent/inbox.js";
import type { HostApiDeps } from "./modules/api/deps.js";
import { AssetService } from "./modules/asset/service.js";
import { assetTable, sessionAssetTable } from "./modules/asset/table.js";
import { CredentialService } from "./modules/credential/service.js";
import { credentialTable } from "./modules/credential/table.js";
import { NoticeService } from "./modules/notice/service.js";
import { noticeTable } from "./modules/notice/table.js";
import { QuestionRegistry } from "./modules/question/registry.js";
import { AgentRegistry } from "./modules/api/registry.js";
import { createAppRouter } from "./modules/api/router.js";
import { AgentDefinitionService } from "./modules/config/agents.js";
import type { ConfigEvent } from "./modules/config/events.js";
import { GeneralConfig } from "./modules/config/general.js";
import { HostSettings } from "./modules/config/hostSettings.js";
import { McpConfig } from "./modules/config/mcp.js";
import { ModelService } from "./modules/config/models.js";
import { Connections } from "./modules/connection/registry.js";
import type { HostEvent } from "./modules/events.js";
import { createTranslator } from "./modules/i18n/index.js";
import { ScopeRegistry } from "./modules/scope/registry.js";
import { messageTable } from "./modules/session/messages.js";
import { SessionService } from "./modules/session/service.js";
import { sessionTable } from "./modules/session/table.js";
import { workspaceTable } from "./modules/workspace/table.js";
import { WorkspaceService } from "./modules/workspace/service.js";

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
}

/** 启动参数里与装配有关的那几格；数据根与配置仍然由 `open()` 自己读 */
export interface HostAppOpenOptions {
  /** 见 `HostAppDeps.port` */
  readonly port?: number;
}

/**
 * 唯一装配根：只有这个文件同时 import 多个模块。它自己没有业务 —— 构造顺序就是依赖顺序，
 * 对外只有启停与端口。
 */
export class HostApp {
  /**
   * 装配完、还没开始监听的宿主。
   *
   * 装配的入口是异步的，因为配置要先从磁盘上读一次，而读到之前没有 `AppConfig` 可以往下传；
   * 构造器不能 await，所以「读数据根、读配置」这两步留在这里，其余全部在构造器里按顺序接。
   */
  static async open(options: HostAppOpenOptions = {}): Promise<HostApp> {
    const dataRoot = process.env.AI_ZEN_DIR ?? join(homedir(), ".ai-zen");
    const manager = new ConfigManager(join(dataRoot, "config.json"));
    const bootstrapped = await manager.bootstrap();
    return new HostApp({ dataRoot, manager, current: bootstrapped.config, port: options.port });
  }

  private readonly db: DatabaseSync;
  private readonly log: FileLogger;
  private readonly general: GeneralConfig;
  private readonly hostSettings: HostSettings;
  private readonly agents: AgentRegistry;
  private readonly scopes: ScopeRegistry;
  private readonly connections: Connections;
  private readonly server: WebSocketServer;
  /**
   * 绑端口的结果。
   *
   * 监听在构造这一刻就挂上，不留到 `start()`：绑端口的失败是一个 `error` 事件，事件在没人
   * 接的时候会让进程直接退出 —— 那时错误信息还在，但已经不是「启动失败，端口被占用」了。
   */
  private readonly listening: Promise<void>;

  private constructor(deps: HostAppDeps) {
    const agentsDir = join(deps.dataRoot, "agents");

    this.db = openDatabase(join(deps.dataRoot, "ai-zen.db"));
    const workspaceRows = workspaceTable(this.db);
    const sessionRows = sessionTable(this.db);
    const messages = messageTable(this.db);
    const inbox = inboxTable(this.db);

    this.log = new FileLogger({ file: join(deps.dataRoot, "logs", "host.log") });

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
    this.hostSettings = new HostSettings({ path: join(deps.dataRoot, "host.json") });
    // 模型与 MCP 这一版还没有 procedure 用它们：先按依赖顺序接上，免得下一波以为这里没装配过
    // 而另立一份配置读法。
    new ModelService({ config: deps.manager, events: configEvents, t });
    new McpConfig({ dataRoot: deps.dataRoot, homeDir: homedir(), events: configEvents, t });

    const workspaces = new WorkspaceService({ workspaces: workspaceRows, t });
    const sessions = new SessionService({ sessions: sessionRows, t });
    this.agents = new AgentRegistry({ sessions, workspaces, events });

    // `assets` 与 `session_assets` 的表引了 `messages`，所以只能在它之后建
    const assets = new AssetService({
      assets: assetTable(this.db),
      sessionAssets: sessionAssetTable(this.db),
      dataRoot: deps.dataRoot,
      t,
    });
    const notices = new NoticeService({ notices: noticeTable(this.db), events });
    const credentials = new CredentialService({ credentials: credentialTable(this.db), t });
    const questions = new QuestionRegistry({ events, t });

    this.scopes = new ScopeRegistry({
      createScope: async (cwd) => {
        const scope = new Scope({
          getConfig: () => this.general.read(),
          agentsDir,
          cwd,
        }).use(...allInOne());
        await scope.init();
        return scope;
      },
      aliveSessions: (cwd) => this.agents.aliveSessions(cwd),
      t,
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
      credentials,
      questions,
      events,
      t,
      onError: (error, what) => this.log.error(what, { error }),
    };

    // 三档优先级：启动参数 > `host.json` > 默认值。`0`（由系统分配）只有启动参数那一档放行，
    // 所以这里不能用 `||`：`0` 是给出来的值，不是没给。
    this.server = new WebSocketServer({ port: deps.port ?? this.hostSettings.port() });
    this.listening = new Promise<void>((resolve, reject) => {
      this.server.once("listening", () => resolve());
      this.server.once("error", reject);
    });

    applyWSSHandler({
      wss: this.server,
      router: createAppRouter(api),
      createContext: ({ res }) => {
        // 这一波不做凭证校验，所以每条连接都没有凭证（`credential/` 域还没建）
        const connection = this.connections.open(null);
        res.once("close", () => this.connections.close(connection.id));
        return { connection };
      },
    });
  }

  /** 等到端口真的绑上。绑不上（端口被占用等）就抛，不换端口重试 */
  async start(): Promise<void> {
    await this.listening;
  }

  /** 收尾：先杀执行体（它们还会写库），再断连接、拆能力容器，最后关库与日志 */
  async stop(): Promise<void> {
    this.agents.killAll();
    // 不握手：等客户端回一个 close 帧，等于给关机加一段不确定的时长
    for (const client of this.server.clients) client.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.scopes.disposeAll();
    this.connections.closeAll();
    this.db.close();
    await this.log.close();
  }

  /** 绑定之后才能知道的端口：启动参数给了 `0` 时由系统分配 */
  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }
}
