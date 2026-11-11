/**
 * 配置门面 `RemoteConfig` —— `config.*`(7) + `agent.*`(5) + `asset.*`(1) 的类型化封装。
 *
 * ## 为什么它与 `RemoteSessions` 是两个门面
 *
 * 判据只有一句：**这个方法的作用对象是不是某一段会话**（协议里两张表的拆分理由，
 * 这里只是照着线上契约分）。
 *
 *   - 是 → {@link RemoteSessions}（`session.*` + `workspace.*`）；
 *   - 不是 → 这里（改 `config.json`、改 MCP 配置、增删改 Agent 定义、列资产）。
 *
 * 这条边界的实际含义是**影响范围**：改一段会话只影响那段；改配置或 Agent 定义影响**所有**
 * 用它的会话（甚至影响还没出生的会话）。混在一个对象上，调用方会本能地以为「改完只对我
 * 这个窗口生效」—— 而这种误解通常要到「另一个终端怎么也变了」才被发现。
 *
 * ## 会话级模型动作为什么**不在**这里
 *
 * `session.model.set` / `session.modelParams.set` 读起来像配置，但它们的**作用对象**是某一段
 * 会话（写的是这段会话的存档），影响范围也只是一段 —— 按上面那条判据它们属于会话面。
 * 放在配置面还有一个具体坏处：配置面的方法都长成「改全局的那个字段」，而这两个改的是
 * **一段**，是把边界画在了影响范围的中间。
 *
 * ## 与 `ConfigPort`（应用侧的端口）的分工
 *
 * 这个类是**协议的一比一封装**：参数与结果就是线上形状（`config` 是 `unknown`，
 * 因为线上契约不认识 SDK 的类型）。应用要的 `AppConfig` / `AgentStore` 这类「兑现成类型」
 * 的读写口在 `config-port.ts`（`ConfigPort`）—— 那一层用这个类做事，不再自己拼参数。
 *
 * 无状态：只持有连接，不缓存、不判活（连接的生死归 `ServerConnection`）。
 */

import type {
  AgentGetParams,
  AgentGetResult,
  AgentListResult,
  AgentRemoveParams,
  AgentRemoveResult,
  AgentSaveParams,
  AgentSaveResult,
  AgentSetModelResult,
  AssetListParams,
  AssetListResult,
  ConfigGetResult,
  ConfigMcpGetParams,
  ConfigMcpGetResult,
  ConfigMcpSaveParams,
  ConfigMcpSaveResult,
  ConfigReasoningPresetsResult,
  ConfigSaveResult,
  ConfigSetDefaultAgentResult,
  ConfigSetDefaultModelResult,
} from "@ai-zen/agents-server/protocol";
import type { ServerClient } from "../types.js";

export class RemoteConfig {
  constructor(private readonly client: ServerClient) {}

  // ==================== 全局配置（`config.*`，7 条） ====================

  /** 读全局配置 + 那份文件在**服务端**的位置（客户端的路径是它自己的，算不出来） */
  async get(): Promise<ConfigGetResult> {
    return await this.client.call<ConfigGetResult>("config.get");
  }

  /** 整份写回全局配置（形状 = SDK 的 `AppConfig`，协议层不解释） */
  async save(config: unknown): Promise<ConfigSaveResult> {
    return await this.client.call<ConfigSaveResult>("config.save", { config });
  }

  /** 读思考策略表（文件缺失 / 损坏时由 SDK 回落出厂种子） */
  async reasoningPresets(): Promise<ConfigReasoningPresetsResult> {
    return await this.client.call<ConfigReasoningPresetsResult>("config.reasoningPresets");
  }

  /**
   * 换「默认 Agent」：**只写** `defaultAgent` 一个字段。
   *
   * 窄方法而不是「读整份 → 改一个字段 → 整份写回」：多客户端（终端 + 桌面端）并存时，
   * 整份写回会把对方刚改的字段抹掉。
   */
  async defaultAgentSet(agentId: string): Promise<ConfigSetDefaultAgentResult> {
    return await this.client.call<ConfigSetDefaultAgentResult>("config.defaultAgent.set", {
      agentId,
    });
  }

  /**
   * 换「全局兜底模型」（三级解析的最后一级）：只写 `defaultModel` 一个字段。
   *
   * 它只动兜底那一级：已经绑了模型的 Agent 一个都不受影响。
   */
  async defaultModelSet(modelId: string): Promise<ConfigSetDefaultModelResult> {
    return await this.client.call<ConfigSetDefaultModelResult>("config.defaultModel.set", {
      modelId,
    });
  }

  /**
   * 读某个作用域的 MCP 配置。
   *
   * `project` 作用域要 `workspaceId` —— **由调用方解析**（「当前工作区」是应用的事：
   * 本地服务端才该递客户端 cwd，见 `local-host.ts`）。门面只搬参数，不做这个判断，
   * 否则同一套判据会在两个地方各写一遍。
   */
  async mcpGet(params: ConfigMcpGetParams): Promise<ConfigMcpGetResult> {
    return await this.client.call<ConfigMcpGetResult>("config.mcp.get", params);
  }

  /** 整份写回某个作用域的 MCP 配置 */
  async mcpSave(params: ConfigMcpSaveParams): Promise<ConfigMcpSaveResult> {
    return await this.client.call<ConfigMcpSaveResult>("config.mcp.save", params);
  }

  // ==================== Agent 定义（`agent.*`，5 条） ====================

  /**
   * 换模型：写 `AgentDefinition.modelId` 并清空与新模型不兼容的思考参数（**一个字段**）。
   *
   * 为什么是专门一条而不是「读定义 → 改字段 → 写回」：思考参数是**模型相关**的
   * （`GLM-5.3` 不接受 `thinking.disabled` 这类），这条规则只该有一份实现。
   */
  async agentSetModel(agentId: string, modelId: string): Promise<AgentSetModelResult> {
    return await this.client.call<AgentSetModelResult>("agent.model.set", {
      agentId,
      modelId,
    });
  }

  /** 列全部 Agent 定义（顶层 + 子 Agent 两路，配置中心分两栏展示） */
  async agentList(): Promise<AgentListResult> {
    return await this.client.call<AgentListResult>("agent.list");
  }

  /** 按 id 取一份定义（`kind` 缺省时顶层优先；不存在回 `null`，不是错） */
  async agentGet(params: AgentGetParams): Promise<AgentGetResult> {
    return await this.client.call<AgentGetResult>("agent.get", params);
  }

  /** 整份写回一份定义（`id` 决定文件名） */
  async agentSave(params: AgentSaveParams): Promise<AgentSaveResult> {
    return await this.client.call<AgentSaveResult>("agent.save", params);
  }

  /** 删一份定义（本来就不存在回 `removed: false`，不当错误） */
  async agentRemove(params: AgentRemoveParams): Promise<AgentRemoveResult> {
    return await this.client.call<AgentRemoveResult>("agent.remove", params);
  }

  // ==================== 资产（`asset.*`，1 条） ====================

  /**
   * 列某个工作区（或全局）的资产（skill / 用户工具）。
   *
   * 发现规则在服务端（扫哪些目录、同名谁优先、哪些文件不是工具）：客户端自己扫一遍就是
   * 第二套规则，两份迟早不一致（症状：Agent 实际能用 12 个 skill，面板上列了 9 个）。
   */
  async assetList(params: AssetListParams): Promise<AssetListResult> {
    return await this.client.call<AssetListResult>("asset.list", params);
  }
}
