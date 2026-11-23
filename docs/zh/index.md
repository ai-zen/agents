---
title: AI-Zen Agents
description: AI-Zen Agents 的门面：四层（内核、能力面与运行时、宿主、客户端）、分层的判据、仓里的包，以及从这里往哪读。
outline: deep
---

# AI-Zen Agents

一套自己部署的 agent 运行时。这里的 agent 是进程内的一个对象，带一个 inbox 与两个循环；仓里其余的东西，要么给它能力，要么让它活着、能被连上，要么把它做过的事写下来。

## 四层

```
终端客户端 · 桌面端                       各在自己的仓里，各自把
        │                                @ai-zen/agents-client 捆进产物
        │  一条 WebSocket；tRPC 跑在上面，往回一条事件流
        ▼
@ai-zen/agents-host      会话行与消息、项目、连接与凭证、
        │                通知、Asset、提问、搜索、用户可见文案
        │  procedure 进来，事件出去
        ▼
@ai-zen/agents-sdk       能力面：Scope、内置工具、技能、SubAgent、MCP、PeerSession。
        │                运行时：唤醒 Agent、登记谁活着、给另一段会话发话、拆容器
        ▼
@ai-zen/agents-core      一个 Agent：inbox、外循环、内循环、isInputPaused 与 isOutputPaused、
                         事件名、插件钩子
```

四层从上往下都可以整块换掉：客户端可以换成一个脚本，宿主可以换成一个空实现，下面几层的行为一条不变。客户端不在本仓：终端客户端与桌面端在各自的仓里，本仓只提供它们内联进去的那一层 `@ai-zen/agents-client`。

只有宿主有契约面，它分两半。一半是按域分的 procedure，第一段就说明这条路径碰的是什么：`runtime.agent.*` 与 `runtime.scope.*` 碰的是进程里的活对象；`config.*` 只要一份配置文件（`config.endpoints.*`、`config.models.*`、`config.imageModels.*`、`config.presets.update`、`config.agents.*`、`config.mcp.*`）；其余是业务域，读写自己的东西 —— `session.*`、`workspace.*`、`asset.*`、`notice.*`、`question.*`、`handoff.*`、`search.*`，另有 `host.*` 管进程本身，`events` 是那条流。另一半是一条订阅，宿主发出来的每一条事实都从它走 —— 客户端因此不会去问「有没有变」。

## 分层的判据

不经过宿主，只用 `@ai-zen/agents-core` 与 `@ai-zen/agents-sdk` 也能组装出事件驱动、常驻、能互相通信的 agent：一段会话被唤醒之后，取走 `InboxEntry`、开跑、回到闲都不需要有人在调用栈上等它；另一段会话能给它发话。这是分层唯一要过的那一关。

有一块代码如果只是因为宿主恰好在才存在 —— 谁活着、`Scope` 什么时候拆、一段会话叫什么 —— 做法是把它搬进运行时，不是在宿主里再开一条路。

## 仓库里的包

| 包 | 做什么 | 不做什么 |
|---|---|---|
| `@ai-zen/agents-core` | 跑一个 `Agent`：inbox、按批取走的外循环、发请求与跑工具的内循环、`isInputPaused` / `isOutputPaused` 那两格连同它们的方法与现读、事件名、插件钩子 | 不知道会话与项目、不碰库与任何持久化、不碰网络与凭证、不碰语言与文案、不读配置文件、不做能力发现 |
| `@ai-zen/agents-sdk` | 两半。能力面：按目录一份的 `Scope`，装工具、技能、`SubAgent`、MCP 服务器与 `PeerSession` 那三个工具；模型的三级解析；交接。运行时：按交上来的 `WakeMaterials` 唤醒 `Agent`、留一份「谁活着」的登记、给另一段会话 `post()`、最后一段会话没了就拆掉容器 | 不碰库、不碰连接与凭证、不碰会话行、不出用户可见文案；会话对它只是一个不透明的身份 |
| `@ai-zen/agents-host` | 一个 SQLite 文件里的行与表、连接与凭证、客户端杂项（通知、`Asset`、提问、搜索）、用户可见文案与语言、单实例的发现文件、命令行 | 不装 `Agent`、不记谁活着、不决定 `Scope` 什么时候拆、不判配置合不合法、不算 MCP 合并、不管连接与重连 |
| `@ai-zen/agents-client` | 到宿主的连接：拉起一台、读发现文件与凭证交付文件、凭证来源、重连 | 不发版（`private: true`，被终端与桌面各捆进自己的产物）；不被 `core` 与 `sdk` import |
| `@ai-zen/agents-logger` | 一个进程一个日志文件，零依赖；`info` / `warn` / `error` 只从一个口出 | 不在装配根之外的地方被创建 |
| `@ai-zen/agents-testing` | 几个包共用的测试件，把 `@ai-zen/fake-llm` 转出去，调用点只认一个 import | 不进生产依赖图 |
| `@ai-zen/fake-llm` | 一个 OpenAI 兼容的假端点：交给它一条目标消息，它把那条消息本该到达的那一串 delta 放回来 | 不连真实的服务方，也不对「模型该答什么」有意见 |

## 从这里往哪读

| 页 | 讲什么 |
|---|---|
| [快速开始](getting-started.md) | 从零开始：装依赖、跑测试、起一台宿主、拿凭证、把客户端连上去，以及只用 `core` 与 `sdk` 的一条路 |
| [架构](architecture.md) | 为什么这么切：四层的判据、活物的四问与五条判据、事实与材料的方向、事件与持久化的落点 |
| [Core API](core.md) | 内核：一个 `Agent` 的 inbox、两个循环、两道开关、事件名、插件钩子 |
| [SDK](sdk.md) | 能力面与运行时：`Scope`、模型解析、交接、唤醒与发话 |
| [只用 core 与 Scope](scope.md) | 不装 `AgentRuntime`、不碰宿主：能力那一层单独怎么用 |
| [MCP](mcp.md) | 服务器的配置从哪来、怎么连、工具怎么给模型 |

## 许可

MIT。
