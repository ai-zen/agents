# TODO：SDK 重构 —— 去 Provider（Workspace + SdkAgent 两级对象，领域插件化装配）

> 状态：**方案务虚讨论已定稿**，代码尚未开始。
> 本文件是本次重构的单一执行依据。
> **接手者请先读「术语与概念定义」与「关键决策的理由与已否决方案」，再按「实施步骤」推进**——只看决策表不足以理解意图，可能导致返工。

## 一、背景与目标

当前 `@ai-zen/agents-sdk`（0.9.x）存在以下结构性负担：

1. **Provider 全局隐式单例**：配置、路径（每工作区 cwd）、模型工厂、能力管线（发现→过滤→实例化）集中于一个全局上下文；多 Agent / 多工作区难以并行，依赖隐式、不可显式注入。
2. **能力装配集中管线化**：discovery（builtin / mcp / skills / subagents / usertools）→ `PermissionEvaluator` 过滤 → 实例化注入；扩展点分裂（工具走管线、插件走 `use`）。
3. **工具带状态**：`SdkCallbackTool` 构造注入 `ToolEnv{cwd, config}`、持有 manager/注册表，偏离 core 的"声明 + `exec(ctx)`"哲学。
4. **父子权限继承耦合**：子 Agent 按父 definition 权限过滤，父子权限纠缠，子 Agent 易成权限逃逸口。
5. **刷新 / 迁移 / 手动触发分散**：AutoRefreshToolsPlugin send 前重跑管线、TaskMigrationService 为独立实体、插件仅有被动钩子。
6. **钩子 API 不一致**：`onInit()` 无参，各钩子需自 `ctx.agent` 取 Agent。

重构目标（延续 core 4.0"以退为进"的方向）：

- Provider → 显式、可多实例、**注入式**的两级对象：**Workspace（来源/候选层）** 与 **SdkAgent（运行时层）**；
- 能力装配**插件化**：领域插件挂 Workspace，`loader` 登记候选、`buildTools` 按 def 过滤产出；权限过滤下放各插件；
- 工具**无状态化**，服务运行期经 `ctx.agent.workspace.xxx` 获取；
- 父子权限**独立**、各自按自身 def 过滤；
- 刷新收口为 `workspace.load()`；迁移与手动动作收口为**可手动触发的行为插件**；
- core 泛型化（`AgentPlugin<A>` / `Tool<A>` / `ToolCallContext<A>`），sdk 以 `SdkAgent` 收口。

## 二、术语与概念定义

| 术语 | 定义 |
|------|------|
| **Workspace** | 来源/候选层对象。显式、可多实例、注入式；持有 cwd、config 能力、领域插件、loader 产物、工作区级共享的 MCP 连接。父子 Agent 共享同一 Workspace |
| **领域插件（来源型插件）** | 挂在 Workspace 上的能力来源处理器，提供 `loader`（扫描来源、登记候选产物到 ws）与 `buildTools`（按 def 权限过滤并产出 Tool）。如 SkillPlugin / McpPlugin / UserToolsPlugin / UserSubAgentsPlugin / 内置工具菜单 |
| **行为插件（SdkAgentPlugin）** | 挂在 SdkAgent 上的插件，实现生命周期钩子（`onInit`/`onBeforeSend`/`onToolCall`…）并提供可手动触发的动作。继承 `AgentPlugin<SdkAgent>` |
| **候选集** | Workspace 上登记的全部可用能力（四维名字表 tools/skills/mcps/subagents + 各来源产物），未被权限过滤 |
| **已选集** | SdkAgent 上经 `buildTools(def)` 按权限过滤并编译后的工具实例表（`Tool[]`），即将发给 LLM 的工具集 |
| **编译** | 从候选（名字/定义）按 def 权限过滤后实例化为 Tool 的过程 |
| **代理工具** | skill/mcp 的**固定名称**工具（`load_skill` / `call_skill_sub_agent` / `load_mcp` / `call_mcp_tool` / `read_mcp_resource`），其背后是运行期注册表；用于避免动态 schema 进入静态工具表 |
| **前缀缓存友好** | 静态工具表（名称与顺序）保持稳定，动态能力收敛到代理工具背后的注册表，使 LLM API 提供方的 prefix/context caching 能持续命中 |
| **load** | `Workspace.load()`：转发各领域插件 `loader`，扫描来源并把产物挂到 ws；**幂等**；MCP 连接不在此建立（按需连接） |
| **buildTools(def)** | `Workspace.buildTools(def)`：转发各领域插件 `buildTools` 并聚合产出；Workspace 自身不做过滤 |
| **不变量（invariants）** | 实现过程中必须始终成立的行为契约（见「不变量清单」），是测试与评审的依据 |

