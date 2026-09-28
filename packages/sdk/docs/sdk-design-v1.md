# SDK 设计文档 v1（Scope / ScopePlugin）

> **本文档是 `@ai-zen/agents-sdk` 的 v1 设计真相源。**
>
> v1 是一次**架构重构**：把原 `Provider`（全局上下文 + 能力管线）改名为 **`Scope`**，并把"能力来源"从 `Scope` 的内联逻辑中**疏散为可组合的 `ScopePlugin`**。
>
> 本文档描述的是 **v1 目标设计**（重构完成后与实现逐项对齐）。重构前的设计见 [sdk-design-v0.md](./sdk-design-v0.md)。v0 与 v1 的功能边界、权限模型、渐进式披露、MCP 生命周期、任务迁移等**语义完全一致**，差异仅在"能力来源如何组织"。

---

## 0. v0 → v1 一句话

> 把 `Provider` 从"**上帝对象**（上下文 + 注册表 + 四类能力的发现/过滤/实例化硬编码）"拆成"**编排容器 `Scope`**（只保留上下文 + 三阶段管线骨架）" + "**若干 `ScopePlugin`**（各自自持一类能力的发现状态与实例化逻辑）"。

| 维度 | v0 | v1 |
|------|----|----|
| 入口对象 | `Provider` | `Scope` |
| 能力来源组织 | 硬编码在 `Provider.refresh/filter/instantiate` | 疏散为 5 个 `ScopePlugin` |
| 扩展方式 | 改 `Provider` 源码 | 实现 `ScopePlugin` 并 `scope.use()` |
| 上下文 | `Provider` 持有 config/cwd/env/paths/mcpManager | `Scope` 只持 config/cwd/env/agentsDir；paths/mcpManager 归各插件 |
| 能力候选集 | `Provider.builtinTools/userTools/skills/mcps/subagents` | 插件私有自持，`Scope` 不再暴露聚合 |
| 渐进式披露 | `load_skill` / `load_mcp` 等元工具 | **原样保留**，仅从 `Provider` 平移到插件 |

---

## 1. 定位与边界

`@ai-zen/agents-sdk` 是建立在 `@ai-zen/agents-core` 之上的**引擎层**，为 CLI / Desktop 提供统一的 Agent 运行时：

- 持有**能力管线**：发现 → 权限过滤 → 实例化（内置工具、用户工具、Skill、MCP、SubAgent）
- 提供 **Scope 编排容器**：配置、工作目录、模型工厂、能力插件装配
- 提供 **Agent 组装**：`createAgent()` 产出可用的 `SdkAgent`
- 提供 **两套插件机制**：
  - `ScopePlugin`（本层）：扩展**能力装配管线**（发现/候选/实例化/释放）
  - `AgentPlugin`（继承自 core）：扩展 **Agent 运行时行为**（send/loop/toolcall）

**SDK 不管的事**（下放给各端）：

- 会话（Conversation）/ 草稿（Draft）的持久化 —— 各端自建存储，可复用 `EntityRepository`
- 端侧 UI、交互、输入框状态
- 进程生命周期、窗口管理

**边界图**：

```
CLI ──┐
      ├── @ai-zen/agents-sdk ──┬── @ai-zen/agents-core（Agent / Message / Tool / AgentPlugin）
Desktop ──┘                   │
                          LLM API / MCP 服务器（openai 官方 SDK / @modelcontextprotocol/sdk）
```

**依赖方向（SDK 内部）**：

```
scope ──> runtime ──> capabilities ──> crud ──> config ──> types
  │           │
  │           └──> shared
  │
  └──> @ai-zen/agents-core
```

- `scope` 是最高层：`Scope` 编排、`ScopePlugin` 契约与 5 个具体插件。
- 插件依赖 `runtime`（`Scope` 类型、`McpConnectionManager`、`createModel`）与 `capabilities`（discovery + implements）。
- `Scope` 只依赖 `ScopePlugin` **接口**（不静态 import 具体插件），插件经 `scope.use()` 注入 —— 无模块级循环，仅存在"插件 → Scope"的类型级单向引用。

---

## 2. 核心实体

```
openai SDK client（baseURL + apiKey）──> Agent（client + model + modelConfig）
                       │
                       └──> Tool（Agent 创建时绑定）
                              ├── 内置工具（BuiltinToolsScopePlugin，按 scope 实例化）
                              ├── 用户工具（UserToolsScopePlugin：tools/*.js）
                              ├── Skill 工具（SkillsScopePlugin：SKILL.md）
                              ├── MCP 工具（McpScopePlugin：mcp.json）
                              └── SubAgent（SubAgentsScopePlugin：子 Agent 注册为工具）
```

| 实体 | 说明 | 存储 |
|------|------|------|
| **Endpoint** | API 端点，含 baseUrl + apiKey | `config.json` |
| **Model** | 模型配置，绑定一个 Endpoint + 默认参数 + maxContextTokens | `config.json` |
| **ImageModel** | 图片生成模型配置，绑定一个 Endpoint | `config.json` |
| **Agent** | 可对话的 AI 人格，含提示词、权限、可选工具签名 | `agents/*.json` |
| **SubAgent** | 特殊 Agent：有 `function` 字段，可被其他 Agent 作为工具调用 | `sub-agents/*.json` |
| **ToolEnv** | 工具环境 `{ cwd, config }`，插件实例化内置工具时注入 | 内存态，不落盘 |
| **SdkCallbackTool** | 内置工具抽象基类：`env` 构造注入 + 子类 `call()` + `resolve()` | 内存态，不落盘 |
| **Scope** | 编排容器：上下文 + 三阶段管线 + 插件注册表 | 内存态，不落盘 |
| **ScopePlugin** | 能力插件：自持一类能力的发现状态 + 候选 + 实例化 | 内存态，不落盘 |

> 会话（Conversation）与草稿（Draft）**不属于 SDK**：SDK 只保留 `AgentNS.Message` 作为驱动接口数据结构，各端自行持久化。

---

## 3. 核心类型（types/index.ts）

### AppConfig

```typescript
interface AppConfig {
  defaultModel?: string;          // 默认模型 id
  endpoints: Endpoint[];
  models: Model[];
  imageModels?: ImageModel[];     // 图片生成模型列表
  defaultImageModel?: string;     // 默认图片生成模型 ID
  defaultAgent?: string;          // 默认 Agent ID
  defaultMigrationModel?: string; // 默认迁移模型 ID
  maxToolOutput?: number;         // 工具输出上限（字符数，缺省 32768）
}

interface Endpoint {
  id: string; baseUrl: string; apiKey: string;
  name: string; description?: string;
}

interface Model {
  id: string; name: string; endpointId: string;
  modelName?: string;             // 发送给 API 的模型名（不填用 id）
  maxContextTokens: number;       // 上下文窗口 token 上限
  maxContextChars?: number;       // 旧版字符数阈值（兼容迁移）
  defaultParams?: Record<string, unknown>;
  vision?: boolean;               // 是否支持图片输入（视觉模型）
  description?: string; version?: number;
}

interface ImageModel {
  id: string; name: string; endpointId: string; modelName: string;
  description?: string; defaultSize?: string; defaultQuality?: string; version?: number;
}
```

### AgentDefinition

```typescript
interface AgentDefinition {
  id: string;                    // 唯一标识，文件名 = id.json
  name: string;                  // 展示名称
  description?: string;
  messages: AgentNS.Message[];   // 预设对话（至少一条 system）
  modelId?: string;              // 指定模型，不填用默认
  permissions?: AgentPermissions;

  // 以下有则视为 SubAgent
  function?: AgentNS.FunctionDefine;

  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
  version?: number;
  custom?: boolean;              // 用户自定义标记：为 true 时初始化不同步内置内容
}
```

