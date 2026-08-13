# SDK 设计文档（v0.5.0）

> 本文档是 `@ai-zen/agents-sdk` 的**唯一设计真相源**，与当前实现逐项对齐。
> 任何代码改动若与此文档不符，需先更新文档；文档描述以当前 `src/` 实现为准。

## 1. 定位与边界

`@ai-zen/agents-sdk` 是建立在 `@ai-zen/agents-core` 之上的**引擎层**，为 CLI / Desktop 提供统一的 Agent 运行时：

- 持有**能力管线**：发现 → 权限过滤 → 实例化（内置工具、用户工具、Skill、MCP、SubAgent）
- 提供 **Provider 全局上下文**：配置、路径、工作目录、模型工厂、MCP 连接管理
- 提供 **Agent 组装**：`createAgent()` 一键产出可用的 `SdkAgent`
- 提供 **插件机制**：`AutoMigratePlugin` / `AutoRefreshToolsPlugin` 扩展 Agent 行为

**SDK 不管的事**（下放给各端）：
- 会话（Conversation）/ 草稿（Draft）的持久化 —— 各端自建存储，可复用 `EntityRepository`
- 端侧 UI、交互、输入框状态
- 进程生命周期、窗口管理

**边界图**：

```
CLI ──┐
      ├── @ai-zen/agents-sdk ──┬── @ai-zen/agents-core（Agent / Message / Tool / Model / Endpoint）
Desktop ──┘                   │
                          LLM API / MCP 服务器
```

依赖方向（SDK 内部）：

```
plugin ──> runtime ──> capabilities ──> crud ──> config ──> types
  │           │
  │           └──> shared
  │
  └──> @ai-zen/agents-core
```

上层依赖下层，反之不行。同层模块不互相依赖。

## 2. 核心实体

```
Endpoint ──1:N──> Model ──> Agent
                       │
                       └──> Tool（Agent 创建时绑定）
                              ├── 内置工具（BUILTIN_TOOL_CLASSES，按 Provider 实例化）
                              ├── 用户工具（tools/*.js）
                              ├── MCP 工具（mcp.json 发现）
                              ├── Skill 工具（SKILL.md 发现）
                              └── SubAgent（子 Agent 注册为工具）
```

| 实体 | 说明 | 存储 |
|------|------|------|
| **Endpoint** | API 端点，含 baseUrl + apiKey | `config.json` |
| **Model** | 模型配置，绑定一个 Endpoint + 默认参数 + maxContextTokens | `config.json` |
| **ImageModel** | 图片生成模型配置，绑定一个 Endpoint | `config.json` |
| **Agent** | 可对话的 AI 人格，含提示词、权限、可选工具签名 | `agents/*.json` |
| **SubAgent** | 特殊 Agent：有 `function` 字段，可被其他 Agent 作为工具调用 | `sub-agents/*.json` |
| **ToolEnv** | 工具环境 `{ cwd, config }`，Provider 实例化内置工具时注入 | 内存态，不落盘 |
| **SdkCallbackTool** | 内置工具抽象基类：`env` 构造注入 + 子类 `call()` + `resolve()` | 内存态，不落盘 |

> 会话（Conversation）与草稿（Draft）**不属于 SDK**：SDK 只保留 `AgentNS.Message` 作为驱动接口数据结构，各端自行持久化。

## 3. 核心类型（types/index.ts）

### AppConfig

```typescript
interface AppConfig {
  defaultModel?: string;        // 默认模型 id
  endpoints: Endpoint[];
  models: Model[];
  imageModels?: ImageModel[];   // 图片生成模型列表
  defaultImageModel?: string;   // 默认图片生成模型 ID
  defaultAgent?: string;        // 默认 Agent ID
  defaultMigrationModel?: string; // 默认迁移模型 ID
}

interface Endpoint {
  id: string; baseUrl: string; apiKey: string;
  name: string; description?: string;
}

interface Model {
  id: string; name: string; endpointId: string;
  modelName?: string;            // 发送给 API 的模型名（不填用 id）
  maxContextTokens: number;      // 上下文窗口 token 上限
  maxContextChars?: number;      // 旧版字符数阈值（兼容迁移）
  defaultParams?: Record<string, unknown>;
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
}
```

消息统一使用 Core 的 `AgentNS.Message`（`role` 为 `AgentNS.Role` 枚举，`content` 支持多模态）。**SDK 不定义自己的消息类型**。

### ToolEnv（工具环境）

