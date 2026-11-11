/**
 * **`ServerApp` —— 状态与方法的根。**
 *
 * ## 它是什么
 *
 * 一个常驻服务进程里「活下来的那套东西」的对象形态：配置服务、事件出口、会话管理器、
 * Agent 工厂、资产服务、三个路径根、**全局通知槽位表**，以及**线上方法表**。上一版这些东西
 * 散在 `cli.ts` 的一长串注入里 —— 组装根手里有状态却没有一个名字，于是「谁持有会话」、
 * 「谁往 hub 里发全局通知」、「收摊该按什么顺序」全靠读那段函数才知道。
 *
 * `cli.ts` 因此缩成四件事：读 `argv` / `env` → 造一个 `ServerApp` → `start()` → 把退出码
 * 交回去。状态与方法都在这里，收摊顺序也只在这里写一遍。
 *
 * ## 三条纪律（判据，不是口号）
 *
 * 1. **只持有 / 暴露，不写业务逻辑。** 它会话怎么活、什么时候回收、交接怎么写文档，
 *    一律在 `domain/`。这里能出现的只有「接线」（把依赖给到某个对象）、「进程作用域的
 *    那一小份状态」（全局通知槽位）、以及生命周期（`start` / `stop` / 信号）。
 *    要在这里写 `if` 判断业务，先问一句：这条判定换一个消费者（webui、脚本）还成立吗？
 * 2. **成员不许反向 import `ServerApp`。** `SessionManager` / `ConfigService` / `Daemon`
 *    都不认识这个名字，它们只收构造参数。「谁持有谁」是单向的：本类依赖它们，它们不知道
 *    本类存在。反向 import 一旦出现，这个文件就会变成所有东西的公共厕所。
 * 3. **判据：进程作用域进 `ServerApp`，会话作用域进 `LiveSession`，机理留 `lib/`。**
 *    全局通知挂在进程上（切会话不该把它误杀），会话通知与题目挂在会话上（会话没了它们
 *    跟着没），`EventHub` / `PhaseTracker` 这类纯机理留在 `lib/`。
 *
 * ## `EventHub` 一个字段都不许加
 *
 * 它只当喇叭（见 `lib/events.ts`）：`publish` / `subscribe` / `watcherCount` / `clear`。
 * 全局通知的**存**在本类（`notices` 那个 `Map`），**播**走 `hub.publish` —— 而且
 * 只有一个入口（{@link ServerApp.publishNotice}）。存与播分两处写的后果是「有人存了、没人
 * 播」或反过来，而这两种都不会报错：只会在某个客户端上少一条通知。
 *
 * ## 不落盘
 *
 * 全局通知随**进程**生死：它们是「此刻正在发生的事」，不是历史。进程退出就没了，重启后
 * 重新登记。同理，它们不做计时器自动消失 —— 寿命的终点是「有人确认」（`notice.ack`）。
 *
 * ## 可单独 `new` 出来测
 *
 * 构造只吃注入项：路径根、日志出口、以及每个协作者（不注入就按路径自己造）。不读 `argv`、
 * 不读 `process.env`、不读 `cwd` —— 那些只在 `cli.ts`（组装根）里出现。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentDefinition, AppConfig } from "@ai-zen/agents-sdk";
import { resolveModel } from "@ai-zen/agents-sdk";

import { Daemon, type MethodHandlers } from "./daemon/Daemon.js";
import { createAgentHandlers } from "./daemon/agentHandlers.js";
import { createAssetHandlers } from "./daemon/assetHandlers.js";
import { createConfigHandlers } from "./daemon/configHandlers.js";
import { createContentHandlers } from "./daemon/contentHandlers.js";
import { createNoticeHandlers } from "./daemon/noticeHandlers.js";
import { createSessionHandlers } from "./daemon/sessionHandlers.js";
import { AssetService } from "./domain/asset/AssetService.js";
import { globalAgentPaths } from "./domain/agent/agentPaths.js";
import { SessionAgentFactory } from "./domain/agent/SessionAgentFactory.js";
import { ConfigService } from "./domain/config/ConfigService.js";
import { createAutoTitle } from "./domain/session/AutoTitle.js";
import {
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  SessionManager,
} from "./domain/session/SessionManager.js";
import { FileSessionStore } from "./domain/session/store/FileSessionStore.js";
import { EventHub } from "./lib/events.js";
import type { AnyMethod, ResultOf } from "./protocol/api.js";
import type { GlobalNoticeSlot, NoticeAckResult, NoticeListResult } from "./protocol/index.js";
import { callOnce } from "./wire/call-once.js";
import type { ServerDescriptor } from "./wire/discovery.js";
import { isProcessAlive, readDescriptor, removeDescriptor } from "./wire/discovery.js";
import { SERVER_VERSION } from "./version.js";

/** 日志级别（与 `Daemon` / `cli.ts` 的日志出口同一套词） */
export type LogLevel = "info" | "warn" | "error";