消息统一使用 Core 的 `AgentNS.Message`（`role` 为 `AgentNS.Role` 枚举，`content` 支持多模态）。**SDK 不定义自己的消息类型**。

### ToolEnv（工具环境）

```typescript
interface ToolEnv {
  /** 当前工作目录 — 相对路径解析的基准（每个 Scope 一个） */
  cwd: string;
  /** 应用配置（端点、模型、图片模型等） */
  config: AppConfig;
}
```

`ToolEnv` 在**工具构造时注入**，是工具获取环境信息的唯一来源。工具逻辑不反查 Agent / 全局状态。

### 权限类型

```typescript
type PermissionPolicy = { allow: string[] } | { deny: string[] };

interface AgentPermissions {
  tools?: PermissionPolicy;
  skills?: PermissionPolicy;
  mcps?: PermissionPolicy;
  subagents?: PermissionPolicy;
}
```

---

## 4. 权限模型

### 结构

```
Agent.permissions
  ├── tools:      { allow: string[] } 或 { deny: string[] }
  ├── skills:     { allow: string[] } 或 { deny: string[] }
  ├── mcps:       { allow: string[] } 或 { deny: string[] }
  └── subagents:  { allow: string[] } 或 { deny: string[] }
```

### 规则

1. **必须显式配置**：整个 `permissions` 字段缺失时，所有维度等同于 `deny: ['*']`（全部拒绝）
2. **维度独立**：`permissions` 存在时，四个维度各自独立判断。未配置的子维度 = 该维度 `deny: ['*']`
3. **allow 与 deny 互斥**：每个维度只能配置 `allow` 或 `deny` 之一，同时配置两者运行时抛错
4. **无命中 = 拒绝**：name 不在 allow 列表 → 拒绝；name 在 deny 列表 → 拒绝

典型配置：

- `allow: ["readFile", "exec"]` → 只有这两个可用（白名单）
- `deny: ["rm"]` → 除 rm 外全可用（黑名单）
- `allow: ["*"]` → 全开
- `deny: ["*"]` → 全关

### 匹配

- 通配符 `*` 匹配任意字符串
- `tools` 按工具名称匹配（含内置/用户/动态元工具，如 `"rm"`、`"load_skill"`）
- `skills` 按 skill id 匹配（如 `"my-skill"`）
- `mcps` 按 server 名匹配（如 `"github"`、`"postgres"`）
- `subagents` 按 `function.name` 匹配（如 `"sub_agent_default"`）

### 权限即披露

权限不仅控制「能不能用」，也控制「能不能看见」。deny 掉的工具/skill/mcp/subagent 对 LLM 完全不可见（不出现在工具列表和 `load_skill`/`load_mcp` 的参数枚举中），避免「知道但不能用」引发的困惑和无效调用。

### 隔离

每个 Agent 的权限完全独立，不继承、不传递。A 调用 SubAgent B 时，B 用自己的权限。例外：`call_skill_sub_agent` 创建的临时 Skill 子 Agent **沿用调用者的工具集**（`ctx.agent.tools`），不再走第二遍权限过滤，并额外剔除 `call_skill_sub_agent` 自身以避免链式自递归 —— 这是有意的、文档化的不对称。

### PermissionEvaluator

```typescript
class PermissionEvaluator {
  constructor(permissions?: AgentPermissions);
  filter(candidates: CandidateSets): CandidateSets;   // 四维过滤
  isAllowed(name: string, dimension: keyof CandidateSets): boolean;
  static match(name: string, policy: PermissionPolicy): boolean;
}
```

---

## 5. 模块分层与目录结构

```
types         ← 纯类型，零业务依赖（含 ToolEnv、权限、MCP 类型）
config        ← ConfigManager + constants：读写 config.json + 目录初始化 + 出厂默认
crud          ← 能力实体 CRUD（AgentRepository；通用 EntityRepository 在 shared）
runtime       ← 运行时常驻件：模型工厂 + Agent 组装 + 任务迁移（createModel / createAgent / SdkAgent / TaskMigrationService）
scope         ← Scope 编排容器 + ScopePlugin 契约 + PermissionEvaluator + disclosure + plugins/（5 个能力来源，各自自包含「发现 + 工具 + 插件」）
agent-plugins ← AgentPlugin 插件（autoMigrate、autoRefreshTools、contextGuard、unknownToolHint）
shared        ← EntityRepository、SdkError、Logger
```

> **结构原则（v1.x）**：能力来源按「自包含模块」组织——每个来源一个文件夹，内含「发现 + 工具 + 插件」，插件不再跨文件夹「缝合」。`runtime/` 保留运行时常驻件；`scope/` 只放 Scope 相关；顶层不再有 `capabilities/`、`plugin/`。
>
> 依赖方向：`agent-plugins → runtime → scope`（runtime 组装 Scope；scope 的能力插件依赖 runtime 的 `createModel`）；`scope → types / shared`，`runtime → scope / crud / shared / types`。`runtime ⇆ scope` 仅剩一条类型级边。

### 目录结构（src/）

```
types/index.ts                ← 纯类型
config/
  ConfigManager.ts            ← config.json 读写 + 目录 + 默认实体（bootstrap）
  constants.ts                ← 出厂默认（DEFAULT_APP_CONFIG / DEFAULT_AGENT / DEFAULT_SUBAGENT / CONFIG_SUB_DIRS）
crud/
  AgentRepository.ts          ← Agent 定义仓储（继承 EntityRepository）
runtime/
  createModel.ts              ← createModel(scope, modelId) → { client, model, modelConfig }
  createAgent.ts              ← createAgent(scope, agentId) → SdkAgent
  SdkAgent.ts                 ← SdkAgent（携带 scope + definition；插件机制继承自 Core）
  TaskMigrationService.ts     ← 任务迁移（实例化服务：migrate 复用传入 agent 的模型调用）
scope/
  Scope.ts                    ← 编排容器
  ScopePlugin.ts              ← ScopePlugin 接口 + ScopeCandidates
  PermissionEvaluator.ts      ← 权限匹配 + 四维度过滤
  disclosure.ts               ← createDisclosureParam（load_skill / load_mcp 参数枚举）
  plugins/                    ← 每个能力来源一个自包含文件夹
    allInOne.ts               ← 便捷工厂：恒返回 5 个标准插件
    builtin/                  ← 内置工具来源（发现 + 工具 + 插件）
      BuiltinToolsScopePlugin.ts
      discover.ts             ← discoverBuiltinTools(env) → Tool[]
      SdkCallbackTool.ts      ← 内置工具抽象基类
      outputGuard.ts          ← 工具输出保护骨架
      index.ts                ← BUILTIN_TOOL_CLASSES + 工具类再导出
      *Tool.ts                ← 20 个内置工具类
      test-helpers.ts
    usertools/                ← 用户工具来源
      UserToolsScopePlugin.ts
      discover.ts             ← discoverUserTools(paths) → Tool[]
    skills/                   ← Skill 来源
      SkillsScopePlugin.ts
      discover.ts             ← discoverSkills / readSkill / parseFrontmatter / validateSkill
      skillTools.ts           ← createLoadSkillTool / createCallSkillSubAgentTool
    mcp/                      ← MCP 来源
      McpScopePlugin.ts
      discover.ts             ← discoverMcpServers(paths) → McpServerConfig[]
      mcpTools.ts             ← createLoadMcpTool / createCallMcpTool / createReadMcpResourceTool
      McpConnectionManager.ts ← MCP 连接生命周期
    subagents/                ← SubAgent 来源
      SubAgentsScopePlugin.ts
      discover.ts             ← discoverSubAgents(paths) → AgentDefinition[]
      subAgentTools.ts        ← createSubAgentTool
agent-plugins/                ← AgentPlugin 插件
  AutoMigratePlugin.ts        ← 上下文超限自动迁移
  AutoRefreshToolsPlugin.ts   ← send 前刷新工具列表
  ContextGuardPlugin.ts       ← 严重超限安全护栏
  UnknownToolHintPlugin.ts    ← 未知工具的 MCP 智能提示（调用方显式注册）
shared/
  EntityRepository.ts         ← 通用 JSON 仓储
  errors.ts                   ← SdkError / ContextOverflowError
  logger.ts                   ← getLogger / setLogger
```

