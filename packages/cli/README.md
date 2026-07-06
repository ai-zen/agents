# @ai-zen/agents-cli

A command-line interface for AI agents, built on `@ai-zen/agents-core`. Provides an interactive conversation terminal with 15 built-in tools (file system operations, command execution, image generation, etc.) and MCP protocol integration.

## Installation

### Global Install

```bash
npm install -g @ai-zen/agents-cli
```

### Build from Source

```bash
git clone <your-repo-url>
cd agents
pnpm install
pnpm build-core
cd packages/cli
pnpm build
npm install -g .
```

## Quick Start

```bash
# Interactive main menu
aiz

# Quick chat (pass message as argument)
aiz Hello, introduce yourself.
```

## Main Menu

Run `aiz` to enter the main menu:

```
🤖 Welcome to AI-Zen CLI

? Select an action:
  ▶️  Continue last unfinished conversation  (if draft exists)
  💬  Start a new conversation
  📂  Continue a saved conversation
  📋  Manage saved conversations
  🤖  Manage Agents
  ⚙️   Configuration
  ❌  Exit
```

### Draft Recovery (New in v0.7.0)

If you exit a conversation without saving (or the process is killed), the conversation is **automatically saved as a draft**. Next time you start `aiz`, you'll see:

```
▶️  Continue last unfinished conversation (12 messages, 2025/1/1 12:00:00)
💬  Start a new conversation (discard draft)
```

### Conversation Commands

While in a conversation, all commands start with `/`:

| Command | Description |
|---------|-------------|
| `/exit` `/quit` | Exit the conversation (prompts to save) |
| `/save` | Save the current conversation |
| `/new` | Reset the conversation (clear history) |
| `/back` | Undo messages (roll back to a specific point and resend) |
| `/editor` | Open system editor for long-form input |
| `/clear` | Clear the screen |
| `/help` | Show available commands |

### Conversation Migration

When the context approaches the token limit, the system automatically generates a **handover document** summarizing completed tasks, pending items, and key decisions. A new conversation session is created with this document as context, ensuring seamless continuation.

The migration prompt template includes:
- **Conversation Breakpoint** — Last user/AI exchange verbatim
- **Completed Tasks** — Task titles and output paths
- **Pending Tasks** — Description, progress, next steps
- **Important Notes** — Technical preferences, lessons learned, architecture decisions
- **File Index** — Key files with descriptions
- **Handover Instructions** — SOP for the relay agent (read files first, verify state, then act)

### Shell Fallback Hook

When you type an unrecognized command in your terminal, it can be automatically forwarded to AI for processing:

```bash
# Install the hook
aiz hook install

# After that, try typing something random:
> what's the weather today?
# This will be forwarded to AI instead of showing "command not found"

# Uninstall
aiz hook uninstall
```

## Configuration

Configuration is stored in `~/.ai-zen/config.json` (or `$AI_ZEN_DIR/config.json` if set).

```jsonc
{
  "endpoints": [
    {
      "id": "openai",
      "name": "OpenAI",
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.openai.com/v1"
    }
  ],
  "models": [
    {
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "endpointId": "openai",
      "modelName": "gpt-5.5"
    }
  ],
  "defaultModel": "deepseek-v4-flash",
  "defaultAgent": "default",
  "mcpServers": []
}
```

### Environment Variable

- `AI_ZEN_DIR` — Override the config directory (useful for testing and sandboxing)

## Filesystem Auto-Discovery

All user resources are automatically discovered from the filesystem:

```
~/.ai-zen/                    ← Global (shared across projects)
├── config.json               ← Endpoints, models, MCP config
├── agents/                   ← Conversation agents
│   └── default.json
├── sub-agents/               ← Sub-agents (callable as tools)
│   └── general-assistant.json
├── skills/                   ← Skill prompts (.md)
│   └── git-operations.md
├── tools/                    ← Custom tools (.js)
│   └── my-tool.js
├── conversations/            ← Saved conversations
└── draft.json                ← Auto-saved draft (for crash recovery)

/path/to/project/
└── .ai-zen/                  ← Project-level (overrides global)
    ├── agents/
    ├── sub-agents/
    ├── skills/
    └── tools/
```

## Built-in Tools (15)

| Tool | Description |
|------|-------------|
| `cwd` | Get current working directory |
| `readFile` | Read file contents |
| `writeFile` | Write content to file |
| `batchEdit` | Batch replace text in files |
| `mkdir` | Create directories |
| `rm` | Delete files or directories |
| `glob` | Scan files with glob patterns |
| `ls` | List directory contents |
| `exist` | Check if path exists |
| `exec` | Execute shell commands |
| `findText` | Search text in files |
| `downloadFile` | Download file from URL |
| `generateImage` | Generate images from text |
| `rename` | Rename or move files |
| `copy` | Copy files or directories |

## MCP Server Support

Supports MCP (Model Context Protocol) for integrating external tools:

```json
{
  "mcpServers": [
    {
      "id": "my-server",
      "name": "My MCP Server",
      "transport": "stdio",
      "command": "node",
      "args": ["server.js"],
      "enabled": true
    }
  ]
}
```

## Preset Endpoints

| ID | Name | Default Base URL |
|----|------|-----------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (ZhipuAI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

## Preset Models

| ID | Name | Endpoint |
|----|------|----------|
| `gpt-5.5` | GPT-5.5 | OpenAI |
| `glm-5.2` | GLM-5.2 | ZhipuAI |
| `glm-5.1` | GLM-5.1 | ZhipuAI |
| `glm-5` | GLM-5 | ZhipuAI |
| `glm-5-turbo` | GLM-5-Turbo | ZhipuAI |
| `glm-5v-turbo` | GLM-5V-Turbo | ZhipuAI |
| `glm-4.7-flash` | GLM-4.7-Flash | ZhipuAI |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | DeepSeek |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | DeepSeek (**default**) |

## Development

```bash
# In project root
pnpm install

# Build core dependency
pnpm build-core

# Build CLI
pnpm --filter @ai-zen/agents-cli build

# Run tests
pnpm --filter @ai-zen/agents-cli test

# Dev mode (build + run)
pnpm --filter @ai-zen/agents-cli start
```

## Testing

```bash
# Unit tests
pnpm --filter @ai-zen/agents-cli test

# E2E tests (requires API key in .env.local)
# Edit packages/cli/.env.local with your key, then:
pnpm --filter @ai-zen/agents-cli test -- src/__tests__/e2e.test.ts
```

## License

ISC
