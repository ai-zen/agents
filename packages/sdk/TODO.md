# TODO

> 接手此项目请先读 `GOAL.md`（设计原则）和 `docs/sdk-design.md`（设计真相源），
> 再读 [`TODO2.md`](./TODO2.md) 了解当前改造计划。

---

## 当前架构概览

```
agents/
├── packages/
│   ├── core/                  ← @ai-zen/agents-core  基础框架（Agent, Message, Tool, Model, RAG）
│   ├── sdk/                   ← @ai-zen/agents-sdk   业务逻辑层（本包）
│   │   ├── types/             ← 纯类型，零业务依赖
│   │   ├── config/            ← 读写 config.json + 迁移 + 缓存
│   │   ├── crud/              ← 实体 CRUD
│   │   ├── capabilities/      ← 能力发现 + 权限过滤 + 实例化
│   │   ├── runtime/           ← Provider + 模型工厂 + Agent 组装 + MCP + 任务迁移
│   │   ├── plugin/            ← Agent 插件（autoMigrate, autoDraft, autoRefreshTools）
│   │   └── shared/            ← 日志、错误
│   ├── cli/                   ← @ai-zen/agents-cli   命令行（待接入 SDK）
│   └── webui/                 ← @ai-zen/agents-webui Web 界面
├── GOAL.md                    ← 项目设计原则（必读）
├── AI_README.md               ← AI 助手行为准则
└── README.md                  ← 项目总览
```

### 模块分层

```
plugin ──> runtime ──> capabilities ──> crud ──> config ──> types
  │           │
  │           └──> shared
  │
  └──> @ai-zen/agents-core (Agent, Message)
```

### 核心类

| 类 | 说明 |
|---|------|
| `Provider` | 全局上下文，持有配置、路径、模型工厂、MCP 管理器 |
| `Capabilities` | 全局能力注册表（发现 → 过滤 → 实例化） |
| `SdkAgent` | 继承 Core Agent，携带 provider/definition/permissions/caps，支持 `use()` 插件注册 |
| `AgentPlugin` | 插件接口（`onInit`, `onBeforeSend`, `onAfterSend`） |

### 消费模式

```typescript
const provider = new Provider({ config, ...paths });
const agent = createAgent(provider, "my-agent");
agent.use(autoMigrate({ maxTokens, migrationAgent, onHandoff }));
agent.use(autoDraft());
agent.use(autoRefreshTools());
await agent.init();
await agent.send("你好");
```

---

## 当前状态

- ✅ TypeScript strict 模式，零编译错误
- ✅ 171 个测试全部通过（21 个文件）
- ⚠️ CLI 尚未接入 SDK，自己维护了一套重复实现
- ⚠️ CLI 有 25 个测试失败（Windows 路径 + 缺少 SDK 构建产物）

---

## 待完成任务

### P0 — 核心通路

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 1 | `SdkAgent.use()` / `init()` 实现 | 在 SdkAgent 上实现插件注册和初始化勾子 | ⬜ |
| 2 | `plugin/` 目录搬迁 | 从 `session/` 搬移到 `plugin/`，改造为 `AgentPlugin` | ⬜ |
| 3 | `autoMigrate` 改造 | `SessionPlugin` → `AgentPlugin`，去掉 SessionContext 依赖 | ⬜ |
| 4 | `autoDraft` 改造 | 从 `ctx.agent.provider` 自发现路径，零参数 | ⬜ |
| 5 | `autoRefreshTools` 改造 | 同上 | ⬜ |
| 6 | 删除 `src/session/` | 整个目录 | ⬜ |
| 7 | `Provider.createModel()` 改为同步 | Core 需提供 `chatCompletionSync` | ⬜ |
| 8 | `createAgent` 改为同步 | 依赖 #7 | ⬜ |
| 9 | `AgentToolLazy.buildAgent` 注入 | 在 `createAgent` 中创建 SubAgent 时注入 provider/model 回调 | ⬜ |
| 10 | `discoverUserTools` 安全加载 | 安全的 `require()` 加载 `.js` 文件，含沙箱/错误隔离 | ⬜ |

### P1 — MCP 闭环

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 11 | SDK 内置 stdio transport | 子进程 spawn、stdin/stdout JSON-RPC | ⬜ |
| 12 | SDK 内置 HTTP transport | HTTP SSE 连接 + 请求/响应 | ⬜ |
| 13 | OAuth token 持久化 | `mcp-oauth/` 目录 token 读写 + 授权码交换 + token 刷新 | ⬜ |
| 14 | `McpTransport` 补充方法 | `callTool` / `readResource` / `listPrompts` / `getPrompt` | ⬜ |
| 15 | `call_mcp_tool` 完整实现 | 通过 transport.callTool 调用 | ⬜ |
| 16 | `read_mcp_resource` 完整实现 | 通过 transport.readResource 调用 | ⬜ |

### P2 — 收尾

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 17 | 端到端测试 | `createAgent` → `agent.use()` → `agent.init()` → `agent.send()` 完整链路 | ⬜ |
| 18 | CLI 接入 SDK | 删 CLI 中重复的 agent-creator、工具发现、draft 逻辑 | ⬜ |
| 19 | Skill 辅助文件加载 | `loadSupportingFile` 机制，加载 `scripts/`、`references/`、`assets/` | ⬜ |
| 20 | Skill 预算管理 | 按使用频次排序，低频 Skill 加载后可能被任务迁移截断 | ⬜ |
| 21 | MCP Prompts 支持 | `prompts/list`、`prompts/get` 及动态提示工具 | ⬜ |
| 22 | MCP Resources 模板与订阅 | `resources/templates/list`、`resources/subscribe` | ⬜ |

### P3 — 可延后

| # | 步骤 | 说明 | 状态 |
|---|------|------|:--:|
| 23 | MCP Roots / Sampling | MCP Client 特性，SDK 层暂不处理，由上层实现 | ⬜ |
| 24 | `generateImage` 扩展更多服务 | 当前仅支持 ZhipuImage，后续可扩展 DALL-E 等 | ⬜ |

---

## 已完成的历史工作

| # | 项 | 说明 |
|---|------|------|
| ✅ | Runtime → Provider | 全局上下文改名 |
| ✅ | Session 层移除 | 改为 SdkAgent 原生 `use()` / `init()` 插件机制 |
| ✅ | `resolveAgent` → `createAgent` | 一站式装配（待同步改为同步） |
| ✅ | `createSession` 移除 | 不再需要 Builder 包装层 |
| ✅ | `restoreSession` 移除 | 改为直接 `createAgent` + `agent.messages.push(...)` |
| ✅ | 工具装配三阶段 | Capabilities 统一管理发现 → 过滤 → 实例化 |
| ✅ | MCP 连接生命周期 | McpConnectionManager（重连、退避、超时、状态机） |
| ✅ | 自动迁移 | autoMigrate 插件 + 交接文档 |
| ✅ | 自动保存 | autoDraft 插件 + 7 天过期清理 |
| ✅ | 自动刷新工具 | autoRefreshTools 插件 |
| ✅ | Skill 加载 | load_skill / call_skill_sub_agent |
| ✅ | 权限系统 | 四维度过滤 + ExcludeOptions + 枚举披露 |
| ✅ | BUILTIN_TOOLS 16 个 | 内置工具全部实现 |
| ✅ | generateImage 工具 | 条件注入，依赖 imageModels 配置 |
| ✅ | 工具去重 | 后注册覆盖先注册 |
| ✅ | Draft 7 天过期清理 | checkDraftForRestore |
| ✅ | `exec` 工具错误处理 | 补充 exitCode 返回 |