---

## 6. Scope — 编排容器

`Scope` 是 SDK 的**唯一入口对象**。它只做三件事：**持有上下文**、**编排插件**、**跑三阶段管线骨架**。它**不再持有任何一类具体能力的候选集**。

### 构造

```typescript
const scope = new Scope({
  config,        // AppConfig
  cwd,           // 当前工作目录，默认 process.cwd()
  agentsDir,     // Agent 定义目录（createAgent 用）
});
```

> **v0 → v1 变化**：`Provider` 构造曾接收 `subAgentsPaths / skillsPaths / toolsPaths / mcpPaths`；v1 中这些**路径移交给各自的能力插件**（见 §9）。`Scope` 只保留 `config / cwd / agentsDir`。

### 关键字段

```typescript
class Scope {
  readonly config: AppConfig;
  readonly cwd: string;               // 相对路径解析基准，也是 ToolEnv.cwd 的来源
  readonly env: ToolEnv;              // { cwd, config }，插件实例化内置工具时注入
  readonly agentsDir: string;         // createAgent 用
  readonly plugins: readonly ScopePlugin[];   // 已注册插件（只读视图）
}
```

### 插件注册与生命周期

```typescript
class Scope {
  /** 注册插件（链式，可变参数：use(a) / use(...allInOne(...))）。必须在 init() 之前调用；init() 之后再 use() → 抛错。 */
  use(...plugins: ScopePlugin[]): this;

  /** 按 id 查找插件（供外部代码/其它插件查询插件状态，如 UnknownToolHintPlugin 查 MCP 配置） */
  getPluginById<T extends ScopePlugin>(id: string): T | undefined;

  /** 初始化：遍历插件执行首次 discover()。 */
  async init(): Promise<void>;

  /** 重新发现：遍历插件执行 discover()（可静默）。 */
  async refresh(options?: { silent?: boolean }): Promise<void>;

  /** 释放：逆序调用各插件 dispose()（如 MCP 断开所有连接）。与 init() 对称。 */
  async dispose(): Promise<void>;
}
```

### 能力管线方法

```typescript
class Scope {
  /** 阶段 2：汇总各插件候选名 → exclude 预过滤 → 四维权限过滤，返回名称列表 */
  filter(definition: AgentDefinition, options?: FilterOptions): FilterOutput;

  /** 阶段 3：遍历插件 instantiate()，收集工具实例并去重 */
  instantiate(filtered: FilterOutput): Tool[];

  /** 快捷：filter + instantiate 一步完成 */
  buildTools(definition: AgentDefinition, options?: FilterOptions): Tool[];
}
```

```typescript
interface FilterOutput {
  tools: string[];
  subagents: string[];
  skills: string[];
  mcps: string[];
}

interface ExcludeOptions {
  tools?: string[];       // 排除的工具名称（内置 + 用户 + 动态元工具）
  skills?: string[];      // 排除的 skill id
  mcps?: string[];        // 排除的 MCP server 名
  subagents?: string[];   // 排除的 agent/function 名称
}

interface FilterOptions {
  exclude?: ExcludeOptions;
}
```

`ExcludeOptions` 是优先级高于 permissions 的安全黑名单，用途：

- SubAgent 递归保护：`{ exclude: { subagents: [自身 function.name] } }`
- Skill 自调用保护：`{ exclude: { skills: [自身 skillId] } }`

### 不可变原则

`Scope` 实例创建后 `config / cwd / agentsDir / env` 不变；`refresh()` 只让插件重新发现能力，**不重建 Scope，也不重建插件实例**。

### 多会话并行（核心能力）

每个 `Scope` 可绑定不同 `cwd`（对应一个工作目录）。内置工具以 `ToolEnv.cwd` 为相对路径基准，**不依赖全局 `process.cwd()`**。CLI/Desktop 可同时持有多个 Scope 服务不同工作目录的会话，互不干扰。

```
Desktop（workspaces.json）
   │ 每 workspace 一个 Scope（1:1，运行时映射）
   ▼
Scope(cwd) ──ToolEnv──▶ 插件实例化工具（cwd/config 注入）
   │
   ▼
createAgent(scope, agentId, { messages }) → SdkAgent（并行 send）
```

---

## 7. ScopePlugin — 插件契约

`ScopePlugin` 是 **v1 的核心扩展点**。一个插件**自持一类能力**的完整生命周期：它自己发现、自己持有发现结果、自己声明候选名、自己按过滤结果实例化工具、自己负责释放。

> **与 `AgentPlugin` 的区别**：`ScopePlugin` 挂在**能力装配管线**（discover/filter/instantiate）；`AgentPlugin` 挂在 **Agent 运行时**（send/loop/toolcall）。两者互不相关，也不可混用。

```typescript
// scope/ScopePlugin.ts

/** 插件向四维权限体系贡献的候选名称（任意子集） */
export interface ScopeCandidates {
  tools?: string[];
  skills?: string[];
  mcps?: string[];
  subagents?: string[];
}

/**
 * 能力插件。
 *
 * 生命周期与三阶段管线的对应：
 *   discover     —— 阶段 1 · 发现
 *   candidates   —— 阶段 2 · 候选（供权限过滤）
 *   instantiate  —— 阶段 3 · 实例化
 *   dispose      —— 释放
 */
export interface ScopePlugin {
  /** 唯一标识，如 "builtin" / "user-tools" / "skills" / "mcp" / "subagents" */
  readonly id: string;

  /**
   * 阶段 1 · 发现：扫描来源、刷新自身状态。
   * 每次内部重新扫描（不跨 refresh 累积脏状态）。
   * 相对路径应在此基于 `scope.cwd` 解析。
   */
  discover?(scope: Scope, options: { silent?: boolean }): Promise<void> | void;

  /**
   * 阶段 2 · 候选：返回本插件向四维贡献的候选名。
   * 可结合 `definition` 做可用性判断（如内置工具的 isAvailable）。
   * 同步返回（只读已发现状态）。
   */
  candidates(scope: Scope, definition: AgentDefinition): ScopeCandidates;

  /**
   * 阶段 3 · 实例化：按过滤后的允许名产出 Tool 实例。
   * `filtered` 为 `Scope.filter()` 的产物（四维允许名）。
   */
  instantiate(scope: Scope, filtered: FilterOutput): Tool[];

  /** 可选 · 释放：逆序于注册顺序调用。如 MCP 断开所有连接。 */
  dispose?(): Promise<void> | void;
}
```

### 契约要点

- **自持状态**：插件在 `discover()` 中把发现结果存进自身字段；`candidates()` / `instantiate()` 从自身字段读取。`Scope` 不感知、不聚合这些状态。
- **候选 ≠ 实例**：`candidates()` 只报"名称"（供权限过滤）；是否真正注册为工具由 `instantiate()` 决定（可带附加条件，如"有可用 skill 才注册 `load_skill`"）。
- **可用性判断内聚在插件**：`isAvailable` 一类判断由产出该工具的插件在 `candidates()` 中完成（`Scope` 不管）。
- **同步 `candidates`**：只读内存态，同步返回；`instantiate` 亦同步。`discover` / `dispose` 可异步。

