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
import type { AppConfig, ToolEnvDeps } from "@ai-zen/agents-sdk";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";

import { createBus } from "./infra/bus.js";
import { openDatabase } from "./infra/db.js";
import { HostError } from "./infra/errors.js";
import { clearHostFile, isProcessAlive, readHostFile, writeHostFile } from "./infra/hostFile.js";
import { hostPaths, resolveDataRoot, type HostPaths } from "./infra/paths.js";
import { resolveHostVersion } from "./infra/version.js";
import { clearVersionPin, readVersionPin } from "./infra/versionPin.js";
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
import { registryHasVersion, UpdateService } from "./modules/update/service.js";
import { workspaceTable } from "./modules/workspace/table.js";
import { WorkspaceService } from "./modules/workspace/service.js";

/** 本机实例只监听回环；对外实例监听所有网卡，那台机器外的客户端凭凭证连进来 */
const LOOPBACK = "127.0.0.1";
const PUBLIC = "0.0.0.0";

/**
 * 升级那一路的退出码。正常关闭是 `0`，升级是另一个值 —— 启动方式据此分清「照 pin 重拉」与
 * 「就是关了」：pin 与退出信号必须分开，只有 pin 的话，一次正常关闭之后启动方式会照着老 pin
 * 把服务又拉起来。
 *
 * 取 `75`（`sysexits.h` 的 `EX_TEMPFAIL`，「稍后再试」）：不与常见错误码撞，也不落在 shell
 * 自己的 126 / 127 / 128+n 上。
 */
export const UPGRADE_EXIT_CODE = 75;

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
  /**
   * 进程退出的那一下：正常关闭给 `0`，升级那一路给 {@link UPGRADE_EXIT_CODE}。
   *
   * 从外面给是给用例用的：真的调 `process.exit` 会把整个用例进程带走，而「退出码是多少」正是
   * 要钉住的那一格。缺省由 `open()` 接成 `process.exit`。
   */
  readonly exit: (code: number) => void;
}

/** 启动参数里与装配有关的那几格；数据根与配置仍然由 `open()` 自己读 */
export interface HostAppOpenOptions {
  /** 见 `HostAppDeps.port` */
  readonly port?: number;
  /** 见 `HostAppDeps.host` */
  readonly host?: string;
  /** 见 `HostAppDeps.local`，缺省 `true` */
  readonly local?: boolean;
  /** 见 `HostAppDeps.exit`，缺省 `process.exit` */
  readonly exit?: (code: number) => void;
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
      exit: options.exit ?? ((code: number) => process.exit(code)),
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
  /** 进程退出的那一下（见 `HostAppDeps.exit`）。换掉它的是用例，不是运行时 */
  private readonly exit: (code: number) => void;
  /**
   * 在途的那一次收尾（见 `stop`）。
   *
   * 「关门只做一次」就靠这一格：留着它，第二次来调 `stop()` 的人拿到的是同一句 promise，而不是
   * 从头再拆一遍已经拆掉的东西。
   */
  private stopping?: Promise<void>;
  /**
   * 这一趟收尾是「以升级为理由」：在 `requestRestart` 里、调 `stop()` 之前立起来。
   *
   * pin 的去留只听这一格 —— 有值就不清。值是升到的那一版（pin 上写的就是它）。
   *
   * 只立不清：`stop()` 不带理由时不会把已经立起来的这一格抹掉，所以「先到的那一句没有理由」
   * 吞不掉「后来那句有理由」。
   */
  private upgrading?: string;

  /** 本机实例（只监听回环、写本机凭证）还是对外实例 */
  readonly local: boolean;
  /** 本包的版本号：发现文件与 `agents-host version` 报的是同一个 */
  readonly version: string;

