/**
 * 在服务端把一个 Agent 装配起来 —— 会话真正「能跑」的那一环。
 *
 * ## Scope 为什么要按工作区缓存
 *
 * Scope 装着能力发现的结果与 **MCP 连接**（每个 server 是一个子进程/连接）。两件事
 * 必须同时成立：
 *   - 同一个工作区的多个会话必须**共用**一个 Scope —— 否则每开一个会话就多一套 MCP
 *     连接与工具发现（CLI 时代缓存单例就是为了这个）；
 *   - 不同工作区**不能共用** —— 项目级 skills / tools / mcp 都挂在工作区路径上，
 *     共用等于把 A 项目的工具塞给 B 项目。
 * 所以缓存键是工作区路径，值是 **Promise**（并发建会话时共享同一次初始化，避免穿透
 * 建出两个 Scope）。
 *
 * ## 配置读取
 *
 * `bootstrap()` 只在进程内每个配置文件上跑一次（`models` 出厂同步、默认 Agent 落盘），
 * 之后每次取 Scope 都重新 `read()` —— 于是改了 `config.json` 再 `invalidate()` 就能生效，
 * 与 CLI 的 `/reload` 语义一致。
 */

import { existsSync } from "node:fs";
import {
  AgentRepository,
  allInOne,
  AutoMigratePlugin,
  AutoRefreshToolsPlugin,
  ConfigManager,
  ContextGuardPlugin,
  createAgent as sdkCreateAgent,
  Scope,
  SdkAgent,
  SubAgentGuardInstallerPlugin,
  type AgentDefinition,
  type AppConfig,
  type HandoffMode,
  type HandoffService,
} from "@ai-zen/agents-sdk";
import { agentPaths, globalAgentPaths, type AgentPaths } from "./agentPaths.js";
import type { AgentLike, CreateAgentInput } from "../session/SessionManager.js";

export interface SessionAgentFactoryOptions {
  /** 配置根（`~/.ai-zen`） */
  aiZenDir: string;
  /** 用户主目录（`~/.agents` 的位置） */
  homeDir: string;
  /** 注入：读配置；默认 SDK `ConfigManager`（首次 bootstrap，之后每次重新 read） */
  loadConfig?: (configFile: string) => Promise<AppConfig>;
  /** 注入：建并初始化 Scope；默认 SDK `Scope` + `allInOne` */
  createScope?: (input: { config: AppConfig; paths: AgentPaths }) => Promise<Scope>;
  /** 注入：从一个 Scope 里造出 Agent；默认 SDK `createAgent` */
  createAgent?: (scope: Scope, agentId: string) => Promise<AgentLike>;
}

export class SessionAgentFactory {
  private readonly options: SessionAgentFactoryOptions;
  private readonly scopes = new Map<string, Promise<Scope>>();
  /** 每个配置文件只在进程内 bootstrap 一次（出厂模型同步、默认 Agent 落盘） */
  private readonly bootstrapped = new Map<string, Promise<void>>();

  constructor(options: SessionAgentFactoryOptions) {
    this.options = options;
  }

  /** 给会话管理器用：造一个能跑一轮对话的 Agent */
  async create(input: CreateAgentInput): Promise<AgentLike> {
    const scope = await this.scopeFor(input.path);
    // 始终从磁盘读 Agent 定义（含 permissions / 工具配置）；中断策略不传，取
    // `scope.config`，于是配置中心改完 invalidate 一下就生效
    const build = this.options.createAgent ?? defaultCreateAgent;
    const agent = await build(scope, input.agentId);
    this.installPlugins(agent, scope, input);
    return agent;
  }

  /**
   * 丢掉某个工作区（或全部）的 Scope —— 配置变更后调用。
   *
   * 同步从缓存里摘掉，便于并发调用方立刻拿到新实例；再异步释放旧的（断开 MCP）。
   */
  async invalidate(workspacePath?: string): Promise<void> {
    const targets = workspacePath ? [workspacePath] : [...this.scopes.keys()];
    const pending = targets.map((key) => {
      const scope = this.scopes.get(key);
      this.scopes.delete(key);
      return scope;
    });
    await Promise.all(
      pending.map(async (scope) => {
        try {
          await (await scope)?.dispose();
        } catch {
          // 释放失败不影响后续重建
        }
      }),
    );
  }

  /** 收摊：释放全部 Scope（守护进程退出时调用） */
  async dispose(): Promise<void> {
    await this.invalidate();
  }