---

## 8. 标准插件（5 个）

**一来源一插件**：SDK 现有的 5 类能力来源，各拆成独立插件。

| 插件 | `id` | `discover` 来源 | `candidates` 贡献 | `instantiate` 产物 |
|------|------|----------------|-------------------|-------------------|
| `BuiltinToolsScopePlugin` | `builtin` | `BUILTIN_TOOL_CLASSES`（20 类） | `tools`（经 `isAvailable(config, def)` 剔除不可用） | 20 个内置工具实例 |
| `UserToolsScopePlugin` | `user-tools` | `discoverUserTools(paths)` | `tools` | 用户 `tools/*.js` 工具 |
| `SkillsScopePlugin` | `skills` | `discoverSkills(paths)` | `skills` + `tools: [load_skill, call_skill_sub_agent]` | `createLoadSkillTool` / `createCallSkillSubAgentTool` |
| `McpScopePlugin` | `mcp` | `discoverMcpServers(paths)` + 私有 `mcpManager` | `mcps` + `tools: [load_mcp, call_mcp_tool, read_mcp_resource]` | `createLoadMcpTool` / `createCallMcpTool` / `createReadMcpResourceTool` |
| `SubAgentsScopePlugin` | `subagents` | `discoverSubAgents(paths)` | `subagents` | `createSubAgentTool(def, scope)` |

### 路径归属（v0 → v1 变化）

各插件在**构造时接收自己的路径**（绝对路径，或相对路径 → 在 `discover()` 中按 `scope.cwd` join）：

```typescript
new BuiltinToolsScopePlugin()                          // 无路径（用 scope.env 实例化）
new UserToolsScopePlugin({ paths: [...] })
new SkillsScopePlugin({ paths: [...] })
new McpScopePlugin({ paths: [...] })                   // 有 paths → 内部创建 mcpManager
new SubAgentsScopePlugin({ paths: [...] })
```

### BuiltinToolsScopePlugin

```typescript
// candidates(scope, def)：discover 产出实例后，逐个体检 isAvailable
candidates(scope, def) {
  const names = this.tools
    .filter((t) => t.isAvailable?.(scope.config, def) ?? true)
    .map((t) => t.function.name);
  return { tools: names };
}
// instantiate(scope, filtered)：按允许名回捞实例
instantiate(scope, filtered) {
  const allow = new Set(filtered.tools);
  return this.tools.filter((t) => allow.has(t.function.name));
}
```

### UserToolsScopePlugin

同 `BuiltinToolsScopePlugin` 结构，来源换成 `discoverUserTools(paths)`。与内置插件**分开**，以便单独替换/停用其中一类。

### SkillsScopePlugin（渐进式披露保留）

```typescript
discover(scope, opts) { this.skills = await discoverSkills(this.paths, opts); }
candidates() {
  return {
    skills: this.skills.map((s) => s.id),
    // 元工具名恒定上报（供 tools 维度允许/拒绝 → 拒绝即切断披露通道）
    tools: ["load_skill", "call_skill_sub_agent"],
  };
}
instantiate(scope, filtered) {
  const allow = new Set(filtered.tools);
  const filteredSkills = this.skills.filter((s) => filtered.skills.includes(s.id));
  const out: Tool[] = [];
  if (allow.has("load_skill") && filteredSkills.length > 0)
    out.push(createLoadSkillTool(this.paths, filteredSkills));
  if (allow.has("call_skill_sub_agent") && filteredSkills.some((s) => s.subAgent))
    out.push(createCallSkillSubAgentTool(this.paths, filteredSkills));
  return out;
}
```

### McpScopePlugin（渐进式披露保留）

```typescript
// 构造：paths 非空 → 内部创建 mcpManager
constructor(opts: { paths?: string[] }) {
  this.paths = opts.paths ?? [];
  this.mcpManager = this.paths.length > 0 ? new McpConnectionManager() : undefined;
}
discover(scope) { this.mcps = await discoverMcpServers(this.paths); }
candidates() {
  return {
    mcps: this.mcps.map((s) => s.id),
    tools: ["load_mcp", "call_mcp_tool", "read_mcp_resource"],
  };
}
instantiate(scope, filtered) {
  const allow = new Set(filtered.tools);
  const filteredMcps = this.mcps.filter((m) => filtered.mcps.includes(m.id));
  const m = this.mcpManager; const out: Tool[] = [];
  if (allow.has("load_mcp") && m && filteredMcps.length > 0) out.push(createLoadMcpTool(m, filteredMcps));
  if (allow.has("call_mcp_tool") && m) out.push(createCallMcpTool(m));
  if (allow.has("read_mcp_resource") && m) out.push(createReadMcpResourceTool(m));
  return out;
}
dispose() { return this.mcpManager?.disconnectAll(); }

/** 供 UnknownToolHintPlugin 判断"是否有 MCP 配置" */
hasConfig(): boolean { return this.paths.length > 0; }
```

### SubAgentsScopePlugin

```typescript
discover(scope) { this.subagents = await discoverSubAgents(this.paths); }
candidates() { return { subagents: this.subagents.map((d) => d.function!.name) }; }
instantiate(scope, filtered) {
  const allow = new Set(filtered.subagents);
  return this.subagents
    .filter((d) => d.function && allow.has(d.function.name))
    .map((d) => createSubAgentTool(d, scope));   // AgentToolLazy，延迟构建
}
```

### allInOne — 便捷工厂

恒返回 5 个标准插件（"全家桶"）。

```typescript
// scope/plugins/allInOne.ts
export function allInOne(options?: {
  skillsPaths?: string[];
  toolsPaths?: string[];
  subAgentsPaths?: string[];
  mcpPaths?: string[];
}): ScopePlugin[] {
  return [
    new BuiltinToolsScopePlugin(),
    new UserToolsScopePlugin({ paths: options?.toolsPaths ?? [] }),
    new SkillsScopePlugin({ paths: options?.skillsPaths ?? [] }),
    new McpScopePlugin({ paths: options?.mcpPaths ?? [] }),
    new SubAgentsScopePlugin({ paths: options?.subAgentsPaths ?? [] }),
  ];
}
```

> **顺序即优先级**：`instantiate()` 收集后按"后注册覆盖先注册"去重，故 `allInOne` 按 `[builtin, user-tools, skills, mcp, subagents]` 排列 —— 用户工具可覆盖同名内置工具（与 v0 一致）。想裁剪/替换某一类，改用手工逐个 `new XxxScopePlugin(...)` + `.use()`。

---

## 9. 能力装配三阶段

装配三阶段：**发现 → 过滤 → 实例化**，由 `Scope` 编排、各插件落实现。

### 阶段 1 — 发现（`Scope.init()` / `Scope.refresh()`）

```
Scope.init() / refresh()
  └── for (plugin of plugins) await plugin.discover(scope, { silent })
```

各插件刷新自身状态。发现结果**插件自持**，不汇总到 `Scope`。

### 阶段 2 — 过滤（`Scope.filter`）

```
filter(definition, { exclude })
  │
  ├── 1. 汇总候选：for (plugin of plugins) merge(plugin.candidates(scope, definition))
  │        → 四维候选名 { tools, skills, mcps, subagents }
  │        （插件已在 candidates 内完成自身可用性判断，如 isAvailable）
  │
  ├── 2. 应用 exclude（四维安全黑名单，优先级高于权限）
  │
  └── 3. 四维权限过滤（PermissionEvaluator）
           ├── tools / skills / mcps / subagents
           └── 产出 FilterOutput { tools, subagents, skills, mcps }
```

### 阶段 3 — 实例化（`Scope.instantiate`）

