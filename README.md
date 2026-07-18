# AI-ZEN Agents

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A modular LLM Agent framework based on `@ai-zen/agents-core`.

## Project Structure

This project uses pnpm workspace with the following sub-packages:

| Package | Description | Version |
|---------|-------------|---------|
| [`@ai-zen/agents-core`](./packages/core) | Core framework — Agent, Messages, Tools, Models, Endpoints, RAG, Vector Database | [![version](https://img.shields.io/badge/version-2.4.0-blue)] |
| [`@ai-zen/agents-sdk`](./packages/sdk) | SDK — Shared business logic (capabilities, permissions, MCP, plugins) | [![version](https://img.shields.io/badge/version-0.1.0-blue)] |

### External Projects

These projects were previously part of this monorepo and have been migrated to their own repositories:

| Package | Repository | Description |
|---------|------------|-------------|
| [`@ai-zen/cli`](https://github.com/ai-zen/cli) | `git@github.com:ai-zen/cli.git` | CLI — Interactive conversation terminal with file tools, MCP support, and draft recovery (formerly `@ai-zen/agents-cli`) |
| Web UI | — | Discontinued |

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
| **Agent** | Conversation lifecycle management with streaming, tool calls, events, `onBeforeSend` hook |
| **AgentContext** | Base context class holding model, messages, tools, rag configuration |
| **Message** | Message model supporting text/image multimodal content |
| **Tool** | Abstract base class for tools |
| **CallbackTool** | Quick tool definition via callback function |
| **CodeTool** | Tool logic defined as string code (via `new Function`) |
| **AgentTool** | Expose a sub-Agent as a tool |
| **IndexedSearchTool** | Keyword-based local search tool |
| **Endpoint** | API endpoint abstraction (OpenAI / Azure OpenAI / ZhipuAI / Generic) |
| **ChatCompletionModel** | Chat completion model abstraction |
| **EmbeddingModel** | Embedding model abstraction |
| **ImageGenerationModel** | Image generation model abstraction |
| **Rag** | Retrieval-Augmented Generation base class |
| **VectorDatabase** | In-memory vector database with cosine similarity |
| **KnowledgeBase** | Knowledge base (embedding model + vector database) |
| **FunctionCallContext** | Function call parameter parsing with `preventDefault()` |

**Built-in Implementations**:
- **Models**: `ChatGPT` (OpenAI-compatible), `TextEmbeddingAda002_2`, `ZhipuImage`
- **Endpoints**: `OpenAI`, `AzureOpenAI`, `Zhipu` (deprecated), `CommonEndpoint`
- **RAG**: `EmbeddingSearch`

[View core docs →](./packages/core/README.md)

## 📦 @ai-zen/agents-sdk

SDK layer built on top of `@ai-zen/agents-core`, providing shared business logic for CLI and Desktop applications:

- **Capabilities** — Three-phase tool assembly (discovery, filtering, instantiation) with permission model
- **MCP** — Full connection lifecycle management (connect, reconnect, OAuth, idle timeout)
- **Skill** — Discovery, frontmatter parsing, lazy loading
- **Plugins** — autoMigrate, autoDraft, autoRefreshTools
- **Provider** — Global context with config, paths, and model factory

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
