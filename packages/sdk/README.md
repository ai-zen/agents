# @ai-zen/agents-sdk

AI-Zen SDK — shared business logic layer providing a unified Agent runtime for CLI and Desktop. Works out of the box, with preconfigured vendor settings, a default Agent, and a default SubAgent.

## Source of Truth

**[`docs/sdk-design.md`](./docs/sdk-design.md)** is the single source of truth for this package's design. All implementations must stay consistent with the document.

## Architecture

```
CLI ──┐
      ├── @ai-zen/agents-sdk ──┐
Desktop ──┘                    │
                          LLM API
```

## Module Layering

```
types        ← pure types, zero business dependencies (incl. ToolEnv)
config       ← read/write config.json + migration + in-memory cache + atomic writes
crud         ← capability-entity CRUD (Agent definitions, etc.; conversations/drafts are persisted by each consumer)
capabilities ← capability discovery & assembly (built-in + user + MCP + Skill + SubAgent)
runtime      ← Provider + model factory + Agent assembly + MCP connection management + task migration + SdkCallbackTool base
plugin       ← Agent plugins (autoMigrate, autoRefreshTools)
shared       ← logging, errors
```

Dependency direction: `plugin → runtime → capabilities → crud → config → types`. Upper layers depend on lower layers, never the other way around.

## Core Concepts

| Entity | Description |
|--------|-------------|
| **Provider** | Global context + capability registry, holding config, paths (incl. `cwd`), model factory, and MCP manager; integrates discovery → filtering → instantiation |
| **ToolEnv** | Tool environment `{ cwd, config }`; injected when the Provider instantiates built-in tools, serving as the base for relative path resolution and config reads |
| **SdkCallbackTool** | Abstract base for built-in tools: `env` constructor injection + subclass `call()` + `resolve()` relative path resolution |
| **SdkAgent** | Extends the Core Agent, carries SDK metadata, supports `use()` plugin registration |
| **AgentPlugin** | Plugin interface (`onInit`, `onBeforeSend`, `onAfterSend`, `onInnerLoopStart`, `onInnerLoopEnd`) |
| **Endpoint** | API endpoint (baseUrl + apiKey) |
| **Model** | Model config, bound to an Endpoint |
| **SubAgent** | An Agent with a `function` field, callable by other Agents as a tool |

## Permission Model

The four dimensions are independent; allow/deny are mutually exclusive, no match means deny, and permission is disclosure (denied items are completely invisible to the LLM).

```
Agent.permissions
  ├── tools:      { allow: string[] } | { deny: string[] }
  ├── skills:     { allow: string[] } | { deny: string[] }
  ├── mcps:       { allow: string[] } | { deny: string[] }
  └── subagents:  { allow: string[] } | { deny: string[] }
```

## Consumption

```typescript
const provider = await Provider.create({
  config,
  cwd: "/path/to/workspace", // one working directory per Provider; parallel sessions don't interfere
  ...paths,
});
const agent = createAgent(provider, "my-agent");
agent.use(new AutoMigratePlugin({ maxTokens, migrationAgent, onMigrated }));
agent.use(new AutoRefreshToolsPlugin());
await agent.init();
await agent.send("Hello");
```

## Development Status

| Module | Status |
|--------|--------|
| `types` | ✅ Implemented — core entities, permission model, MCP types complete |
| `config` | ✅ Implemented — ConfigManager + factory defaults + one-shot bootstrap |
| `crud` | ✅ Implemented — capability-entity CRUD for Agents, etc. (conversations/drafts persisted by each consumer) |
| `capabilities` | ✅ Implemented — discovery + permission filtering + safe pre-filtering + enumeration disclosure |
| `runtime` | ✅ Implemented — Provider, Capabilities, createAgent, MCP connection management, task migration |
| `plugin` | ✅ Implemented — AutoMigratePlugin / AutoRefreshToolsPlugin |
| `shared` | ✅ Implemented — SdkError + injectable Logger |
| Tests | ✅ 409 tests, 47 files, all passing (incl. real-API chat e2e) |

## Built-in Tools

All built-in tools are classes (extending `SdkCallbackTool`), instantiated by the Provider with a `ToolEnv` — one set of instances per Provider, with `cwd` injected and relative paths resolved against `Provider.cwd`, never depending on the global `process.cwd()`.

| Tool | Description |
|------|-------------|
| `cwd` | Get the current working directory |
| `readFile` | Read a file |
| `writeFile` | Write a file |
| `exec` | Execute a command (supports `timeout`) |
| `exec_async` | Execute a command asynchronously, returns immediately without waiting |
| `mkdir` | Create a directory |
| `rm` | Delete a file or directory |
| `glob` | Scan and find files using glob patterns |
| `ls` | List directory contents |
| `exist` | Check whether a file or directory exists |
| `findText` | Search for text or regex in files |
| `downloadFile` | Download a file from a URL and save it locally |
| `rename` | Rename or move a file/directory |
| `copy` | Copy a file or directory |
| `batchEdit` | Batch-edit file text |
| `edit` | Edit text in a file |
| `sleep` | Wait for a specified number of milliseconds |

Conditionally injected (registered only when `defaultImageModel` is configured):

| Tool | Description |
|------|-------------|
| `generateImage` | Generate an image from a text description |

## Built-in Plugins

| Plugin | Description |
|--------|-------------|
| `AutoMigratePlugin` | Automatically triggers task migration when the context overflows, generates a handoff document, and transparently replaces the Agent |
| `AutoRefreshToolsPlugin` | Re-scans the file system before each `send()` to refresh the tool list |

## Design Principles

See the project-root [`GOAL.md`](../../GOAL.md):

1. Logical consistency
2. Design first, documentation as the source of truth
3. Symmetry and uniformity
4. No over-engineering
5. Occam's razor
6. Refactor as you go; keep clean layering
7. Tests are the foundation