```
instantiate(filtered)
  │
  ├── for (plugin of plugins) result.push(...plugin.instantiate(scope, filtered))
  │        （内置/用户工具按名回捞；Skill/MCP 插件按条件注册元工具；SubAgent 建 AgentToolLazy）
  │
  └── 去重（后注册覆盖先注册）
```

---

## 10. 动态工具与渐进式披露（**原样保留**）

MCP 和 Skill 采用**惰性加载**：装配时不直接注册具体工具，而是注册「加载器工具」，由 LLM 在运行时按需触发。**v1 不改变这套设计**，仅把装配逻辑从 `Provider.instantiate()` 平移到 `SkillsScopePlugin` / `McpScopePlugin`。

### load_skill

- 参数：`skill_id`（枚举 = 所有允许的 skill，附各 skill 描述）
- 返回：SKILL.md 完整正文 + 目录路径 + 目录文件列表
- 权限：skill 枚举已按 `permissions.skills` 裁剪

### call_skill_sub_agent

- 参数：`skill_id`（仅枚举 `subAgent: true` 的 skill）+ `task`
- 承载类：`AgentToolLazy`（与 SubAgent 工具同一通道）—— 同样经过 `onSubAgentStart` / `onSubAgentEnd` 委派边界，并广播 `sub-agent-start` / `sub-agent-end` 事件
- 行为：`buildAgent` 中读取 SKILL.md，以「正文为 system prompt + `task` 为 user 消息」创建临时 Agent；工具集沿用父 Agent 的工具（`ctx.agent.tools`），剔除 `call_skill_sub_agent` 自身防自递归，不再走第二遍权限过滤
- 初始消息依赖运行时参数，故不传 `messages` 模板，由 `buildAgent` 自行决定
- `skill_id` 不存在或未声明 `sub-agent: true` → 抛出错误（正常路径由枚举限定）

### load_mcp

- 参数：`server`（枚举 = 所有允许的 server，附各 server 描述）+ `include_manifest`（可选布尔，默认 `true`）
- 返回（两种模式）：
  - `include_manifest=true`（默认）：结构化 JSON `{ tools, resources }`（tools 含完整 `inputSchema`，resources 含 uri/name/description/mimeType）
  - `include_manifest=false`：仅建立连接，返回摘要 `{ server, connected, tools: 数量, resources: 数量 }`，不含任何工具/资源定义；完整清单仍留在 `McpConnectionManager` 内供 `call_mcp_tool` 使用
- 披露开关用途：进程重启后连接已失效、但上文中已存在该清单时，只重建连接而不重复向上下文灌入数十 KB 清单；日志同步降为摘要
- 已连接 → 直接返回当前清单（`touch` 续期）；未连接 → `mcpManager.connect()`；失败 → 错误信息（两种模式一致）
- `description`：server 描述在 `server` 参数枚举中呈现，供 LLM 参考（对齐 `load_skill`，缺失时默认空白）

### call_mcp_tool

- 参数：`server` + `tool` + `arguments`
- 未连接 → "请先使用 load_mcp 连接 'X'"；`isError` → 错误文本

### read_mcp_resource

- 参数：`server` + `uri`
- 返回资源文本内容

### 工具总览（动态）

| 工具 | 所属维度 | 幂等 | 副作用 |
|------|----------|------|--------|
| `load_skill` | skills | ✅ 重复可加载 | 消耗上下文 |
| `call_skill_sub_agent` | skills | — 每次独立执行 | 创建临时 Agent（走委派边界，分发 `sub-agent-start` / `sub-agent-end`） |
| `load_mcp` | mcps | ✅ 重复不重连 | 建立连接（可选不披露清单） |
| `call_mcp_tool` | mcps | — 取决于工具 | 取决于工具 |
| `read_mcp_resource` | mcps | ✅ 可重复读取 | 无 |

> **披露通道的切断语义不变**：`load_skill` / `load_mcp` 等元工具名上报到 `tools` 维度参与权限过滤；`tools` 维度拒绝它们即切断整条披露通道。

---

## 11. 能力发现细节

### 用户工具（scope/plugins/usertools/discover.ts）

- 扫描 `tools/*.js` / `*.mjs`，原生 `import()` 加载（`type: module` 下 .js 也是 ESM）
- 每次加载加时间戳 querystring 防止模块缓存，确保 `refresh()` 能重新加载
- 导出格式归一化：Tool 实例 / `{ function, exec }` / `{ function, callback }` → 统一为 Tool
- 按文件名排序保证确定性；同名工具靠前路径优先

### Skill（scope/plugins/skills/discover.ts）

- 目录结构：`<skillId>/SKILL.md`，id = 目录名
- 三段式：Scanner（扫描含 SKILL.md 的子目录）→ Parser（解析 YAML frontmatter）→ Loader（`readSkill` 返回完整正文）
- frontmatter 字段：`name`、`description`、`sub-agent`、`license`、`compatibility`、`metadata`、`allowed-tools`
- 校验为**警告不阻塞**：name 规范（小写字母/数字/连字符、与目录名一致、≤64）、description 非空 ≤1024、compatibility ≤500

### MCP（scope/plugins/mcp/discover.ts）

- 格式：`{ "mcpServers": { id: { type?, command?, args?, env?, url?, headers?, disabled?, description? } } }`
- `description`：服务器描述，经 `load_mcp` **透传呈现给 LLM 参考**（拼接进 `server` 参数枚举）
- transport 推断：`type`/`transport`/`transportType` 优先，否则有 `command` → stdio、有 `url` → http
- transport 语义：`http` = Streamable HTTP（现行规范），`sse` = 旧版 HTTP+SSE
- `disabled: true` 跳过；解析失败记日志并跳过

### SubAgent（scope/plugins/subagents/discover.ts）

- 扫描 `sub-agents/*.json`，仅保留含 `function` 字段的定义
- 同名 `function.name` 靠前路径优先

---

## 12. 内置工具 — 类化 + ToolEnv 注入

### SdkCallbackTool 抽象基类（scope/plugins/builtin/SdkCallbackTool.ts）

```typescript
abstract class SdkCallbackTool extends Tool {
  /** 注入的工具环境 */
  readonly env: ToolEnv;

  /**
   * 工具对当前 Agent 的可用性判断。直接透传完整 app config + agent definition，
   * 工具自取所需。返回 false 则不注册；不实现则默认可用。
   * 在插件的 candidates() 阶段调用（见 BuiltinToolsScopePlugin）。
   */
  isAvailable?(config: AppConfig, definition: AgentDefinition): boolean;

  constructor(options: SdkCallbackToolOptions /* { env } */);

  /** 工具核心逻辑（子类实现，参数为 parsedArgs）；可选第二参 ctx 携带完整 ToolCallContext */
  abstract call(input: unknown, ctx?: ToolCallContext): unknown | Promise<unknown>;

  /** 桥接 core 的 Tool.exec：解析参数 → call → 序列化/透传内容块 */
  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent>;

  /** 将相对路径解析到 env.cwd，绝对路径原样返回 */
  resolve(p: string): string;
}
```

设计原则：

- 一个工具一个类，文件名 = 类名（PascalCase）
- 环境（`cwd`、`config`）**构造注入**，不依赖全局 `process.cwd()`，也不反查 Agent 上下文
- 相对路径统一用 `resolve()` 解析到 `env.cwd`
- `exec()` 保证返回 string：字符串原样，非字符串 JSON 序列化，`undefined` 归一为空串

### BUILTIN_TOOL_CLASSES 注册表（scope/plugins/builtin/index.ts）

