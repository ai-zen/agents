---
title: AI-Zen Agents
description: AI-Zen Agents — 模块化 LLM Agent 框架（core + sdk monorepo），插件驱动运行时、能力管线、RAG 检索工具与 MCP 支持。
outline: deep
---

# AI-Zen Agents

AI-Zen Agents 是一个**模块化的 LLM Agent 框架**，以 pnpm workspace 形式组织为 monorepo。它提供从「对话运行时」到「业务能力管线」的分层能力，供 CLI / Desktop 等上层应用直接使用。

- **许可证**：MIT
- **npm 包**：`@ai-zen/agents-workspace`（workspace 根，私有）；公开子包为 `@ai-zen/agents-core` 与 `@ai-zen/agents-sdk`
- **当前版本**：workspace `2.0.0`；`@ai-zen/agents-core` `4.1.0`；`@ai-zen/agents-sdk` `0.9.1`

## 这是什么

框架围绕两个层次设计：

1. **`@ai-zen/agents-core`** —— 插件驱动的 Agent 运行时。直接运行于官方 `openai` SDK 之上，不维护自己的请求层。负责对话生命周期、流式输出、工具调用、多轮递归对话、事件与插件扩展。
2. **`@ai-zen/agents-sdk`** —— 建立在 core 之上的**引擎 / 能力层**。负责业务能力管线（发现 → 权限过滤 → 实例化）、Provider 全局上下文、MCP 连接管理、任务迁移，以及内置文件/命令工具集。

## 项目结构

```bash
agents/
├── packages/
│   ├── core/    # @ai-zen/agents-core — Agent / Message / Tool / 插件机制
│   └── sdk/     # @ai-zen/agents-sdk — Provider / 能力管线 / MCP / 内置工具
├── package.json # workspace 根（私有）
└── pnpm-workspace.yaml
```

## 核心能力

| 能力 | 说明 | 详见 |
|------|------|------|
| 插件驱动运行时 | `AgentPlugin` + `HookResult` 短路语义 + `dispatchHook` 事件/插件统一入口 | [Core API](core.md) |
| 模块化工具 | `Tool` / `CallbackTool` / `AgentTool` / `AgentToolLazy` / `IndexedSearchTool` | [Core API](core.md) |
| 能力管线 | 发现 → 权限过滤 → 实例化（内置 / 用户 / Skill / MCP / SubAgent） | [SDK](sdk.md) |
| 权限模型 | 四维度（tools / skills / mcps / subagents），权限即披露 | [SDK](sdk.md) |
| MCP 支持 | `McpConnectionManager` + 惰性加载工具（`load_mcp` 等） | [MCP](mcp.md) |
| 检索 / 检索增强 | RAG 已移除，检索由搜索工具承担 | [检索与 RAG](rag.md) |

## 架构分层

```
上层应用（CLI / Desktop）
        │
        ▼
@ai-zen/agents-sdk  ──►  @ai-zen/agents-core  ──►  openai 官方 SDK
  （能力管线 / Provider / MCP）      （Agent 运行时）     （LLM API）
        │
        ▼
LLM API / MCP 服务器
```

依赖方向（SDK 内部）：`plugin → runtime → capabilities → crud → config → types`。上层依赖下层，反之不行。详见 [架构](architecture.md)。

## 快速开始

```bash
git clone <your-repo-url>
cd agents
pnpm install
pnpm build-core
```

最小可运行示例：

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({ apiKey: "sk-xxx", baseURL: "https://api.openai.com/v1" });
const agent = new Agent({ client, model: "gpt-4o", modelConfig: { temperature: 0.7 } });
agent.append(Message.System("You are an AI assistant."));
await agent.send("Hello, please introduce yourself.");
console.log(agent.messages.at(-1)?.content);
```

完整安装与使用见 [快速开始](getting-started.md)。

## 文档索引

- [快速开始](getting-started.md) —— 环境要求、安装、构建、第一个 Agent
- [架构](architecture.md) —— core / sdk 分层与模块依赖
- [Core API](core.md) —— 核心运行时公开 API（Agent / Message / Tool / 插件）
- [SDK](sdk.md) —— 能力层（Provider / 权限 / 内置工具 / 迁移）
- [检索与 RAG](rag.md) —— 检索能力现状、RAG 移除说明
- [MCP](mcp.md) —— Model Context Protocol 支持

## 相关仓库

`@ai-zen/cli`（交互式 AI Agent 终端）与 Web UI 曾属于本 monorepo，已迁移至独立仓库或停止维护。详见仓库根 `README.md`。

## 许可证

MIT。见 [LICENSE](../../LICENSE)。
