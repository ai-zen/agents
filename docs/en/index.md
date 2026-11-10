---
title: AI-Zen Agents
description: AI-Zen Agents — a modular LLM Agent framework (core + sdk + server + client monorepo) with a plugin-driven runtime, capability pipeline, a resident server, and MCP support.
outline: deep
---

# AI-Zen Agents

AI-Zen Agents is a **modular LLM Agent framework**, organized as a monorepo via pnpm workspace. It provides layered capabilities from "conversation runtime" to "resident server", consumed by the CLI / desktop app through `@ai-zen/agents-client`.

- **License**: MIT
- **npm package**: `@ai-zen/agents-workspace` (workspace root, private); public subpackages are `@ai-zen/agents-core`, `@ai-zen/agents-sdk`, `@ai-zen/agents-server` and `@ai-zen/agents-client`
- **Current versions**: workspace `2.0.0`; `@ai-zen/agents-core` `4.5.5`; `@ai-zen/agents-sdk` `1.1.0`; `@ai-zen/agents-server` `0.1.0`; `@ai-zen/agents-client` `0.1.0`

## What this is

The framework has four layers with a one-way dependency direction:

1. **`@ai-zen/agents-core`** — A plugin-driven Agent runtime. It runs directly on the official `openai` SDK and does not maintain its own request layer. It is responsible for conversation lifecycle, streaming output, tool calls, multi-turn recursive dialogs, events, and plugin extension.
2. **`@ai-zen/agents-sdk`** — The **engine / capability layer** built on top of core. It is responsible for the business capability pipeline (discover → permission-filter → instantiate), the global Scope context, MCP connection management, task migration, and the built-in file/command toolset.
3. **`@ai-zen/agents-server`** — The **resident server** (`agents-server serve`). Session orchestration, capability assembly, archives, workspaces and migration all live here; the CLI and the desktop app only render and read input.
4. **`@ai-zen/agents-client`** — The **connection layer** to the server: service discovery and spawning, one TCP connection, session and config facades. The CLI and the desktop main process share this one implementation.

## Project structure

```bash
agents/
├── packages/
│   ├── core/    # @ai-zen/agents-core — Agent / Message / Tool / plugin mechanism
│   ├── sdk/     # @ai-zen/agents-sdk — Scope / capability pipeline / MCP / built-in tools
│   ├── server/  # @ai-zen/agents-server — Daemon / session orchestration / archives / workspaces + protocol
│   ├── client/  # @ai-zen/agents-client — discovery & spawning / connection / session & config facades
│   └── testing/ # @ai-zen/agents-testing — private, test doubles
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
CLI / desktop main
        │
        ▼
@ai-zen/agents-client  ──►  @ai-zen/agents-protocol  ◄──  @ai-zen/agents-server
     (connection layer)     (wire contract: method/event    (session orchestration /
                             names, payloads, error codes,   archives / workspaces)
                             frames, discovery)
                                            ▲
                                            │ (types only)
@ai-zen/agents-server  ──►  @ai-zen/agents-sdk  ──►  @ai-zen/agents-core  ──►  official openai SDK
  (session orchestration / archives / workspaces)  (capability pipeline / Scope / MCP)  (Agent runtime)
```

The dependency direction is one-way, never reversed: `core ← sdk ← server`, `protocol ← server` and
`protocol ← client` (**there is no edge between client and server**), `client ← CLI / desktop main`.
See [Architecture](architecture.md).

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
- [Architecture](architecture.md) — the five packages, their dependency direction, the server process model and protocol surface, build order and on-disk layout
- [Core API](core.md) — core runtime public API (Agent / Message / Tool / plugins)
- [SDK](sdk.md) — capability layer (Scope / permissions / built-in tools / migration)
- [Retrieval & RAG](rag.md) — retrieval capability status, RAG removal note
- [MCP](mcp.md) — Model Context Protocol support

## Related repositories

`@ai-zen/cli` (interactive AI Agent terminal) and the desktop app (`@ai-zen/desktop-main`) live in their own repositories and connect to this repository's `@ai-zen/agents-server` through `@ai-zen/agents-client`. The `packages/webui` directory holds nothing but a `README.md`; it is not a package.

## License

MIT. See [LICENSE](../../LICENSE).