```typescript
export const BUILTIN_TOOL_CLASSES: Array<new (env: ToolEnv) => SdkCallbackTool> = [
  CwdTool, ReadFileTool, InspectFileTool, WriteFileTool, ExecTool, MkdirTool, RmTool,
  GlobTool, LsTool, ExistTool, FindTextTool, DownloadFileTool,
  RenameTool, CopyTool, BatchEditTool, EditTool, ExecAsyncTool, SleepTool,
  ViewImageTool, GenerateImageTool,
];
```

20 个内置工具类（发现层不做过滤，可用性由各工具 `isAvailable` 声明，在 `BuiltinToolsScopePlugin.candidates()` 阶段过滤）：

| 工具 | 说明 |
|------|------|
| `cwd` | 获取当前工作目录（`env.cwd`） |
| `readFile` | 读取文件（>300KB 拒绝）；可选 `range` 按行列范围读取；输出超限仅警告 |
| `inspectFile` | 勘察文件结构概况；流式扫描，不受 300KB 限制 |
| `writeFile` | 写入文件（自动建父目录） |
| `exec` | 执行命令（`timeout` 必填）；超限时分文件落盘 `stdout.log` / `stderr.log` |
| `exec_async` | 异步执行命令，启动后立即返回；全平台经 shell 解析 |
| `mkdir` | 创建目录（`recursive`） |
| `rm` | 删除文件或目录 |
| `glob` | glob 模式扫描；输出超限落盘 `result.json` |
| `ls` | 列出目录内容；输出超限落盘 |
| `exist` | 检查文件或目录是否存在 |
| `findText` | 在文件中搜索文本或正则；输出超限落盘 |
| `downloadFile` | 从 URL 下载文件并保存 |
| `rename` | 重命名或移动文件/目录 |
| `copy` | 复制文件或目录 |
| `batchEdit` | 批量替换文件文本 |
| `edit` | 单次替换文件文本 |
| `sleep` | 等待指定毫秒数 |
| `generateImage` | 生成图片；`isAvailable` 声明**依赖 `config.defaultImageModel`** |
| `viewImage` | 查看图片；`isAvailable` 声明**仅视觉模型可用**（`Model.vision === true`） |

### 输出保护（`maxToolOutput` + `guardOutput`）

- **上限配置**：`AppConfig.maxToolOutput`（字符数，缺省 32768）。仅 CONFIG 层可配。
- **骨架**：`guardOutput({ tool, content, isOverLimit, dump?, buildWarning })`——工具自陈策略，骨架负责判定与落盘。
- **落盘目录**：`<os.tmpdir()>/ai-zen/tool-output/<tool>-<时间戳>-<随机串>/`。
- **已接入**：`exec`、`findText` / `glob` / `ls`、`readFile`、`inspectFile`。
- **读取阈值与输出阈值互相独立**：300KB 是"能否读取"，`maxToolOutput` 是"是否落盘"。

---

## 13. MCP 连接生命周期（McpConnectionManager）

基于官方 `@modelcontextprotocol/sdk` 的 `Client` + `Transport`：

- `stdio` → `StdioClientTransport`（子进程）
- `http` → `StreamableHTTPClientTransport`
- `sse` → `SSEClientTransport`

> **归属变化**：`McpConnectionManager` 仍是 `runtime` 层的独立类，但**实例由 `McpScopePlugin` 私有持有**（v0 中由 `Provider` 持有）。外部不再经 `scope.mcpManager` 访问，而是经 `scope.getPluginById(McpScopePlugin.ID)`。

### 状态机

```
                     ┌──────────┐
          connect ──>│connecting│<────────┐
                     └────┬─────┘         │
              ┌─────失败──┴──成功──────┐  │
              ▼                       ▼  │
         ┌────────┐             ┌─────────┐
         │  error │────────────>│connected│
         └────────┘  (重试)     └────┬────┘
                          ┌─空闲超时┼─主动 disconnect
                          ▼        ▼
                    断开并清理   断开并清理
```

### API

```typescript
class McpConnectionManager {
  getState(name): McpConnectionState;
  getManifest(name): McpServerManifest | undefined;
  getClient(name): Client | undefined;
  async connect(name, config, options?): Promise<McpServerManifest>;
  async disconnect(name): Promise<void>;
  async disconnectAll(): Promise<void>;
  touch(name): void;
}

interface McpConnectOptions {
  idleTimeoutMs?: number;   // 默认 stdio: 30min, http/sse: 5min
  autoReconnect?: boolean;
  maxRetries?: number;      // 默认 3
  isConfigError?: (err) => boolean;
}
```

### 关键行为

- **按需调用**：连接后仅对 Server 声明的 capabilities 调用 `listTools` / `listResources` / `listPrompts`。
- **重连**：指数退避 1s→2s→4s→8s→16s→30s（封顶），配置类错误不重试。
- **空闲超时**：每次操作 `touch()` 续期；计时器 `unref()` 不阻止进程退出。
- **主动释放**：`Scope.dispose()` → 各插件 `dispose()` → `McpScopePlugin.dispose()` → `disconnectAll()`。
- **list_changed**：服务端推送变更 → 自动刷新本地注册表。
- 测试注入：构造函数可传自定义 transport / client 工厂。

---

## 14. ConfigManager 与出厂默认

### ConfigManager

```typescript
class ConfigManager {
  constructor(configPath: string);
  readonly configPath: string;
  readonly basePath: string;

  async read(): Promise<AppConfig>;                       // 无文件时返回出厂默认（不落盘）
  async write(config: AppConfig): Promise<void>;          // 原子写入（.tmp + rename）
  async ensureDirs(): Promise<void>;                      // basePath + CONFIG_SUB_DIRS
  async ensureDefaultConfig(): Promise<AppConfig>;
  async ensureDefaultAgent(): Promise<AgentDefinition | null>;
  async ensureDefaultSubAgent(): Promise<AgentDefinition | null>;
  async readMcpConfig(): Promise<{ mcpServers: Record<string, unknown> }>;
  async writeMcpConfig(config: { mcpServers: Record<string, unknown> }): Promise<void>;
  async ensureDefaultMcpConfig(): Promise<void>;
  async bootstrap(): Promise<{ config, agent, subAgent }>;
}
```

### 出厂默认（constants.ts）

| 常量 | 说明 |
|------|------|
| `DEFAULT_APP_CONFIG` | 预置端点（OpenAI / 智谱 / DeepSeek）+ 7 个模型（含视觉模型，`vision: true`）+ 3 个图片模型 + 默认选项 + `maxToolOutput: 32768` |
| `DEFAULT_AGENT_ID` / `DEFAULT_AGENT_DEFINITION` | 默认 Agent（id=`default`，四维全开，`custom: false`） |
| `DEFAULT_SUBAGENT_ID` / `DEFAULT_SUBAGENT_DEFINITION` | 默认通用助手 SubAgent（id=`sub-agent-default`，`subagents: deny` 防递归） |
| `DEFAULT_MCP_CONFIG` | 出厂默认 MCP 服务器（socket-pty 终端） |
| `CONFIG_SUB_DIRS` | 标准共享子目录：`agents` / `sub-agents` / `skills` / `tools` / `mcp-oauth` |

设计决策：

- **SDK 持有出厂默认**：预置厂商/模型由 SDK 统一维护，各端不重复定义
- **幂等安全**：所有 `ensure*` 对已存在文件不覆盖
- **提示词可同步**：`custom` 为 `false` 时同步出厂提示词；用户设为 `true` 则完全自主
- **read() 无文件返回默认**：无需先写 config.json 也能工作

### 文件布局（共享）

