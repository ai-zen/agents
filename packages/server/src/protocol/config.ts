/**
 * 配置与管理面线上契约 —— 改「全局的东西」的方法名、参数与结果。
 *
 * ## 与 `sessions.ts` 的分工
 *
 * 判据只有一句：**这个方法的作用对象是不是某一段会话**。
 *
 *   - 是（`session.create` / `session.send` / `session.handoff` …）→ `sessions.ts`，会话面；
 *   - 不是（改 `config.json`、改 MCP 配置、增删改 Agent 定义）→ 这里，配置与管理面。
 *
 * 为什么非要分开：这些方法的**影响范围**完全不同。改一段会话只影响那段会话；改配置或
 * Agent 定义影响**所有**用它的会话（甚至影响还没出生的会话）。混在一个命名空间里，
 * 调用方会本能地以为「改完只对我这个窗口生效」，而这种误解通常要到「另一个终端怎么
 * 也变了」才被发现。文件边界就是这条语义边界。
 *
 * 为什么落在两个文件而不是一个：两批方法由不同批次搬进服务端（会话面先搬完），
 * 文件归属就是责任归属；两边的头注释各讲自己那面的命名理由，挤在一起会互相打岔。
 *
 * ## 为什么这里不引用 SDK 的类型
 *
 * 协议是**线上契约**。客户端（TUI / 桌面端 / 将来的浏览器、手机）为了一个枚举或一个字段
 * 形状去装 `@ai-zen/agents-sdk` 是不合理的 —— 那等于把「客户端」和「Agent 运行时的实现」
 * 焊在一起：SDK 改一次内部类型，所有客户端都得跟着发版。所以：
 *
 *   - `config` / `presets` / `agent` / `definition` 一律是 `unknown`：形状由 SDK 定义并演进，
 *     协议层**不解释**（与 `sessions.ts` 的 `messages: unknown[]` / `lastUsage?: unknown`
 *     是同一口径 —— 那里已经开过这个先例）；
 *   - 只有**协议自己必须收窄**的东西才在这里写死类型（`McpScope`、`kind`），因为它们是
 *     「客户端要能自己拼出请求」的最小词汇表，不写死就没法校验；
 *   - 唯一一处「形状写进了协议」的是 `config.mcp.get` 的 `{ ok, error }` 联合 —— 那不是
 *     在解释形状，那是**成功/失败的可判别标记**：坏文件必须能被客户端当成「可展示的
 *     状态」渲染出来，而不是伪装成一次调用失败（见下面 `ConfigMcpGetResult` 的注释）。
 *
 * ## 为什么 save 类方法的返回是 `{ saved: boolean }`
 *
 * 这一版所有写操作要么成功要么抛错（抛错时客户端拿到 `ok:false` 帧）。`saved` 里的
 * `false` 是留给「写了一半、需要客户端自己判断」的情形的位置 —— 现在恒为 `true`，
 * 但客户端不该因此把它当成「没有返回值就不必看」。
 */

/** 配置方法名（服务端注册与客户端调用共用同一份字面量，避免两边各写一份字符串） */
export const CONFIG_METHODS = {
  /** 读全局配置（`<配置根>/config.json`）；形状 = SDK 的 `AppConfig` */
  get: "config.get",
  /** 整份写回全局配置 */
  save: "config.save",
  /** 读思考策略表（`<配置根>/reasoning-presets.json`，缺失/损坏时由 SDK 回落出厂种子） */
  reasoningPresets: "config.reasoningPresets",
  /** 读某个作用域的 MCP 配置 */
  mcpGet: "config.mcp.get",
  /** 整份写回某个作用域的 MCP 配置 */
  mcpSave: "config.mcp.save",
} as const;

/**
 * Agent 定义的增删改查（**管理面**）。
 *
 * 与 `AGENT_METHODS.setModel`（`agent.model.set`）分开的理由不是命名美学：
 * `setModel` 是「改这一个 Agent 的一个字段」，请求形状被收窄成两个 id；而这里是
 * 「整份定义的读写」—— 客户端配置中心里那张编辑屏要的就是原样整份（含 `messages`、
 * `permissions` 等），协议不能替它挑字段。两种粒度混在一个方法里，只能靠参数里加
 * `patch: true` 这类开关来区分，那是给调用方制造分叉。
 */
