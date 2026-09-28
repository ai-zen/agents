# @ai-zen/agents-sdk

AI-Zen SDK — shared business logic layer providing a unified Agent runtime for CLI and Desktop. Works out of the box, with preconfigured vendor settings, a default Agent, and a default SubAgent.

## Source of Truth

**[`docs/sdk-design-v1.md`](./docs/sdk-design-v1.md)** is the single source of truth for this package's design. All implementations must stay consistent with the document. (Pre-refactor design is kept in [`docs/sdk-design-v0.md`](./docs/sdk-design-v0.md).)

## Architecture

```
CLI ──┐
      ├── @ai-zen/agents-sdk ──┐
Desktop ──┘                    │
                          LLM API
```

## Module Layering

```
types         ← pure types, zero business dependencies (incl. ToolEnv)
config        ← ConfigManager + constants: config.json read/write + directory setup + factory defaults
crud          ← capability-entity CRUD (Agent definitions; conversations/drafts are persisted by each consumer)
runtime       ← model factory + Agent assembly + task migration (createModel / createAgent / SdkAgent / TaskMigrationService)
scope         ← Scope orchestration container + ScopePlugin contract + PermissionEvaluator / disclosure + plugins/ (5 self-contained capability sources: discovery + tools + plugin)
agent-plugins ← Agent plugins (autoMigrate, autoRefreshTools, contextGuard, unknownToolHint)
shared        ← logging, errors
```

Dependency direction: `agent-plugins → runtime → scope`; `runtime → scope / crud / shared / types`, `scope → types / shared`. Upper layers depend on lower layers.

## Core Concepts

| Entity | Description |
|--------|-------------|
| **Scope** | Orchestration container: global context (`config` / `cwd` / `agentsDir`) + the three-phase capability pipeline (discover → filter → instantiate) + plugin registry. Explicitly assembled via `scope.use(...)` |
| **ScopePlugin** | Capability plugin (the v1 extension point): self-owns one capability source's discovery state, candidate names, and instantiation (`discover` / `candidates` / `instantiate` / `dispose`). 5 standard plugins ship out of the box, assembled via `allInOne()` |
| **ToolEnv** | Tool environment `{ cwd, config }`; injected when the built-in-tools plugin (`BuiltinToolsScopePlugin`) instantiates tools, serving as the base for relative path resolution and config reads |
| **SdkCallbackTool** | Abstract base for built-in tools: `env` constructor injection + subclass `call()` + `resolve()` relative path resolution |
| **SdkAgent** | Extends the Core Agent, carries SDK metadata, supports `use()` plugin registration |
| **AgentPlugin** | Plugin interface (`onInit`, `onBeforeSend`, `onAfterSend`, `onInnerLoopStart`, `onInnerLoopEnd`, `onInnerLoopsStart`, `onInnerLoopsEnd`, `onToolCall`, `onUnknownTool`, `onSubAgentStart`, `onSubAgentEnd`) |
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
const scope = new Scope({
  config,
  cwd: "/path/to/workspace", // one working directory per Scope; parallel sessions don't interfere
  agentsDir,
}).use(
  ...allInOne({ skillsPaths, toolsPaths, subAgentsPaths, mcpPaths }),
);
await scope.init();

const agent = await createAgent(scope, "my-agent");
const migrationService = new TaskMigrationService({ onMigrated }); // migrates via the agent's own model client
agent.use(new AutoMigratePlugin({ service: migrationService, maxTokens }));
agent.use(new AutoRefreshToolsPlugin());
agent.use(new UnknownToolHintPlugin({ scope }));
await agent.init();
await agent.send("Hello");