```
~/.ai-zen/
  config.json           ← 全局配置（端点、模型；CLI/Desktop 共享）
  mcp.json              ← 用户级 MCP 服务器
  agents/               ← Agent 定义（*.json）
  sub-agents/           ← SubAgent 定义（*.json）
  skills/               ← 全局 Skill 目录
  tools/                ← 用户自定义工具（*.js / *.mjs）
  mcp-oauth/            ← MCP OAuth token 持久化

项目根/
  .mcp.json             ← 项目共享 MCP（可提交 git）
  .ai-zen/
    mcp.json            ← 项目个人 MCP（不提交）
    skills/             ← 项目 Skill 目录
    tools/              ← 项目工具目录
    sub-agents/         ← 项目 SubAgent
```

> 各端运行时数据（config.json 读写位置、conversations/、drafts/）由各端自行管理。

---

## 15. 仓储（EntityRepository / AgentRepository）

```typescript
class EntityRepository<T extends { id: string }> {
  constructor(dir: string);
  protected path(id: string): string;      // join(dir, `${id}.json`)
  async list(): Promise<T[]>;              // 跳过解析失败的文件
  async read(id: string): Promise<T | null>;
  async write(entity: T): Promise<void>;   // 自动建目录
  async delete(id: string): Promise<void>;
}

class AgentRepository extends EntityRepository<AgentDefinition> {
  constructor(agentsDir: string);
}
```

约定：每个实体一个 JSON 文件（`${id}.json`），目录不存在时自动创建，解析失败跳过。**各端可继承 `EntityRepository` 实现自己的会话/草稿存储**。

---

## 16. SdkAgent 与 AgentPlugin 机制

插件机制（`AgentPlugin` / `SendContext` / `HookResult` / `use` / `init` / `dispatchHook`）**在 core**。

### SdkAgent

```typescript
class SdkAgent extends Agent {
  readonly scope: Scope;                  // v0 中为 provider
  readonly definition: AgentDefinition;   // 含权限 permissions
}
```

构造参数：`{ scope, definition, client, model, modelConfig?, messages?, tools?, allowJsonParseError? }`。权限统一从 `definition.permissions` 读取。

### AgentPlugin 接口（类型来源 core）

```typescript
type HookResult = string | void | Promise<string | void>;

interface SendContext {
  agent: SdkAgent;
  content: string;
  messages: AgentNS.Message[];
}

interface AgentPlugin {
  onInit?(): Promise<void>;
  onBeforeSend?(ctx: SendContext): HookResult;
  onAfterSend?(ctx: SendContext): HookResult;
  onInnerLoopStart?(ctx: SendContext): HookResult;
  onInnerLoopEnd?(ctx: SendContext): HookResult;
  onInnerLoopsStart?(ctx: SendContext): HookResult;
  onInnerLoopsEnd?(ctx: SendContext): HookResult;
  onToolCall?(ctx: ToolCallContext): HookResult;
  onUnknownTool?(ctx: UnknownToolContext): HookResult;
  onSubAgentStart?(ctx: SubAgentContext): HookResult;
  onSubAgentEnd?(ctx: SubAgentContext): HookResult;
}
```

`send()` 流程：`onBeforeSend` → `super.send()`（内含内循环及其钩子）→ `onAfterSend`，返回 `this.messages`。

---

## 17. 内置 AgentPlugin

### AutoRefreshToolsPlugin

每次 `send()` 前重新扫描文件系统并按权限重建工具（v1 中经 `scope`）：

```typescript
class AutoRefreshToolsPlugin implements AgentPlugin {
  async onBeforeSend(ctx: SendContext): Promise<void> {
    const { agent } = ctx as { agent: SdkAgent };
    await agent.scope.refresh({ silent: true });
    agent.tools = agent.scope.buildTools(agent.definition, {
      exclude: { subagents: agent.definition.function?.name ? [agent.definition.function.name] : undefined },
    });
  }
}
```

### UnknownToolHintPlugin（v1 调整）

未知工具的 MCP 智能提示。由调用方显式注册。**v1 中改为经 `scope.getPluginById(McpScopePlugin.ID)` 获知 MCP 配置**（v0 中读 `provider.mcpPaths`）：

```typescript
class UnknownToolHintPlugin implements AgentPlugin {
  constructor(options: { scope: Scope });

  onUnknownTool(ctx): string | undefined {
    const toolName = ctx.toolCall.function?.name ?? "未知";
    const mcp = this.scope.getPluginById<McpScopePlugin>(McpScopePlugin.ID);
    const hasMcpConfig = mcp?.hasConfig() ?? false;
    const hasCallMcpTool = ctx.availableTools.some((t) => t.function.name === "call_mcp_tool");

    if (hasMcpConfig && !hasCallMcpTool) return `工具 "${toolName}" 不存在。当前有 MCP 服务器配置，但 call_mcp_tool 权限已被禁用，如需使用 MCP 工具请调整权限。`;
    if (hasMcpConfig && hasCallMcpTool) return `工具 "${toolName}" 不存在。如果要调用 MCP 工具，请使用 call_mcp_tool。`;
    return `工具 "${toolName}" 不存在。`;
  }
}
```

### AutoMigratePlugin

只负责「何时触发」，迁移逻辑委托给注入的 `TaskMigrationService`。

```typescript
interface AutoMigrateOptions {
  service: TaskMigrationService;
  maxTokens: number;
}
```

`onAfterSend`：读 `agent.lastUsage?.prompt_tokens` → 超 `maxTokens` 则 `service.migrate({ agent, promptTokens, maxTokens })`。

### ContextGuardPlugin

上下文**安全护栏**，与迁移插件职责分离（迁移管"正常超限"，护栏管"严重超限"）。

```typescript
interface ContextGuardOptions {
  maxTokens: number;
  ratio?: number;          // 默认 1.5
}
```

`onInnerLoopStart`：`promptTokens > maxTokens × ratio` → 抛 `ContextOverflowError`。

**推荐配合**：

```typescript
agent.use(new ContextGuardPlugin({ maxTokens }));                      // >maxTokens×1.5 → 中断报错
agent.use(new AutoMigratePlugin({
  service: new TaskMigrationService({ onMigrated }),
  maxTokens,
}));                                                                   // [maxTokens, maxTokens×1.5] → 交接迁移
```

---

## 18. 任务迁移（TaskMigrationService）

迁移服务是**实例化服务**，职责是「怎么迁移」。它**不持有**任何模型调用：`migrate()` 直接复用传入 `agent` 的 `client` / `model` / `modelConfig` 生成交接文档，**无需 Scope、无需独立迁移 Agent**。

> **策略开关（`strategy`）**：
> - **`omit`（默认）**：迁移后不删除历史消息，而是标记 `omit: true`，并追加「对话断点」消息作为新上下文起点。
> - **`prune`**：物理剔除历史，只保留 `definition.messages` + 断点消息。

```typescript
type MigrationStrategy = "omit" | "prune";

interface TaskMigrationServiceOptions {
  strategy?: MigrationStrategy;
  onBeforeMigrate?: (ctx: MigrationContext) => void | Promise<void>;
  onMigrated?: (ctx: MigrationContext) => void | Promise<void>;
  logger?: Logger;
}

interface MigrationContext {
  agent: SdkAgent;
  model: string;
  promptTokens?: number;
  maxTokens?: number;
  historyText: string;
  messageCountBefore: number;
  handoffDoc?: string;
}

class TaskMigrationService {
  static readonly HANDOFF_SECTIONS: { breakpoint, completed, pending, memory, files, instructions };
  static createPrompt(): string;
  static createPostMessages(handoffDoc: string): AgentNS.Message[];
  static serializeMessages(messages: AgentNS.Message[]): string;
  constructor(options?: TaskMigrationServiceOptions);
  async migrate(params: { agent: SdkAgent; promptTokens?; maxTokens?; strategy? }): Promise<MigrationContext>;
}
```

交接文档固定章节：`## 💬 对话断点` / `## ✅ 已完成的任务` / `## 📋 未完成的任务` / `## 🧠 重要记忆` / `## 📁 文件索引` / `## 🔔 接手指令`。