/** 一条全局通知的入参：`level` + `code` + `params`（id 与登记时刻由本类补） */
export type GlobalNoticePayload = Omit<GlobalNoticeSlot, "id" | "createdAt">;

export interface ServerAppOptions {
  /** 配置根（`~/.ai-zen`）—— 路径由组装根解析成值再注入，本包不读进程级全局 */
  aiZenDir: string;
  /** 用户主目录（Agent 路径、Skill 发现都要它） */
  homeDir: string;
  /** 客户端没指定工作目录时用哪个（通常是启动本进程时的 cwd，由组装根决定） */
  defaultWorkspacePath: string;
  /** `<aiZenDir>/workspaces`；缺省按 `aiZenDir` 算 */
  workspacesRoot?: string;
  /** 监听地址；缺省 `127.0.0.1`（非 loopback 会被 `Daemon` 拒绝） */
  host?: string;
  /** 端口；缺省 8790，`0` = 系统分配 */
  port?: number;
  /** 整个守护进程的空闲退出（毫秒）；`0` = 不自动退出 */
  idleTimeoutMs?: number;
  /** 单段会话「没人看着之后还留多久」（毫秒），缺省 {@link DEFAULT_SESSION_IDLE_TIMEOUT_MS} */
  sessionIdleTimeoutMs?: number;
  /** 服务端包版本（写进发现文件与握手回执）；缺省取本包版本 */
  version?: string;
  /** 日志出口（守护进程是 detach 出来的，绝不能往客户端终端写） */
  log?: (level: LogLevel, message: string) => void;
  /** 收摊时把日志刷出去（不注入 = 不等，靠进程退出前的那一瞬） */
  flushLog?: () => Promise<void>;
  /** 进程退出（可注入：用例里不该真把测试进程杀掉） */
  exit?: (code: number) => void;
  /** 登记通知时的时钟（缺省 ISO 现在；注入只为用例能断言一个固定值） */
  now?: () => string;
  // ---- 协作者（不注入就按上面那些路径自己造；注入只为用例能换成假件） ----
  hub?: EventHub;
  config?: ConfigService;
  agentFactory?: SessionAgentFactory;
  sessions?: SessionManager;
  assets?: AssetService;
}

export class ServerApp {
  // ---- 路径根（值，不是读取器） ----
  readonly aiZenDir: string;
  readonly homeDir: string;
  readonly workspacesRoot: string;
  readonly defaultWorkspacePath: string;

  // ---- 进程作用域的持有一览 ----
  /** 唯一一条「推给客户端」的线（会话事件与全局通知共用） */
  readonly hub: EventHub;
  readonly config: ConfigService;
  readonly agentFactory: SessionAgentFactory;
  readonly sessions: SessionManager;
  readonly assets: AssetService;
  /**
   * **全局通知槽位表**：内存 `Map`，不落盘，随进程生死。
   *
   * 归属是进程而不是会话（C4）：寄在某个 `LiveSession` 上的话，用户切一次会话就会把还没
   * 人看过的全局通知误杀。`id` 用 UUID —— 跨进程、跨 daemon、跨重启都不撞号，也就不需要
   * 任何持久化计数器。
   */
  private readonly notices = new Map<string, GlobalNoticeSlot>();
  /**
   * 线上方法表：5 个 handler 工厂 + `notice.*`。
   *
   * 调用工厂的人从 `cli.ts` 变成了本类 —— 工厂还是那些工厂（参数校验 + 接线），只是
   * 「谁把它们拼起来」跟着状态一起搬了进来。
   */
  readonly methods: MethodHandlers;

