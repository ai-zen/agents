/**
 * 配置面（ConfigPort）—— 配置中心、`/model`、`/agent`、`/think`、`/mcp` 与启动预检
 * 共用的那一个口子。
 *
 * ## 为什么要有这一层
 *
 * 这些动作以前在 TUI 里直接调 `readConfig` / `saveConfig` / `readAgentStore` 这些函数，
 * 而它们全是**本地磁盘**操作。两端在同一台机器时看不出问题；客户端搬到另一台机器上，
 * 「我在笔记本上改的配置」和「服务端 Agent 实际用的配置」就是两份互不相干的事实 ——
 * 界面上显示成功，跑起来还是旧模型（错得很安静）。
 *
 * 所以把「配置面」收成一个接口，**只有一个实现**：`createRemoteConfigPort()` —— 走服务端的
 * `config.*` / `agent.*`，落盘发生在服务端。
 *
 * 曾经还有第二个实现（`createLocalConfigPort()`，包一层本地函数给进程内模式用）。会话执行
 * 搬到服务端之后进程内模式没有了，它也就没有调用方 —— 一起删掉，需要时看 git 历史。
 *
 * 方法签名刻意与那些本地函数**逐字对齐**（`readConfig` 之类），这样调用点只换注入值，
 * 不换写法：`deps.config.readConfig()` 读的就是同一件事（只是问在服务端）。
 *
 * ## MCP 的「项目作用域」为什么不传路径
 *
 * 项目级 `mcp.json` 在 `<工作区>/.ai-zen/` 下，而「当前工作区」是**服务端**的事实。
 * 远程实现不带路径地 `workspace.resolve()`（服务端用它自己的目录），与会话开在哪里
 * 是同一个答案 —— 客户端再抄一份路径过去，就又多了一份会漂的真相。
 */

import {
  AGENT_METHODS,
  CONFIG_METHODS,
  SESSION_METHODS,
  WORKSPACE_METHODS,
  type AgentListResult,
  type AgentRemoveParams,
  type AgentSaveParams,
  type ConfigGetResult,
  type ConfigMcpGetResult,
  type ConfigMcpSaveParams,
  type ConfigReasoningPresetsResult,
  type ConfigSaveParams,
  type ConfigSetDefaultAgentParams,
  type ConfigSetDefaultModelParams,
  type SessionModelParamsSetParams,
  type SessionModelSetParams,
  type WorkspaceResolveResult,
  type AgentKind,
} from "@ai-zen/agents-server/protocol";
// 只取类型：`AppConfig` / `AgentDefinition` / `ReasoningPresets` 是配置与定义在两端的
// 共同形状，而**线上**刻意不认识 SDK（`config.get` 的 `config` 在协议里是 `unknown`）。
// `import type` 在产物里被整体擦除，所以本包的运行期依赖图仍然只有 `./protocol` + node 内置
// —— 桌面端 main 打包时不会因此拖进 sdk（验证命令见 README）。
import type { AgentDefinition, AppConfig, ReasoningPresets } from "@ai-zen/agents-sdk";
import { ensureServer } from "./ensure-server.js";
import { clientWorkspacePath } from "./local-host.js";
import type { McpConfig, McpReadResult, McpScope } from "./mcp.js";
import type { ClientInfo, ServerClient } from "./types.js";

/**
 * Agent / SubAgent 定义的全量快照（配置中心的列表与 Agent 切换用）。
 *
 * `save` / `remove` 挂在返回值上而不是另立接口：拿到清单的人接下来要做的就这两件事，
 * 而它们本来就只认 `kind` + 定义 —— 再拆一层端口只是多一个要注入的东西。
 */
export interface AgentStore {
  agents: AgentDefinition[];
  subAgents: AgentDefinition[];
  save: (kind: AgentKind, definition: AgentDefinition) => Promise<void>;
  remove: (kind: AgentKind, id: string) => Promise<void>;
}

/** 一份全局配置 + 那份文件的**服务端**位置（配置中心的菜单要印后者） */
export interface ConfigFileSnapshot {
  config: AppConfig;
  /** `<配置根>/config.json` 在服务端的绝对路径 */
  path: string;
}