```typescript
interface ToolEnv {
  /** 当前工作目录 — 相对路径解析的基准（每个 Provider 一个） */
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
- `tools` 按工具名称匹配（如 `"rm"`、`"readFile"`）
- `skills` 按 skill id 匹配（如 `"my-skill"`）
- `mcps` 按 server 名匹配（如 `"github"`、`"postgres"`）
- `subagents` 按 `function.name` 匹配（如 `"sub_agent_default"`）

### 权限即披露

权限不仅控制「能不能用」，也控制「能不能看见」。deny 掉的工具/skill/mcp/subagent 对 LLM 完全不可见（不出现在工具列表和 `load_skill`/`load_mcp` 的参数枚举中），避免「知道但不能用」引发的困惑和无效调用。

### 隔离

每个 Agent 的权限完全独立，不继承、不传递。A 调用 SubAgent B 时，B 用自己的权限（包括披露范围）。例外：`call_skill_sub_agent` 创建的临时 Skill 子 Agent 继承父 Agent 的 `permissions`（它是临时对话分身而非独立实体）——这是有意的、文档化的不对称。

### PermissionEvaluator

```typescript
class PermissionEvaluator {
  constructor(permissions?: AgentPermissions);
  filter(candidates: CandidateSets): CandidateSets;   // 四维过滤
  isAllowed(name: string, dimension: keyof CandidateSets): boolean;
  static match(name: string, policy: PermissionPolicy): boolean;
}
```

## 5. 模块分层

```
types        ← 纯类型，零业务依赖（含 ToolEnv、权限、MCP 类型）
config       ← ConfigManager + constants：读写 config.json + 目录初始化 + 出厂默认
crud         ← 能力实体 CRUD（AgentRepository；通用 EntityRepository 在 shared）
capabilities ← 能力：discovery（发现）+ implements（实现）+ PermissionEvaluator + disclosure
runtime      ← Provider + 模型工厂 + Agent 组装 + MCP 连接管理 + 任务迁移 + SdkCallbackTool
plugin       ← 插件（autoMigrate、autoRefreshTools），扩展 SdkAgent 行为
shared       ← EntityRepository、SdkError、Logger
```

### 目录结构（src/）

```
types/index.ts                ← 纯类型
config/
  ConfigManager.ts            ← config.json 读写 + 目录 + 默认实体（bootstrap）
  constants.ts                ← DEFAULT_APP_CONFIG / DEFAULT_AGENT / DEFAULT_SUBAGENT / CONFIG_SUB_DIRS
crud/
  AgentRepository.ts          ← Agent 定义仓储（继承 EntityRepository）
capabilities/
  PermissionEvaluator.ts      ← 权限匹配 + 四维度过滤
  disclosure.ts               ← createDisclosureParam（load_skill/load_mcp 参数枚举）
  discovery/
    builtin.ts                ← discoverBuiltinTools(env) → Tool[]
    subagents.ts              ← discoverSubAgents(paths) → AgentDefinition[]
    skills.ts                 ← discoverSkills / readSkill / parseFrontmatter / validateSkill
    usertools.ts              ← discoverUserTools(paths) → Tool[]
    mcp.ts                    ← discoverMcpServers(paths) → McpServerConfig[]
  implements/
    builtin/                  ← 17 个工具类 + GenerateImageTool + BUILTIN_TOOL_CLASSES + test-helpers
    skillTools.ts             ← createLoadSkillTool / createCallSkillSubAgentTool
    mcpTools.ts               ← createLoadMcpTool / createCallMcpTool / createReadMcpResourceTool
    subAgentTools.ts          ← createSubAgentTool
runtime/
  Provider.ts                 ← 全局上下文 + 能力管线（filter/instantiate/buildTools/refresh）
  createModel.ts              ← createModel(provider, modelId) → ChatCompletionModel
  createAgent.ts              ← createAgent(provider, agentId) → SdkAgent
  SdkAgent.ts                 ← SdkAgent + AgentPlugin + SendContext
  SdkCallbackTool.ts          ← 内置工具抽象基类
  McpConnectionManager.ts     ← MCP 连接生命周期
  TaskMigrationService.ts     ← 任务迁移（shouldMigrate / 交接文档）
plugin/
  AutoMigratePlugin.ts        ← 上下文超限自动迁移
  AutoRefreshToolsPlugin.ts   ← send 前刷新工具列表
shared/
  EntityRepository.ts         ← 通用 JSON 仓储
  errors.ts                   ← SdkError
  logger.ts                   ← getLogger / setLogger
```

## 6. Provider — 全局上下文 + 能力管线

`Provider` 是 SDK 的**唯一入口对象**。各层不接收散装参数，而是持有 `provider` 引用获取所需。

### 创建

```typescript
const provider = new Provider({
  config,               // AppConfig
  agentsDir,            // Agent 定义目录
  subAgentsPaths?: string[],  // SubAgent 搜索路径
  skillsPaths?: string[],     // Skill 搜索路径
  toolsPaths?: string[],      // 用户工具搜索路径
  mcpPaths?: string[],        // MCP 配置路径（有配置时内部创建 mcpManager）
  cwd?: string,               // 当前工作目录，默认 process.cwd()
});

// 或一步构造 + 全局能力发现
const provider = await Provider.create(options);
```

### 关键字段

```typescript
class Provider {
  readonly config: AppConfig;
  /** 当前工作目录 — 相对路径解析基准，也是 ToolEnv.cwd 的来源 */
  readonly cwd: string;
  /** 工具环境 — 实例化内置工具时注入 */
  readonly env: ToolEnv;
  readonly agentsDir: string;
  readonly subAgentsPaths: string[];
  readonly skillsPaths: string[];
  readonly toolsPaths: string[];
  readonly mcpPaths: string[];
  readonly mcpManager: McpConnectionManager | undefined;

