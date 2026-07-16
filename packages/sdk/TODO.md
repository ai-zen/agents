# TODO

> 已迁移至 [`TODO2.md`](./TODO2.md) 作为当前开发方向。
>
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

## 已完成的历史工作

| # | 项 | 说明 |
|---|------|------|
| ✅ | Runtime → Provider | 全局上下文改名，表意更准确 |
| ✅ | Session 层移除 | 改为 SdkAgent 原生 `use()` / `init()` 插件机制 |
| ✅ | `resolveAgent` → `createAgent` | 一站式装配，纯同步 |
| ✅ | `createSession` 移除 | 不再需要 SessionBuilder/Plugin 包装层 |
| ✅ | `restoreSession` 移除 | 改为直接 `createAgent` + `agent.messages.push(...)` |
| ✅ | 工具装配三阶段 | Capabilities 统一管理发现 → 过滤 → 实例化 |
| ✅ | MCP 连接生命周期 | McpConnectionManager（重连、退避、超时、状态机） |
| ✅ | 自动迁移 | autoMigrate 插件 + 交接文档 |
| ✅ | 自动保存 | autoDraft 插件 + 7 天过期清理 |
| ✅ | 自动刷新工具 | autoRefreshTools 插件 |
| ✅ | Skill 加载 | load_skill / call_skill_sub_agent |
| ✅ | 权限系统 | 四维度过滤 + ExcludeOptions + 枚举披露 |
