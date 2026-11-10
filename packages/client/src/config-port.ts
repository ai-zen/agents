/**
 * 配置面（ConfigPort）—— 配置中心、`/model`、`/agent`、`/think`、`/mcp` 与启动预检
 * 共用的那一个口子。
 *
 * ## 为什么要有这一层
 *
 * 配置中心这套动作如果直接调本地的 `readConfig` / `saveConfig` / `readAgentStore`，
 * 操作的全是**本地磁盘**。两端在同一台机器时看不出问题；客户端搬到另一台机器上，
 * 「我在笔记本上改的配置」和「服务端 Agent 实际用的配置」就是两份互不相干的事实 ——
 * 界面上显示成功，跑起来还是旧模型（错得很安静）。
 *
 * 所以把「配置面」收成一个接口，**只有一个实现**：`createRemoteConfigPort()` —— 走服务端的
 * `config.*` / `agent.*`，落盘发生在服务端。
 *
 * ## 它和 `facade/config.ts`（`RemoteConfig`）的分工
 *
 * `RemoteConfig` 是**协议的一比一封装**（线上形状原样进出，`config` 是 `unknown`）；
 * 这里是**应用侧的端口**：签名与那些本地函数逐字对齐（`readConfig` 之类），并把线上的
 * `unknown` 兑现成应用真正要用的类型（`AppConfig` / `ReasoningPresets` / `AgentStore`）。
 * 于是调用点只换注入值，不换写法。
 *
 * 两层共用的那部分（方法名、参数拼装）只在门面（`RemoteConfig` / `RemoteSessions`）里写一次
 * （包括工作区的解析）：本文件不 import 任何「方法名
 * 常量表」（那类常量的名字都以 METHODS 结尾），于是「同一件事两处拼参数」在这里无从发生。
 *
 * ## 会话级模型动作**不在**这里
 *
 * `session.model.set` / `session.modelParams.set` **不**在这个接口上：它们读起来像配置，
 * 但作用对象是一段会话，所以归 `RemoteSessions.modelSet` /
 * `modelParamsSet`。判据见 `facade/config.ts` 的文件头：作用对象是不是某一段会话。
 *
 * ## MCP 的「项目作用域」为什么不传路径
 *
 * 项目级 `mcp.json` 在 `<工作区>/.ai-zen/` 下，而「当前工作区」是**服务端**的事实。
 * 远程实现不带路径地 `workspace.resolve()`（服务端用它自己的目录），与会话开在哪里
 * 是同一个答案 —— 客户端再抄一份路径过去，就又多了一份会漂的真相。
 */

