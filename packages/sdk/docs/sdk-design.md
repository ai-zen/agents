# SDK 设计文档

## 1. 核心实体

```
Endpoint ──1:N──> Model ──> Agent ──1:N──> Conversation
                       │
                       └──> Tool（Agent 创建时绑定）
                              ├── 内置工具（代码写死）
                              ├── 用户工具（tools/*.js）
                              ├── MCP 工具（mcp.json 发现）
                              ├── Skill 工具（SKILL.md 发现）
                              └── SubAgent（子 Agent 注册为工具）
```

| 实体 | 说明 | 存储 |
|------|------|------|
| **Endpoint** | API 端点，含 baseUrl + apiKey | `config.json` |
| **Model** | 模型配置，绑定一个 Endpoint + 默认参数 + maxContextTokens | `config.json` |
| **Agent** | 可对话的 AI 人格，含提示词、权限、可选工具签名 | `agents/*.json` |
| **SubAgent** | 特殊 Agent：有 `function` 字段，可被其他 Agent 作为工具调用 | `sub-agents/*.json` |
| **Conversation** | 用户与 Agent 的对话记录 | `conversations/*.json` |
| **Draft** | 当前会话的自动保存副本 | `drafts/<conversationId>.json`，未命名用 `drafts/_current.json` |

---

## 2. AgentDefinition 完整 Schema

```typescript
interface AgentDefinition {
  id: string;                    // 唯一标识，文件名 = id.json
  name: string;                  // 展示名称
  description?: string;          // 简短描述（列表展示用）
  messages: AgentNS.Message[];      // 预设对话（至少一条 system）
  modelId?: string;              // 指定模型，不填用默认
  permissions?: AgentPermissions;

  // 以下有则视为 SubAgent
  function?: {
    name: string;                // 工具注册名（英文标识）
    description: string;         // 工具描述（LLM 据此决定是否调用）
    parameters: {                // JSON Schema
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };

  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
  version?: number;
}

// 使用 Core 的 AgentNS.Message（role 为 AgentNS.Role 枚举，content 为 MessageContent）
```

### SubAgent 约定

- `messages` 最后一条 `user` 消息必须包含 `{{task}}`，调用时替换为传入的任务描述
- 如果没有 `function`，自动生成：`name` 由 id 转换，`parameters` 为 `{ task: string }`
- **subagents 维度建议 deny: ['*']**：SubAgent 一般不需要调用其他 SubAgent，建议将 `subagents` 设为 `deny: ['*']`。其他维度（tools/skills/mcps）与普通 Agent 一样按需配置即可
- **不能递归调用自己**：装配时从 SubAgent 候选集中预过滤掉自身 `function.name`
- **不能反向调用调用者**：装配时从 SubAgent 候选集中预过滤掉调用者的 `function.name`
- **普通 Agent 仅作对话入口**：没有 `function` 字段的普通 Agent 不会被注册为工具，只能由用户手动选择发起对话。只有 SubAgent（有 `function`）才能被其他 Agent 调用

---

## 3. 权限模型

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
3. **allow 与 deny 互斥**：每个维度只能配置 `allow` 或 `deny` 之一，同时配置两者为非法
4. **无命中 = 拒绝**：name 不在 allow 列表中 → 拒绝；name 在 deny 列表中 → 拒绝

典型配置：
- `allow: ["readFile", "exec"]` → 只有这两个可用（白名单）
- `deny: ["rm"]` → 除 rm 外全可用（黑名单）
- `allow: ["*"]` → 全开
- `deny: ["*"]` → 全关

### 匹配

- 通配符 `*` 匹配任意字符串
- `tools` 按工具名称匹配（如 `"rm"`、`"Bash(*)"`）
- `skills` 按 skill id 匹配（如 `"my-skill"`）
- `mcps` 按 server 名匹配（如 `"github"`、`"postgres"`）
- `subagents` 按 `function.name` 匹配（如 `"general_assistant"`、`"code-reviewer"`）

### 权限即披露

权限不仅控制「能不能用」，也控制「能不能看见」。deny 掉的工具/skill/mcp/subagent 对 LLM 完全不可见（不出现在工具列表和 `load_skill`/`load_mcp` 的参数枚举中）。LLM 只知道 allow 的东西，避免「知道但不能用」引发的困惑和无效调用。

### 隔离

每个 Agent 的权限完全独立，不继承、不传递。A 调用 SubAgent B 时，B 用自己的权限（包括披露范围）。

---

## 4. 模块分层

```
types        ← 纯类型，零业务依赖
config       ← 读写 config.json + 迁移 + 内存缓存 + 原子写入
crud         ← 实体 CRUD（Endpoints / Models / Agents / Conversations / Draft）
capabilities ← 能力：discovery（发现）+ implements（实现）+ 权限过滤管线
runtime      ← Provider 全局上下文 + 模型工厂 + Agent 组装 + MCP 连接管理 + 任务迁移
plugin       ← 插件（autoMigrate、autoDraft、autoRefreshTools），扩展 SdkAgent 行为
shared       ← 日志、错误
```

### 依赖方向

```
plugin ──> runtime ──> capabilities ──> crud ──> config ──> types
  │           │
  │           └──> shared
  │
  └──> @ai-zen/agents-core (Agent, Message)
```

上层依赖下层，反之不行。同层模块不互相依赖。

### Provider 全局上下文

`Provider` 是 SDK 的全局上下文实例，持有所有配置和外部依赖。各层不接收散装参数，而是通过 `Provider` 实例获取所需：

