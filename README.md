# AI-Zen Agents

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A modular LLM Agent framework based on `@ai-zen/agents-core`.

## Project Structure

This project uses pnpm workspace with the following sub-packages:

| Package | Description |
|---------|-------------|
| [`@ai-zen/agents-core`](./packages/core) | Core framework — Agent, Messages, Tools, Models, Endpoints, RAG, Vector Database |
| [`@ai-zen/agents-sdk`](./packages/sdk) | SDK — Shared business logic (capabilities, permissions, MCP, plugins) |

### External Projects

These projects were previously part of this monorepo and have been migrated to their own repositories:

| Package | Repository | Description |
|---------|------------|-------------|
| [`@ai-zen/cli`](https://github.com/ai-zen/cli) | `git@github.com:ai-zen/cli.git` | CLI — Interactive conversation terminal with file tools, MCP support, and draft recovery (formerly `@ai-zen/agents-cli`) |
| Web UI | — | 已停止维护 |

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm 8.0.0+ (or run `corepack enable`)

### Installation

```bash
git clone <your-repo-url>
cd agents
pnpm install
```

### Build Core

```bash
pnpm build-core
```

## 🧩 @ai-zen/agents-core

TypeScript core library for Node.js and browser environments.

**Core Classes**:

| Class | Description |
|-------|-------------|
| **Agent** | Conversation lifecycle management with streaming, tool calls, events, and plugins (`use()` / `init()`) |
| **AgentContext** | Base context class holding `client` (openai SDK), `model`, messages, tools, `modelConfig` |
| **AgentPlugin** | Plugin interface — the only extension point (`onBeforeSend` / `onInnerLoopStart` / `onToolCall` / `onUnknownTool` …) |
| **SendContext** | Plugin hook context (agent + content + message snapshot) |
| **HookResult** | Unified plugin hook return value — string short-circuits, undefined/void passes through |
| **Message** | Message model supporting text/image/file multimodal content |
| **Tool** | Abstract base class for tools |
| **CallbackTool** | Quick tool definition via callback function |
| **CodeTool** | (deprecated) Tool logic defined as string code (via `new Function`) |
| **AgentTool** | Expose a sub-Agent as a tool |
| **AgentToolLazy** | Lazily-built sub-Agent tool (`buildAgent(parsedArgs, ctx)`) |
| **IndexedSearchTool** | Keyword-based local search tool |
| **ToolCallContext** | Unified tool-call context spanning interception → execution (`onToolCall` + `Tool.exec`) |

**Built-in Implementations**:
- **Runtime**: runs directly on the **official OpenAI SDK** — `client.chat.completions.create` (streaming) / `client.images.generate` / `client.files`; any OpenAI-compatible vendor (OpenAI / DeepSeek / Zhipu BigModel / …) via `baseURL`
- **Plugins**: `AgentPlugin` with unified `HookResult` semantics; `dispatchHook` as the single entry for non-blocking events (kebab-case) + blocking plugins (short-circuit)

[View core docs →](./packages/core/README.md)

## 📦 @ai-zen/agents-sdk

SDK layer built on top of `@ai-zen/agents-core`, providing shared business logic for CLI and Desktop applications:

- **Capabilities** — Three-phase tool assembly (discovery, filtering, instantiation) with permission model
- **Built-in Tools** — All tools are classes (`SdkCallbackTool`), instantiated per-Provider with `ToolEnv` (`cwd` + config) injection; relative paths resolve against `Provider.cwd`, no global `process.cwd()` dependency
- **MCP** — Full connection lifecycle management (connect, reconnect, OAuth, idle timeout)
- **Skill** — Discovery, frontmatter parsing, lazy loading
- **Plugins** — autoMigrate, autoRefreshTools
- **Provider** — Global context with config, paths (incl. per-workspace `cwd`), and model factory

[View SDK docs →](./packages/sdk/docs/sdk-design.md)

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm build-core` | Build `@ai-zen/agents-core` |
| `pnpm build-sdk` | Build `@ai-zen/agents-sdk` |
| `pnpm test` | Run all tests (core + sdk) |
| `pnpm --filter @ai-zen/agents-core test` | Run core tests only |
| `pnpm --filter @ai-zen/agents-sdk test` | Run SDK tests only |

## License

MIT. See [LICENSE](./LICENSE).
