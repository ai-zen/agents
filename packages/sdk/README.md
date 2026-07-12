# @ai-zen/agents-sdk

> 🚧 **开发中** — 当前处于从零构建阶段。

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
store        ← 实体 CRUD（Endpoints / Models / Agents / Conversations / Draft）
capabilities  ← 能力发现与装配（内置 + 用户 + MCP + Skill + SubAgent）
runtime      ← Agent 组装 + 对话生命周期 + 任务迁移
shared       ← 日志、错误
```

依赖方向：`runtime → capabilities → store → config → types`，上层依赖下层，反之不行。

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
| `types` | ⏳ 待实现 |
| `config` | ⏳ 待实现 |
| `store` | ⏳ 待实现 |
| `capabilities` | ⏳ 待实现 |
| `runtime` | ⏳ 待实现 |
| `shared` | ⏳ 待实现 |
| 测试 | ⏳ 零覆盖 |

## 设计原则

参见项目根 [`GOAL.md`](../../GOAL.md)：

1. 逻辑自洽
2. 设计为先，文档为准
3. 对称、统一
4. 去除过度设计
5. 奥卡姆剃刀
6. 即时重构，保持分层
7. 测试是基石