export interface ConfigPort {
  /** 读全局配置（服务端侧读到即迁移；旧字段不会漏出来） */
  readConfig(): Promise<AppConfig>;
  /**
   * 读全局配置**并带回那份文件的路径**。
   *
   * 与 {@link readConfig} 是同一次调用（`config.get`）的两个视图：只要配置本身的地方用前者，
   * 要把「你改的是哪个文件」印在屏上的地方（配置中心菜单）用后者 —— 客户端算不出服务端的
   * 路径，那个 `~/.ai-zen/config.json` 是它自己的。
   */
  readConfigFile(): Promise<ConfigFileSnapshot>;
  /** 整份写回全局配置 */
  saveConfig(config: AppConfig): Promise<void>;
  /** 读思考策略表（文件缺失/损坏时回落出厂种子） */
  readReasoningPresets(): Promise<ReasoningPresets>;
  /**
   * 换「默认 Agent」：**只写**配置里的 `defaultAgent` 一个字段。
   *
   * 不走「读出整份 → 改一个字段 → 整份写回」：终端与桌面端并存时，整份写回会把对方
   * 刚改的字段抹掉（`agent.model.set` 早就按这个理由做成了窄方法）。
   */
  setDefaultAgent(agentId: string): Promise<void>;
  /** 读某个作用域的 MCP 配置；坏文件是「可展示的状态」而不是抛错 */
  readMcpConfig(scope?: McpScope): Promise<McpReadResult>;
  /** 写某个作用域的 MCP 配置 */
  writeMcpConfig(config: McpConfig, scope?: McpScope): Promise<void>;
  /** Agent / 子 Agent 定义的全量快照（配置中心的列表与 Agent 切换用） */
  readAgentStore(): Promise<AgentStore>;
  /**
   * 换模型：写 `AgentDefinition.modelId` 并清空思考参数。
   *
   * 为什么是专门一个方法而不是「读定义 → 改字段 → 写回」：思考参数是**模型相关**的
   * （GLM-5.3 不接受 `thinking.disabled` 这类），这条规则只该有一份实现。
   * 服务端 `agent.model.set` 就是那条实现，客户端不必自己再做一次。
   */
  setModel(agentId: string, modelId: string): Promise<void>;
  /**
   * 换**这一段会话**的模型（`session.model.set`）：只写这段会话存档里的 `modelId`。
   *
   * 为什么不并进 {@link setModel}：那是「以后用这个 Agent 就跑这个模型」（写定义，影响
   * 所有用它的会话），这个是「这次用它」（只影响这一段）。两个意思两个方法 —— 合成一个
   * 就只能靠参数开关分叉，调用方得猜自己改的是哪一份。
   */
  setSessionModel(sessionId: string, modelId: string): Promise<void>;
  /**
   * 写**这一段会话**的模型参数覆盖（`session.modelParams.set`）。
   *
   * 为什么需要它与 {@link setSessionModel} 并存：参数跟着「模型来自哪一级」走。模型是本段
   * 会话换的，参数就必须也写在这一段（写进定义会影响别的会话，而且那一层的参数在本段会话
   * 根本不生效）。`null` = 清掉覆盖、回到模型出厂参数。
   *
   * 形状交给服务端当**不透明载荷**存（与存档里的 `messages` 同一口径）：这里只负责把算好
   * 的参数送上去。
   */
  setSessionModelParams(
    sessionId: string,
    modelParams: Record<string, unknown> | null,
  ): Promise<void>;
  /**
   * 换**全局兜底模型**（`config.defaultModel`）—— 三级解析的最后一级。
   *
   * 同样是窄方法（只写一个字段）：整份写回在多客户端（终端 + 桌面端）并存时会抹掉对方
   * 刚改的字段。它只在 Agent **没绑模型**时才生效（`会话级 > 定义 > 全局`）。
   */
  setDefaultModel(modelId: string): Promise<void>;
}

// ==================================================================
// 客户端模式（唯一的实现：配置的真相源在服务端）
// ==================================================================