### 上下文计量

不估算、不学习。**只在 API 响应后，用 `usage.prompt_tokens` 做迁移判断**。`Model.maxContextTokens` 设为模型窗口约 25%，留足 response 空间。

---

## 19. 会话与草稿：边界说明

SDK 不维护 Conversation / Draft 概念，只保留 `AgentNS.Message`。各端自行持久化，可复用 `EntityRepository`：

- 消息状态始终由 `agent.messages` 唯一持有，`send()` 返回后整体取回即可落盘
- 迁移触发时在 `onBeforeMigrate` 回调中保存完整旧历史
- 草稿自动保存属于各端产品逻辑，SDK 不内置

---

## 20. 与 Core 的边界

| 能力 | Core（@ai-zen/agents-core） | SDK（@ai-zen/agents-sdk） |
|------|------------------------------|---------------------------|
| Agent / Message / Tool | ✅ Agent、Message、Tool、CallbackTool、AgentToolLazy | ❌ 不重复实现 |
| 模型 / 端点 | ❌ | ✅ `createModel(scope, modelId)` |
| 权限模型 | ❌ | ✅ AgentPermissions + PermissionEvaluator |
| 能力发现 | ❌ | ✅ discovery（builtin / user / skill / mcp / subagent） |
| 能力编排 | ❌ | ✅ **Scope + ScopePlugin（v1）** |
| MCP 连接 | ❌ | ✅ McpConnectionManager（基于官方 sdk） |
| 配置 / 默认值 | ❌ | ✅ ConfigManager + constants |
| 实体持久化 | ❌ | ✅ EntityRepository |
| 插件 | ✅ AgentPlugin / HookResult / use / init / dispatchHook | ✅ 5 个 ScopePlugin + 内置 AgentPlugin |
| 工作目录 | ❌（工具无 cwd 概念） | ✅ Scope.cwd → ToolEnv.cwd |

---

## 21. 消费模式（完整示例）

```typescript
import {
  Scope, allInOne, createAgent, ConfigManager,
  AutoMigratePlugin, AutoRefreshToolsPlugin, UnknownToolHintPlugin, TaskMigrationService,
} from "@ai-zen/agents-sdk";

// 1. 初始化配置（幂等，已有文件不覆盖）
const mgr = new ConfigManager("~/.ai-zen/config.json");
const { config } = await mgr.bootstrap();

// 2. 创建 Scope（每个工作目录一个实例），显式装配插件
const scope = new Scope({
  config,
  cwd: "/path/to/workspace-a",
  agentsDir: "~/.ai-zen/agents",
})
  .use(...allInOne({
    skillsPaths: ["~/.ai-zen/skills"],
    toolsPaths: ["~/.ai-zen/tools"],
    subAgentsPaths: ["~/.ai-zen/sub-agents"],
    mcpPaths: ["~/.ai-zen/mcp.json"],
  }))
  .use(new UnknownToolHintPlugin({ scope }));
await scope.init();

// 3. 创建 Agent 并注册 AgentPlugin
const agent = await createAgent(scope, config.defaultAgent ?? "default");
agent.use(new AutoMigratePlugin({
  service: new TaskMigrationService({
    onBeforeMigrate: (mctx) => saveConversation(convId, mctx.agent.messages),
  }),
  maxTokens: 250_000,
}));
agent.use(new AutoRefreshToolsPlugin());
await agent.init();

// 4. 对话
const messages = await agent.send("你好");
saveConversation(convId, messages);

// 5. 释放
await scope.dispose();

// 6. 多会话并行：另一个工作目录的独立 Scope
const scopeB = new Scope({ config, cwd: "/path/to/workspace-b", agentsDir: "~/.ai-zen/agents" })
  .use(...allInOne({ /* paths */ }));
await scopeB.init();
const agentB = await createAgent(scopeB, "default");
await agentB.send("……");
```

---

## 22. 设计决策汇总

1. **Scope 是唯一入口**：各层通过 `scope` 引用获取全局服务
2. **能力插件化（v1 核心）**：四类能力来源疏散为 5 个 `ScopePlugin`，一来源一插件
3. **插件全自持**：插件的发现状态、候选、实例化、释放都在插件内；`Scope` 只编排
4. **显式装配**：`Scope` 不装默认插件，调用方经 `.use()` 注入；`allInOne()` 仅供便利
5. **路径随插件**：能力来源路径由插件持有（可基于 `scope.cwd` join）；`Scope` 只留 `config/cwd/agentsDir`
6. **`use()` 必须在 `init()` 前**：`init()` 之后再 `use()` 抛错
7. **`getPluginById` + `dispose`**：对外暴露插件查询；`dispose()` 与 `init()` 对称
8. **渐进式披露原样保留**：`load_skill` / `load_mcp` 等元工具设计零改动，仅平移归位
9. **工具类化 + 环境注入**：内置工具都是 `SdkCallbackTool` 子类，`ToolEnv` 构造注入
10. **cwd 下沉到 Scope**：多会话并行靠 `ToolEnv.cwd` 而非进程级 chdir
11. **权限即披露**：deny 掉的项对 LLM 完全不可见
12. **权限不继承**：SubAgent 各自独立判断（Skill 子 Agent 沿用调用者工具集是有意例外）
13. **显式声明，无默认**：权限必须显式声明，不声明 = 全关
14. **安全预过滤**：递归/反向调用保护在权限判断前剔除
15. **MCP 无 tool 级权限**：server 级信任，连接后其工具全可用
16. **枚举披露**：skill/mcp 编译为 `load_*` 参数枚举
17. **惰性加载**：MCP / Skill 通过加载器工具按需触发
18. **会话/草稿下放**：SDK 只保留 Message 数据结构
19. **全异步 IO**：生产代码无同步文件操作
20. **apiKey 明文存储**：文件权限 600 由用户保证

---

## 23. 迁移指南（v0 → v1）

### 改名映射

| v0 | v1 |
|----|----|
| `class Provider`（`runtime/Provider.ts`） | `class Scope`（`scope/Scope.ts`） |
| `new Provider({ config, cwd, agentsDir, subAgentsPaths, skillsPaths, toolsPaths, mcpPaths })` | `new Scope({ config, cwd, agentsDir })` + `.use(...allInOne({ skillsPaths, toolsPaths, subAgentsPaths, mcpPaths }))` |
| `Provider.create(options)` | **暂不提供**（用 `new Scope()` + `.use()` + `await scope.init()`） |
| `provider`（字段/参数/变量） | `scope` |
| `SdkAgent.provider` | `SdkAgent.scope` |
| `createAgent(provider, …)` | `createAgent(scope, …)` |
| `createModel(provider, …)` | `createModel(scope, …)` |
| `provider.mcpManager` | `scope.getPluginById(McpScopePlugin.ID)`（MCP 插件私有） |
| `provider.mcpPaths` | 由 `McpScopePlugin` 持有；外部经 `scope.getPluginById(...).hasConfig()` |
| `provider.builtinTools / userTools / skills / mcps / subagents` | **不再暴露**；如需读取改为经对应插件查询 |
| `provider.refresh() / filter() / instantiate() / buildTools()` | `scope.*`（同名同义） |

### 破坏性变更

- `Provider` 符号**删除**（不留别名）
- `Scope` 构造不再接收能力来源路径
- `Scope` 不再暴露聚合候选集
- 插件必须**显式装配**（`Scope` 不装默认）
- `SdkAgent` / `createAgent` / `createModel` / `subAgentTools` 的 `provider` 参数改名 `scope`

### 版本

`0.12.0 → 1.0.0-alpha.0`（破坏性重构，转正为 1.0 预发布）。
