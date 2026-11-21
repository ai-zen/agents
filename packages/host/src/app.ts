import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { FileLogger } from "@ai-zen/agents-logger";
import {
  AgentRepository,
  AgentRuntime,
  ConfigManager,
  PeerSessionsScopePlugin,
  Scope,
  allInOne,
  resolveModel,
} from "@ai-zen/agents-sdk";
import type { AppConfig } from "@ai-zen/agents-sdk";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";

import { createBus } from "./infra/bus.js";
import { openDatabase } from "./infra/db.js";
import { HostError } from "./infra/errors.js";
import { clearHostFile, isProcessAlive, readHostFile, writeHostFile } from "./infra/hostFile.js";
import { hostPaths, resolveDataRoot, type HostPaths } from "./infra/paths.js";
import { resolveHostVersion } from "./infra/version.js";
import { inboxTable } from "./modules/agent/inbox.js";
import { materialsFor } from "./modules/agent/materials.js";
import { HostObserver } from "./modules/agent/observer.js";
import type { HostApiDeps } from "./modules/api/deps.js";
import { createAppRouter } from "./modules/api/router.js";
import { connectionParams } from "./modules/api/trpc.js";
import { AssetService } from "./modules/asset/service.js";
import { assetTable, sessionAssetTable } from "./modules/asset/table.js";
import { AgentDefinitionService } from "./modules/config/agents.js";
import { Discovery } from "./modules/config/discovery.js";
import { EndpointService } from "./modules/config/endpoints.js";
import type { ConfigEvent } from "./modules/config/events.js";
import { GeneralConfig } from "./modules/config/general.js";
import { HostSettings } from "./modules/config/hostSettings.js";
import { ImageModelService } from "./modules/config/imageModels.js";
import { McpConfig } from "./modules/config/mcp.js";
import { ModelService } from "./modules/config/models.js";
import { PresetService } from "./modules/config/presets.js";
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
  /**
   * 谁活着、怎么装起来、容器什么时候拆：全在这一处（宿主不再自己留一份）。
   *
   * 它是个薄壳与运行时之间唯一的接面：宿主给四格端口（造容器、开平级会话的行、现读会话名、日志），
   * 其余全部问它。
   */
  private readonly runtime: AgentRuntime;
  /** 全进程一份的观察者：把运行时的事实翻译成写库与推送 */
  private readonly observer: HostObserver;
  /** 收工时解掉观察者：它在运行时那条事实流上的一个订阅 */
  private readonly detachObserver: () => void;
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
    // 配置面的四个写口。读只有一个入口（`this.general`），写全经过它的 `write`：写盘、更新内存
    // 那份、发事件三件事在一处，内存与文件才不会各自漂移。
    const endpoints = new EndpointService({ general: this.general, t });
    const models = new ModelService({ general: this.general, t });
    const imageModels = new ImageModelService({ general: this.general, t });
    const presets = new PresetService({ general: this.general, config: deps.manager, t });
    // MCP 的两条路看的是同一批文件、问的是不同的问题：运行期（`openScope` 里的发现）问「这些
    // 服务器怎么连」，配置面（`mcp` 这个 router）问「每条写在哪一层、还能不能改」。
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

    // 运行时：装起来、登记、开跑、发话、拆容器全在它那一侧。宿主给它四格端口，每一格都是
    // 「只有宿主答得出」的事（怎么装配能力、怎么开一行会话、一段会话此刻叫什么、日志往哪写）。
    //
    // 建在交接之前：交接的编排要问它「这一段有没有活执行体」。
    this.runtime = new AgentRuntime({
      /**
       * 造一个能力容器。什么时候造、造几个、什么时候拆不归这里（归运行时），这里只回答
       * 「这个目录上怎么把能力装起来」。
       *
       * 平级会话那三个工具随本次装配一起下去：端口由运行时给，容器在同一次装配里把它装成工具。
       */
      openScope: async (cwd, peers) => {
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
          // 平级会话的三个工具：能力不在这里，它们只认这一个端口
          new PeerSessionsScopePlugin(peers),
        );
        await scope.init();
        return scope;
      },

      /**
       * 开一段平级会话：写行、定身份，把装它的材料交回去（装起来由运行时自己接着做）。
       *
       * 新会话挂在**开出它的那一段**的项目下：会话是项目里的东西，一段会话开出来的那一段
       * 当然也在同一个项目里干活。模型先解析、解析不出来直接回一句结构化的拒绝 —— 不先写行，
       * 一条指不到模型的半成品行没有任何用处。
       */
      open: async (input) => {
        const opener = sessions.get(input.lineage);
        if (opener === undefined) {
          // 运行时只会从活着的执行体那一段进来，走到这里说明行刚好被删了。开不出来就是开不出来，
          // 不假装成功
          throw new Error(
            `Cannot open a peer session from "${input.lineage}": that session does not exist`,
          );
        }

        const definition = await definitions.get(input.agentId);
        const resolved = resolveModel({
          sessionModelId: input.modelId,
          agentModelId: definition.modelId,
          defaultModel: this.general.read().defaultModel,
        });
        // 模型解析不出来是**结构化的拒绝**：模型读得懂，可以换一个助手或自己干
        if (resolved === null) return { ok: false, reason: "model_unresolved" };

        const session = sessions.create({
          workspaceId: opener.workspaceId,
          // 名字是模型给的那一个；没给就先用一个时刻串顶上（与「自动起的名字」同一套，
          // 此后由自动命名或用户改名接管）
          name: input.label ?? new Date().toISOString(),
          nameIsAuto: input.label === undefined,
          agentId: input.agentId,
          modelId: resolved.modelId,
          // 平级会话默认自动交接：撞线自己交班、不问（`dev-docs/prd/01-decisions.md` 第 45 行：
          // 用户建的会话默认关、平级会话反过来默认开）。血缘就是开出它的那一段
          //（「只许开一层」那条判据在运行时那边）
          autoHandoff: true,
          lineage: input.lineage,
        });

        return {
          ok: true,
          sessionId: session.id,
          materials: await materialsFor(
            { workspaces, definitions, config: this.general, messages, inbox, sessions, handoff },
            session,
          ),
        };
      },

      // 一段会话此刻叫什么：名字长在会话行上，只有宿主认得出它
      nameOf: async (sessionId) => sessions.get(sessionId)?.name,
      log: this.log,
    });

    // 交接排在通知之后：失败那条路上它要推通知。这里给的是那个工厂而不是一份实例 ——
    // 文档落点与落库那一格都只对一段会话的一趟交接成立，实例由 `start` 每趟现造。
    const handoff = new HandoffService({
      db: this.db,
      sessions,
      workspaces,
      runtime: this.runtime,
      notices,
      events,
      t,
      createSdk: createSdkHandoff,
    });

    /**
     * 观察者：全进程一份，**挂在第一次 `wake` 之前**。
     *
     * 它是这个进程里所有会话「消息与状态落库、再推给客户端」的唯一出口。`wake` 一返回，那段会话
     * 的执行体就已经在跑了（运行时那边 `void agent.start()`），它发出来的每一条事实都要有人接；
     * 而事实只报变化、没有回放 —— 晚一步挂，从装载到挂上之间那几条就永远丢了。
     */
    const onError = (error: unknown, what: string): void => this.log.error(what, { error });
    this.observer = new HostObserver({
      messages,
      inbox,
      events,
      onError,
      // 交接态会在一个执行体的寿命里变好几次，所以传函数不传值
      isHandingOff: (sessionId) => handoff.isHandingOff(sessionId),
    });
    this.detachObserver = this.observer.attach(this.runtime);

    // 配置面改完之后，运行期要知道。没有这一条，用户在界面上停掉一个 MCP 服务器、
    // 运行期照旧连着它，直到进程重启——「启停即时生效」就不成立。
    //
    // 助手定义的变动不走这里：它不进容器的配置，受影的是那几段会话的执行体。
    configEvents.subscribe((event) => {
      if (event.kind === "agentDefinition") return;
      void this.runtime.scopes.refreshAll();
    });

    this.connections = new Connections();

    const api: HostApiDeps = {
      sessions,
      workspaces,
      runtime: this.runtime,
      definitions,
      config: this.general,
      endpoints,
      models,
      imageModels,
      presets,
      mcp,
      messages,
      inbox,
      assets,
      notices,
      questions,
      search,
      handoff,
      events,
      t,
      onError,
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

  /**
   * 收尾：先把执行体杀光、把能力容器拆光（它们在拆之前还会写库），再解观察者那条订阅，
   * 然后断连接，最后关库与日志。
   *
   * `runtime.close()` 与老的两步同次序：先 `kill` 再 `disposeAll` —— 反过来的话，拆容器会遇到
   * 还活着的执行体，而那时已经没有「稍后再拆」这回事。
   */
  async stop(): Promise<void> {
    await this.runtime.close();
    // 观察者排在 close 之后：那里面每一次 `kill` 都还会发最后几条事实（`resident:gone` 也在其中），
    // 解早了客户端就收不到「这一段没了」。
    this.detachObserver();

    const listening = this.listening;
    if (listening.on === "self") {
      // 不握手：等客户端回一个 close 帧，等于给关机加一段不确定的时长
      for (const client of listening.server.clients) client.terminate();
      await new Promise<void>((resolve) => listening.server.close(() => resolve()));
      clearHostFile(this.paths.hostFile);
    }

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