export interface RemoteConfigPortDeps {
  /** 注入连接（测试用）；不给则首次调用时自动 ensureServer + 连接 */
  client?: ServerClient;
  /** 注入「拿连接」的函数（可选，二者取一） */
  connect?: () => Promise<ServerClient>;
  /**
   * 自动拉起服务端所需的两个事实：配置根与服务端可执行文件的位置。
   *
   * 只在不给 `client` / `connect` 时才需要。为什么不在包内读 `AI_ZEN_DIR` 这个 env：
   * 本包是**库**，读进程级全局就再也改不了目录（测试、多实例、桌面端的可配置数据目录
   * 全都会撞上它）。由组装根（CLI 的 `config.ts` / 桌面端 main）读一次 env 再递进来。
   */
  aiZenDir?: string;
  /** 握手时自称的身份（同样只在不给连接时用到）：应用名 + 版本号 */
  clientInfo?: ClientInfo;
  /**
   * 项目作用域的路径来源（缺省：按 loopback 判据取客户端 cwd，见 `local-host.ts`）。
   *
   * 之所以可注入：「当前目录」在测试里是进程级全局（会往真实工作区写文件），
   * 而它与连接无关。注入一个函数比在用例里 `chdir` 干净，也不会串到别的用例。
   */
  workspacePath?: () => string | undefined;
}

/**
 * 客户端模式：所有配置读写都发生在**服务端**。
 *
 * ## 为什么是懒连接
 *
 * 配置面是**应用级**的，它可能在会话建立之前就要用：启动时的凭据预检（「有没有可用
 * 的端点 / 模型」）走的就是这里，而那一刻用户还没开任何会话。所以不能在构造时就把连接
 * 建起来（`createRemoteConfigPort()` 甚至可能在整个进程里一次都没被调用到），而是第一次
 * 真正要读配置时才建；建好之后缓存复用，一条连接服务后续所有读写。
 *
 * 连接死了（服务端重启、网络断）不必再来问一次：下次调用发现它已关闭就重建一条
 * —— 这正是「TUI 常驻、服务端可以随时重启」那个使用形态。
 *
 * ## 为什么工作区 id 也在这层解析
 *
 * 项目级 `mcp.json` 在 `<工作区>/.ai-zen/` 下，而「当前工作区」要用与开会话**同一套判据**
 * （见 `local-host.ts`）：本地就把客户端 cwd 递上去（这样项目级 mcp 改的确实是这个项目的
 * 那份文件），远端不说（客户端把本机目录递给远端服务端，等于替它决定会话跑在哪）。
 * 两处各自判断一次就会出现「会话在 A 项目、mcp 配置读的是别处」。接口里刻意没有
 * workspaceId 参数：那是服务端的返回，不是客户端的入参。
 *
 * ## 错误不包装
 *
 * 服务端回的错误帧带着机器可判别的 code（`bad-params` / `unknown-workspace` / `unknown-model`
 * …），客户端这一层原样往上抛：包一层自己的错误类型，界面就只能显示一句「读取失败」，
 * 而那串 code 正是排查与提示的依据。
 */