  // 全局候选集（refresh 时重新发现）
  builtinTools: Tool[];
  userTools: Tool[];
  subagents: AgentDefinition[];
  skills: SkillInfo[];
  mcps: McpServerConfig[];
}
```

> **不可变原则**：Provider 实例创建后路径、配置不变；`refresh()` 只重新发现能力，不重建 Provider。

### 能力管线方法

```typescript
class Provider {
  /** 重新执行全局发现（重新扫描文件系统） */
  async refresh(options?: { silent?: boolean }): Promise<void>;

  /** 阶段 2：按权限 + 排除黑名单过滤，返回名称列表 */
  filter(permissions: AgentPermissions, options?: {
    exclude?: ExcludeOptions;   // 四维黑名单，优先级高于 permissions
  }): FilterOutput;

  /** 阶段 3：将过滤后的名称映射为 Tool 实例 */
  instantiate(filtered: FilterOutput): Tool[];

  /** 快捷：filter + instantiate 一步完成 */
  buildTools(permissions: AgentPermissions, options?: {
    exclude?: ExcludeOptions;
  }): Tool[];
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
  tools?: string[];       // 排除的工具名称（内置 + 用户 + 动态工具）
  skills?: string[];      // 排除的 skill id
  mcps?: string[];        // 排除的 MCP server 名
  subagents?: string[];   // 排除的 agent/function 名称
}
```

`ExcludeOptions` 是优先级高于 permissions 的安全黑名单，用途：
- SubAgent 递归保护：`{ exclude: { subagents: [自身 function.name] } }`
- Skill 自调用保护：`{ exclude: { skills: [自身 skillId] } }`

### 多会话并行（核心能力）

每个 Provider 可绑定不同 `cwd`（对应一个工作目录）。内置工具以 `ToolEnv.cwd` 为相对路径基准，**不再依赖全局 `process.cwd()`**。CLI/Desktop 可同时持有多个 Provider 服务不同工作目录的会话，互不干扰。

```
Desktop（workspaces.json）
   │ 每 workspace 一个 Provider（1:1，运行时映射）
   ▼
Provider(cwd) ──ToolEnv──▶ 工具实例（cwd/config 注入）
   │
   ▼
createAgent(provider, agentId, { messages }) → SdkAgent（并行 send）
```

## 7. 内置工具 — 类化 + ToolEnv 注入

### SdkCallbackTool 抽象基类（runtime/SdkCallbackTool.ts）

```typescript
abstract class SdkCallbackTool extends Tool {
  /** 注入的工具环境 */
  readonly env: ToolEnv;

  constructor(options: { function: AgentNS.FunctionDefine; env: ToolEnv });

  /** 工具核心逻辑（子类实现，参数为 parsed_args） */
  abstract call(input: unknown): unknown | Promise<unknown>;

  /** 桥接 core 的 Tool.exec：解析参数 → call → 序列化 */
  async exec(ctx: ToolCallContext): Promise<string>;