## 三、已确认决策（务虚定稿）

### 3.1 对象模型

| 决策 | 说明 |
|------|------|
| 删除 Provider | 改为显式、可多实例、注入式的两级对象；无全局隐式状态 |
| Workspace | 来源/候选层：cwd、config、约定目录、loader 产物统一挂载、MCP 连接（工作区级共享） |
| SdkAgent | 运行时层：独立构造 + workspace 注入，可换 ws；自身持 was/已选集/消息 |
| 能力入口 | 便捷 `ws.createAgent(name \| def)` + 底层 `new SdkAgent({ workspace, definition, history })`；`name→def` 解析为内部实现细节 |

### 3.2 Workspace

| 决策 | 说明 |
|------|------|
| `use(领域插件)` | SkillPlugin / McpPlugin / UserToolsPlugin / UserSubAgentsPlugin / 内置工具菜单 |
| `await load()` | 转发各插件 `loader`，产物统一挂到 ws；**幂等**；MCP 连接与 load 解耦、按需连接 |
| `buildTools(def)` | 转发各插件 `buildTools`（Workspace 只聚合、不过滤）；各插件内部按 def 对应维度权限过滤后产 Tool |
| 候选表 | 沿用四维名字表（tools/skills/mcps/subagents）；过滤发生在"名字层"，过滤后按名实例化 |
| config 能力 | 读取/迁移/原子写（原 ConfigManager 能力）归 ws |

### 3.3 SdkAgent

| 决策 | 说明 |
|------|------|
| 构造 | `new SdkAgent({ workspace, definition, history? })`；definition 为纯声明数据 |
| 模型运行时 | **每 agent 独立装配** `{ client, model, modelConfig }`（def.modelId + ws.config）；子 agent def 未声明模型时**缺省继承父** |
| `use` | **仅收行为插件（SdkAgentPlugin）**；工具一律经 workspace 候选进入（不使用 tool 逃生口） |
| `init` | 手动执行；`onInit` 内反向绑定 agent；内部兜底 `if (!ws.loaded) await ws.load()`；提示通道不归 SDK（静默，错误带上下文） |
| `send` | 未 init 自动补 init → `buildTools(ownDef)` 现取已选集 → 调模型；**默认不 load** |
| 手动动作 | `agent.plugin(id).动作()`；插件自带默认 id，同 id 冲突时构造显式传自定义 id |
| 工具表 | 仅存已编译的已选集（tools 实例）；不持有任何候选/中间态 |

### 3.4 插件体系

| 决策 | 说明 |
|------|------|
| 来源型插件 | 挂 Workspace：`loader`（登记候选挂 ws）+ `buildTools(def)`（按维度权限过滤产出）；实现：Skill/Mcp/UserTools/UserSubAgents/内置 |
| 行为型插件 | 挂 SdkAgent：`SdkAgentPlugin extends AgentPlugin<SdkAgent>`；生命周期钩子 + 可手动触发动作 |
| 手动触发 | `agent.plugin(id)`（id 为唯一寻址键，instanceof 不用于寻址） |
| 反向绑定 | `onInit(agent)` 内自存 agent，**不新增 `onUse` 钩子**（API 最小） |
| 刷新 | 取消 `agent.refresh` 与 `onRefresh`；`AutoRefreshPlugin`（opt-in）在 send 前 `workspace.load()` |

### 3.5 工具