```typescript
class Provider {
  config: AppConfig;           // 应用配置（端点、模型等）
  agentsDir: string;           // Agent 定义目录
  subAgentsPaths: string[];    // SubAgent 搜索路径
  skillsPaths: string[];       // Skill 搜索路径
  toolsPaths: string[];        // 用户工具搜索路径
  mcpPaths: string[];          // MCP 配置搜索路径
  conversationsDir: string;    // 对话记录目录
  draftsDir: string;           // 草稿目录
  readonly mcpManager: McpConnectionManager;  // 内部创建，全局唯一
}
```

`McpConnectionManager` 是纯技术基础设施，由 `Provider` 内部创建并维护，外部无需感知其构造细节。外部只需通过 `mcpPaths` 指定 MCP 配置文件路径即可。

`Provider` 实例一旦创建不可变。各层（Capabilities、SdkAgent、Plugin 等）都持有 `provider` 引用。

### 模型工厂

模型构建是独立的 runtime 子层，不依赖 capabilities/ 或其他模块：

```
runtime/createModel.ts
  └── createModel(config, modelId) → ChatCompletionModel
```

调用方直接使用 `createModel(provider.config, modelId)`，`Capabilities` 不直接涉及模型构建。

### capabilities 内部结构

```
capabilities/
  Capabilities.ts           ← Capabilities 类：全局注册表，提供 filter + instantiate + buildTools
  PermissionEvaluator.ts    ← 权限匹配 + 四维度过滤
  disclosure.ts             ← 枚举披露
  discovery/                ← 阶段 1：扫描文件系统，找到候选
    builtin.ts              ← discoverBuiltinTools → Tool[]（条件注入 generateImage）
    subagents.ts            ← discoverSubAgents → AgentDefinition[]
    skills.ts               ← discoverSkills → SkillInfo[]（含 subAgent 标记等完整信息）
    mcp.ts                  ← discoverMcpServers → McpServerConfig[]（完整服务器配置）
    usertools.ts            ← discoverUserTools → Tool[]
  implements/               ← 阶段 3：工具实例（注册 = 实现）
    builtin/                ← BUILTIN_TOOLS: 16 个 Tool 实例（含 generateImage 工厂）
    mcpTools.ts             ← createLoadMcpTool / createCallMcpTool / createReadMcpResourceTool
    skillTools.ts           ← createLoadSkillTool / createCallSkillSubAgentTool
    subAgentTools.ts        ← createSubAgentTool(def, provider, caps)
```

`Capabilities` 类管理完整的三阶段管线：构造函数接收 `Provider` 实例（非散装参数），从中获取配置和路径执行全局发现（阶段 1），`filter()` 执行安全预过滤 + 权限过滤（阶段 2），`instantiate()` 执行名称到 Tool 实例的映射（阶段 3）。`buildTools()` 是 filter + instantiate 的快捷调用。

---

## 5. 文件布局

```
~/.ai-zen/
  config.json           ← 全局配置（端点、模型，CLI/Desktop 共享）
  mcp.json              ← 用户级 MCP 服务器
  agents/               ← Agent 定义（*.json）
  sub-agents/           ← SubAgent 定义（*.json）
  skills/               ← 全局 Skill 目录
  tools/                ← 用户自定义工具（*.js）
  mcp-oauth/            ← MCP OAuth token 持久化
  cli/                  ← CLI 运行时数据
    conversations/      ← 对话记录（*.json）
    drafts/             ← 当前会话自动保存

项目根/
  .mcp.json             ← 项目共享 MCP（可提交 git）
  .ai-zen/
    mcp.json            ← 项目个人 MCP（不提交）
    skills/             ← 项目 Skill 目录
    tools/              ← 项目工具目录
    sub-agents/         ← 项目 SubAgent
```

### mcp.json 配置格式

遵循业界标准，`mcp.json` 使用 `mcpServers` 作为顶层字段，每个 server 以 id 为键（可以是任意字符串，含中文等）：

```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-foo"],
      "env": {
        "API_KEY": "${API_KEY}"
      },
      "disabled": false
    }
  }
}
```

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mcpServers` | object | 顶层字段，key 为 server id，value 为 server 配置 |
| `command` | string | 启动命令（stdio 类型必填） |
| `args` | string[] | 命令参数 |
| `env` | object | 环境变量 |
| `url` | string | HTTP/SSE 服务器地址（http/sse 类型必填） |
| `type` | string | transport 类型：`"stdio"`、`"http"` 或 `"sse"`。不填则自动推断——有 `command` 则为 `stdio`，有 `url` 则为 `http`。同时兼容 `transportType` 字段（二者取一，`type` 优先） |
| `disabled` | boolean | 是否禁用，默认为 `false` |
| `headers` | object | HTTP 请求头（仅 http/sse） |
| `autoApprove` | string[] | 可自动批准的工具列表（当前未使用，预留） |
| `timeout` | number | 超时时间（毫秒）（当前未使用，预留） |

### MCP 配置合并

优先级从高到低：
1. 项目个人 `.ai-zen/mcp.json`（从 cwd 向上到 git root 沿途收集）
2. 项目共享 `.mcp.json`（同上）
3. 用户级 `~/.ai-zen/mcp.json`

同名 server 高优先级覆盖低优先级。

---

## 6. 工具装配流程

装配分为三个阶段：**发现**、**过滤**、**实例化**。全部由 `Capabilities` 类管理，最终产出 `SdkAgent`（含可直接注册的 `Tool[]`）。

### Capabilities 类

`Capabilities` 是全局能力注册表，构造函数接收 `Provider` 实例，从中获取配置和路径执行全局发现。之后 `filter()` 和 `instantiate()` 按需被不同 Agent 调用。

```typescript
class Capabilities {
  constructor(provider: Provider);  // 所有全局状态从 Provider 获取