  private constructor(deps: HostAppDeps) {
    const paths = hostPaths(deps.dataRoot);
    this.paths = paths;
    this.local = deps.local;
    this.exit = deps.exit;
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

    /**
     * 素材端口：**只在这里造一次**，两处用 —— 能力容器的 `Scope.deps`（工具那一侧）与
     * `materialsFor` 交给附件传输插件的那一格。两处各拼一个 `readAsset` 的话，「素材怎么取」
     * 就成了两份得同时改的实现，而它们差一步就会在「工具能看见图、发出去的那一份看不见」
     * 这种地方表现出来。
     *
     * 找不到就是 `undefined`，**不抛**：素材被删是一个正常处境（引用归零就会删），发送前那一步
     * 把它换成一句「附件已不在」的文本就好。字节读不出来（文件没了）才抛 —— 那是一件真事故，
     * 由调用方接住并说清。
     */
    const assetPort: ToolEnvDeps = {
      readAsset: (assetId) => {
        const asset = assets.find(assetId);
        if (asset === undefined) return undefined;
        return {
          bytes: assets.getBytes(asset.id),
          mime: asset.mime,
          name: asset.name ?? undefined,
        };
      },
    };
    const notices = new NoticeService({ notices: noticeTable(this.db), events });
    this.credentials = new CredentialService({ credentials: credentialTable(this.db), t });
    // 本机实例把能用的那一串交付到 `run/token`：客户端因此不必手抄令牌。对外实例不写这个文件，
    // 凭证由 `agents-host token create` 造出来分发给要连的设备。
    if (this.local && attached === undefined) {
      ensureLocalToken(this.credentials, this.paths.tokenFile);
    }
    const questions = new QuestionRegistry({ events, t });
    // 连接登记表：握手时建一条、socket 断开时摘掉，进程收尾清空。它不进业务判断 —— 问不问交接
    // 与有没有人连着无关，题就挂在内存里等人。
    this.connections = new Connections();
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
          // 工具那一侧的出网/素材端口（与 `materialsFor` 给附件插件的是同一个对象）
          deps: assetPort,
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
            {
              workspaces,
              definitions,
              config: this.general,
              messages,
              inbox,
              sessions,
              handoff,
              assetPort,
            },
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
      questions,
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
      assets,
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

    // 升级的第 ② 段。宿主只验、只记、只请：{@link requestRestart} 是「请」不是「做」—— 不
    // re-exec 自己，也不碰 npm，真正把新版拉起来的是启动方式。
    const updates = new UpdateService({
      pinFile: paths.versionPinFile,
      // 现读：就地换过（桌面端、docker、`npm i -g`）之后，这个答案要跟着变
      installedVersion: () => resolveHostVersion(),
      registryHas: (version) => registryHasVersion(version, this.log),
      requestRestart: (version) => this.requestRestart(version),
      t,
      log: this.log,
    });

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
      assetPort,
      notices,
      questions,
      search,
      handoff,
      updates,
      // 关宿主是客户端那条命令（`host.shutdown`）的最后一步：收尾与退出在装配根上，这里只递一句「请」
      shutdown: () => this.requestShutdown(),
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

    // 升级已经完成的判据：正跑着的这一份就是 pin 上写的那一版。不清的话，它会在下一次正常
    // 关闭时误导启动方式。
    // 这一条只在「跑起来之后」判：上面那一支（别人在这台机器上服务）本进程没在跑任何一版，
    // 那条 pin 不是给它写的。
    const pin = readVersionPin(this.paths.versionPinFile);
    if (pin?.version === this.version) clearVersionPin(this.paths.versionPinFile);
  }

  /**
   * 升级那一路的最后一句：请宿主以升级为理由退出（`UpdateService` 的 `requestRestart` 接的就是它）。
   *
   * 这一步的全部内容是三件事的次序：pin 先落盘（`UpdateService.upgrade` 写完才走到这里）、
   * {@link upgrading} 这一格再立起来、最后才请退出。反过来的话就会出现「退出码说升级、pin 说
   * 没升」—— 启动方式读到 75 却读不到版本，这一次升级静默失效。
   *
   * 退出推后一拍（`setImmediate`）：此刻那次 `host.upgrade` 调用的答复已经在写回的路上，而收尾
   * 会先把这个进程的库与连接都关掉。答复没出去就断的话，客户端只看得到「连不上了」，而它本来该
   * 拿到的是 `{ restarting: true }` 与随后那次重连。
   *
   * 摆到类上是给用例用的：收尾已经开始之后再走一遍升级这一路，只有这个入口造得出那个次序。
   */
  requestRestart(version: string): void {
    this.upgrading ??= version;
    setImmediate(() => {
      void this.stop("upgrade").then(
        () => this.exit(UPGRADE_EXIT_CODE),
        (error: unknown) => {
          // 收尾没做完也要退：pin 已经写上，留着这个进程只会占着端口，而拉起那一侧要的正是
          // 它让开
          this.log.error("Upgrade shutdown did not complete", { error });
          this.exit(UPGRADE_EXIT_CODE);
        },
      );
    });
  }

  /**
   * 正常关闭的最后一句：客户端那条命令（`host.shutdown`）接的就是它。
   *
   * 次序与 {@link requestRestart} 同一套，只换了两处理由：pin 不在这里判（收尾的判据不变 ——
   * 没有立起 {@link upgrading} 就是正常关闭，正常关闭清 pin），退出码是正常关闭的那个 0，而不是
   * 升级专用的 {@link UPGRADE_EXIT_CODE}。
   *
   * 退出推后一拍（`setImmediate`）的理由与升级那一路同一个：此刻那次调用的答复还在写回的路上，
   * 而收尾会先把这个进程的连接断掉、库关掉。答复没出去就断的话，客户端只看得到「连不上了」，
   * 而它本来该拿到的是 `{ accepted: true }`。连着的客户端会被收尾断掉，这是一台机器一个宿主
   * 的意思 —— 关的就是这一台。
   */
  requestShutdown(): void {
    setImmediate(() => {
      void this.stop().then(
        () => this.exit(0),
        (error: unknown) => {
          // 收尾没做完也要退：留着这个进程只会占着端口，而它已经不服务了
          this.log.error("Shutdown did not complete", { error });
          this.exit(1);
        },
      );
    });
  }