| 决策 | 说明 |
|------|------|
| class 形式保留 | core `Tool` 抽象保留；内置工具以 class 组织 |
| 无状态化 | 删除 `ToolEnv{cwd, config}` 构造注入；`SdkCallbackTool` 改造为**无状态基类**保留（schema 声明 + exec 模板），环境经运行期获取 |
| 类型收口 | core 泛型化 `Tool<A>` / `ToolCallContext<A>`；sdk 工具以 `SdkAgent` 收口，编译期类型安全 |
| 运行期服务 | 经 `ctx.agent.workspace.xxx` 获取（skill store、mcp manager、cwd 等） |
| 内置工具 | 同为 Workspace 候选菜单，经 def 权限过滤后由 buildTools 统一编译（可被剔除） |
| 用户工具 | `tools/*.js` 沿用现状导出格式并归一化 |

### 3.6 权限与父子

| 决策 | 说明 |
|------|------|
| 模型沿用 | 四维 `tools/skills/mcps/subagents` `{allow \| deny}`；维度未配置默认全拒；definition 未配置 permissions 则全空 |
| 过滤时机 | 仅发生在 `buildTools(def)` 内（下放各插件）；与 use 无关 |
| 被禁工具 | **直接丢弃**，不进工具表（不进 LLM schema） |
| 父子关系 | **权限无关、各自过滤**；子继承父环境（同 ws、缺省继承模型），不继承权限 |

### 3.7 生命周期（端侧典型序列）

```ts
const ws = new Workspace({ cwd })
  .use(skillPlugin).use(mcpPlugin)
  .use(userToolsPlugin).use(userSubAgentsPlugin)
  .use(builtinToolsPlugin);          // 内置工具同为候选

await ws.load();                     // 各 loader 扫描来源，产物挂 ws（幂等，MCP 不在此连接）

const agent = ws.createAgent("coder") // 或 new SdkAgent({ workspace: ws, definition, history })
  .use(contextGuardPlugin);           // 行为插件；手动动作经 agent.plugin(id)

await agent.init();                  // onInit 反向绑定；内部兜底 ensure ws.loaded
await agent.send("…");               // 未 init 自动补 init → buildTools 现取 → 调模型
// 默认不 load；装 AutoRefreshPlugin 时 send 前先 ws.load() 再 buildTools
```

- 两忘（忘 load、忘 init）场景验证通过：`send → ensureInit → (init 内) ensureWorkspaceLoaded → buildTools → 运行`；
- 首次 send 隐式承担 load+init 的重量操作；错误需携带 `workspace.load() / agent.init()` 阶段上下文。

### 3.8 core 配套改动

| 决策 | 说明 |
|------|------|
| `AgentPlugin<A extends Agent>` | 泛型化；钩子统一 `(agent, ctx)`，**ctx 不再携带 agent**；`onInit(agent)` |
| `Tool<A>` / `ToolCallContext<A>` | 携带宿主类型，与 AgentPlugin 对称 |
| `use()` / `dispatchHook` | 传递宿主类型 A |
| 破坏性 | 与 sdk 重写**同批 major 发布**；core 测试、双语文档、CHANGELOG 同步 |
| 版本号 | 待确认（core 预计 5.0.0，sdk 预计 1.0.0 方向，未定） |

### 3.9 保留与不变项（兼容性）

- core 直跑官方 openai SDK；HookResult 短路语义与插件钩子主体沿用；
- **skill/mcp 前缀缓存友好结构**（静态工具表稳定、动态能力收敛到固定代理工具背后的运行期注册表）——不可破坏；
- 权限四维 allow/deny 模型与"维度缺省全拒"语义——原样沿用；
- JSON 声明层**零 schema 变化**：`config.json`（endpoints/models 等）、`agents/*.json`、`mcp.json`、skill 目录/SKILL.md、`sub-agents/*.json`、`tools/*.js` 格式全部沿用现状；仅解读层迁移（Provider→Workspace、discovery→领域插件 loader，复用 `discoverMcpServers` / `discoverSkills` / `readSkill` / `normalizeToolExport` 等现有解析函数）；
- MCP 按需连接、空闲超时等生命周期治理方向；会话/草稿持久化归各端；
- 子 agent 两轨：技能子 agent（`load_skill` / `call_skill_sub_agent` 代理工具）与声明式子 agent（AgentTool 入口）并行保留。

## 四、关键决策的理由与已否决方案

> 目的：防止接手者"好心优化"回退已否决设计。每条给出理由与**已否决的替代方案**。