  readonly provider: Provider;      // 持有 Provider 引用，各层可访问

  // 阶段 2：按权限 + 排除黑名单过滤，返回名称列表
  filter(permissions: AgentPermissions, options?: {
    exclude?: ExcludeOptions;   // 四维黑名单，优先级高于 permissions
  }): FilterOutput;

  // 阶段 3：将过滤后的名称映射为 Tool 实例
  instantiate(filtered: FilterOutput): Tool[];

  // 快捷：filter + instantiate 一步完成
  buildTools(permissions: AgentPermissions, options?: {
    exclude?: ExcludeOptions;
  }): Tool[];

  // 重新执行全局发现（重新扫描文件系统）
  refresh(): void;
}
```

### ExcludeOptions — 排除黑名单

与 `AgentPermissions` 四维对称，作为优先级高于 permissions 的安全黑名单：

```typescript
interface ExcludeOptions {
  tools?: string[];       // 排除的工具名称（内置 + 用户 + 动态工具）
  skills?: string[];      // 排除的 skill id
  mcps?: string[];        // 排除的 MCP server 名
  subagents?: string[];   // 排除的 agent/function 名称
}
```

用途：
- SubAgent 递归保护：`{ exclude: { subagents: [自身 function.name] } }`
- Skill 自调用保护：`{ exclude: { skills: [自身 skillId] } }`

### 阶段 1 — 发现（构造函数中执行一次）

| 来源 | 发现函数 | 返回类型 | 说明 |
|------|----------|----------|------|
| 内置工具 | `discoverBuiltinTools(config?)` | `Tool[]` | 16 个实例（含条件注入的 generateImage） |
| 用户工具 | `discoverUserTools(paths)` | `Tool[]` | 扫描 `tools/*.js`，动态 `require` 为 Tool 实例 |
| SubAgent | `discoverSubAgents(paths)` | `AgentDefinition[]` | 含完整定义（function、messages 等） |
| Skill | `discoverSkills(paths)` | `SkillInfo[]` | 含 id、name、description、subAgent 标记等完整信息 |
| MCP Server | `discoverMcpServers(paths)` | `McpServerConfig[]` | 含完整服务器配置（type/transport、command、url 等） |

发现结果全局共享，SubAgent 和 Skill 子 Agent 复用同一份候选集。

### 阶段 2 — 过滤（Capabilities.filter）

```
filter(permissions, { exclude })
  │
  ├── 1. 安全预过滤
  │     └── 从 SubAgent 候选集中剔除 exclude.subagents 中的名称
  │
  ├── 2. 拼装所有候选名称
  │     ├── 内置工具名 + 用户工具名 + 动态工具名
  │     └── 从 tools 候选名中剔除 exclude.tools
  │
  ├── 3. 四维度权限过滤
  │     ├── tools:     候选名 → filterByPermissions(permissions.tools)
  │     ├── subagents: 排除后的 SubAgent → filterByPermissions(permissions.subagents)
  │     ├── skills:    排除 exclude.skills 后的 skill id → filterByPermissions(permissions.skills)
  │     └── mcps:      排除 exclude.mcps 后的 MCP id → filterByPermissions(permissions.mcps)
  │
  └── 产出 FilterOutput { tools: string[], subagents: string[], skills: string[], mcps: string[] }
```

安全预过滤在权限判断之前执行，不受用户配置影响。

### 权限过滤与披露

#### tools

```
候选 = BUILTIN_TOOLS + discoverUserTools()  →  Tool[]
排除 = exclude.tools（黑名单裁剪）
权限 = filterByPermissions(permissions.tools)
结果 → 保留的 Tool[] 实例 + 5 个动态工具（按条件注册）
```

SubAgent 不作为普通工具出现在此维度。`call_skill_sub_agent`、`load_skill`、`load_mcp` 等动态加载工具也在此维度控制。

#### subagents

```
候选 = discoverSubAgents()  →  AgentDefinition[]（按 function.name 标识）
排除 = exclude.subagents（剔除自身 / 调用者）
权限 = filterByPermissions(permissions.subagents)
结果 → 保留的 AgentDefinition[]，后续构造 AgentToolLazy
```

#### skills

```
候选 = discoverSkills()  →  SkillInfo[]（完整信息，含 subAgent 标记）
排除 = exclude.skills（防止 Skill 调用自身）
权限 = filterByPermissions(permissions.skills)
结果 → 编译进 load_skill 的 skill_id 参数枚举，call_skill_sub_agent 只枚举 subAgent: true 的 skill
```

#### mcps

```
候选 = discoverMcpServers()  →  McpServerConfig[]（完整服务器配置，含 type/command/url 等）
排除 = exclude.mcps
权限 = filterByPermissions(permissions.mcps)
结果 → 编译进 load_mcp 的 server 参数枚举
```

### 阶段 3 — 实例化（Capabilities.instantiate）

```
instantiate(filtered: FilterOutput)
  │
  ├── 1. 内置 + 用户工具：名称匹配 → 直接入 result
  │
  ├── 2. 构建枚举披露参数
  │     ├── skillDisclosure：按 filtered.skills 筛选 → 编译枚举
  │     └── mcpDisclosure：按 filtered.mcps 筛选 → 编译枚举
  │
  ├── 3. 动态工具（按条件注册）
  │     ├── load_skill         ← 需要 tools 允许 + skills 非空
  │     ├── call_skill_sub_agent ← 同上
  │     ├── load_mcp           ← 需要 tools 允许 + mcps 非空 + mcpManager 就绪
  │     ├── call_mcp_tool      ← 需要 tools 允许 + mcpManager 就绪
  │     └── read_mcp_resource  ← 同上
  │
  ├── 4. SubAgent → AgentToolLazy
  │     └── 每个保留的 SubAgent → createSubAgentTool(def, provider, caps)
  │
  └── 5. 去重（后注册覆盖先注册）
```

### 动态工具注册条件

| 工具 | 注册条件 |
|------|----------|
| `load_skill` | `permissions.tools` 允许 + skills 维度至少有一个可用 skill |
| `call_skill_sub_agent` | `permissions.tools` 允许 + 至少有一个 `sub-agent: true` 的 skill |
| `load_mcp` | `permissions.tools` 允许 + mcps 维度至少有一个可用 server + mcpManager 就绪 |
| `call_mcp_tool` | `permissions.tools` 允许 + mcpManager 就绪 |
| `read_mcp_resource` | `permissions.tools` 允许 + mcpManager 就绪 |

### 去重规则

- 同名工具：后注册覆盖先注册（用户可覆盖内置同名工具）
- 去重范围：`builtinTools + userTools + 动态工具 + subAgents` 合并后的 `Tool[]`

### 动态加载工具

MCP 和 Skill 采用**惰性加载**：装配时不直接注册具体工具，而是注册 5 个「加载器工具」，由 LLM 在运行时按需触发。

---

#### load_skill — 加载 Skill 完整内容

装配时，将所有经 `permissions.skills` 裁剪后的 skill 编译为 `skill_id` 参数的枚举值。

```
name:        load_skill
description: 加载指定 Skill 的完整指导文档。Skill 是预制的专业指导，加载后展开到上下文中。当前没有可用的 Skill 时，描述中追加提示「（当前没有可用的 Skill，请联系用户添加）」。
parameters:
  skill_id: string（必填）— Skill ID。有可用 Skill 时为枚举值（从扫描到的 skill 动态生成，如 "my-skill" | "code-analyzer"），无可用时为自由文本。

返回:
  成功 → SKILL.md 的完整 markdown 正文，附加到对话上下文
  重复加载 → "Skill 'X' 已加载"（不重复注入，节省上下文）
  不存在 → "Skill 'X' 未找到"
```

权限：skill 枚举在装配时已按 `permissions.skills` 裁剪。

---

#### call_skill_sub_agent — 将任务委派给 Skill 子 Agent

不是所有 Skill 都有子 Agent 模式。Skill 可以在 SKILL.md frontmatter 中声明 `sub-agent: true`。

```
name:        call_skill_sub_agent
description: 将任务委派给指定的 Skill 子 Agent，由其独立完成并返回结果。
parameters:
  skill_id: string（必填）— Skill ID
  task:     string（必填）— 任务描述

返回:
  成功 → Agent 执行结果
  skill 无子 Agent 模式 → "Skill 'X' 不支持子 Agent 模式，请使用 load_skill 加载指导后自行处理"
  权限外 / 不存在 → 同 load_skill
```

实现：以 Skill 正文作为 system prompt 创建临时 Agent，传入 task 作为 user 消息。临时 Agent **通过 Capabilities 独立解析工具集**（继承调用者的 permissions，但传入 `exclude: { skills: [当前 skillId] }` 防止自调用），不直接继承父 Agent 的工具列表。

权限：同 `load_skill`，走 `permissions.skills`。

---

#### load_mcp — 连接 MCP 服务器并列出工具

装配时，从所有 mcp.json 中收集 server 名称，按 `permissions.mcps` 裁剪后编译为 `server` 参数的枚举值。

```
name:        load_mcp
description: 连接到指定 MCP 服务器，获取其可用工具和资源列表。连接后可使用 call_mcp_tool 和 read_mcp_resource。当前没有可用的 MCP 服务器时，描述中追加提示「（当前没有可用的 MCP 服务器，请联系用户添加）」。
parameters:
  server: string（必填）— MCP 服务器名称。有可用服务器时为枚举值（从 mcp.json 动态生成，如 "github" | "slack"），无可用时为自由文本。

返回:
  成功 → 工具清单（名称 + 描述 + 参数 schema）+ 资源清单（URI 列表）
  已连接 → 返回当前清单（list_changed 触发过更新则返回最新的）
  连接失败 → "无法连接到 'X': <错误信息>"
```

权限：server 枚举在装配时已按 `permissions.mcps` 裁剪。连接后该 server 的所有工具直接可用。生命周期受空闲超时管理（§7），同一 server 重复调用不重建连接。

---

#### call_mcp_tool — 调用 MCP 工具

```
name:        call_mcp_tool
description: 调用已连接 MCP 服务器上的指定工具。需先通过 load_mcp 连接服务器。
parameters:
  server:    string（必填）— MCP 服务器名称
  tool:      string（必填）— 工具名称
  arguments: object（必填）— 工具参数（结构须与 load_mcp 返回的 schema 一致）

返回:
  成功 → 工具执行结果
  未连接 → "请先使用 load_mcp 连接 'X'"
  工具不存在 → "'X' 上没有工具 'Y'"
  参数错误 → 错误详情及正确的参数 schema
```

---

#### read_mcp_resource — 读取 MCP 资源

```
name:        read_mcp_resource
description: 读取已连接 MCP 服务器上的指定资源（文档、数据等）。
parameters:
  server: string（必填）— MCP 服务器名称
  uri:    string（必填）— 资源 URI（从 load_mcp 返回的资源清单中获取）

返回:
  成功 → 资源内容
  未连接 → "请先使用 load_mcp 连接 'X'"
  资源不存在 → "'X' 上没有资源 '<uri>'"
```

---

#### 工具总览

| 工具 | 所属维度 | 触发时机 | 幂等 | 副作用 |
|------|----------|----------|------|--------|
| `load_skill` | skills | LLM 决定使用某 Skill | ✅ 重复不注入 | 消耗上下文 |
| `call_skill_sub_agent` | skills | LLM 委派任务给 Skill | — 每次独立执行 | 创建临时 Agent |
| `load_mcp` | mcps | LLM 决定使用某 MCP | ✅ 重复不重连 | 建立连接 |
| `call_mcp_tool` | mcps | LLM 调用具体工具 | — 取决于工具 | 取决于工具 |
| `read_mcp_resource` | mcps | LLM 读取资源 | ✅ 可重复读取 | 无 |

---

## 7. MCP 连接生命周期

MCP 连接由 SDK 全权管理，上层（CLI/Desktop）不感知连接细节。`McpConnectionManager` 由 `Provider` 内部创建，负责完整的连接生命周期，包括重连、退避、空闲超时、状态机。

底层 transport（stdio 进程管理、HTTP/SSE 请求）也由 SDK 内置实现，不作为注入点暴露给上层。

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

### OAuth 流程（仅 HTTP 类型）

```
connect()
  ├─ 检查本地 token
  │   ├─ 有效 → 直接使用
  │   └─ 有 refresh_token → 尝试刷新
  │       ├─ 成功 → 使用新 token
  │       └─ 失败 → 发起授权
  └─ 发起授权
        ├─ 启动本地回调服务器（随机端口）
        ├─ 打开浏览器 → 用户授权 → 回调
        └─ 用授权码换取 token → 持久化
```

### 重连

- 指数退避：1s → 2s → 4s → 8s → 16s → 30s（封顶）
- 最多 5 次
- 配置类错误（无效 transport、缺少必填字段）不重试

### 空闲超时

- 连接上每次操作更新 `lastActiveAt`
- 定时器每 60s 检查：`now - lastActiveAt > idleTimeout` → 断开
- 定时器 `unref()`，不阻止进程退出
- 默认超时：stdio 30 分钟，HTTP 5 分钟

### list_changed

连接时注册回调，服务端推送工具/资源/提示变更 → 自动刷新本地注册表。

---

## 8. Skill 发现与加载

### 发现路径（优先级从高到低）

1. `.ai-zen/skills/`（项目级，cwd 向上到 git root）
2. `~/.ai-zen/skills/`（用户级）
3. 嵌套子目录的 `.ai-zen/skills/`（monorepo 场景，最多 4 层）

同名 skill：项目覆盖全局。嵌套 skill 以 `prefix:name` 存在。

### 三段式加载

```
Scanner  →  扫描目录，找到所有包含 SKILL.md 的子目录
Parser   →  解析 YAML frontmatter，提取 name/description 等元数据
Loader   →  load_skill 触发时返回完整正文
```

### 渐进式披露

- **阶段 1**：`load_skill` 的 `skill_id` 参数枚举暴露 name + description（不占上下文）
- **阶段 2**：调用 `load_skill` 后，完整正文进入上下文


---

## 9. 对话生命周期

```
用户发消息
  │
  ├─ 检查上下文量
  │   ├─ 未超 threshold → 正常继续
  │   └─ 超过 maxContextTokens → 触发任务迁移
  │
  ├─ 任务迁移
  │   ├─ 保存当前对话
  │   ├─ 将完整历史传给迁移 Agent（专用，无工具）
  │   ├─ 迁移 Agent 生成结构化交接文档
  │   └─ 创建新 Agent，交接文档作为第一条 user 消息
  │
  ├─ Agent.run()
  │
  └─ 完成
      ├─ 自动保存 draft
      └─ 用户手动 save → 持久化 conversation
```

### 上下文计量

不估算、不学习。**只在 API 响应后，用 `usage.prompt_tokens` 做迁移判断。**

```
Round N 请求
  ↓
API 响应 → usage.prompt_tokens = 180,000
  ↓
shouldMigrate(180_000, 250_000) → false → 继续
  ...
  ↓
API 响应 → usage.prompt_tokens = 260,000
  ↓
shouldMigrate(260_000, 250_000) → true → 触发迁移
```

#### shouldMigrate

```typescript
function shouldMigrate(promptTokens: number, maxTokens: number): boolean {
  return promptTokens > maxTokens;
}
```

纯比较，无依赖。运行时在每轮 API 响应后调用。

#### Conversation 存储

```typescript
interface Conversation {
  // ... 其他字段
  lastPromptTokens?: number;  // 最近一轮 API 返回的 usage.prompt_tokens
}
```

#### 流式兼容性

`usage` 在流式最后一个 chunk 返回（`stream_options: { include_usage: true }`）。`shouldMigrate` 在流结束后调用即可，无额外处理。

#### 阈值设定

`Model.maxContextTokens` 设为模型上下文窗口的约 25%（例如 1M tokens 窗口 → 250,000），留足 response 空间。

### Draft 自动保存与恢复

- **保存时机**：每次 `Agent.run()` 返回后自动保存 draft（无论成功或失败）。如进程在 `run()` 执行期间被中断，保留的是上一次 `run()` 结束后的状态。
- **保存路径**：已命名对话保存到 `drafts/<conversationId>.json`，未命名对话保存到 `drafts/_current.json`
- **保存内容**：modelId、agentId、messages（完整消息历史）、updatedAt
- **启动恢复**：下次启动时检查 `drafts/_current.json` 是否存在且未超过 7 天，存在则提示用户"检测到未完成的对话，是否恢复？"
- **清理**：用户手动 save 后删除对应 draft；超过 7 天未恢复的 draft 自动清理

### 任务迁移交接文档格式

```markdown
## 💬 对话断点
## ✅ 已完成的任务
## 📋 未完成的任务
## 🧠 重要记忆
## 📁 文件索引
## 🔔 接手指令
```

### 错误处理

迁移失败时原始对话不丢失，错误日志写入 `~/.ai-zen/logs/`。

---

## 10. 关键决策

### Agent 和 SubAgent 统一类型
用 `AgentDefinition` 统一表达，`function` 字段区分。避免定义两套结构再写转换函数。

### 文件格式即运行时格式
`allow` 和 `deny` 以 `string[]` 存储，运行时直接用于匹配，无需中间编译步骤。

### 权限不继承
Agent 调用 SubAgent 时各自独立判断。继承会引入不可预测性。Skill 子 Agent（call_skill_sub_agent 创建的临时 Agent）是例外 — 它是临时对话分身而非独立实体，因此继承调用者 permissions。两者不对称是有意的。

### 显式声明，无默认
权限必须显式声明，每个维度只配 `allow` 或 `deny` 其一。不声明 = 全关。普通 Agent 推荐四个维度都 `allow: ['*']`（全开）。SubAgent 权限规则相同，仅 `subagents` 建议 `deny: ['*']`。

### allow 与 deny 互斥
每个维度只允许 `allow` 或 `deny` 之一，杜绝优先级争议。白名单用 `allow`，黑名单用 `deny`，简单直接。

### 枚举披露
Skill 和 MCP server 编译为 `load_skill` / `load_mcp` 的参数枚举。LLM 在函数签名中直接看到可用列表。`tools` 维度可以控制这两个工具是否注册，拒绝即切断整个披露通道。

### MCP 无 tool 级权限
`mcps` 维度只控制 server 级别，连接后该 server 的所有工具直接可用。MCP server 提供的是配套工具集，信任 server 即信任其所有工具。不做 `server:tool` 粒度的裁剪。

扩展预留：若将来需要 tool 级控制，可自然扩展为 `mcps: { allow: ["github"], tools: { "github": { deny: ["delete_repo"] } } }` — 外层管 server，`tools` 子键管该 server 内的工具，不写 `tools` 等同于全开。当前无此需求。

### SubAgent 权限独立维度
SubAgent 在运行时以工具形式注册，但其权限控制走独立的 `subagents` 维度，不与 `tools` 维度混在一起。

### 安全预过滤
递归/反向调用保护不走权限系统，而是在候选集进入 allow/deny 判断之前直接剔除。预过滤不受用户配置影响，保证循环依赖防护永不被意外覆盖。

### 迁移 Agent 专用化
迁移 Agent 不注册任何工具，只做文本分析。避免迁移过程触发新的工具调用。

### 模块分层严格
`types → config → crud → capabilities → runtime`，每层只依赖下一层。改一层不影响上层。

### apiKey 明文存储
当前阶段 apiKey 以明文存储在 `config.json` 中。文件权限（600）由用户自行保证。后续版本可考虑集成系统密钥链（macOS Keychain / Windows Credential Manager / Linux libsecret）。

---

## 11. 插件机制（SdkAgent + Plugin）

Core `Agent` 保持纯粹，只管 `send()` / `run()`。插件能力由 SDK 的 `SdkAgent` 提供——`SdkAgent` 继承 Core `Agent`，在其上增加 `use()` 和 `init()` 方法。

### 设计哲学

- **Agent 保持纯粹**：Core `Agent` 不感知插件，不增加 `use()` / `init()` 等方法
- **插件注册在 SdkAgent 上**：`SdkAgent` 继承 Core `Agent`，提供 `use()` 注册插件，`init()` 执行插件异步初始化
- **`init()` 为插件而生**：`SdkAgent` 本身没有异步初始化需求——模型、工具、消息在构造时已就绪。`init()` 的存在完全是为了给插件一个执行异步初始化的机会

### 核心类型

```typescript
// sdk/src/runtime/SdkAgent.ts

class SdkAgent extends Agent {
  private _plugins: AgentPlugin[] = [];

  use(plugin: AgentPlugin): void {
    this._plugins.push(plugin);
  }

  async init(): Promise<void> {
    for (const plugin of this._plugins) {
      await plugin.onInit?.();
    }
  }

  // 重写 send，在 send 前后及内循环中执行插件勾子
  async send(content: string): Promise<Message[]> {
    const ctx: SendContext = { agent: this, content, messages: this.messages };

    for (const plugin of this._plugins) {
      await plugin.onBeforeSend?.(ctx);
    }

    this.onInnerLoopStart = async () => {
      for (const plugin of this._plugins) {
        await plugin.onInnerLoopStart?.(ctx);
      }
    };
    this.onInnerLoopEnd = async () => {
      for (const plugin of this._plugins) {
        await plugin.onInnerLoopEnd?.(ctx);
      }
    };
    const messages = await super.send(content);
    this.onInnerLoopStart = undefined;
    this.onInnerLoopEnd = undefined;

    for (const plugin of this._plugins) {
      await plugin.onAfterSend?.(ctx);
    }

    return messages;
  }
}

interface AgentPlugin {
  onInit?(): Promise<void>;
  onBeforeSend?(ctx: SendContext): Promise<void>;
  onAfterSend?(ctx: SendContext): Promise<void>;
  onInnerLoopStart?(ctx: SendContext): Promise<void>;
  onInnerLoopEnd?(ctx: SendContext): Promise<void>;
}

interface SendContext {
  agent: SdkAgent;
  content: string;
  messages: Message[];
}
```

**`init()` 不是必须调用的**——如果不使用任何插件，可以不调。但建议统一调用以保持一致性。

### 消费模式

```typescript
// 新建对话
const provider = new Provider({ config, ...paths });
const agent = createAgent(provider, "my-agent");
agent.use(new AutoMigratePlugin({ maxTokens, migrationAgent, onHandoff }));
agent.use(new AutoDraftPlugin({ draftsDir, agentId, modelId }));
agent.use(new AutoRefreshToolsPlugin());
await agent.init();
await agent.send("你好");

// 恢复历史对话
const agent = createAgent(provider, conv.agentId);
agent.messages.push(...conv.messages);
agent.use(new AutoMigratePlugin({ ... }));
agent.use(new AutoDraftPlugin({ ... }));
await agent.init();
```

插件通过 `SdkAgent.use()` 注册，无中间层，无 Builder，无 Session。

---

### 内置插件：autoRefreshTools

对话过程中文件系统可能发生变化（新增 skill、工具文件、sub-agent），需要在每次发送前刷新工具列表。

```typescript
class AutoRefreshToolsPlugin implements AgentPlugin {
  async onBeforeSend(ctx: SendContext): Promise<void> {
    const { agent } = ctx;
    if (!agent.caps) return;

    // 1. 重新扫描文件系统
    agent.caps.refresh();

    // 2. 重新按权限过滤并实例化工具
    agent.tools = agent.caps.buildTools(agent.permissions ?? {}, {
      exclude: {
        subagents: agent.definition.function?.name
          ? [agent.definition.function.name]
          : undefined,
      },
    });
  }
}
```

全量重扫（读目录、读文件、权限过滤），不做增量检测。目录通常很小（几个到几十个文件），开销忽略不计。

---

### 内置插件：autoMigrate

```typescript
interface AutoMigrateOptions {
  maxTokens: number;
  migrationAgent: SdkAgent;
  onHandoff?: (handoffDoc: string, oldAgent: SdkAgent, newAgent: SdkAgent) => void;
}

class AutoMigratePlugin implements AgentPlugin { ... }
```

**onAfterSend 逻辑**：

```
1. 读取 agent.lastUsage?.prompt_tokens
2. shouldMigrate(promptTokens, maxTokens)
3. 如果未超限 → 返回（Agent 不变）
4. 如果超限：
   a. 将当前 agent.messages（完整历史）作为 user 消息发给 migrationAgent
   b. migrationAgent.send() → 生成交接文档 handoffDoc
   c. 调用 onHandoff(handoffDoc)（消费者可在此保存旧对话）
   d. 构建新 Agent：
      - 沿用原始 system prompt + 工具配置
      - messages 初始化为 buildPostMigrationMessages(handoffDoc)
   e. ctx.agent = newAgent → 替换当前 Agent
```

**使用示例**：

```typescript
const migrationAgent = createAgent(provider, "migration-agent");

const agent = createAgent(provider, "my-agent");
agent.use(new AutoMigratePlugin({
  maxTokens: model.maxContextTokens,
  migrationAgent,
  onHandoff: (doc, oldAgent, newAgent) => {
    writeConversation(id, oldAgent.messages);
    rebindEvents(oldAgent, newAgent);
  },
}));
await agent.init();
await agent.send("继续重构...");
```

### 迁移失败处理

- 迁移 Agent 调用失败 → 原 Agent 不变，错误日志写入 `~/.ai-zen/logs/`
- `onHandoff` 中保存旧对话失败 → 不影响迁移流程，新 Agent 已就绪
- 迁移过程中用户旧对话不丢失（已保存在 `agent.messages` 中）

---

## 12. 一站式装配（Provider + createAgent + SdkAgent）

SDK 不是一个模块工具箱（到处 import 散装函数），而是一个 **Provider 实例**，持有所有配置和外部依赖，各层通过它获取所需。

### Provider — 全局上下文

`Provider` 是 SDK 的全局上下文实例，由上层（CLI/Desktop）创建并传入：

```typescript
class Provider {
  config: AppConfig;
  agentsDir: string;           // Agent 定义目录
  subAgentsPaths: string[];    // SubAgent 搜索路径
  skillsPaths: string[];       // Skill 搜索路径
  toolsPaths: string[];        // 用户工具搜索路径
  mcpPaths: string[];          // MCP 配置搜索路径
  conversationsDir: string;    // 对话记录目录
  draftsDir: string;           // 草稿目录
  readonly mcpManager: McpConnectionManager;  // 内部创建
}
```

`McpConnectionManager` 由 `Provider` 在构造时内部创建，外部无需关心其构造细节。`Capabilities` 通过 `provider.mcpManager` 访问 MCP 连接管理，通过 `this.mcps`（`discoverMcpServers` 的产物）获取服务器配置——两者同源，消除不一致风险。

### createAgent

```typescript
function createAgent(
  provider: Provider,
  agentId: string,
): SdkAgent
```

函数内部创建 `Capabilities` 实例（执行全局发现），读取 Agent 定义，通过 `createModel(provider.config, modelId)` 构建模型，通过 `caps.buildTools()` 过滤并实例化工具。纯同步，一次性。

### SdkAgent

```typescript
class SdkAgent extends Agent {
  readonly provider: Provider;         // 全局上下文
  readonly definition: AgentDefinition; // Agent 原始定义
  readonly permissions?: AgentPermissions;
  readonly caps?: Capabilities;         // 能力注册表，用于运行时刷新

  use(plugin: AgentPlugin): void;       // 注册插件
  init(): Promise<void>;                // 执行插件异步初始化
}
```

`SdkAgent` 继承 Core `Agent`，携带 SDK 层元数据，并提供 `use()` 和 `init()` 方法。各回调（`call_skill_sub_agent`、SubAgent `buildAgent` 等）通过 `this.agent.provider` 访问全局服务。

### 消费模式

```typescript
// 1. 创建 Provider（一次创建，全局复用）
const provider = new Provider({
  config,
  agentsDir: "~/.ai-zen/agents",
  conversationsDir: "~/.ai-zen/conversations",
  draftsDir: "~/.ai-zen/drafts",
  subAgentsPaths: ["~/.ai-zen/sub-agents"],
  skillsPaths: ["~/.ai-zen/skills"],
  toolsPaths: ["~/.ai-zen/tools"],
});

// 2. 新建 Agent
const agent = createAgent(provider, "my-agent");
// agent 是 SdkAgent，自带 model、messages、tools、permissions、provider

// 3. 注册插件后开始对话
agent.use(autoMigrate({ maxTokens, migrationAgent, onHandoff }));
agent.use(autoDraft());
agent.use(autoRefreshTools());
await agent.init();
await agent.send("你好");

// 4. 恢复历史对话
const conversations = listConversations(provider.conversationsDir);
const conv = conversations[0];
const restoredAgent = createAgent(provider, conv.agentId);
restoredAgent.messages.push(...conv.messages);
restoredAgent.use(autoMigrate({ maxTokens, migrationAgent, onHandoff }));
restoredAgent.use(autoDraft());
await restoredAgent.init();
```

### SubAgent 解析

SubAgent（有 `function` 字段的 Agent）不继承父 Agent 的工具列表，通过 `Capabilities` 按自身 permissions 独立装配。模型构建通过 `Provider`：

```typescript
// createSubAgentTool(def, provider, caps) 的 buildAgent 回调中：
// 模型构建
if (def.modelId) {
  subModel = createModel(provider.config, def.modelId);
} else {
  subModel = parentAgent.model;  // 复用父 Agent 模型
}

// 能力过滤
const subFiltered = caps.filter(def.permissions ?? {}, {
  exclude: { subagents: [def.function.name] },  // 排除自身
});
const tools = caps.instantiate(subFiltered);
```

Skill 子 Agent（`call_skill_sub_agent` 创建的临时 Agent）同样通过 `caps.buildTools()` 独立解析工具集，传入 `exclude: { skills: [当前 skillId] }` 防止自调用。

### 设计决策

- **Provider 是全局上下文**：各层不接收散装参数，通过 Provider 实例获取配置、路径、模型工厂等全局服务
- **SdkAgent 持有 Provider**：回调中通过 `.provider` 访问全局服务
- **插件注册在 SdkAgent 上**：Core Agent 保持纯粹，不感知插件
- **`init()` 为插件而生**：SdkAgent 本身无异步初始化需求，`init()` 仅用于插件异步初始化
- **SubAgent 独立解析工具**：不继承父 Agent 的工具列表快照，通过 Capabilities 按自身 permissions 独立装配
- **SubAgent 独立模型**：可通过 `modelId` 指定不同模型，由 `createModel(provider.config, modelId)` 构建
- **tools 是 Tool[]**：权限系统消费者就是 `createAgent`，上层拿到的是最终结果，不再需要理解权限逻辑


---

## 13. 出厂默认配置（ConfigManager）

`ConfigManager` 是配置层的核心类，负责 `config.json` 的读写、目录初始化、以及默认实体的创建。SDK 内置完整的出厂默认配置（端点、模型、默认 Agent、默认 SubAgent），CLI 和 Desktop 无需各自维护。

### ConfigManager

```typescript
class ConfigManager {
  constructor(configPath: string);

  read(): AppConfig;
  write(config: AppConfig): void;

  // 目录 & 默认实体
  ensureDirs(): void;
  ensureDefaultConfig(): AppConfig;
  ensureDefaultAgent(): AgentDefinition | null;
  ensureDefaultSubAgent(): AgentDefinition | null;

  // 一键初始化
  bootstrap(): {
    config: AppConfig;
    agent: AgentDefinition | null;
    subAgent: AgentDefinition | null;
  };
}
```

### 出厂默认值

所有默认值集中在 `constants.ts`：

| 常量 | 说明 |
|------|------|
| `DEFAULT_APP_CONFIG` | 预置端点（OpenAI / 智谱 / DeepSeek）+ 模型列表 + 图片模型 + 默认选项 |
| `DEFAULT_AGENT_DEFINITION` | 默认 Agent（id="default"，全权限开放） |
| `DEFAULT_SUBAGENT_DEFINITION` | 默认通用助手 SubAgent（id="general-assistant"） |

### 使用方式

```typescript
// CLI/Desktop 首次启动
const mgr = new ConfigManager("~/.ai-zen/config.json");
const { config, agent, subAgent } = mgr.bootstrap();
// → 自动创建目录结构、写入 config.json、default.json、general-assistant.json
// 已有文件不会被覆盖

// 后续读取
const config = mgr.read(); // 文件不存在时返回出厂默认配置（不落盘）
```

### 设计决策

- **SDK 持有出厂默认**：预置厂商/模型列表由 SDK 统一维护，CLI/Desktop 不再各自重复定义
- **幂等安全**：所有 `ensure*` 方法对已存在的文件不覆盖，用户自定义配置永不丢失
- **read() 无文件时返回出厂默认**：无需先写 config.json 也能正常工作（内存中返回预置配置）