  /**
   * 换模型：把 `modelId` 写进 **Agent 定义**（真相源），并清空模型相关的思考参数。
   *
   * 为什么是 Agent 定义而不是会话：会话不记模型（`SessionRecord` 没有 `modelId`），
   * 运行期只读 `definition.modelId`。写在别处就会出现「状态栏 A、实际发 B」。
   * 代价是它影响所有用这个 Agent 的会话 —— 所以这是个 **agent 级**方法，不是 `session.*`。
   *
   * 清空 `modelParams` 是必须的：旧模型的思考档位对新模型可能非法
   * （如 GLM 不接受 `thinking.disabled`）；清掉让目标模型走自己的 defaultParams。
   */
  async setModel(input: {
    agentId: string;
    modelId: string;
  }): Promise<{ agentId: string; modelId: string }> {
    const { configFile, agentsDir } = globalAgentPaths({
      aiZenDir: this.options.aiZenDir,
      homeDir: this.options.homeDir,
    });
    const config = await this.readConfig(configFile);

    const model = (config.models ?? []).find((item) => item.id === input.modelId);
    if (!model) throw codedError("unknown-model", `unknown model: ${input.modelId}`);

    const repository = new AgentRepository(agentsDir);
    const definition = await repository.read(input.agentId);
    if (!definition) throw codedError("unknown-agent", `unknown agent: ${input.agentId}`);

    const next: AgentDefinition = {
      ...definition,
      modelId: input.modelId,
      updatedAt: new Date().toISOString(),
    };
    delete next.modelParams;
    await repository.write(next);

    return { agentId: input.agentId, modelId: input.modelId };
  }

  // ==================================================================
  // 内部
  // ==================================================================

  /**
   * 按当前模型的 `tokenThresholds` 装护栏 / 自动迁移 —— 与 CLI 同一套策略。
   *
   * 为什么在装配方而不是会话层：阈值挂在**模型**上（`config.models[].tokenThresholds`），
   * 而模型是 Agent 定义的一部分；会话层刻意不认识配置与 SDK 插件。
   *
   * 两个让行开关都由会话层给：
   *   - `isSuspended`：交接回合本身就是「上下文最满」的时刻，硬线必须让行；
   *   - `autoMigrate`：真的迁移要跑在会话层（存档、换 id 在它手里），插件只负责"何时"。
   * 没配阈值就一个都不装：不给阈值还拦，等于凭直觉拍一个数。
   */
  private installPlugins(agent: AgentLike, scope: Scope, input: CreateAgentInput): void {
    const sdkAgent = agent as unknown as SdkAgent;

    /**
     * 工具清单刷新：**与阈值无关**，所以装在下面那个早退之前。
     *
     * 档位来自全局配置（`autoRefreshTools`，缺省 `inner-loop-start` = 旧版行为）；
     * `off` 就不装 —— 那时只有 `/reload`（它重建 Agent 时会丢掉缓存的 Scope）能刷。
     */
    const when = scope.config.autoRefreshTools ?? "inner-loop-start";
    if (when !== "off") sdkAgent.use(new AutoRefreshToolsPlugin({ when }));

    const modelId = (agent as unknown as SdkAgent).definition?.modelId;
    const thresholds = (scope.config.models ?? []).find(
      (model) => model.id === modelId,
    )?.tokenThresholds;
    if (!thresholds) return;

    sdkAgent.use(
      new ContextGuardPlugin({
        guardTokens: thresholds.guard,
        isSuspended: input.isHandoffBusy,
      }),
    );
    // 子 Agent 的硬线：子 Agent 是新 `new Agent()` 出来的，不继承主 Agent 的插件；
    // 而且它走 `run()` 而非 `send()`（`onBeforeSend`/`onAfterSend` 不触发），所以只能在
    // `onSubAgentStart` 钩子里现场装配。阈值与让行判断都必须与主 Agent 同源（同一个
    // `thresholds.guard` + 同一个 `input.isHandoffBusy`），本插件会递归安插自身，孙级自动覆盖。
    //
    // 为什么让行也必须传下去：交接回合本身就是上下文最满的时刻，主 Agent 让行而子 Agent
    // 照拦，等于交接中派出去的子任务被自己的硬线打断（甚至「交接触发拦截 → 拦截又触发
    // 交接」地打转）。传函数而不是布尔值：它反映的是**当时**是否在交接。
    sdkAgent.use(
      new SubAgentGuardInstallerPlugin({
        guardTokens: thresholds.guard,
        isSuspended: input.isHandoffBusy,
      }),
    );

    const autoMigrate = input.autoMigrate;
    if (autoMigrate) {
      sdkAgent.use(
        new AutoMigratePlugin({
          // 插件只认 `busy` 与 `migrate()`：这里给的是**会话层**的实现，不是裸的
          // `HandoffService` —— 否则存档与换 id 会静默跳过
          service: {
            get busy() {
              return input.isHandoffBusy?.() ?? false;
            },
            // `mode` 必须原样递下去：`resolveMode` 只回答「用哪种方式」，迁移本体在会话层
            // —— 中间这一跳把它丢掉的话，用户在 `session.question` 里的选择就白选了
            migrate: (params?: { mode?: HandoffMode }) => autoMigrate(params?.mode),
          } as unknown as HandoffService,
          handoffTokens: thresholds.handoff,
          // 谁来写交接文档由**用户**定：`resolveMode` 回到会话层，由它向客户端提问
          // （`session.question`）并等回答。不传（别的组装方）就用交接服务的默认执行者
          // —— 那是这一层的兜底，不是产品决策。
          //
          // 注意不要跟 CLI 的 `createAutoMigratePlugin` 那一套搞混：`shouldConfirm` /
          // `choose` 是那边自己的封装，服务端直接给 SDK 的 `resolveMode`。
          resolveMode: input.resolveMode,
        }),
      );
    }
  }