  /** 将相对路径解析到 env.cwd，绝对路径原样返回 */
  resolve(p: string): string;
}
```

设计原则：
- 一个工具一个类，文件名 = 类名（PascalCase）
- 环境（`cwd`、`config`）**构造注入**，不依赖全局 `process.cwd()`，也不反查 Agent 上下文
- 相对路径统一用 `resolve()` 解析到 `env.cwd`
- `exec()` 保证返回 string：字符串原样，非字符串 JSON 序列化，`undefined` 归一为空串

### BUILTIN_TOOL_CLASSES 注册表（capabilities/implements/builtin/index.ts）

```typescript
export const BUILTIN_TOOL_CLASSES: Array<new (env: ToolEnv) => SdkCallbackTool> = [
  CwdTool, ReadFileTool, WriteFileTool, ExecTool, MkdirTool, RmTool,
  GlobTool, LsTool, ExistTool, FindTextTool, DownloadFileTool,
  RenameTool, CopyTool, BatchEditTool, EditTool, ExecAsyncTool, SleepTool,
];
```

17 个无条件注册的工具类：

| 工具 | 说明 |
|------|------|
| `cwd` | 获取当前工作目录（`env.cwd`） |
| `readFile` | 读取文件（>300KB 拒绝） |
| `writeFile` | 写入文件（自动建父目录） |
| `exec` | 执行命令（`timeout` 必填，超时被终止时返回 `terminated: "timeout"` 明确告知 agent；`cwd` 为 `env.cwd`） |
| `exec_async` | 异步执行命令，启动后立即返回；全平台经 shell 解析，支持重定向（`>` / `>>`）、管道（`|`）等 shell 语法 |
| `mkdir` | 创建目录（`recursive`） |
| `rm` | 删除文件或目录 |
| `glob` | glob 模式扫描（`path` 参数 resolve 到 `env.cwd`） |
| `ls` | 列出目录内容 |
| `exist` | 检查文件或目录是否存在 |
| `findText` | 在文件中搜索文本或正则 |
| `downloadFile` | 从 URL 下载文件并保存 |
| `rename` | 重命名或移动文件/目录 |
| `copy` | 复制文件或目录 |
| `batchEdit` | 批量替换文件文本 |
| `edit` | 单次替换文件文本 |
| `sleep` | 等待指定毫秒数 |

### GenerateImageTool — 条件注册

`GenerateImageTool` 同样继承 `SdkCallbackTool`、构造签名 `(env: ToolEnv)`，但它**依赖图片模型配置**（`config.defaultImageModel`），因此**不进入 `BUILTIN_TOOL_CLASSES` 静态注册表**，由 `discoverBuiltinTools` 按条件实例化：

```typescript
// capabilities/discovery/builtin.ts
export function discoverBuiltinTools(env: ToolEnv): Tool[] {
  const tools: Tool[] = BUILTIN_TOOL_CLASSES.map((Cls) => new Cls(env));
  if (env.config.defaultImageModel) {
    // 未配置图片模型时不暴露 generateImage
    tools.push(new GenerateImageTool(env));
  }
  return tools;
}
```

未配置图片模型时调用 `GenerateImageTool` 会返回友好错误（"未配置图片生成模型"）。

## 8. 工具装配流程

装配三阶段：**发现** → **过滤** → **实例化**，全部由 `Provider` 管理。

### 阶段 1 — 发现（refresh）

| 来源 | 发现函数 | 返回类型 |
|------|----------|----------|
| 内置工具 | `discoverBuiltinTools(env: ToolEnv)` | `Tool[]`（17 类 + 条件 GenerateImageTool） |
| 用户工具 | `discoverUserTools(paths, { silent? })` | `Tool[]`（扫描 `tools/*.js`、`*.mjs`，动态 import） |
| SubAgent | `discoverSubAgents(paths)` | `AgentDefinition[]`（仅含 function 的定义） |
| Skill | `discoverSkills(paths, { silent? })` | `SkillInfo[]`（含 subAgent 标记等完整信息） |
| MCP Server | `discoverMcpServers(paths)` | `McpServerConfig[]`（完整服务器配置） |

发现结果全局共享，SubAgent 和 Skill 子 Agent 复用同一份候选集。

### 阶段 2 — 过滤（Provider.filter）

```
filter(permissions, { exclude })
  │
  ├── 1. 安全预过滤
  │     └── 从 SubAgent 候选集中剔除 exclude.subagents 中的名称
  │
  ├── 2. 拼装所有候选名称
  │     ├── 内置工具名 + 用户工具名 + 动态工具名（load_skill / call_skill_sub_agent / load_mcp / call_mcp_tool / read_mcp_resource）
  │     └── 从 tools 候选名中剔除 exclude.tools
  │
  ├── 3. 四维度权限过滤（PermissionEvaluator）
  │     ├── tools / subagents / skills / mcps
  │
  └── 产出 FilterOutput { tools, subagents, skills, mcps }
```

### 阶段 3 — 实例化（Provider.instantiate）

```
instantiate(filtered)
  │
  ├── 1. 内置 + 用户工具：名称匹配 → 直接入 result
  │
  ├── 2. 动态工具（按条件注册）
  │     ├── load_skill            ← tools 允许 + skills 非空
  │     ├── call_skill_sub_agent  ← tools 允许 + 至少一个 subAgent skill
  │     ├── load_mcp              ← tools 允许 + mcps 非空 + mcpManager 就绪
  │     ├── call_mcp_tool         ← tools 允许 + mcpManager 就绪
  │     └── read_mcp_resource     ← tools 允许 + mcpManager 就绪
  │
  ├── 3. SubAgent → createSubAgentTool(def, provider)（AgentToolLazy 延迟构建）
  │
  └── 4. 去重（后注册覆盖先注册：用户工具可覆盖内置同名工具）
```

### 枚举披露（disclosure.ts）

Skill 和 MCP server 编译为 `load_skill` / `load_mcp` 的参数枚举：

```typescript
function createDisclosureParam(
  ids: string[],          // 候选 id
  baseDescription: string,
  emptyHint: string,      // 无候选时追加的提示
): DisclosureParam;       // { type: "string", description, enum? }
```

有候选项 → 生成 `enum`；无候选项 → 退化为自由文本并在描述中追加提示（"当前没有可用的 Skill/MCP，请联系用户添加"）。`tools` 维度可以控制这两个工具是否注册，拒绝即切断整个披露通道。

## 9. 动态工具

MCP 和 Skill 采用**惰性加载**：装配时不直接注册具体工具，而是注册「加载器工具」，由 LLM 在运行时按需触发。

### load_skill

- 参数：`skill_id`（枚举 = 所有允许的 skill，附各 skill 描述）
- 返回：SKILL.md 完整正文 + 目录路径 + 目录文件列表
- 权限：skill 枚举已按 `permissions.skills` 裁剪

### call_skill_sub_agent

- 参数：`skill_id`（仅枚举 `subAgent: true` 的 skill）+ `task`
- 行为：以 skill 正文为 system prompt 创建临时 Agent，通过 `provider.buildTools()` 按父 Agent permissions 独立解析工具集（`exclude: { skills: [skillId] }` 防自调用）
- 不支持子 Agent 的 skill → 返回提示改用 `load_skill`

### load_mcp

- 参数：`server`（枚举 = 所有允许的 server，附各 server 描述）
- 返回：结构化 JSON `{ tools, resources }`（tools 含完整 `inputSchema`，resources 含 uri/name/description/mimeType）
- 已连接 → 直接返回当前清单（`touch` 续期）；未连接 → `mcpManager.connect()`；失败 → 错误信息
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
| `call_skill_sub_agent` | skills | — 每次独立执行 | 创建临时 Agent |
| `load_mcp` | mcps | ✅ 重复不重连 | 建立连接 |
| `call_mcp_tool` | mcps | — 取决于工具 | 取决于工具 |
| `read_mcp_resource` | mcps | ✅ 可重复读取 | 无 |

## 10. 能力发现细节

### 用户工具（usertools.ts）

- 扫描 `tools/*.js` / `*.mjs`，原生 `import()` 加载（`type: module` 下 .js 也是 ESM）
- 每次加载加时间戳 querystring 防止模块缓存，确保 `refresh()` 能重新加载
- 导出格式归一化：Tool 实例 / `{ function, exec }` / `{ function, callback }` → 统一为 Tool
- 按文件名排序保证确定性；同名工具靠前路径优先

### Skill（skills.ts）

- 目录结构：`<skillId>/SKILL.md`，id = 目录名
- 三段式：Scanner（扫描含 SKILL.md 的子目录）→ Parser（解析 YAML frontmatter）→ Loader（`readSkill` 返回完整正文）
- frontmatter 字段：`name`、`description`、`sub-agent`、`license`、`compatibility`、`metadata`、`allowed-tools`
- 校验为**警告不阻塞**：name 规范（小写字母/数字/连字符、与目录名一致、≤64）、description 非空 ≤1024、compatibility ≤500

### MCP（mcp.ts）

- 格式：`{ "mcpServers": { id: { type?, command?, args?, env?, url?, headers?, disabled?, description? } } }`
- `description`：服务器描述，经 `load_mcp` **透传呈现给 LLM 参考**（拼接进 `server` 参数枚举，对齐 `load_skill`；非连接必需，缺失时默认空白）
- transport 推断：`type`/`transport`/`transportType` 优先，否则有 `command` → stdio、有 `url` → http
- `disabled: true` 跳过；解析失败记日志并跳过

### SubAgent（subagents.ts）

- 扫描 `sub-agents/*.json`，仅保留含 `function` 字段的定义
- 同名 `function.name` 靠前路径优先

## 11. MCP 连接生命周期（McpConnectionManager）

基于官方 `@modelcontextprotocol/sdk` 的 `Client` + `Transport`：

- `stdio` → `StdioClientTransport`（子进程）
- `http` / `sse` → `StreamableHTTPClientTransport`

### 状态机

```
                     ┌──────────┐
          connect ──>│connecting│<────────┐
                     └────┬─────┘         │
                          │               │
              ┌─────失败──┴──成功──────┐  │
              ▼                       ▼  │
         ┌────────┐             ┌─────────┐
         │  error │────────────>│connected│
         └────────┘  (重试)     └────┬────┘
                                    │
                          ┌─空闲超时┼─主动 disconnect
                          ▼        ▼
                    断开并清理   断开并清理
```

### API

```typescript
class McpConnectionManager {
  getState(name): McpConnectionState;      // disconnected/connecting/connected/error
  getManifest(name): McpServerManifest | undefined;
  getClient(name): Client | undefined;
  async connect(name, config, options?): Promise<McpServerManifest>;
  async disconnect(name): Promise<void>;
  async disconnectAll(): Promise<void>;
  touch(name): void;                        // 活跃心跳，重置空闲计时
}

interface McpConnectOptions {
  idleTimeoutMs?: number;   // 默认 stdio: 30min, http/sse: 5min
  autoReconnect?: boolean;  // 失败自动重连
  maxRetries?: number;      // 默认 3
  isConfigError?: (err) => boolean;  // 配置错误不重试
}
```

### 关键行为

- **按需调用**：连接后仅对 Server 声明的 capabilities 调用 `listTools` / `listResources` / `listPrompts`，避免 Method not found
- **重连**：指数退避 1s→2s→4s→8s→16s→30s（封顶），配置类错误不重试
- **空闲超时**：每次操作 `touch()` 续期；计时器 `unref()` 不阻止进程退出
- **list_changed**：服务端推送变更 → 自动刷新本地注册表
- 测试注入：构造函数可传自定义 transport / client 工厂

## 12. ConfigManager 与出厂默认

### ConfigManager

```typescript
class ConfigManager {
  constructor(configPath: string);
  readonly configPath: string;
  readonly basePath: string;   // dirname(configPath)

  async read(): Promise<AppConfig>;                       // 无文件时返回出厂默认（不落盘）
  async write(config: AppConfig): Promise<void>;          // 原子写入（.tmp + rename）
  async ensureDirs(): Promise<void>;                      // basePath + CONFIG_SUB_DIRS
  async ensureDefaultConfig(): Promise<AppConfig>;        // 存在则读，否则写默认
  async ensureDefaultAgent(): Promise<AgentDefinition | null>;  // agents/ 为空才写默认
  async ensureDefaultSubAgent(): Promise<AgentDefinition | null>;
  async readMcpConfig(): Promise<{ mcpServers: Record<string, unknown> }>;   // 无文件返回空 mcpServers
  async writeMcpConfig(config: { mcpServers: Record<string, unknown> }): Promise<void>;  // 原子写入 mcp.json
  async ensureDefaultMcpConfig(): Promise<void>;  // mcp.json 不存在才写 DEFAULT_MCP_CONFIG
  async bootstrap(): Promise<{ config, agent, subAgent }>;      // 一键初始化
}
```

### 出厂默认（constants.ts）

| 常量 | 说明 |
|------|------|
| `DEFAULT_APP_CONFIG` | 预置端点（OpenAI / 智谱 / DeepSeek）+ 6 个模型 + 3 个图片模型 + 默认选项 |
| `DEFAULT_AGENT_ID` / `DEFAULT_AGENT_DEFINITION` | 默认 Agent（id=`default`，四维全开，六条行为原则） |
| `DEFAULT_SUBAGENT_ID` / `DEFAULT_SUBAGENT_DEFINITION` | 默认通用助手 SubAgent（id=`sub-agent-default`，`subagents: deny` 防递归） |
| `DEFAULT_MCP_CONFIG` | 出厂默认 MCP 服务器（socket-pty 终端），首启写入 `~/.ai-zen/mcp.json`，已存在则不覆盖 |
| `CONFIG_SUB_DIRS` | 标准共享子目录：`agents` / `sub-agents` / `skills` / `tools` / `mcp-oauth` |

设计决策：
- **SDK 持有出厂默认**：预置厂商/模型由 SDK 统一维护，各端不再重复定义
- **幂等安全**：所有 `ensure*` 对已存在文件不覆盖，用户配置永不丢失
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

> 各端运行时数据（config.json 的读写位置、conversations/、drafts/）由各端自行管理，不在 SDK 目录约定内。

## 13. 仓储（EntityRepository / AgentRepository）

```typescript
// shared/EntityRepository.ts — 通用 JSON 实体仓储
class EntityRepository<T extends { id: string }> {
  constructor(dir: string);
  protected path(id: string): string;      // join(dir, `${id}.json`)
  async list(): Promise<T[]>;              // 跳过解析失败的文件
  async read(id: string): Promise<T | null>;
  async write(entity: T): Promise<void>;   // 自动建目录
  async delete(id: string): Promise<void>;
}

// crud/AgentRepository.ts
class AgentRepository extends EntityRepository<AgentDefinition> {
  constructor(agentsDir: string);
}
```

约定：每个实体一个 JSON 文件（`${id}.json`），目录不存在时自动创建，解析失败跳过。**各端可继承 `EntityRepository` 实现自己的会话/草稿存储**（CLI 即如此）。

## 14. SdkAgent 与插件机制

Core `Agent` 保持纯粹，只管 `send()` / `run()`。插件能力由 SDK 的 `SdkAgent` 提供。

### SdkAgent

```typescript
class SdkAgent extends Agent {
  readonly provider: Provider;
  readonly definition: AgentDefinition;
  readonly permissions?: AgentPermissions;

  /** LLM 调用不存在工具时的智能提示（含 MCP 场景引导） */
  onUnknownTool: (ctx: UnknownToolContext) => string;

  use(plugin: AgentPlugin): void;
  async init(): Promise<void>;       // 执行插件 onInit
  async send(content: string): Promise<AgentNS.Message[]>;  // 前后执行插件钩子
}
```

构造参数：`{ provider, definition, model, model_config?, messages?, tools?, permissions?, rag?, allowJsonParseError? }`

### 插件接口

```typescript
interface SendContext {
  agent: SdkAgent;
  content: string;
  messages: AgentNS.Message[];   // 浅拷贝快照，仅供读取，不应直接修改
}

