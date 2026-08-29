---
title: Quick Start
description: Environment requirements, installation, build, and examples for quickly creating your first Agent and tool calls with the core library.
outline: deep
---

# Quick Start

This page walks you through getting the `@ai-zen/agents` framework running from scratch. You can use only the low-level `@ai-zen/agents-core`, or the more complete `@ai-zen/agents-sdk`.

## Environment requirements

| Item | Requirement |
|----|------|
| Node.js | 18+ |
| pnpm | 8.0.0+ (or run `corepack enable` first) |
| API Key | Any OpenAI-compatible endpoint (OpenAI / DeepSeek / Zhipu, etc.), specified via `baseURL` |

> The runtime is directly based on the official `openai` npm package, so any OpenAI-compatible vendored endpoint (including `baseURL`) can be used.

## Installation

Clone the repository and install dependencies:

```bash
git clone <your-repo-url>
cd agents
pnpm install
```

Build the core package (`packages/core` compiles to `dist/`):

```bash
pnpm build-core
```

Build the SDK package:

```bash
pnpm build-sdk
```

To use `@ai-zen/agents-core` directly as a dependency:

```bash
npm install @ai-zen/agents-core
```

## Your first Agent (core)

`Agent` runs directly on the official OpenAI SDK, so there is no need to build your own request layer:

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

> `client` is an `openai` SDK instance; any OpenAI-compatible vendor can be accessed via `baseURL` (DeepSeek, Zhipu BigModel, compatible endpoints, etc.).

## Multi-turn dialog with tools

To define a custom tool, extend `Tool`, declare the `function` definition and implement `exec(ctx)`:

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

// The Agent automatically handles tool calls and multi-turn recursive dialogs
await agent.send("What is the weather like in Beijing and Shanghai today?");
```

## Creating an Agent with the SDK (capability layer)

The SDK provides one-click assembly: `ConfigManager` (config & factory defaults) → `Provider.create()` (global context + capability discovery) → `createAgent()` (produces an `SdkAgent`).

```ts
import { Provider, createAgent, ConfigManager, AutoMigratePlugin, AutoRefreshToolsPlugin, TaskMigrationService } from "@ai-zen/agents-sdk";

// 1. Initialize config (idempotent; existing files are not overwritten)
const mgr = new ConfigManager("~/.ai-zen/config.json");
const { config } = await mgr.bootstrap();

// 2. Create a Provider (one instance per working directory)
const provider = await Provider.create({
  config,
  cwd: "/path/to/workspace-a",
  agentsDir: "~/.ai-zen/agents",
  subAgentsPaths: ["~/.ai-zen/sub-agents"],
  skillsPaths: ["~/.ai-zen/skills"],
  toolsPaths: ["~/.ai-zen/tools"],
  mcpPaths: ["~/.ai-zen/mcp.json"],
});

// 3. Create an Agent and register plugins
const agent = await createAgent(provider, config.defaultAgent ?? "default");
agent.use(new AutoMigratePlugin({
  service: new TaskMigrationService({ onMigrated: (mctx) => { /* save the receipt */ } }),
  maxTokens: 250_000,
}));
agent.use(new AutoRefreshToolsPlugin());
await agent.init();

// 4. Conversation (messages are held by agent.messages)
const messages = await agent.send("Hello");
```

## Testing

```bash
# Run all core + sdk tests
pnpm test

# Core only
pnpm --filter @ai-zen/agents-core test

# SDK only
pnpm --filter @ai-zen/agents-sdk test
```

## Next steps

- [Architecture](architecture.md) — understand core / sdk layering and dependency direction
- [Core API](core.md) — plugins, ToolCallContext, event system in detail
- [SDK](sdk.md) — capability pipeline, permissions, built-in tools, task migration
