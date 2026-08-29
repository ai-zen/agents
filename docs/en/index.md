---
title: AI-Zen Agents
description: AI-Zen Agents — a modular LLM Agent framework (core + sdk monorepo) with a plugin-driven runtime, capability pipeline, retrieval tools, and MCP support.
outline: deep
---

# AI-Zen Agents

AI-Zen Agents is a **modular LLM Agent framework**, organized as a monorepo via pnpm workspace. It provides layered capabilities from "conversation runtime" to "business capability pipeline", to be consumed directly by upper-layer applications such as CLI / Desktop.

- **License**: MIT
- **npm package**: `@ai-zen/agents-workspace` (workspace root, private); public subpackages are `@ai-zen/agents-core` and `@ai-zen/agents-sdk`
- **Current versions**: workspace `2.0.0`; `@ai-zen/agents-core` `4.1.0`; `@ai-zen/agents-sdk` `0.9.1`

## What this is

The framework is designed around two layers:

1. **`@ai-zen/agents-core`** — A plugin-driven Agent runtime. It runs directly on the official `openai` SDK and does not maintain its own request layer. It is responsible for conversation lifecycle, streaming output, tool calls, multi-turn recursive dialogs, events, and plugin extension.
2. **`@ai-zen/agents-sdk`** — The **engine / capability layer** built on top of core. It is responsible for the business capability pipeline (discover → permission-filter → instantiate), the global Provider context, MCP connection management, task migration, and the built-in file/command toolset.

## Project structure

```bash
agents/
├── packages/
│   ├── core/    # @ai-zen/agents-core — Agent / Message / Tool / plugin mechanism
│   └── sdk/     # @ai-zen/agents-sdk — Provider / capability pipeline / MCP / built-in tools
├── package.json # workspace root (private)
└── pnpm-workspace.yaml
```

## Core capabilities

| Capability | Description | See |
|------|------|------|
| Plugin-driven runtime | `AgentPlugin` + `HookResult` short-circuit semantics + `dispatchHook` unified event/plugin entry | [Core API](core.md) |
| Modular tools | `Tool` / `CallbackTool` / `AgentTool` / `AgentToolLazy` / `IndexedSearchTool` | [Core API](core.md) |
| Capability pipeline | Discover → permission-filter → instantiate (built-in / user / Skill / MCP / SubAgent) | [SDK](sdk.md) |
| Permission model | Four dimensions (tools / skills / mcps / subagents); permissions are disclosure | [SDK](sdk.md) |
| MCP support | `McpConnectionManager` + lazy-loaded tools (`load_mcp`, etc.) | [MCP](mcp.md) |
| Retrieval / RAG | RAG has been removed; retrieval is handled by search tools | [Retrieval & RAG](rag.md) |

## Architecture layers

```
Upper-layer apps (CLI / Desktop)
        │
        ▼
@ai-zen/agents-sdk  ──►  @ai-zen/agents-core  ──►  official openai SDK
  (capability pipeline / Provider / MCP)   (Agent runtime)    (LLM API)
        │
        ▼
LLM API / MCP servers
```

Dependency direction (inside SDK): `plugin → runtime → capabilities → crud → config → types`. Upper layers depend on lower layers, not the other way around. See [Architecture](architecture.md).

## Quick start

```bash
git clone <your-repo-url>
cd agents
pnpm install
pnpm build-core
```

A minimal runnable example:

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({ apiKey: "sk-xxx", baseURL: "https://api.openai.com/v1" });
const agent = new Agent({ client, model: "gpt-4o", modelConfig: { temperature: 0.7 } });
agent.append(Message.System("You are an AI assistant."));
await agent.send("Hello, please introduce yourself.");
console.log(agent.messages.at(-1)?.content);
```

For complete installation and usage, see [Quick Start](getting-started.md).

## Documentation index

- [Quick Start](getting-started.md) — environment requirements, installation, build, first Agent
- [Architecture](architecture.md) — core / sdk layering and module dependencies
- [Core API](core.md) — core runtime public API (Agent / Message / Tool / plugins)
- [SDK](sdk.md) — capability layer (Provider / permissions / built-in tools / migration)
- [Retrieval & RAG](rag.md) — retrieval capability status, RAG removal note
- [MCP](mcp.md) — Model Context Protocol support

## Related repositories

`@ai-zen/cli` (interactive AI Agent terminal) and the Web UI used to belong to this monorepo; they have been migrated to their own repositories or are no longer maintained. See the repository root `README.md`.

## License

MIT. See [LICENSE](../../LICENSE).