interface AgentPlugin {
  onInit?(): Promise<void>;
  onBeforeSend?(ctx: SendContext): Promise<void>;
  onAfterSend?(ctx: SendContext): Promise<void>;
  onInnerLoopStart?(ctx: SendContext): Promise<void>;   // 每轮内循环请求前（Core try 块外，抛错即中断对话）
  onInnerLoopEnd?(ctx: SendContext): Promise<void>;     // 每轮内循环请求+工具调用后
  onInnerLoopsStart?(ctx: SendContext): Promise<void>;  // 一次 send 整组内循环开始前
  onInnerLoopsEnd?(ctx: SendContext): Promise<void>;    // 一次 send 整组内循环结束后
  onToolCall?(ctx: ToolCallContext): string | undefined | Promise<string | undefined>;
  // 单个工具调用执行前拦截（对应 Core onToolCall，收同一个 ToolCallContext 实例）：
  // 返回字符串 = 拒绝该工具（不执行，原因作为工具结果回给 LLM，继续下一轮）；
  // 返回 undefined = 放行。多个插件按注册顺序调用，任一返回字符串即拒绝（短路）。
}
```

`send()` 流程：`onBeforeSend` → `super.send()`（内含内循环及其钩子）→ `onAfterSend`，返回 `this.messages`（整体取回自行落盘）。

### 内置插件：AutoRefreshToolsPlugin

每次 `send()` 前重新扫描文件系统并按权限重建工具：

```typescript
class AutoRefreshToolsPlugin implements AgentPlugin {
  async onBeforeSend(ctx: SendContext): Promise<void> {
    const { agent } = ctx;
    await agent.provider.refresh({ silent: true });
    agent.tools = agent.provider.buildTools(agent.permissions ?? {}, {
      exclude: { subagents: agent.definition.function?.name ? [agent.definition.function.name] : undefined },
    });
  }
}
```

### 内置插件：AutoMigratePlugin

```typescript
interface AutoMigrateOptions {
  maxTokens: number;
  migrationAgent: SdkAgent;
  onBeforeMigrate?: (promptTokens, maxTokens, agent: SdkAgent) => void;  // 迁移前，agent.messages 仍是完整旧历史
  onMigrated?: (handoffDoc: string, agent: SdkAgent) => void;            // 迁移后，交接文档已注入
}
```

`onAfterSend` 逻辑：

```
1. 读取 agent.lastUsage?.prompt_tokens
2. shouldMigrate(promptTokens, maxTokens)
3. 未超限 → 返回
4. 超限：
   a. onBeforeMigrate(promptTokens, maxTokens, agent)  // 可在此保存旧对话
   b. 将 agent.messages（完整历史）发给 migrationAgent → 交接文档 handoffDoc
   c. 仅替换 agent.messages（不重建 Agent，保留所有引用和插件绑定）：
      agent.messages = [...definition.messages, ...createPostMessages(handoffDoc)]
   d. onMigrated(handoffDoc, agent)
