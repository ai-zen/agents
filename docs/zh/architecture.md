---
title: 架构
description: AI-Zen Agents 的 core / sdk 分层、pnpm monorepo 结构、模块依赖方向与对话流程。
outline: deep
---

# 架构

AI-Zen Agents 是一个 **pnpm monorepo**，拆分为两个公开子包（`@ai-zen/agents-core` 与 `@ai-zen/agents-sdk`），并通过 workspace 根 `@ai-zen/agents-workspace`（私有）统一编排。

## 分层总览

```
上层应用（CLI / Desktop）
        │
        ▼
@ai-zen/agents-sdk  ──►  @ai-zen/agents-core  ──►  openai 官方 SDK
 （能力管线 / Provider / MCP / 内置工具） （Agent 运行时）   （LLM API）
        │
        ▼
LLM API / MCP 服务器（openai SDK / @modelcontextprotocol/sdk）
```

- **Core** 是框架「内核」：只关心对话运行时的通用抽象，不感知权限、文件系统等业务。
- **SDK** 是「引擎层」：为 CLI / Desktop 提供统一能力，持有能力管线、Provider、MCP、内置工具。

## 子包职责

| 包 | 版本 | 职责 |
|----|------|------|
| `@ai-zen/agents-core` | 4.1.0 | `Agent` / `Message` / `Tool` / `ToolCallContext`、插件机制（`AgentPlugin` + `HookResult` + `dispatchHook`）、事件系统 |
| `@ai-zen/agents-sdk` | 0.9.1 | `Provider` 全局上下文、能力管线（发现 → 过滤 → 实例化）、权限模型、MCP 生命周期、任务迁移、内置工具、`ConfigManager` |

> workspace 根包 `@ai-zen/agents-workspace` 为私有，版本 `2.0.0`。该版本号与两个公开子包各自独立的版本并不一致，仅用于 workspace 编排。

## SDK 内部模块分层

```
types        ← 纯类型，零业务依赖（含 ToolEnv、权限、MCP 类型）
config       ← ConfigManager + constants：读写 config.json + 迁移 + 原子写入 + 出厂默认
crud         ← 能力实体 CRUD（AgentDefinition 等；会话/草稿由各端持久化）
capabilities ← 能力发现与装配（内置 + 用户 + MCP + Skill + SubAgent）
runtime      ← Provider + 模型工厂 + Agent 组装 + MCP 连接管理 + 任务迁移 + SdkCallbackTool
plugin       ← Agent 插件（autoMigrate / autoRefreshTools / contextGuard / unknownToolHint）
shared       ← 日志、错误
```

**依赖方向**：

```text
plugin → runtime → capabilities → crud → config → types
              │
              └──→ shared
              └──→ @ai-zen/agents-core
```

上层依赖下层，反之不行；同层模块互不依赖。三方依赖关系详见 [`packages/sdk/docs/sdk-design.md`](../../packages/sdk/docs/sdk-design.md)（该文档是 SDK 的单一设计真相源）。

## Core 运行时设计

### 插件是唯一扩展点

`AgentContext` 不再提供任何 `onXxx` 构造钩子。**插件（`agent.use(plugin)`）是扩展 Agent 的唯一方式**。所有钩子统一走 `dispatchHook`：

1. 先发出**非阻塞** kebab-case 事件（`agent.events.emit`，只通知、不干预）；
2. 再按注册顺序**阻塞**调用插件钩子，任一返回字符串即短路。

`HookResult = string | void | Promise<string | void>`：

- **string** → 短路（拒绝 / 中断 / 提供结果，语义随钩子而定）；
- **undefined / void** → 放行（继续后续插件或默认行为）。

### 对话流程（一次 `send()`）

```
send(content)
  ├── onBeforeSend 钩子 → 可能拒绝
  ├── 追加 User 消息
  └── run()
        ├── onInnerLoopsStart 钩子（每次 send 一次）
        ├── 内循环（只要还有工具调用就继续）
        │     ├── 开头追加 Assistant 占位（Pending）
        │     ├── onInnerLoopStart 钩子（每次请求前）
        │     ├── client.chat.completions.create(...)（官方 SDK 流式）
        │     ├── parseStreamData() → content / reasoning_content / tool_calls
        │     ├── handleToolCall() → 执行工具调用
        │     │     ├── onToolCall 拦截钩子 → 可能拒绝
        │     │     ├── onUnknownTool 插件 → 兜底提示
        │     │     └── Tool.exec(ctx) 执行匹配工具
        │     └── onInnerLoopEnd 钩子
        ├── onInnerLoopsEnd 钩子
        └── 返回 this.messages
  └── onAfterSend 钩子
```

ToolCallContext 同一实例贯穿「拦截决策（`onToolCall`）→ 执行（`Tool.exec`）」。

## SDK 能力管线：三阶段

```
1. 发现（refresh）    discoverBuiltinTools / discoverUserTools / discoverSubAgents / discoverSkills / discoverMcpServers
2. 过滤（filter）     安全预过滤 + 权限四维过滤 + 工具 isAvailable 过滤
3. 实例化（instantiate） 名称 → Tool 实例 / 动态工具 / SubAgent 延迟构建 / 去重
```

`Provider` 是 SDK 的唯一入口对象，持有配置、路径、`cwd`、模型工厂与 MCP 管理器。每个 `Provider` 绑定一个工作目录（`cwd`），实现多会话并行互不干扰。详见 [SDK](sdk.md)。

## 多会话并行

内置工具以 `ToolEnv.cwd` 为相对路径基准，**不再依赖全局 `process.cwd()`**。CLI / Desktop 可同时持有多个 `Provider` 服务不同工作目录的会话。

```
Desktop（workspaces.json）
   │ 每 workspace 一个 Provider（1:1）
   ▼
Provider(cwd) ──ToolEnv──▶ 工具实例（cwd/config 注入）
   │
   ▼
createAgent(provider, agentId) → SdkAgent（并行 send）
```

## 相关文档

- [Core API](core.md) —— 运行时公开 API 与实现细节
- [SDK](sdk.md) —— 能力层公开 API
- [检索与 RAG](rag.md) —— 检索能力现状
- [MCP](mcp.md) —— MCP 接入与生命周期
- [`packages/sdk/docs/sdk-design.md`](../../packages/sdk/docs/sdk-design.md) —— SDK 设计真相源
