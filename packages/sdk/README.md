# @ai-zen/agents-sdk

AI-Zen SDK — 共享业务逻辑层，为 CLI 和 Desktop 提供统一的 Agent 运行时。开箱即用，包含预置厂商配置、默认 Agent 和 SubAgent。

## 真相源

**[`docs/sdk-design.md`](./docs/sdk-design.md)** 是本包的唯一设计真相源。所有实现必须与文档一致。
## 架构

```
CLI ──┐
      ├── @ai-zen/sdk ──┐
Desktop ──┘              │
                    LLM API
```

## 模块分层

```
types        ← 纯类型，零业务依赖
config       ← 读写 config.json + 迁移 + 内存缓存 + 原子写入
crud         ← 实体 CRUD（Endpoints / Models / Agents / Conversations / Draft）
capabilities ← 能力发现与装配（内置 + 用户 + MCP + Skill + SubAgent）
runtime      ← Provider + 模型工厂 + Agent 组装 + MCP 连接管理 + 任务迁移
plugin       ← Agent 插件（autoMigrate、autoDraft、autoRefreshTools）
shared       ← 日志、错误
```

依赖方向：`plugin → runtime → capabilities → crud → config → types`，上层依赖下层，反之不行。

## 核心概念

| 实体 | 说明 |
|------|------|
| **Provider** | 全局上下文，持有配置、路径、模型工厂、MCP 管理器 |
| **Capabilities** | 全局能力注册表（发现 → 过滤 → 实例化） |
| **SdkAgent** | 继承 Core Agent，携带 SDK 元数据，支持 `use()` 插件注册 |
| **AgentPlugin** | 插件接口（`onInit`, `onBeforeSend`, `onAfterSend`, `onInnerLoopStart`, `onInnerLoopEnd`） |
| **Endpoint** | API 端点（baseUrl + apiKey） |
| **Model** | 模型配置，绑定 Endpoint |
| **SubAgent** | 有 `function` 字段的 Agent，可被其他 Agent 作为工具调用 |
| **Conversation** | 对话记录 |
| **Draft** | 当前会话自动保存 |

## 权限模型

四维度各自独立，allow/deny 互斥，无命中即拒绝，权限即披露（deny 掉的项对 LLM 完全不可见）。

```
Agent.permissions
  ├── tools:      { allow: string[] } | { deny: string[] }
  ├── skills:     { allow: string[] } | { deny: string[] }
  ├── mcps:       { allow: string[] } | { deny: string[] }
  └── subagents:  { allow: string[] } | { deny: string[] }
```

## 消费模式

```typescript
const provider = new Provider({ config, ...paths });
const agent = createAgent(provider, "my-agent");
agent.use(new AutoMigratePlugin({ maxTokens, migrationAgent, onHandoff }));
agent.use(new AutoDraftPlugin({ draftsDir, agentId, modelId }));
agent.use(new AutoRefreshToolsPlugin());
await agent.init();
await agent.send("你好");
```

## 开发状态

| 模块 | 状态 |
|------|------|
| `types` | ✅ 已实现 — 核心实体、权限模型、MCP 类型完整 |
| `config` | ✅ 已实现 — ConfigManager + 出厂默认配置 + 一键 bootstrap |
| `crud` | ✅ 已实现 — Agent / Conversation / Draft 完整 CRUD |
| `capabilities` | ✅ 已实现 — 发现 + 权限过滤 + 安全预过滤 + 枚举披露 |
| `runtime` | ✅ 已实现 — Provider、Capabilities、createAgent、MCP 连接管理、任务迁移 |
| `plugin` | ✅ 已实现 — AutoMigratePlugin / AutoDraftPlugin / AutoRefreshToolsPlugin |
| `shared` | ✅ 已实现 — SdkError + 可注入 Logger |
| 测试 | ✅ 359 个测试，45 个文件，全通过（含真实 API 聊天 e2e） |

## 内置工具

| 工具 | 说明 |
|------|------|
| `cwd` | 获取当前工作目录 |
| `readFile` | 读取文件 |
| `writeFile` | 写入文件 |
| `exec` | 执行命令（支持 `timeout` 超时参数） |
| `exec_async` | 异步执行命令，启动后立即返回，不等待结果 |
| `mkdir` | 创建目录 |
| `rm` | 删除文件或目录 |
| `glob` | 使用 glob 模式扫描查找文件 |
| `ls` | 列出目录内容 |
| `exist` | 检查文件或目录是否存在 |
| `findText` | 在文件中搜索文本或正则 |
| `downloadFile` | 从 URL 下载文件并保存到本地 |
| `rename` | 重命名或移动文件/目录 |
| `copy` | 复制文件或目录 |
| `batchEdit` | 批量编辑文件文本 |
| `edit` | 编辑文件中的文本 |
| `sleep` | 等待指定毫秒数后继续 |

条件注入（需配置 `imageModels`）：

| 工具 | 说明 |
|------|------|
| `generateImage` | 根据文字描述生成图片 |

## 内置插件

| 插件 | 说明 |
|------|------|
| `AutoMigratePlugin` | 上下文超限时自动触发任务迁移，生成交接文档，透明替换 Agent |
| `AutoDraftPlugin` | 每次 `send()` 后自动保存当前消息历史到 draft 文件 |
| `AutoRefreshToolsPlugin` | 每次 `send()` 前重新扫描文件系统，刷新工具列表 |

## 设计原则

参见项目根 [`GOAL.md`](../../GOAL.md)：

1. 逻辑自洽
2. 设计为先，文档为准
3. 对称、统一
4. 去除过度设计
5. 奥卡姆剃刀
6. 即时重构，保持分层
7. 测试是基石