```

迁移失败 / 回调抛错 → 不影响流程，原消息不丢失（迁移前仍在 `agent.messages`）。

### 内置插件：ContextGuardPlugin

上下文**安全护栏**，与迁移插件职责分离：迁移处理「正常超限」，护栏处理「严重超限（可能读入超大文件）」。

```typescript
interface ContextGuardOptions {
  maxTokens: number;   // 与迁移插件同一告警阈值
  ratio?: number;      // 越界比例，默认 1.2（+20%）
}
```

`onInnerLoopStart` 逻辑（每次内循环**发请求前**检测，Core 里该钩子在 try 块外、`createStream` 前）：

```
1. 读取 agent.lastUsage?.prompt_tokens；为空（首轮请求前无数据）→ 跳过
2. promptTokens > maxTokens × ratio → 抛 ContextOverflowError（含 promptTokens/maxTokens/threshold/ratio）
3. 未超硬上限 → 继续（正常超限交由 AutoMigratePlugin 在范围内迁移）
```

**为何用 `onInnerLoopStart` 而非 `onAfterSend`/`onInnerLoopEnd`：**
- 它位于每次「请求前」，且不在 Core `run()` 的 try 块内，**抛错即跳出内循环、直接中断本次 `send()`**，无需改动 Core。
- 检测依据是上一轮 `usage.prompt_tokens`；首轮请求前无数据自动跳过（须先发出首轮拿到用量）。
- 超大文件在读入后、紧接着的下一轮请求前即被拦截，不再继续放大上下文。

**推荐配合**（同一 `maxTokens`，区间互补）：

```typescript
agent.use(new ContextGuardPlugin({ maxTokens }));      // >maxTokens×1.2 → 中断报错
agent.use(new AutoMigratePlugin({ maxTokens, migrationAgent }));  // [maxTokens, maxTokens×1.2] → 交接迁移
```


## 15. 任务迁移（TaskMigrationService）

```typescript
class TaskMigrationService {
  static readonly HANDOFF_SECTIONS: { breakpoint, completed, pending, memory, files, instructions };
  static shouldMigrate(promptTokens: number, maxTokens: number): boolean;  // promptTokens > maxTokens
  static createPrompt(): string;                    // 迁移 Agent system prompt
  static createAgentDefinition(options?): AgentDefinition;  // "task-migration" 专用迁移 Agent
  static createPostMessages(handoffDoc: string): AgentNS.Message[];
}
```

交接文档固定章节：

```markdown
## 💬 对话断点
## ✅ 已完成的任务
## 📋 未完成的任务
## 🧠 重要记忆
## 📁 文件索引
## 🔔 接手指令
```

### 上下文计量

不估算、不学习。**只在 API 响应后，用 `usage.prompt_tokens` 做迁移判断**（流式最后一个 chunk 返回，`stream_options: { include_usage: true }`）。`Model.maxContextTokens` 设为模型窗口约 25%，留足 response 空间。

## 16. 会话与草稿：边界说明

SDK 不维护 Conversation / Draft 概念，只保留 `AgentNS.Message`。各端（CLI/Desktop）自行持久化，可复用 `EntityRepository`：

- 消息状态始终由 `agent.messages` 唯一持有，`send()` 返回后整体取回即可落盘
- 迁移触发时在 `onBeforeMigrate` 回调中保存完整旧历史
- 草稿自动保存（断点恢复）属于各端产品逻辑，SDK 不内置

## 17. 消费模式（完整示例）

```typescript
import { Provider, createAgent, ConfigManager } from "@ai-zen/agents-sdk";