| # | 决策 | 理由 | 已否决的替代方案 |
|---|------|------|------------------|
| 1 | 去 Provider，改两级对象 | 消除全局隐式单例；显式可多实例；依赖注入便于测试与多工作区并行 | ① 保留 Provider 单例；② 让 SdkAgent 独自全包环境+候选（子 agent 无共享候选、重复扫描与连接、状态分裂） |
| 2 | 候选集独立抽象为 Workspace | 共享物（skill 扫描、MCP 连接、config）必须有单一归属，父子/多 agent 共享 | 候选放 agent 内部、靠父子引用传递（共享物散落对象链，无归属） |
| 3 | 领域插件化 + load/buildTools 转发 | 各来源自管内聚；与 core 插件哲学对称；扩展新来源只加插件 | 集中 discovery 管线（现状）；Workspace 统一过滤 |
| 4 | 权限过滤下放各插件 | 各领域只关心自身维度；先 load 后过滤语义清晰 | Workspace 集中过滤（各插件产物形态不一，集中过滤需拆解） |
| 5 | 工具无状态化 | 回归 core"声明 + exec(ctx)"哲学；消除构造注入；刷新与工具表解耦；易测试 | 保留 `ToolEnv` 注入（工具持有状态，与刷新/复用冲突） |
| 6 | skill/mcp 保持代理工具（不平铺） | **前缀缓存友好**：静态工具表稳定，动态能力收敛注册表 | 把远程工具/技能平铺进工具表（刷新即改 schema，缓存频繁失效） |
| 7 | `use` 仅收行为插件 | 能力唯一入口，避免两套生命周期；奥卡姆 | `use(tool)` 逃生口（暂不需要，见「可选后续」） |
| 8 | 父子权限无关、各自过滤 | 权限边界 = agent 实例；避免"继承/收窄/放宽"隐式规则含糊 | 子继承父权限集；父子集收窄 + 显式放宽规则（引入逃逸判断复杂度） |
| 9 | 刷新归 `workspace.load()`，去 `agent.refresh` | 候选在 ws，刷新即重扫来源；agent 无中间态可刷 | 保留 `agent.refresh` + `onRefresh` 钩子（机制重复） |
| 10 | init 手动 + send 兜底 + init 内 ensure load | 兜底链保证"两忘"仍可用；send 语义保持纯粹（不感知 load） | 兜底放 send（两处 load 判断）；无兜底（易用性差） |
| 11 | core 泛型化 `AgentPlugin<A>` / `Tool<A>` | sdk 插件与工具需编译期访问 `SdkAgent` 面；与钩子泛型对称 | 运行时 `as SdkAgent` 断言（无编译期保障） |
| 12 | 工具保留 class 形式 | 与 core 一致；继承承载共享逻辑；内置工具菜单需要可列举的类 | 声明式对象 + 函数组合（仪式感低但偏离 core 形态） |
| 13 | 迁移收敛为行为插件动作 | "可手动触发"即无需独立对外服务；机制收口 | 保留 `TaskMigrationService` 对外实体（机制分散） |
| 14 | 手动动作寻址用字符串 id | 支持同类多实例；冲突时构造传自定义 id；无需维护类型表 | `instanceof` 类寻址（同类多实例歧义）；use 顺序下标（可读性差） |
| 15 | 钩子首参 agent、ctx 去 agent | 获取 agent 方式统一；`onInit` 也能拿到 agent | 继续从 `ctx.agent` 取；`onInit` 无参 |
| 16 | history 为完整对话、def.messages 克隆 | 续聊语义清晰；防模板污染（沿 0.9.3 修复经验） | 模板+历史追加；直接引用模板数组（污染） |
| 17 | JSON 声明零 schema 变化 | 重构不改数据契约，存量配置无需迁移 | 借重构调整 schema（增加迁移成本，无收益） |

## 五、目标架构