await scope.dispose(); // disconnect MCP, release plugin resources
```

## Development Status

| Module | Status |
|--------|--------|
| `types` | ✅ Implemented — core entities, permission model, MCP types complete |
| `config` | ✅ Implemented — ConfigManager + factory defaults + one-shot bootstrap |
| `crud` | ✅ Implemented — capability-entity CRUD for Agents, etc. (conversations/drafts persisted by each consumer) |
| `scope` | ✅ Implemented — Scope + ScopePlugin + 5 standard plugins (builtin / user-tools / skills / mcp / subagents) + allInOne |
| `runtime` | ✅ Implemented — createAgent, MCP connection management, task migration |
| `agent-plugins` | ✅ Implemented — AutoMigratePlugin / AutoRefreshToolsPlugin / ContextGuardPlugin / UnknownToolHintPlugin |
| `shared` | ✅ Implemented — SdkError + injectable Logger |

## Built-in Tools

All built-in tools are classes (extending `SdkCallbackTool`), instantiated by the built-in-tools plugin (`BuiltinToolsScopePlugin`) with a `ToolEnv` — one set of instances per Scope, with `cwd` injected and relative paths resolved against `Scope.cwd`, never depending on the global `process.cwd()`.

| Tool | Description |
|------|-------------|
| `cwd` | Get the current working directory |
| `readFile` | Read a file (optional `range` for line/column slicing; oversized output warns and suggests batched reads) |
| `inspectFile` | Inspect a file's structural overview (line count, column distribution, etc.); streamed scan, not limited by the 300KB read threshold |
| `writeFile` | Write a file |
| `exec` | Execute a command (supports `timeout`; oversized stdout+stderr is dumped to `stdout.log` / `stderr.log`) |
| `exec_async` | Execute a command asynchronously, returns immediately without waiting |
| `mkdir` | Create a directory |
| `rm` | Delete a file or directory |
| `glob` | Scan and find files using glob patterns (oversized output dumped to `result.json`) |
| `ls` | List directory contents (oversized output dumped to `result.json`) |
| `exist` | Check whether a file or directory exists |
| `findText` | Search for text or regex in files (oversized output dumped to `result.json`) |
| `downloadFile` | Download a file from a URL and save it locally |
| `rename` | Rename or move a file/directory |
| `copy` | Copy a file or directory |
| `batchEdit` | Batch-edit file text (only unmatched items are echoed back; successful ones are counted) |
| `edit` | Edit text in a file |
| `sleep` | Wait for a specified number of milliseconds |

Conditionally injected based on the active model / config:

| Tool | Injection Condition | Description |
|------|---------------------|-------------|
| `generateImage` | Only when `defaultImageModel` is configured | Generate an image from a text description |
| `viewImage` | Only for vision models (the agent's `modelId` resolves to a model with `vision: true`) | View / analyze an image: local images are auto-uploaded via the Files API, network URLs are referenced directly |

Tool output protection: `AppConfig.maxToolOutput` (in characters, default 32768) is the unified ceiling for tool output. Each tool handles overflow itself — `exec` dumps `stdout.log` / `stderr.log` separately (returning head/tail previews per stream), `findText` / `glob` / `ls` dump `result.json` (returning a head preview), and `readFile` only warns and suggests batched reads via `range`. Dumps go to `<tmpdir>/ai-zen/tool-output/<tool>-<timestamp>-<random>/`, one directory per call, with no self-cleanup. See [`docs/sdk-design-v1.md` §12](docs/sdk-design-v1.md).

## Built-in Plugins

| Plugin | Description |
|--------|-------------|
| `AutoMigratePlugin` | Automatically triggers task migration when the context overflows; delegates the actual migration to the injected `TaskMigrationService` instance (history handled per `strategy`: default `omit` keeps it auditable, optional `prune` drops it), which reuses the agent's own model client |
| `AutoRefreshToolsPlugin` | Re-scans the file system before each `send()` to refresh the tool list |
| `ContextGuardPlugin` | Context safety guard — before each request, throws `ContextOverflowError` (interrupting the conversation) when the previous round's `usage.prompt_tokens` exceeds `maxTokens × ratio` (default 1.5), preventing context runaway from reading oversized files |
| `UnknownToolHintPlugin` | Smarter unknown-tool hints — when the LLM calls a nonexistent tool, guides it to `call_mcp_tool` / points out permission issues based on MCP config (opt-in via `agent.use`) |

## Design Principles

See the project-root [`PRINCIPLES.md`](../../PRINCIPLES.md):

1. Logical consistency
2. Design first, documentation as the source of truth
3. Symmetry and uniformity
4. No over-engineering
5. Occam's razor
6. Refactor as you go; keep clean layering
7. Tests are the foundation
