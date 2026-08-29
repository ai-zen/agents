---
title: MCP
description: AI-Zen Agents SDK 对 Model Context Protocol 的支持 —— 连接生命周期、配置、动态加载工具与权限。
outline: deep
---

# MCP

AI-Zen Agents 在 **SDK 层**（`@ai-zen/agents-sdk`）提供对 **Model Context Protocol（MCP）** 的完整支持，基于官方 `@modelcontextprotocol/sdk` 的 `Client` + `Transport`。

## 能力总览

| 能力 | 说明 |
|------|------|
| 服务器发现 | 扫描 MCP 配置文件中的 `mcpServers` |
| 连接管理 | `McpConnectionManager` 全生命周期（连接 / 重连 / 空闲超时 / OAuth） |
| 惰性加载 | 通过 `load_mcp` / `call_mcp_tool` / `read_mcp_resource` 按需触发 |
| 权限 | **server 级信任**：连接后其工具 / 资源全可用（无 tool 级权限） |
| 传输 | `stdio`（子进程）与 `http` / `sse`（`StreamableHTTPClientTransport`） |

## MCP 配置

MCP 服务器配置格式（`mcp.json`）：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." },
      "description": "GitHub 仓库与 Issue 操作"
    },
    "postgres": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." },
      "description": "PostgreSQL 数据访问"
    }
  }
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `command` / `args` / `env` | stdio（子进程）配置 |
| `url` / `headers` | http / sse 配置 |
| `description` | 服务器描述，经 `load_mcp` 透传呈现给 LLM 参考 |
| `disabled` | 置 `true` 时跳过该服务器 |

**传输推断**：`type` / `transport` / `transportType` 字段优先；否则有 `command` → `stdio`，有 `url` → `http`。`disabled: true` 跳过，解析失败记日志并跳过。

配置文件路径（由各端 / `ConfigManager` 决定）：

```
~/.ai-zen/mcp.json     ← 用户级 MCP（出厂默认含 socket-pty 终端）
项目根/.mcp.json       ← 项目共享 MCP（可提交 git）
```

## McpConnectionManager（连接生命周期）

```ts
import { McpConnectionManager } from "@ai-zen/agents-sdk";

const mcpManager = new McpConnectionManager();
await mcpManager.connect("github", serverConfig, { idleTimeoutMs: 30 * 60 * 1000 });
```

| 方法 | 说明 |
|------|------|
| `getState(name)` | 返回 `disconnected` / `connecting` / `connected` / `error` |
| `getManifest(name)` | 返回 `McpServerManifest`（tools / resources / prompts） |
| `getClient(name)` | 返回底层 `Client` |
| `connect(name, config, options?)` | 建立连接，返回清单 |
| `disconnect(name)` | 断开指定服务器 |
| `disconnectAll()` | 断开全部 |
| `touch(name)` | 活跃心跳，重置空闲计时 |

`McpConnectOptions`：

| 选项 | 说明 |
|------|------|
| `idleTimeoutMs` | 空闲超时（默认 stdio 30min，http/sse 5min） |
| `autoReconnect` | 失败自动重连 |
| `maxRetries` | 最大重试次数（默认 3） |
| `isConfigError` | 判断哪些错误属于配置错误（不重试） |

**关键行为**：

- **按需调用**：连接后仅对 Server 声明的 capabilities 调用 `listTools` / `listResources` / `listPrompts`，避免 Method not found。
- **重连**：指数退避 `1s→2s→4s→8s→16s→30s`（封顶）；配置类错误不重试。
- **空闲超时**：每次操作 `touch()` 续期；计时器 `unref()` 不阻止进程退出。
- **list_changed**：服务端推送变更 → 自动刷新本地注册表。
- **测试注入**：构造函数可传自定义 transport / client 工厂。

状态机：

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

## 动态工具（惰性加载）

MCP 的工具**不预先注册**，而是注册「加载器工具」，由 LLM 在运行时按需触发：

| 工具 | 说明 |
|------|------|
| `load_mcp` | 参数 `server`（枚举 = 所有允许的 server，附描述）；返回结构化 JSON `{ tools, resources }`；已连接则 `touch` 续期并返回清单，未连接则 `mcpManager.connect()` |
| `call_mcp_tool` | 参数 `server` + `tool` + `arguments`；未连接时提示「请先使用 load_mcp 连接」；`isError` → 错误文本 |
| `read_mcp_resource` | 参数 `server` + `uri`；返回资源文本内容 |

这些工具是否注册由 `tools` 权限维度控制（如 `call_mcp_tool` 被禁用则切断整个 MCP 调用通道）。

## 权限注意

（见 [SDK](sdk.md) 的权限模型。）MCP 采用 **server 级信任**：一个 server 被允许后，其全部工具 / 资源对 Agent 可用。`mcps` 维度按 server 名匹配（如 `github` / `postgres`）。

## 深入

SDK 包内维护了更细的 MCP 文档：

- [`packages/sdk/docs/mcp-architecture.md`](../../packages/sdk/docs/mcp-architecture.md) —— MCP 架构
- [`packages/sdk/docs/mcp-basic-lifecycle.md`](../../packages/sdk/docs/mcp-basic-lifecycle.md) —— 连接生命周期
- [`packages/sdk/docs/mcp-client.md`](../../packages/sdk/docs/mcp-client.md) —— 客户端
- [`packages/sdk/docs/mcp-server.md`](../../packages/sdk/docs/mcp-server.md) 及 `mcp-server-*.md` —— 服务器 / 工具 / 资源 / 提示
- [`packages/sdk/docs/mcp-spec.md`](../../packages/sdk/docs/mcp-spec.md) —— 协议规范

## 相关文档

- [SDK](sdk.md) —— `Provider` 与 MCP 管理器集成
- [Core API](core.md) —— 运行时底层
- [架构](architecture.md) —— 分层与依赖方向