// 1. 初始化配置（幂等，已有文件不覆盖）
const mgr = new ConfigManager("~/.ai-zen/config.json");
const { config } = await mgr.bootstrap();

// 2. 创建 Provider（每个工作目录一个实例）
const provider = await Provider.create({
  config,
  cwd: "/path/to/workspace-a",
  agentsDir: "~/.ai-zen/agents",
  subAgentsPaths: ["~/.ai-zen/sub-agents"],
  skillsPaths: ["~/.ai-zen/skills"],
  toolsPaths: ["~/.ai-zen/tools"],
  mcpPaths: ["~/.ai-zen/mcp.json"],
});

// 3. 创建 Agent 并注册插件
const agent = await createAgent(provider, config.defaultAgent ?? "default");
agent.use(new AutoMigratePlugin({
  maxTokens: 250_000,
  migrationAgent: await createAgent(provider, "task-migration"),
  onBeforeMigrate: (promptTokens, maxTokens, agent) => {
    saveConversation(convId, agent.messages);   // 各端自行实现
  },
}));
agent.use(new AutoRefreshToolsPlugin());
await agent.init();

// 4. 对话（消息由 agent.messages 持有，返回后整体取回落盘）
const messages = await agent.send("你好");
saveConversation(convId, messages);

// 5. 多会话并行：另一个工作目录的独立 Provider
const providerB = await Provider.create({ config, cwd: "/path/to/workspace-b", ...paths });
const agentB = await createAgent(providerB, "default");
await agentB.send("……");   // 与 agent 并行，工具以各自 env.cwd 为基准
```

## 18. 与 Core 的边界

| 能力 | Core（@ai-zen/agents-core） | SDK（@ai-zen/agents-sdk） |
|------|------------------------------|---------------------------|
| Agent / Message / Tool | ✅ Agent、Message、Tool、CallbackTool、AgentToolLazy | ❌ 不重复实现 |
| 模型 / 端点 | ✅ ChatGPT、OpenAI、ZhipuImage 等 | ❌ 只做 `createModel(provider, modelId)` 装配 |
| 权限模型 | ❌ | ✅ AgentPermissions + PermissionEvaluator |
| 能力发现 | ❌ | ✅ builtin / user / skill / mcp / subagent |
| MCP 连接 | ❌ | ✅ McpConnectionManager（基于官方 sdk） |
| 配置 / 默认值 | ❌ | ✅ ConfigManager + constants |
| 实体持久化 | ❌ | ✅ EntityRepository（各端可复用） |
| 插件 | ❌（Agent 保持纯粹） | ✅ SdkAgent.use() + 内置插件 |
| 工作目录 | ❌（工具无 cwd 概念） | ✅ Provider.cwd → ToolEnv.cwd |

## 19. 设计决策汇总

1. **Provider 是唯一入口**：各层不接收散装参数，通过 provider 引用获取全局服务
2. **Capabilities 并入 Provider**：三阶段管线直接在 Provider 上，无独立 Capabilities 类
3. **工具类化 + 环境注入**：内置工具都是 `SdkCallbackTool` 子类，`ToolEnv` 构造注入，杜绝全局状态
4. **cwd 下沉到 Provider**：多会话并行靠 ToolEnv.cwd 而非进程级 chdir
5. **权限即披露**：deny 掉的项对 LLM 完全不可见
6. **权限不继承**：SubAgent 各自独立判断（Skill 子 Agent 临时分身继承是有意例外）
7. **显式声明，无默认**：权限必须显式声明，不声明 = 全关
8. **安全预过滤**：递归/反向调用保护在权限判断前剔除，不受用户配置影响
9. **MCP 无 tool 级权限**：server 级信任，连接后其工具全可用
10. **枚举披露**：skill/mcp 编译为 load_* 参数枚举
11. **惰性加载**：MCP / Skill 通过加载器工具按需触发，不预注册具体工具
12. **Agent 保持纯粹**：插件机制在 SdkAgent，Core 不感知
13. **会话/草稿下放**：SDK 只保留 Message 数据结构，各端自建存储
14. **全异步 IO**：生产代码无同步文件操作
15. **apiKey 明文存储**：文件权限 600 由用户保证，后续可考虑系统密钥链
