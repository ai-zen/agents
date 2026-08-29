---
title: 快速开始
description: 环境要求、安装、构建，以及用 core 库快速创建第一个 Agent 与工具调用示例。
outline: deep
---

# 快速开始

本页带你从零跑通 `@ai-zen/agents` 框架。你既可以只使用底层的 `@ai-zen/agents-core`，也可以使用更完整的 `@ai-zen/agents-sdk`。

## 环境要求

| 项 | 要求 |
|----|------|
| Node.js | 18+ |
| pnpm | 8.0.0+（或先运行 `corepack enable`） |
| API Key | 任意 OpenAI 兼容端点（OpenAI / DeepSeek / 智谱等），经 `baseURL` 指定 |

> 运行时直接基于官方 `openai` npm 包，因此只要是 OpenAI 兼容的 vendored 端点（含 `baseURL`）均可接入。

## 安装

克隆仓库并安装依赖：

```bash
git clone <your-repo-url>
cd agents
pnpm install
```

构建 core 包（`packages/core` 编译为 `dist/`）：

```bash
pnpm build-core
```

构建 SDK 包：

```bash
pnpm build-sdk
```

如需直接作为依赖使用 `@ai-zen/agents-core`：

```bash
npm install @ai-zen/agents-core
```

## 第一个 Agent（core）

`Agent` 直接运行在官方 OpenAI SDK 之上，无需自建请求层：

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({
  apiKey: "sk-xxx",
  baseURL: "https://api.openai.com/v1",
});

const agent = new Agent({
  client,
  model: "gpt-4o",
  modelConfig: { temperature: 0.7 },
});

agent.append(Message.System("You are an AI assistant."));

await agent.send("Hello, please introduce yourself.");

console.log(agent.messages.at(-1)?.content);
```

> `client` 是 `openai` SDK 实例，任何 OpenAI 兼容厂商都可通过 `baseURL` 接入（DeepSeek、智谱 BigModel、兼容端点等）。

## 带工具的多轮对话

自定义工具需继承 `Tool`，声明 `function` 定义并实现 `exec(ctx)`：

```ts
import { Agent, Message, Tool, ToolCallContext } from "@ai-zen/agents-core";

class WeatherTool extends Tool {
  function = {
    name: "get_weather",
    description: "Query the weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  };

  async exec(ctx: ToolCallContext) {
    const { city } = ctx.parsedArgs;
    return `The weather in ${city} today is sunny, 22°C.`;
  }
}

const agent = new Agent({
  client,
  model: "gpt-4o",
  tools: [new WeatherTool()],
});

agent.append(Message.System("You are a weather assistant. You can use tools."));

// Agent 自动处理工具调用与多轮递归对话
await agent.send("What is the weather like in Beijing and Shanghai today?");
```

## 用 SDK 创建 Agent（能力层）

SDK 提供了一键组装：`ConfigManager`（配置与出厂默认）→ `Provider.create()`（全局上下文 + 能力发现）→ `createAgent()`（产出 `SdkAgent`）。

```ts
import { Provider, createAgent, ConfigManager, AutoMigratePlugin, AutoRefreshToolsPlugin, TaskMigrationService } from "@ai-zen/agents-sdk";

// 1. 初始化配置（幂等，已有文件不覆盖）
const mgr = new ConfigManager("~/.ai-zen/config.json");
const { config } = await mgr.bootstrap();

// 2. 创建 Provider（每个工作目录一个实例）
const provider = await Provider.create({
  config,
  cwd: "/path/to/workspace-a",
  agentsDir: "~/.ai-zen/agents",
  subAgentsPaths: ["~/.ai-zen/sub-agents"],
  skillsPaths: ["~/.ai-zen/skills"],
  toolsPaths: ["~/.ai-zen/tools"],
  mcpPaths: ["~/.ai-zen/mcp.json"],
});

// 3. 创建 Agent 并注册插件
const agent = await createAgent(provider, config.defaultAgent ?? "default");
agent.use(new AutoMigratePlugin({
  service: new TaskMigrationService({ onMigrated: (mctx) => { /* 保存回执 */ } }),
  maxTokens: 250_000,
}));
agent.use(new AutoRefreshToolsPlugin());
await agent.init();

// 4. 对话（消息由 agent.messages 持有）
const messages = await agent.send("你好");
```

## 测试

```bash
# 运行 core + sdk 全部测试
pnpm test

# 仅 core
pnpm --filter @ai-zen/agents-core test

# 仅 sdk
pnpm --filter @ai-zen/agents-sdk test
```

## 下一步

- [架构](architecture.md) —— 理解 core / sdk 分层与依赖方向
- [Core API](core.md) —— 插件、ToolCallContext、事件系统详解
- [SDK](sdk.md) —— 能力管线、权限、内置工具、任务迁移