import { type AgentKind } from "@ai-zen/agents-protocol";
// 只取类型：`AppConfig` / `AgentDefinition` / `ReasoningPresets` 是配置与定义在两端的
// 共同形状，而**线上**刻意不认识 SDK（`config.get` 的 `config` 在协议里是 `unknown`）。
// `import type` 在产物里被整体擦除，所以本包的运行期依赖图仍然只有协议包 + node 内置
// —— 桌面端 main 打包时不会因此拖进 sdk（验证命令见 README）。
import type { AgentDefinition, AppConfig, ReasoningPresets } from "@ai-zen/agents-sdk";
import { RemoteConfig } from "./facade/config.js";
import { RemoteSessions } from "./facade/sessions.js";
import { clientWorkspacePath } from "./local-host.js";
import type { McpConfig, McpReadResult, McpScope } from "./mcp.js";
import { ServerConnection } from "./transport/connection.js";
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
  /**
   * 共享一条连接（组装根通常传这个）：与对话走**同一条** —— 一个进程一条连接。
   *
   * 不给时这里自己建一条（`client` / `connect` / `aiZenDir` + `clientInfo` 三选一），
   * 于是「配置面在会话之前就要用」的场景（启动预检）不必先开一段会话。
   */
  connection?: ServerConnection;
  /** 注入一条现成连接（测试用）；生命周期归调用方，不重建 */
  client?: ServerClient;
  /** 注入「拿连接」的函数（可选，与 `client` 二者取一） */
  connect?: () => Promise<ServerClient>;
  /**
   * 自动拉起服务端所需的两个事实：配置根与服务端可执行文件的位置。
   *
   * 只在不给 `connection` / `client` / `connect` 时才需要。为什么不在包内读 `AI_ZEN_DIR`
   * 这个 env：本包是**库**，读进程级全局就再也改不了目录（测试、多实例、桌面端的可配置
   * 数据目录全都会撞上它）。由组装根（CLI 的 `config.ts` / 桌面端 main）读一次 env 再递进来。
   */
  aiZenDir?: string;
  /** 握手时自称的身份（同样只在自己建连时用到）：应用名 + 版本号 */
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
 * 真正要读配置时才建；建好之后复用，一条连接服务后续所有读写。
 *
 * ## 「连接死了怎么办」不再是这一层的事
 *
 * 它在这里**既不缓存也不重建连接** —— 那些全归 {@link ServerConnection}：
 * 每次取用都判活，断了就重建（并在新连接上重新订阅 `events.watch`）。
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
  const connection =
    deps.connection ??
    new ServerConnection({
      ...(deps.client ? { client: deps.client } : {}),
      ...(deps.connect ? { connect: deps.connect } : {}),
      ...(deps.aiZenDir ? { aiZenDir: deps.aiZenDir } : {}),
      ...(deps.clientInfo ? { clientInfo: deps.clientInfo } : {}),
    });

  /**
   * 项目作用域的 `workspaceId`（promise 而不是值：并发调用只问服务端一次）。
   * 换连接时作废 —— 新连接可能是另一个服务端，它的工作区不一定还是同一个。
   */
  let cachedWorkspaceId: Promise<string> | null = null;
  // 连接换了 = 可能换了服务端：缓存的答案不能再沿用（这就是 `onOpen` 的用途）
  connection.onOpen(() => {
    cachedWorkspaceId = null;
  });

  /** 每次调用都重新取连接、重新建一个门面：门面本身无状态，连接换了它自然跟着换 */
  const withConfig = async <T>(run: (config: RemoteConfig) => Promise<T>): Promise<T> =>
    await run(new RemoteConfig(await connection.client()));

  const resolveWorkspacePath = (client: ServerClient): string | undefined =>
    deps.workspacePath ? deps.workspacePath() : clientWorkspacePath(client.address.host);

  /**
   * 项目作用域的 `workspaceId`：问服务端「这个目录对应哪个工作区」。
   *
   * 路径按与开会话**同一套判据**给（{@link clientWorkspacePath}）：本地递客户端 cwd、
   * 远端不递。分成两套判断就会出现「会话在 A 项目、项目级 mcp.json 读的却是别处」——
   * 用户改完那屏以为生效了，实际改到了与本会话无关的文件里。
   */
  const projectWorkspaceId = async (): Promise<string> => {
    if (!cachedWorkspaceId) {
      const client = await connection.client();
      const path = resolveWorkspacePath(client);
      // 走门面（`RemoteSessions.resolveWorkspace`）而不是裸调 `client.call(...)`：
      // 方法名与参数拼装只在门面里写一次 —— 本文件连一个方法表常量都不 import（见文件头）。
      // 不给 path 就是「服务端自己的默认工作区」：远端部署时这才是唯一有意义的问法。
      cachedWorkspaceId = new RemoteSessions(client)
        .resolveWorkspace(path)
        .then((resolved) => resolved.workspaceId)
        .catch((error: unknown) => {
          // 问不到就别记着：一次瞬时故障不该让这个进程永久以为「没有工作区」
          cachedWorkspaceId = null;
          throw error;
        });
    }
    return await cachedWorkspaceId;
  };

  return {
    readConfig: async () => {
      const result = await withConfig((config) => config.get());
      // 协议层刻意不解释 `config` 的形状（线上契约不认识 SDK），到这一层才回收成 AppConfig
      return result.config as AppConfig;
    },

    readConfigFile: async () => {
      const result = await withConfig((config) => config.get());
      return { config: result.config as AppConfig, path: result.path };
    },

    saveConfig: async (config) => {
      await withConfig((facade) => facade.save(config));
    },

    readReasoningPresets: async () => {
      const result = await withConfig((config) => config.reasoningPresets());
      return result.presets as ReasoningPresets;
    },

    /** 换默认 Agent：一条窄方法，**不**读整份再写回（见接口上的注释） */
    setDefaultAgent: async (agentId) => {
      await withConfig((config) => config.defaultAgentSet(agentId));
    },

    /**
     * 读 MCP 配置。
     *
     * 服务端 `config.mcp.get` 的 `{ok:false,error}` **就是**本地 `McpReadResult` 的那一半：
     * 坏文件是「可展示的状态」（编辑屏要显示坏在哪，且不能当成空配置覆盖掉），
     * 不是一次调用失败，所以这里原样返回、不抛错。
     */
    readMcpConfig: async (scope = "global") => {
      const workspaceId = scope === "project" ? await projectWorkspaceId() : undefined;
      const result = await withConfig((config) =>
        config.mcpGet({
          scope,
          // project 作用域才需要工作区：global 就是配置根下那一个文件
          ...(workspaceId !== undefined ? { workspaceId } : {}),
        }),
      );
      return result as McpReadResult;
    },

    writeMcpConfig: async (config, scope = "global") => {
      const workspaceId = scope === "project" ? await projectWorkspaceId() : undefined;
      await withConfig((facade) =>
        facade.mcpSave({
          scope,
          config,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
        }),
      );
    },

    /**
     * Agent 定义快照 + 读写能力。
     *
     * 写/删刻意重新走一次 `withConfig` 而不是复用上面那次 `list` 拿到的门面：这两个动作
     * 可能在很久之后才发生（用户编辑完才点保存），那时连接可能已经重建过了。
     */
    readAgentStore: async () => {
      const listed = await withConfig((config) => config.agentList());
      return {
        agents: listed.agents as AgentDefinition[],
        subAgents: listed.subAgents as AgentDefinition[],
        save: async (kind: AgentKind, definition: AgentDefinition) => {
          await withConfig((config) => config.agentSave({ kind, definition }));
        },
        remove: async (kind: AgentKind, id: string) => {
          await withConfig((config) => config.agentRemove({ kind, id }));
        },
      };
    },

    /**
     * 换模型：服务端 `agent.model.set`（写 `definition.modelId` 并清空思考参数），
     * 客户端不再自己做一遍 —— 否则「换模型即重置思考强度」就有了两份实现。
     */
    setModel: async (agentId, modelId) => {
      await withConfig((config) => config.agentSetModel(agentId, modelId));
    },

    /** 换全局兜底模型：一条窄方法，**不**读整份再写回（见接口上的注释） */
    setDefaultModel: async (modelId) => {
      await withConfig((config) => config.defaultModelSet(modelId));
    },
  };
}