```
┌─ core（@ai-zen/agents-core，major 破坏性）────────────────────────┐
│  Agent（泛型宿主 A）· AgentPlugin<A extends Agent>                  │
│  钩子签名统一 (agent, ctx)，ctx 不带 agent，onInit(agent)          │
│  Tool<A> / ToolCallContext<A>（无状态：声明 + exec(ctx)）           │
│  dispatchHook / Message（id required）…                            │
└─────────────────────────────────────────────────────────────────────┘
            ↑ 继承 / 泛型收口
┌─ sdk（@ai-zen/agents-sdk，major 同步）──────────────────────────────┐
│                                                                      │
│  ┌─ Workspace（来源层 · 共享 · 可多实例）─────────────────────────┐  │
│  │  new Workspace({ cwd }).use(来源型插件) → await load()          │  │
│  │  · 领域插件: Skill/Mcp/UserTools/UserSubAgents/内置             │  │
│  │  · loader 产物统一挂载 · config 能力 · MCP 连接(共享,按需)       │  │
│  │  · buildTools(def)：转发各插件按维度权限过滤 → Tool 实例          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                          ▲ 注入                                     │
│  ┌─ SdkAgent（运行时层 · 独立构造）──────────────────────────────┐  │
│  │  new SdkAgent({ workspace, definition, history? })             │  │
│  │  · 自装 client/model/modelConfig（子缺省继承父）                │  │
│  │  · use(行为插件) · agent.plugin(id) 手动动作 · onInit 反向绑定  │  │
│  │  · init(手动/send 兜底, 内含 ensure ws.loaded)                 │  │
│  │  · send: buildTools 现取 → 调模型（默认不 load）                │  │
│  └──────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## 六、API 面草案

> **草案**：实施时可微调细节，但形态与语义不可偏离（语义由「已确认决策」与「不变量清单」约束）。

```ts
// ============================== Workspace ==============================
class Workspace {
  constructor(options: { cwd: string });
  use(...plugins: WorkspacePlugin[]): this;              // 来源型插件
  load(): Promise<void>;                                 // 幂等；转发各插件 loader，产物挂 ws
  buildTools(def: AgentDefinition): Tool<SdkAgent>[];    // 转发并聚合；Workspace 不做过滤
  createAgent(                                           // 便捷层：name→def 解析为内部细节
    nameOrDef: string | AgentDefinition,
    options?: { history?: AgentNS.Message[] },
  ): SdkAgent;
}

interface WorkspacePlugin {
  readonly id?: string;                                  // 领域标识（如 "skill"/"mcp"）
  loader(ws: Workspace): Promise<void>;                  // 扫描来源，登记候选产物到 ws
  buildTools(def: AgentDefinition): Tool<SdkAgent>[];    // 按 def 对应维度权限过滤并产出
}

// ============================== SdkAgent ==============================
class SdkAgent extends Agent<SdkAgent> {
  constructor(options: {
    workspace: Workspace;
    definition: AgentDefinition;                         // 纯声明数据（构造时克隆）
    history?: AgentNS.Message[];                         // 完整既有对话，续聊用
  });
  use(...plugins: SdkAgentPlugin[]): this;                // 仅行为插件
  init(): Promise<void>;                                  // 手动；onInit 反向绑定；ensure ws.loaded
  send(content: string): Promise<unknown>;                // 未 init 自动 init；buildTools 现取
  plugin(id: string): SdkAgentPlugin | undefined;         // 取回实例以触发手动动作
}

interface SdkAgentPlugin extends AgentPlugin<SdkAgent> {
  readonly id: string;                                    // 默认内置；冲突时构造传自定义 id
}

// ============================== core 变化 ==============================
interface AgentPlugin<A extends Agent = Agent> {
  onInit?(agent: A): void | Promise<void>;
  onBeforeSend?(agent: A, ctx: SendContext): HookResult;  // ctx 内不再有 agent 字段
  onToolCall?(agent: A, ctx: ToolCallContext<A>): HookResult;
  // …其余钩子同现状，签名统一为 (agent, ctx)
}