export function createRemoteConfigPort(deps: RemoteConfigPortDeps = {}): ConfigPort {
  /** 缓存的连接：`null` = 还没建过（或上次建失败） */
  let cached: ServerClient | null = null;
  /** 正在建的那条连接：并发调用只建一条，不是每人一条 */
  let pendingConnect: Promise<ServerClient> | null = null;
  /**
   * 项目作用域要的 `workspaceId`（promise 而不是值：并发调用只问服务端一次）。
   * 换连接时作废 —— 新连接可能是另一个服务端，它的工作区不一定还是同一个。
   */
  let cachedWorkspaceId: Promise<string> | null = null;

  /** 拿连接：注入的优先，其次自己建；建好缓存，关了重建 */
  const connection = async (): Promise<ServerClient> => {
    /**
     * 注入的连接由调用方负责生命周期：它在测试里指向测试 Daemon，我们变不出第二条，
     * 所以即便它已经关了也照原样交出去 —— 让 `call()` 如实报「连接已关闭」，
     * 而不是在这里凭空换一条来路不明的连接。
     */
    if (deps.client) return deps.client;

    if (cached && !isClosed(cached)) return cached;
    if (!pendingConnect) {
      pendingConnect = makeConnection(deps).then(
        (client) => {
          cached = client;
          pendingConnect = null;
          // 换了一条连接 = 可能换了服务端：工作区 id 不能再沿用旧的
          cachedWorkspaceId = null;
          return client;
        },
        (error: unknown) => {
          // 建连失败不缓存：下次调用重试（否则一次瞬时故障会让进程永久失能）
          pendingConnect = null;
          throw error;
        },
      );
    }
    return await pendingConnect;
  };

  const resolveWorkspacePath = (client: ServerClient): string | undefined =>
    deps.workspacePath ? deps.workspacePath() : clientWorkspacePath(client.address.host);

  /**
   * 项目作用域的 `workspaceId`：问服务端「这个目录对应哪个工作区」。
   *
   * 路径按与开会话**同一套判据**给（{@link clientWorkspacePath}）：本地递客户端 cwd、
   * 远端不递。分成两套判断就会出现「会话在 A 项目、项目级 mcp.json 读的却是别处」——
   * 用户改完那屏以为生效了，实际改到了与本会话无关的文件里。
   *
   * 缓存它是因为同一个进程的 cwd 不变（换连接时由 `connection()` 作废）。
   */
  const projectWorkspaceId = async (client: ServerClient): Promise<string> => {
    if (!cachedWorkspaceId) {
      const path = resolveWorkspacePath(client);
      cachedWorkspaceId = client
        .call<WorkspaceResolveResult>(WORKSPACE_METHODS.resolve, path ? { path } : {})
        .then((resolved) => resolved.workspaceId)
        .catch((error: unknown) => {
          // 问不到就别记着：一次瞬时故障不该让这个进程永久以为「没有工作区」
          cachedWorkspaceId = null;
          throw error;
        });
    }
    return await cachedWorkspaceId;
  };

  /** 每个方法都重新 `connection()`：连接换了一条时，这里自然用上新的那条 */
  const call = async <T>(method: string, params?: unknown): Promise<T> => {
    const client = await connection();
    return await client.call<T>(method, params);
  };

  return {
    readConfig: async () => {
      const result = await call<ConfigGetResult>(CONFIG_METHODS.get);
      // 协议层刻意不解释 `config` 的形状（线上契约不认识 SDK），到这一层才回收成 AppConfig
      return result.config as AppConfig;
    },

    readConfigFile: async () => {
      const result = await call<ConfigGetResult>(CONFIG_METHODS.get);
      return { config: result.config as AppConfig, path: result.path };
    },

    saveConfig: async (config) => {
      const params: ConfigSaveParams = { config };
      await call(CONFIG_METHODS.save, params);
    },

    readReasoningPresets: async () => {
      const result = await call<ConfigReasoningPresetsResult>(CONFIG_METHODS.reasoningPresets);
      return result.presets as ReasoningPresets;
    },

    /** 换默认 Agent：一条窄方法，**不**读整份再写回（见接口上的注释） */
    setDefaultAgent: async (agentId) => {
      const params: ConfigSetDefaultAgentParams = { agentId };
      await call(CONFIG_METHODS.defaultAgentSet, params);
    },

    /**
     * 读 MCP 配置。
     *
     * 服务端 `config.mcp.get` 的 `{ok:false,error}` **就是**本地 `McpReadResult` 的那一半：
     * 坏文件是「可展示的状态」（编辑屏要显示坏在哪，且不能当成空配置覆盖掉），
     * 不是一次调用失败，所以这里原样返回、不抛错。
     */
    readMcpConfig: async (scope = "global") => {
      const client = await connection();
      const params = {
        scope,
        // project 作用域才需要工作区：global 就是配置根下那一个文件
        ...(scope === "project" ? { workspaceId: await projectWorkspaceId(client) } : {}),
      };
      const result = await client.call<ConfigMcpGetResult>(CONFIG_METHODS.mcpGet, params);
      return result as McpReadResult;
    },

    writeMcpConfig: async (config, scope = "global") => {
      const client = await connection();
      const params: ConfigMcpSaveParams = {
        scope,
        config,
        ...(scope === "project" ? { workspaceId: await projectWorkspaceId(client) } : {}),
      };
      await client.call(CONFIG_METHODS.mcpSave, params);
    },

    /**
     * Agent 定义快照 + 读写能力。
     *
     * 写/删刻意走 `call()` 而不是复用上面那次 `list` 拿到的连接：这两个动作可能在很久
     * 之后才发生（用户编辑完才点保存），那时连接可能已经重建过了。
     */
    readAgentStore: async () => {
      const listed = await call<AgentListResult>(AGENT_METHODS.list);
      return {
        agents: listed.agents as AgentDefinition[],
        subAgents: listed.subAgents as AgentDefinition[],
        save: async (kind: AgentKind, definition: AgentDefinition) => {
          const params: AgentSaveParams = { kind, definition };
          await call(AGENT_METHODS.save, params);
        },
        remove: async (kind: AgentKind, id: string) => {
          const params: AgentRemoveParams = { kind, id };
          await call(AGENT_METHODS.remove, params);
        },
      };
    },

    /**
     * 换模型：服务端 `agent.model.set`（写
     * `definition.modelId` 并清空思考参数），客户端不再自己做一遍 —— 否则「换模型即
     * 重置思考强度」就有了两份实现。
     */
    setModel: async (agentId, modelId) => {
      await call(AGENT_METHODS.setModel, { agentId, modelId });
    },

    /**
     * 换这一段会话的模型：服务端 `session.model.set`（写存档、重建 Agent、回新快照）。
     *
     * 快照这一层用不上：紧接着的 `session.reload()` 会再要一份（它同时刷新消息与
     * 状态栏）。少一层返回值，就少一份「谁负责更新界面」的分叉。
     */
    setSessionModel: async (sessionId, modelId) => {
      const params: SessionModelSetParams = { sessionId, modelId };
      await call(SESSION_METHODS.modelSet, params);
    },

    /**
     * 写这一段会话的模型参数（服务端 `session.modelParams.set`）：写存档、重建 Agent。
     *
     * 同样不取快照：紧接着的 `session.reload()` 会再要一份（它同时刷新消息与状态栏）。
     */
    setSessionModelParams: async (sessionId, modelParams) => {
      const params: SessionModelParamsSetParams = { sessionId, modelParams };
      await call(SESSION_METHODS.modelParamsSet, params);
    },

    /** 换全局兜底模型：一条窄方法，**不**读整份再写回（见接口上的注释） */
    setDefaultModel: async (modelId) => {
      const params: ConfigSetDefaultModelParams = { modelId };
      await call(CONFIG_METHODS.defaultModelSet, params);
    },
  };
}