export const AGENT_ADMIN_METHODS = {
  /** 列全部 Agent 定义（顶层 + 子 Agent 两路，客户端配置中心分两栏展示） */
  list: "agent.list",
  get: "agent.get",
  save: "agent.save",
  remove: "agent.remove",
} as const;

// ==================== 配置 ====================

/** `config.get` 的结果。`config` 的形状 = SDK 的 `AppConfig`，协议层不解释 */
export interface ConfigGetResult {
  config: unknown;
}

export interface ConfigSaveParams {
  config: unknown;
}

export interface ConfigSaveResult {
  saved: boolean;
}

export interface ConfigReasoningPresetsResult {
  /** 形状 = SDK 的 `ReasoningPresets`（策略名 → 档位表），协议层不解释 */
  presets: unknown;
}

/** MCP 配置的作用域：全局（配置根下） / 项目（工作区里的 `.ai-zen/`） */
export type McpScope = "global" | "project";

export interface ConfigMcpGetParams {
  scope: McpScope;
  /** project 作用域必须给（项目级 mcp.json 在 `<工作区>/.ai-zen/` 下） */
  workspaceId?: string;
}

/**
 * `config.mcp.get` 的结果。
 *
 * **坏文件不是错误，而是「可展示的状态」**：客户端编辑屏要显示「这个文件坏了，原因是
 * 什么」，并且绝不能把它当成「没有服务器」—— 那会让用户一保存就把原内容整个覆盖掉
 * （静默丢数据）。所以这里用 `ok` 标记把它和「调用失败」（`ok:false` 帧）分开：
 * 前者客户端渲染成一行警告，后者是网络/参数层面的事。
 *
 * 「文件不存在」不算坏：那是正常的空配置（`ok:true` + 空的 `mcpServers`）。
 */
export type ConfigMcpGetResult =
  | { ok: true; config: unknown }
  | { ok: false; error: string };

export interface ConfigMcpSaveParams {
  scope: McpScope;
  workspaceId?: string;
  config: unknown;
}

export interface ConfigMcpSaveResult {
  saved: boolean;
}

// ==================== Agent 定义（管理面） ====================

/** 两类 Agent 定义：顶层 Agent 与子 Agent 各占一个目录 */
export type AgentKind = "agent" | "subagent";

export interface AgentListResult {
  /** 顶层 Agent 定义（形状 = SDK 的 `AgentDefinition`），协议层不解释 */
  agents: unknown[];
  /** 子 Agent 定义（同上） */
  subAgents: unknown[];
}

export interface AgentGetParams {
  id: string;
  /**
   * 哪个池子（顶层 Agent / 子 Agent）。
   *
   * 可选是为了「只想按 id 看一眼」的老调用仍然能写；但两个池子里同名 id 是常态
   * （都叫 `default`），不指定时**顶层优先**，客户端的两栏界面必须显式带上。
   */
  kind?: AgentKind;
}

export interface AgentGetResult {
  /**
   * 不存在时是 `null`，不是错误：客户端要能区分「没这个 Agent」与「读失败」。
   *
   * 请求不指定 `kind` 时，服务端按「顶层 → 子 Agent」的顺序查，命中先到的那份。
   */
  agent: unknown | null;
}

export interface AgentSaveParams {
  /** 存进哪一类目录（同名 id 在两处是两份不同的定义） */
  kind: AgentKind;
  /** 整份定义（形状 = SDK 的 `AgentDefinition`，`id` 决定文件名） */
  definition: unknown;
}

export interface AgentSaveResult {
  saved: boolean;
}

export interface AgentRemoveParams {
  kind: AgentKind;
  id: string;
}

export interface AgentRemoveResult {
  /** 本来就不存在时是 `false`（不是错误）：与 `session.cancel` 的 `cancelled` 同一口径 */
  removed: boolean;
}
