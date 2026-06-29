# AI-ZEN Agents

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A modular LLM Agent framework providing a full-stack solution from core library to CLI and Web UI.

## Project Structure

This project uses pnpm workspace with the following sub-packages:

| Package | Description | Version |
|---------|-------------|---------|
| [`@ai-zen/agents-core`](./packages/core) | Core framework — Agent, Messages, Tools, Models, Endpoints, RAG, Vector Database | [![version](https://img.shields.io/badge/version-2.4.0-blue)] |
| [`@ai-zen/agents-cli`](./packages/cli) | CLI — Interactive conversation terminal with file tools, MCP support | [![version](https://img.shields.io/badge/version-0.7.4-blue)] |
| [`@ai-zen/agents-webui`](./packages/webui) | Web UI (Vue 3 + Element Plus) | [![version](https://img.shields.io/badge/version-2.0.0-blue)] |

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

### Start CLI

```bash
pnpm cli
```

Or install globally:

```bash
cd packages/cli
pnpm build
npm install -g .
aiz
```

### Start Web UI

```bash
pnpm dev
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

## 💻 @ai-zen/agents-cli

Interactive CLI with full AI conversation experience:

- Main menu with draft auto-save and recovery (resume after crash)
- Conversation commands (`/exit`, `/save`, `/new`, `/back`, `/editor`, `/help`)
- Context migration with auto-generated handover documents
- Shell fallback hook (`aiz hook install`) — unknown commands forwarded to AI
- Multi-endpoint support (OpenAI, ZhipuAI, DeepSeek, etc.)
- Custom Agent presets stored in `~/.ai-zen/agents/`
- Sub-Agent tools in `~/.ai-zen/sub-agents/` (JSON/JS)
- Custom tools in `~/.ai-zen/tools/` (JS)
- Skill prompts in `~/.ai-zen/skills/` (Markdown)
- MCP (Model Context Protocol) server integration
- Image generation (CogView / GLM-Image)
- 15 built-in file system tools
- Conversation history management
- Interactive config wizard

**Built-in tools**: `cwd`, `readFile`, `writeFile`, `batchReplace`, `mkdir`, `rm`, `glob`, `ls`, `exist`, `exec`, `findText`, `downloadFile`, `generateImage`, `rename`, `copy`

### File System Auto-Discovery

```
~/.ai-zen/                    ← Global
├── config.json               ← Endpoints, models, MCP config
├── agents/                   ← Agent presets (JSON)
│   └── default.json
├── sub-agents/               ← Sub-Agents (JSON / JS)
│   └── general-assistant.json
├── skills/                   ← Skill prompts (.md)
├── tools/                    ← Custom tools (.js)
├── conversations/            ← Saved conversations
└── draft.json                ← Auto-saved draft (crash recovery)

/path/to/project/
└── .ai-zen/                  ← Project-level (overrides global)
    ├── agents/
    ├── sub-agents/
    ├── skills/
    └── tools/
```

[View CLI docs →](./packages/cli/README.md)

## 🌐 @ai-zen/agents-webui

Vue 3 + Element Plus + Vite based web application:

- Visual Agent conversation interface
- Agent, Sub-Agent, Tool, Knowledge Base, Endpoint, Model management
- IndexedDB persistence
- No backend required, runs entirely in browser

**Routes**: `/chat`, `/agent/*`, `/agent-tool/*`, `/tool/*`, `/knowledge-base/*`, `/endpoint/*`, `/model/*`

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm build-core` | Build core package |
| `pnpm dev` | Build core then start Web dev server |
| `pnpm cli` | Build core then start CLI |
| `pnpm --filter @ai-zen/agents-core test` | Run core tests |
| `pnpm --filter @ai-zen/agents-cli test` | Run CLI tests |

## License

MIT. See [LICENSE](./LICENSE).