/**
 * 默认的连接来源：有服务端就上，没有就拉起一个（见 `ensure-server.ts`）。
 *
 * ## 为什么它需要两个注入值
 *
 * `aiZenDir`（配置根）与 `clientInfo`（握手自报身份）都是**应用级**事实：前者是
 * 「这台机器上 ai-zen 的数据在哪」，后者是「我是谁、哪个版本」。本包是库，两者都不该由它
 * 拍板 —— 以前这里直接读 `AI_ZEN_DIR` 与 `CLI_VERSION`，包一沉下去就会变成「桌面端拉起
 * 服务端时自称是 CLI」。
 *
 * ## 为什么缺参数是「查的时候才报」
 *
 * 只在**真要自己建一条连接**时才会调到这里（注入了 `client` / `connect` 的调用方永远
 * 不会经过）。放在构造时报错就要求「只是想注入一条连接」的人也得凑齐两个用不上的参数。
 */
async function makeConnection(deps: RemoteConfigPortDeps): Promise<ServerClient> {
  if (deps.connect) return await deps.connect();
  const { aiZenDir, clientInfo } = deps;
  if (!aiZenDir || !clientInfo) {
    throw new Error(
      "createRemoteConfigPort 需要 connect，或者 aiZenDir + clientInfo（不注入时就不知道怎么拉起服务端）",
    );
  }
  return (await ensureServer({ aiZenDir, clientInfo })).client;
}

/**
 * 连接是否已经死了。
 *
 * 直接读端口上的 `closed`（见 `types.ts` 的 `ServerClient`）—— **不做结构化探测**：
 * 存活标志就在契约里，这是为了不让调用方去摸 `SocketServerClient` 的私有字段才放上去的。
 */
function isClosed(client: ServerClient): boolean {
  return client.closed;
}