  private readonly host: string;
  private readonly portNumber: number;
  private readonly idleTimeoutMs: number;
  private readonly version: string;
  private readonly now: () => string;
  private readonly logTo: (level: LogLevel, message: string) => void;
  private readonly flushLog: (() => Promise<void>) | undefined;
  private readonly exit: (code: number) => void;

  private daemon: Daemon | null = null;
  /** 收摊中的 Promise（并发调用要**等它收完**，而不是拿到一个立刻完事的空响应） */
  private stopping: Promise<void> | null = null;
  private started = false;
  private signalsInstalled = false;

  constructor(options: ServerAppOptions) {
    this.aiZenDir = options.aiZenDir;
    this.homeDir = options.homeDir;
    this.defaultWorkspacePath = options.defaultWorkspacePath;
    this.workspacesRoot = options.workspacesRoot ?? join(options.aiZenDir, "workspaces");
    this.host = options.host ?? "127.0.0.1";
    this.portNumber = options.port ?? 8790;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.version = options.version ?? SERVER_VERSION;
    this.now = options.now ?? (() => new Date().toISOString());
    this.logTo = options.log ?? (() => {});
    this.flushLog = options.flushLog;
    this.exit = options.exit ?? ((code) => process.exit(code));

    // 一条事件出口：会话事件与全局通知共用（客户端只需一次订阅）
    this.hub = options.hub ?? new EventHub();

    // ---- 会话装配：配置 / 路径 / Agent 工厂 ----
    const agentFactory =
      options.agentFactory ??
      new SessionAgentFactory({ aiZenDir: this.aiZenDir, homeDir: this.homeDir });
    this.agentFactory = agentFactory;
    // 配置与管理面共用的两个全局路径（`config.json` / `agents`）：只在这里算一次，
    // 下面的 ConfigService 与会话层的自动标题拿的是同一个值
    const { configFile, agentsDir } = globalAgentPaths({
      aiZenDir: this.aiZenDir,
      homeDir: this.homeDir,
    });
    this.config =
      options.config ??
      new ConfigService({
        configFile,
        agentsDir,
        subAgentsDir: join(this.aiZenDir, "sub-agents"),
        globalMcpFile: join(this.aiZenDir, "mcp.json"),
        workspacesRoot: this.workspacesRoot,
        // 配置一写盘就把所有工作区缓存的 Scope 丢掉：它们各持一份配置快照，不丢就是
        // 「改完配置、别的会话还在用旧的」（见 `ConfigServiceOptions.onConfigChanged`）
        onConfigChanged: () => agentFactory.invalidate(),
      });

    this.assets =
      options.assets ??
      new AssetService({
        aiZenDir: this.aiZenDir,
        homeDir: this.homeDir,
        workspacesRoot: this.workspacesRoot,
      });

    this.sessions =
      options.sessions ??
      new SessionManager({
        hub: this.hub,
        createAgent: (input) => agentFactory.create(input),
        // 每个工作区一份存档：续接与 session.save 都走它
        storeFor: (workspaceId) =>
          new FileSessionStore({ rootDir: join(this.workspacesRoot, workspaceId) }),
        // 配置/定义变了要连带丢掉 Scope（它持有配置快照）
        invalidateScope: (workspacePath) => agentFactory.invalidate(workspacePath),
        // 交接要读磁盘上的 `handoff` Skill、写 `<工作区>/.ai-zen/handoffs`：路径根由这里给
        handoff: { aiZenDir: this.aiZenDir, homeDir: this.homeDir },
        // 没人看着的会话多久后回收（断线重连的窗口就在这个值里）
        sessionIdleTimeoutMs: options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
        // 自动标题：第一轮之后异步让模型起个名。开关（`autoTitle`）与用哪个模型
        // （`defaultMigrationModel`）都要读配置，所以注入的是「函数」而不是一个布尔值 ——
        // 会话层不读配置，这里只给它一个 `config.json` 路径
        autoTitle: createAutoTitle({ configFile }),
        // 存档条目的生效模型：会话层只认记录（`agentId` + 会话级覆盖），要算出生效模型
        // 必须有「那个 agentId 的定义」与「全局兜底」—— 这两样只有这里手上有。
        // 解析本身交给 SDK 的 `resolveModel`（三级顺序的唯一实现），本文件只递原始值。
        resolveSessionModel: async ({ agentId, sessionModelId }) => {
          // 协议层把定义与配置当**不透明载荷**（客户端不该解释它们），而这里手上这份就是
          // SDK 的 `AgentDefinition` / `AppConfig` —— 整个仓库里唯一该做这个断言的地方
          const definition = (await this.config.getAgent({ id: agentId }))
            .agent as AgentDefinition | null;
          // 定义已经删了：与 `createAgent` 同一口径（它也认为这段会话根本装不起来）
          if (!definition) throw new Error(`Agent "${agentId}" not found`);
          const { config } = await this.config.get();
          const resolved = resolveModel({
            sessionModelId,
            agentModelId: definition.modelId,
            defaultModel: (config as AppConfig).defaultModel,
          });
          // 三级都空 = 真的没有模型（`createAgent` 对它是报错），所以同样按「解析失败」处理
          if (!resolved) throw new Error(`Agent "${agentId}" has no model bound`);
          return resolved;
        },
      });

    /**
     * 方法表：这里就是「一个请求能调到什么」的全部答案。
     *
     * 六份互不重叠的方法名（`session.*` / `workspace.*` / `events.watch`、`agent.*`、
     * `config.*`、`content.upload`、`asset.list`、`notice.*`）拼成一张表；`hello` / `ping` /
     * `status` / `shutdown` 由 `Daemon` 自带（那几个问题与业务无关）。
     */
    this.methods = {
      ...createSessionHandlers({
        manager: this.sessions,
        workspacesRoot: this.workspacesRoot,
        defaultWorkspacePath: this.defaultWorkspacePath,
      }),
      ...createAgentHandlers({ factory: this.agentFactory, config: this.config }),
      ...createConfigHandlers({ config: this.config }),
      // 内容转块（`content.upload`）：端点与模型从**这段会话**查，上传 / 内联的判据在 SDK
      ...createContentHandlers({ manager: this.sessions, config: this.config }),
      // 资产清单（只读）
      ...createAssetHandlers({ service: this.assets }),
      // 全局通知（不属于任何会话，随进程生死）
      ...createNoticeHandlers({
        list: () => this.listNotices(),
        ack: (ids) => this.ackNotices(ids),
      }),
    };
  }

