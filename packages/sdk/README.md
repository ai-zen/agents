# @ai-zen/agents-sdk

> 🚧 **开发中** — 核心模块已完成，P0 阻塞项已消除，当前处于完善阶段。

AI-Zen SDK — 共享业务逻辑层，为 CLI 和 Desktop 提供统一的 Agent 运行时。

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
runtime      ← Agent 组装 + 对话生命周期 + 任务迁移 + MCP 连接管理
session      ← 会话包装（插件链：autoMigrate、autoDraft 等）
shared       ← 日志、错误
```

依赖方向：`session → runtime → capabilities → crud → config → types`，上层依赖下层，反之不行。
Session 额外依赖 `@ai-zen/agents-core`。

## 核心概念

| 实体 | 说明 |
|------|------|
| **Endpoint** | API 端点（baseUrl + apiKey） |
| **Model** | 模型配置，绑定 Endpoint |
| **Agent** | 可对话的 AI 人格，含提示词和权限 |
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

## 开发状态

| 模块 | 状态 |
|------|------|
| `types` | ✅ 已实现 — 核心实体、权限模型、MCP 类型完整 |
| `config` | ✅ 已实现 — 原子读写 + 默认 Agent 初始化 |
| `crud` | ✅ 已实现 — Agent / Conversation / Draft 完整 CRUD |
| `capabilities` | ✅ 已实现 — 发现 + 权限过滤 + 安全预过滤 + 枚举披露 |
| `runtime` | ✅ 已实现 — Agent 组装、Skill 子 Agent、任务迁移、MCP 连接管理 |
| `session` | ✅ 已实现 — Session 构建器 + autoMigrate + autoDraft 插件 |
| `shared` | ✅ 已实现 — SdkError + 可注入 Logger |
| 测试 | ✅ 191 个测试，25 个文件，全通过 |

## Session 插件

SDK 提供薄包装层 `Session`，通过插件链扩展 Core Agent 行为：

| 插件 | 说明 |
|------|------|
| `autoMigrate` | 上下文超限时自动触发任务迁移，生成交接文档，透明替换 Agent |
| `autoDraft` | 每次 `send()` 后自动保存当前消息历史到 draft 文件 |

```ts
const session = await createSession({ agent, model })
  .use(autoMigrate({ maxTokens, migrationAgent }))
  .use(autoDraft({ draftsDir, agentId }))
  .init();

await session.send("你好");
```

## 设计原则

参见项目根 [`GOAL.md`](../../GOAL.md)：

1. 逻辑自洽
2. 设计为先，文档为准
3. 对称、统一
4. 去除过度设计
5. 奥卡姆剃刀
6. 即时重构，保持分层
7. 测试是基石