  /**
   * 收尾：先告诉观察者「进程正在往下走」，再把执行体杀光、把能力容器拆光（它们在拆之前还会写库），
   * 然后才解观察者那条订阅，接着断连接，最后关库与日志。
   *
   * `runtime.close()` 与老的两步同次序：先 `kill` 再 `disposeAll` —— 反过来的话，拆容器会遇到
   * 还活着的执行体，而那时已经没有「稍后再拆」这回事。
   *
   * pin 的去留只听 {@link upgrading} 那一格：正常关闭要把 pin 清掉（留着它，启动方式会在下一次
   * 起来时照着老 pin 把服务又拉起来），而升级那一路留下 pin —— 那条 pin 正是要让启动方式读到
   * 的。其余收尾两步都一样，收不干净与为什么收无关。
   *
   * `reason` 是「这一趟是升级」的一条来路，只负责把那一格立起来，自己不再决定 pin 的去留。
   */
  stop(reason?: "upgrade"): Promise<void> {
    // 两个来源在这里汇成一格，而且只加不减：升级那一路在 `requestRestart` 里已经立好了（pin
    // 写完之后、请退出那一刻），命令行与信号那一路只递得出 `reason`（它说得出「是升级」、说不出
    // 哪一版，所以去 pin 上读）。
    //
    // 「不删」正是这个窗口的补丁：先到的信号不带理由，它不能把后来的升级请求吞成一次正常关闭 ——
    // 否则就是「以 75 退出、却没有 pin」，启动方式读到 75 却读不到版本，这一次升级静默失效。
    if (reason === "upgrade") {
      // 空串也算「立起来了」：判定只看这一格是不是 `undefined`（见 `shutdown`）
      this.upgrading ??= readVersionPin(this.paths.versionPinFile)?.version ?? "";
    }

    // 收尾只做一次，第二次等第一次。
    //
    // 这不是防御性编程，是一个真实的窗口：客户端点了升级，`stop("upgrade")` 正在收尾
    // （`db.close()` 走了一半），同一刻又来一条 SIGTERM —— `closeOnSignals` 里的 `app.stop()`
    // 会再跑一遍，第二次会在已经关掉的库上抛。让它等第一句，「关门」才不会被两条腿各关一半。
    //
    // 登记先于开拆。两者之间那一段是同步的，没有人能在这段里回头再调一次 `stop`：两条来路
    // （升级请求与信号）都排在事件循环上，信号也等不到同步代码跑完。
    const inflight = this.stopping;
    if (inflight !== undefined) return inflight;

    const stopping = this.shutdown();
    this.stopping = stopping;
    return stopping;
  }

  /** {@link stop} 的那一遍收尾。只有 `stop` 调它，于是它一辈子只跑一次 */
  private async shutdown(): Promise<void> {
    // 开关必须先打开、再 `close()`：那里面每一次 `kill` 都会清空队列并报 `inboxCleared`，而关机时
    // 那不是「这些条目作废」—— 它们一条都没作废，下次打开还要接着等（需求：关掉再打开，记忆与
    // 排队区都在）。晚一步开，观察者已经照老规矩把库里那几行删掉了。
    this.observer.shutdown();
    await this.runtime.close();
    // 观察者仍然排在 close 之后解绑：那里面每一次 `kill` 都还会发最后几条事实（`resident:gone`
    // 也在其中），解早了客户端就收不到「这一段没了」。从上面那一刻起变的是另一件事 ——「作废排队
    // 区」那一格不再落库。
    this.detachObserver();

    const listening = this.listening;
    if (listening.on === "self") {
      // 不握手：等客户端回一个 close 帧，等于给关机加一段不确定的时长
      for (const client of listening.server.clients) client.terminate();
      await new Promise<void>((resolve) => listening.server.close(() => resolve()));
      clearHostFile(this.paths.hostFile);
      // pin 与发现文件同处：两份都是这个进程为自己写的运行期文件。这里只在「本进程真的在
      // 服务」时清 —— 别人在服务时停的是本进程，那条 pin 不是它写的。
      //
      // 清不清只看 `upgrading` 有没有立起来（`undefined` 才算没有）：理由从哪条路来不归这里管，
      // 两条路只要有一条报了「这是升级」，这条 pin 就得留着。
      if (this.upgrading === undefined) clearVersionPin(this.paths.versionPinFile);
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