  // ==================================================================
  // 全局通知槽位：存与播的**同一个**入口
  // ==================================================================

  /**
   * 登记一条全局通知：**存进槽位表** + **广播一声**。
   *
   * 两半写在一起是硬要求：分开写的那天就会漏播（或漏存），而两种都不会报错 —— 只会在
   * 某个客户端上少一条通知，或者「确认过一个不存在的槽位」。
   *
   * 广播只是「顺手通知一声」：此刻没人在听也不影响槽位存在，后来的客户端靠 `notice.list`
   * 补看。返回槽位（含 id），发通知的一方需要拿 id 做后续动作（比如日志里对账）。
   *
   * 广播出去的那条 `server-notice` **带槽位的同一个 id**：推送与槽位是同一条通知的两个出口，
   * id 不一致的话，客户端收到通知也拿不到确认它的凭据（只能按 code + params 本地去重，
   * 确认时还得先 `notice.list` 把 id 捞回来）。
   */
  publishNotice(notice: GlobalNoticePayload): GlobalNoticeSlot {
    const slot: GlobalNoticeSlot = { ...notice, id: randomUUID(), createdAt: this.now() };
    this.notices.set(slot.id, slot);
    this.hub.publish({
      event: "server-notice",
      id: slot.id,
      level: slot.level,
      code: slot.code,
      ...(slot.params !== undefined ? { params: slot.params } : {}),
    });
    return slot;
  }