  private scopeFor(workspacePath: string): Promise<Scope> {
    const cached = this.scopes.get(workspacePath);
    if (cached) return cached;

    const created = this.buildScope(workspacePath).catch((error) => {
      // 失败不缓存：否则一次瞬时故障会让这个工作区永久失能
      this.scopes.delete(workspacePath);
      throw error;
    });
    this.scopes.set(workspacePath, created);
    return created;
  }

  private async buildScope(workspacePath: string): Promise<Scope> {
    const paths = agentPaths({
      aiZenDir: this.options.aiZenDir,
      workspacePath,
      homeDir: this.options.homeDir,
    });

    const config = await this.readConfig(paths.configFile);
    const scope = await (this.options.createScope ?? defaultCreateScope)({ config, paths });
    return scope;
  }

  private async readConfig(configFile: string): Promise<AppConfig> {
    if (this.options.loadConfig) return await this.options.loadConfig(configFile);

    if (!this.bootstrapped.has(configFile)) {
      this.bootstrapped.set(
        configFile,
        new ConfigManager(configFile)
          .bootstrap()
          .then(() => undefined)
          .catch((error) => {
            this.bootstrapped.delete(configFile);
            throw error;
          }),
      );
    }
    await this.bootstrapped.get(configFile);
    return await new ConfigManager(configFile).read();
  }
}

/** 默认：从 Scope 造 Agent（SDK 的 `createAgent`；中断策略取 `scope.config`） */
async function defaultCreateAgent(scope: Scope, agentId: string): Promise<AgentLike> {
  return await sdkCreateAgent(scope, agentId);
}

/**
 * 默认装配：与 CLI 侧那段 Scope 装配同一套优先级，只是路径由调用方给。
 *
 * `cwd` 必须显式给工作区路径：`Scope` 的缺省值是**进程的当前目录**，而服务端进程的 cwd
 * 是守护进程被拉起时的目录 —— 工具的相对路径、交接护栏的基准都取它，于是「会话在工作区 B、
 * `exec pwd` 却在目录 A」。这条曾经就是这么错的（`agentPaths` 的注释一直写着
 * 「工作区根是 Agent 的 cwd」，但那个字段根本没往 Scope 递）。
 */
async function defaultCreateScope(input: { config: AppConfig; paths: AgentPaths }): Promise<Scope> {
  const scope = new Scope({
    config: input.config,
    cwd: input.paths.workspacePath,
    agentsDir: input.paths.agentsDir,
  }).use(
    ...allInOne({
      subAgentsPaths: existing(input.paths.subAgentsDirs),
      skillsPaths: existing(input.paths.skillsDirs),
      toolsPaths: existing(input.paths.toolsDirs),
      mcpPaths: existing(input.paths.mcpConfigs),
    }),
  );
  await scope.init();
  return scope;
}

/** 只保留真实存在的路径：不存在的不参与发现（也不该在候选里多一行） */
function existing(paths: string[]): string[] {
  return paths.filter((path) => existsSync(path));
}

/** 带机器可判别 code 的错误（守护进程原样回给客户端） */
function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error as Error & { code: string };
}