abstract class Tool<A extends Agent = Agent> {
  function: AgentNS.FunctionDefinition;                   // 声明（由子类赋值）
  abstract exec(ctx: ToolCallContext<A>): Promise<AgentNS.MessageContent>;
}
```

## 七、现状 → 新结构迁移映射

> 以现有 `packages/sdk/src` 为准；实施时逐一确认（文件可能已变动）。

| 现有模块 | 处置 | 目标归属 / 说明 |
|----------|------|-----------------|
| `runtime/Provider.ts` | **删除** | 职责拆分：config/cwd/候选/连接 → Workspace；过滤产出 → 各领域插件 |
| `runtime/createModel.ts` | 改造 | agent 级模型装配（每 agent 独立 `client`）；保留 openai 装配逻辑 |
| `runtime/SdkAgent.ts` | 重写 | 运行时层（构造 / init / send / plugin / 已选集） |
| `runtime/createAgent.ts` | 改造 | `ws.createAgent` 便捷层（内部 name→def 解析） |
| `runtime/McpConnectionManager.ts` | 保留 | 归 McpPlugin 持有（Workspace 级共享；按需连接/超时治理不变） |
| `runtime/SdkCallbackTool.ts` | 改造 | 无状态基类：删 `ToolEnv` 注入，保留 schema 声明 + exec 模板；ctx 收口 `SdkAgent` |
| `runtime/TaskMigrationService.ts` | 收敛 | 并入 ContextGuard 行为插件内部，不再对外导出 |
| `capabilities/discovery/{builtin,mcp,skills,subagents,usertools}.ts` | 保留为解析函数 | 被各领域插件 `loader` 复用（格式不变） |
| `capabilities/PermissionEvaluator.ts` | 保留 | 供各领域插件 `buildTools` 内复用（过滤下放） |
| `capabilities/disclosure.ts` | 保留 | 供代理工具参数披露（注意 enum 与缓存取舍，见开放点） |
| `capabilities/implements/builtin/*` | 改造 | 保留 class，去 env 构造注入；注册为内置工具候选菜单 |
| `capabilities/implements/mcpTools.ts` | 改造 | 归 McpPlugin `buildTools` 产出（代理工具） |
| `capabilities/implements/skillTools.ts` | 改造 | 归 SkillPlugin `buildTools` 产出（代理工具） |
| `capabilities/implements/subAgentTools.ts` | 改造 | 归 UserSubAgentsPlugin `buildTools` 产出 |
| `config/ConfigManager.ts` | 保留 | 能力归 Workspace（读取 / 迁移 / 原子写） |
| `crud/AgentRepository.ts`、`shared/EntityRepository.ts` | 保留 | name→def 解析与实体 CRUD |
| `plugin/*.ts`（AutoRefreshTools / ContextGuard / AutoMigrate / UnknownToolHint） | 改造 | 行为插件：适配 `(agent, ctx)` 签名；AutoRefresh 转型为 send 前 `ws.load()` |
| `types/index.ts` | 保留 | **零 schema 变化** |
| `index.ts` | 改造 | 导出面调整（Workspace、各领域插件、SdkAgent、行为插件） |
| **新增** | — | `Workspace`、领域插件（Skill / Mcp / UserTools / UserSubAgents / 内置菜单） |

## 八、不变量清单（行为契约）

> 每条均为实现与评审的判定标准；测试须覆盖。

| # | 不变量 | 验证方式 |
|---|--------|----------|
| 1 | JSON 声明零 schema 变化（config / agents / mcp / skills / sub-agents / tools 格式不变） | 存量 `test-home` 配置可直接加载 |
| 2 | 前缀缓存结构成立：agent 工具表名称与顺序稳定；skill/mcp 动态能力不进静态工具表（收敛于代理工具背后注册表） | load 前后工具表 schema 不变；MCP 重连不改变工具表 |
| 3 | 默认 send 不 load（零 IO）；仅启动/显式 load/AutoRefresh opt-in 时 load | send 期间无来源扫描 IO 断言 |
| 4 | 权限默认全拒：def 未声明 permissions 或其维度时该维度无工具 | 权限单测 |
| 5 | 权限过滤仅发生在 `buildTools` 内；被禁工具**不进工具表**（不进 LLM schema） | 构建结果断言 |
| 6 | 工具无状态：不持有 cwd/config/manager；服务经 `ctx.agent.workspace` 获取 | 代码审查 + 单测 |
| 7 | history 语义：history 为完整对话；def.messages 仅当 history 为空时作初始模板；def.messages 必须克隆（不污染） | 单测（引用隔离） |
| 8 | "两忘"可用：未 load、未 init 直接 send 也正常工作 | 集成/回归测试 |
| 9 | 父子隔离：子 agent 权限独立于父；子继承父环境（同 ws、缺省模型），不继承权限 | 单测 |
| 10 | 手动动作可达：`agent.plugin(id).动作()` 可用；未 init 时动作的守卫行为明确 | 单测 |
| 11 | 破坏性变更同批发布：core major 与 sdk major 一致 | 版本核对 |

## 九、实施步骤（Phase）

> 全部待办（`[ ]`）。每阶段末尾给出**完成判据**。

### Phase 0：core 泛型化与钩子签名（core 侧先行）

- [ ] `AgentPlugin<A extends Agent>`：钩子签名统一为 `(agent, ctx)`，ctx 内移除重复 agent 字段；`onInit(agent)` 带宿主
- [ ] `Tool<A>` / `ToolCallContext<A>` 泛型化，携带宿主类型
- [ ] `Agent.use()` / `dispatchHook` 传递宿主类型 A
- [ ] 确认不新增 `onUse` / `onRefresh`（反向绑定走 `onInit` 自存；刷新归 `workspace.load`）
- [ ] core 测试适配（类型断言、短路语义回归）、双语文档、CHANGELOG（破坏性条目）

**完成判据**：core `tsc` + 全量测试绿灯；类型层面 `SdkAgent` 收口示例可编译（`AgentPlugin<SdkAgent>` / `ToolCallContext<SdkAgent>`）。

### Phase 1：Workspace 对象

- [ ] `new Workspace({ cwd })`：config 读取/迁移/原子写（承接 ConfigManager 能力）、cwd 基准
- [ ] `use(来源型插件)` 注册与遍历；`await load()`（幂等标记，转发各 loader）
- [ ] `buildTools(def)`（聚合转发）；候选四维名字表与挂载结构
- [ ] `name→definition` 解析（内部，供 createAgent）

**完成判据**：单测覆盖 load 幂等、产物挂载、buildTools 聚合；用 `test-home` 夹具可 load 出候选。

### Phase 2：领域插件（来源型）

- [ ] 定义来源型插件契约（`loader` / `buildTools`）
- [ ] SkillPlugin：loader（复用 `discoverSkills` / `readSkill`，产物挂 ws）；buildTools 按 `permissions.skills` 过滤并产 `load_skill` / `call_skill_sub_agent`（保持前缀缓存友好）
- [ ] McpPlugin：loader（复用 `discoverMcpServers` + 连接管理器初始化）；buildTools 按 `permissions.mcps` 过滤并产 `load_mcp` / `call_mcp_tool` / `read_mcp_resource`
- [ ] UserToolsPlugin：loader（复用 `discoverUserTools` / `normalizeToolExport`）；buildTools 按 `permissions.tools` 过滤
- [ ] UserSubAgentsPlugin：loader（读 sub-agents 定义）；buildTools 产 AgentTool 入口
- [ ] 内置工具菜单：内置工具 class 注册为候选，buildTools 统一编译（可被权限剔除）

**完成判据**：各插件单测（过滤前后候选/工具集断言）；四维权限组合用例通过。

### Phase 3：SdkAgent 运行时

- [ ] 构造 `{ workspace, definition, history }`：definition 克隆（防污染）；history 为完整对话，def.messages 仅当 history 为空时作模板
- [ ] 模型运行时独立装配（def.modelId + ws.config）；子 agent 缺省继承父
- [ ] `init()`（`onInit` 反向绑定、兜底 ensure `ws.loaded`）；`send` 未 init 自动补
- [ ] send 流程：`buildTools(ownDef)` 现取已选集 → 调用模型
- [ ] `agent.plugin(id)` 寻址与手动动作通道
- [ ] `ws.createAgent(name | def)` 便捷层（底层 `new SdkAgent`）

**完成判据**：两忘场景回归通过；父子权限隔离用例通过；`history` 合并与防污染用例通过。

### Phase 4：工具无状态化改造

- [ ] `SdkCallbackTool` 改造为无状态基类：删 `ToolEnv` 注入，保留 schema 声明 + exec 模板；环境经 `exec(ctx)` 从 `ctx.agent.workspace` 获取
- [ ] 全部内置工具去构造注入适配；`GenerateImageTool` / `ViewImageTool` 等经 agent.client / model 能力判断
- [ ] 子 agent 工具：运行时 `new SdkAgent`（同 ws、缺省继承父模型、独立 def 权限过滤）
- [ ] 用户工具导出格式适配（沿用现状归一化）

**完成判据**：19+ 内置工具单测通过（无 env 注入）；代码审查确认无状态（工具内无 cwd/config/manager 字段）。

### Phase 5：行为插件集合

- [ ] ContextGuard（上下文护栏 + 迁移能力内聚，`migrate` 动作可手动触发；`TaskMigrationService` 不再对外）
- [ ] AutoRefresh（opt-in，send 前 `workspace.load()`；原 AutoRefreshToolsPlugin 转型）
- [ ] UnknownToolHint 等既有行为插件适配新签名（`(agent, ctx)`、SdkAgent 收口）

**完成判据**：`agent.plugin(id)` 手动触发用例通过；AutoRefresh 开启后 send 前 load 断言通过。

### Phase 6：测试

- [ ] core：泛型化/钩子签名适配回归（单元 + integration）
- [ ] sdk：Workspace.load / buildTools、领域插件 loader 过滤、SdkAgent init/send 兜底、父子权限独立、历史合并与防污染、手动动作通道
- [ ] sdk：integration / e2e（真实 API、mcp server）适配；两忘场景回归
- [ ] 前缀缓存结构回归：工具表静态稳定、代理工具 + 注册表模式不被破坏

**完成判据**：core + sdk 全量测试绿灯（含 e2e）；「不变量清单」逐条有覆盖用例。

### Phase 7：文档与发布

- [ ] `packages/sdk/docs/sdk-design.md` 按新架构重写（文档为唯一真相源）
- [ ] 根 README / core README 双语文档同步（Provider → Workspace/SdkAgent、插件体系）
- [ ] CHANGELOG 更新（core major + sdk major 同批）；版本号经确认后 bump
- [ ] 发布前检查脚本、全量测试绿灯

**完成判据**：文档与实现逐项对齐；发布检查通过。

## 十、风险与注意事项

1. **core 泛型化波及面**：`AgentPlugin` / `Tool` / `ToolCallContext` 签名变更属破坏性，需同批 major 发布，消费方（cli 等）一次性适配；
2. **前缀缓存结构不可破坏**：`buildTools` 每次现取须保证工具表**顺序稳定**（代理工具在前、动态在背后注册表）；避免向工具参数 schema 写入频繁变化的 enum（如需披露，倾向描述文本而非 enum，待实施时验证取舍）；
3. **默认路径零 IO 语义**：send 默认不 load 依赖"启动已 load 一次"；兜底链（send→init→ensure load）保证可用但首次隐式重量操作，错误须携带阶段上下文；
4. **权限默认全拒的连带**：每个 def（含子 agent def）必须显式声明权限方有工具；迁移存量配置时注意 def 完整性；
5. **definition.messages 防污染**：构造时克隆快照（沿 0.9.3 修复经验）；history 视为完整对话；
6. **父子环境继承边界**：仅继承环境（同 ws、缺省模型），不继承权限——实施时防止"逃逸式继承"回归。

## 十一、剩余待确认开放点（实施前/中处理）

- [ ] core 钩子全集最终清单（是否沿用现有 `onBeforeSend` / `onAfterSend` / `onInnerLoop*` / `onToolCall` / `onUnknownTool` 全部，仅改签名）
- [ ] 随附行为插件集合与默认启用策略（ContextGuard / AutoRefresh / UnknownToolHint 等）
- [ ] 命名收尾：领域插件命名（与行为插件区分）、Workspace/AgentEnv 取舍、`SdkCallbackTool` 命名
- [ ] definition schema：默认"零变化"，仅实现确有必要时按需增补字段（需说明理由）
- [ ] 版本号：core major / sdk major 数值
- [ ] 前缀缓存与 enum/描述文本披露方式的最终取舍（`load_skill` / `load_mcp` 参数披露）

## 十二、可选后续（不在本次范围）

- [ ] 若未来需要"code-first 直挂工具逃生口"，评估 `agent.use(tool)`（本次按奥卡姆原则暂不引入）
- [ ] 非文件系统环境（纯 API 配置）时评估 `AgentEnv` 作为 `Workspace` 之上的抽象