  /**
   * 此刻还挂着的全局通知（`notice.list`）。
   *
   * 返回副本：槽位表的唯一主人是本类，调用方拿到的东西不该能改到它。
   */
  listNotices(): NoticeListResult {
    return { notices: [...this.notices.values()].map((slot) => ({ ...slot })) };
  }

  /**
   * 确认一批通知（`notice.ack`）：**一份状态，任意客户端确认即消**。
   *
   * 认**两类**通知的 id：本类的全局槽位表与会话内的通知表（`SessionManager.ackNotice`）。
   * 为什么不拆成两条方法：id 是 UUID，**全局唯一** —— 不管是哪一类，一个 id 就是指那一条
   * 通知，客户端也就没有必要先分辨「这条属于哪一类」再选方法（而分类的信息他手上未必有：
   * 两类通知的事件里只有一个 id，没写着它属于哪个作用域）。
   *
   * 顺序是「**先全局、后会话**」：全局表在本类手上（一次 `Map.delete`），会话表要扫注册表，
   * 把便宜的那一步放前面；两步都是「按 id 删」，先后不影响结果 —— id 全局唯一，不会两边
   * 都有。
   *
   * 不做「每个客户端各记一份已读」：那是状态爆炸（连接数 × 通知数），而且会让「我说过已经
   * 确认了」变成服务端的二次记账。
   *
   * `acked` 只含**这次确实消掉**的 id：本来就不存在、或已被别人确认过的不出现。不抛错 ——
   * 「它已经不在了」对确认方是正常结局（他要的结果已经达成）。
   */
  ackNotices(ids: string[]): NoticeAckResult {
    const acked: string[] = [];
    for (const id of ids) {
      // 先全局、后会话：两边都按 id 删，任一命中就算「这次消掉的」
      if (this.notices.delete(id) || this.sessions.ackNotice(id)) acked.push(id);
    }
    return { acked };
  }

  // ==================================================================
  // 生命周期
  // ==================================================================

  /** 实际监听端口（`start()` 之后才有值） */
  get port(): number {
    return this.daemon?.port ?? 0;
  }

  get listening(): boolean {
    return this.daemon?.listening ?? false;
  }

  /**
   * 起服务：单实例检查 → 释放默认配置 → 建 `Daemon` → 写发现文件。
   *
   * 「单实例」检查留在这里而不是 `cli.ts`：它问的是「这台机器上这套配置目录是不是已经有一个
   * 活着的服务」，那是**进程作用域**的事实。两个守护进程同时活着的后果是两份 MCP 连接、
   * 两份工具发现 —— 用户看不出任何异常，只是工具调用偶尔重复。
   */
  async start(): Promise<ServerDescriptor> {
    if (this.started) throw new Error("ServerApp.start() has already been called");
    await this.refuseWhenAnotherIsRunning();

    // 配置根初始化：默认 Agent / 子 Agent / 出厂模型与策略表都由**服务端**释放。
    // 客户端不再碰本机配置目录，所以「首次启动就有默认 Agent」只能在这里保证 ——
    // 否则新机器上第一个 `agent.list` 拿到空列表，TUI 连启动都过不去（`app.noAgents`）。
    await this.config.bootstrap();
    this.log("info", `default workspace: ${this.defaultWorkspacePath}`);

    const daemon = new Daemon({
      aiZenDir: this.aiZenDir,
      host: this.host,
      port: this.portNumber,
      version: this.version,
      idleTimeoutMs: this.idleTimeoutMs,
      log: (level, message) => this.log(level, message),
      handlers: this.methods,
      // 收摊的中间一步：连接已经全关掉、发现文件还在 —— 会话在这里收
      onDrained: async () => {
        await this.stopSessions();
        await this.flushLog?.();
      },
      // 收摊的最后一步：发现文件已删，日志刷出去之后才退出
      onStopped: (reason) => this.finish(reason),
    });
    this.daemon = daemon;
    try {
      const descriptor = await daemon.start();
      this.started = true;
      return descriptor;
    } catch (error) {
      this.daemon = null;
      throw error;
    }
  }

  /**
   * 收摊：**拒新连接 → 关连接 → 停会话 → flush 日志 → 删发现文件 → 退出**。
   *
   * 顺序有先后，散在别处最容易漏一步。前两步与「删发现文件」是传输层的事（`Daemon.stop`），
   * 中间那步「停会话」只有本类做得到 —— 所以 `Daemon` 在那一刻回调 `onDrained`，最后退出
   * 交给 `onStopped`（那时日志已经刷完）。
   *
   * 幂等：并发调用（客户端发 `shutdown` 与进程收信号撞车）拿到的是同一个 Promise ——
   * 否则后来者会以为「已经停了」，而发现文件那时可能还没删。
   */
  async stop(reason = "shutdown"): Promise<void> {
    this.stopping ??= this.doStop(reason);
    return await this.stopping;
  }

  /** 挂信号处理（只挂一次）：`SIGINT` / `SIGTERM` 都走同一条收摊路径 */
  installSignalHandlers(): void {
    if (this.signalsInstalled) return;
    this.signalsInstalled = true;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void this.stop(`signal ${signal}`);
      });
    }
  }

  private async doStop(reason: string): Promise<void> {
    const daemon = this.daemon;
    if (!daemon) {
      // 没起过 Daemon（用例里直接 `new` 出来测的那种）：会话与工厂仍然要收
      await this.stopSessions();
      await this.flushLog?.();
      return;
    }
    await daemon.stop(reason);
  }

  /**
   * 停会话：关掉挂着的提问、断掉 MCP 连接（`Scope` 是它们的主人）。
   *
   * 先收会话再退出是必须的：MCP 客户端是长连接，进程直接走会留下对端的半开连接；
   * 而 `dispose()` 之后 `settleTurn` 不再跑，也就不会在收摊途中又写一次存档。
   */
  private async stopSessions(): Promise<void> {
    this.sessions.dispose();
    await this.agentFactory.dispose();
  }

  /** 收摊的最后一步：写一条退出日志 → 把日志刷出去 → 退出进程 */
  private finish(reason: string): void {
    this.log("info", `exit (${reason})`);
    void (async () => {
      await this.flushLog?.();
      this.exit(0);
    })();
  }

  /**
   * 已经有一个活着的服务在跑就别起第二个。
   *
   * 三条路：答案正常回来（`ping` 通了）→ 明确报「已经有一个」；进程在但连不上 → 同样不
   * 默默双开（可能端口被占、也可能它正处在启动 / 收尾）；进程已死 → 残留文件清掉继续。
   */
  private async refuseWhenAnotherIsRunning(): Promise<void> {
    const existing = await readDescriptor(this.aiZenDir);
    if (!existing) return;
    if (!isProcessAlive(existing.pid)) {
      // 进程已死：残留文件，清掉继续
      await removeDescriptor(this.aiZenDir);
      return;
    }
    try {
      await this.callRunning(existing.host, existing.port, "ping", 800);
    } catch (error) {
      throw new Error(
        `a live pid ${existing.pid} holds the descriptor but is not answering: ` +
          `${(error as { message?: string } | null)?.message ?? String(error)}`,
      );
    }
    throw new Error(
      `already running on ${existing.host}:${existing.port} ` +
        `(pid ${existing.pid}, v${existing.version})`,
    );
  }

  /**
   * 连上在跑的那个问一句（单实例检查用）。
   *
   * 与客户端探活是**同一件事**：走 `wire/call-once.ts` 的那一份实现，身份署名本进程
   * （`client` 是服务端日志里排查时最有用的一条事实）。
   */
  private async callRunning<M extends AnyMethod>(
    host: string,
    port: number,
    method: M,
    timeoutMs: number,
  ): Promise<ResultOf<M>> {
    return await callOnce({ host, port }, method, undefined, {
      timeoutMs,
      client: { name: "agents-server-cli", version: this.version },
    });
  }

  private log(level: LogLevel, message: string): void {
    this.logTo(level, message);
  }
}
