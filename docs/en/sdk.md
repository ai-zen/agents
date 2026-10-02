---
title: SDK
description: The public API of @ai-zen/agents-sdk — Scope, capability pipeline, permission model, built-in tools, plugins, and task migration.
outline: deep
---

# SDK

`@ai-zen/agents-sdk` is the **engine / capability layer** built on top of `@ai-zen/agents-core`, providing a unified Agent runtime for CLI / Desktop.

- **Installation**: `npm install @ai-zen/agents-sdk` (depends on `@ai-zen/agents-core`, linked via `workspace:^`).
- **Source of truth**: [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) (the older `sdk-design-v0.md` is kept as a historical archive).

## Scope — global context + capability assembly orchestrator

`Scope` is the **sole entry object** of the SDK. It holds configuration, the working directory, the agents directory, and a set of capability plugins (`ScopePlugin`), and integrates the "discover → filter → instantiate" three-stage pipeline. Capability sources (built-in/user tools, Skill, MCP, SubAgent) are all delegated to plugins, each self-contained.

```ts
import { Scope, allInOne } from "@ai-zen/agents-sdk";

const scope = new Scope({
  config,                 // AppConfig (from ConfigManager)
  cwd: "/path/to/workspace",
  agentsDir: "~/.ai-zen/agents",
}).use(
  ...allInOne({                       // always returns the 5 standard capability plugins
    subAgentsPaths: ["~/.ai-zen/sub-agents"],
    skillsPaths: ["~/.ai-zen/skills"],
    toolsPaths: ["~/.ai-zen/tools"],
    mcpPaths: ["~/.ai-zen/mcp.json"],
  }),
);
await scope.init();                   // first discovery, then plugin registration is locked
```

Key fields and methods:

| Member | Description |
|------|------|
| `config` | Application configuration (endpoints, models, etc.) |
| `cwd` | Current working directory — the base for relative-path resolution and the source of `ToolEnv.cwd` |
| `env` | Tool environment `{ cwd, config }`, injected when instantiating built-in tools |
| `agentsDir` | Agents directory (used by `createAgent`) |
| `plugins` | Registered plugins (read-only view) |
| `use(...plugins)` | Register capability plugins (chainable, variadic; must precede `init()`) |
| `getPluginById(id)` | Look up a plugin by id (for external code or other plugins to query state) |
| `async init()` | First global discovery, then locks plugin registration |
| `async refresh()` | Re-run global capability discovery (each plugin re-scans the filesystem) |
| `async dispose()` | Dispose plugins in reverse order (e.g. disconnect MCP); symmetric with `init()` |
| `filter(definition, options?)` | Stage 2: filter by permission + exclude + `isAvailable`, returning a name list |
| `instantiate(filtered)` | Stage 3: name → Tool instance |
| `buildTools(definition, options?)` | `filter` + `instantiate` in one step |

Each `Scope` corresponds to one working directory; multiple Scopes can serve sessions in different directories in parallel without interference.

## createAgent / SdkAgent

```ts
import { createAgent } from "@ai-zen/agents-sdk";

const agent = await createAgent(scope, config.defaultAgent ?? "default");
// agent is an SdkAgent; you can register plugins and send messages directly
```

- `SdkAgent extends Agent` (from core), additionally carrying `scope` and `definition` (including `permissions`).
- Permissions are read uniformly from `definition.permissions`, not held separately.

## Permission model

The four dimensions are independent, `allow` / `deny` are mutually exclusive, and no match means deny. **Permissions are disclosure**: denied items are completely invisible to the LLM.

```
Agent.permissions
  ├── tools:      { allow: string[] } | { deny: string[] }
  ├── skills:     { allow: string[] } | { deny: string[] }
  ├── mcps:       { allow: string[] } | { deny: string[] }
  └── subagents:  { allow: string[] } | { deny: string[] }
```

Rules:

1. When the entire `permissions` is missing, all dimensions are equivalent to `deny: ['*']` (deny everything).
2. When present, each dimension is judged independently; an unconfigured sub-dimension = that dimension's `deny: ['*']`.
3. `allow` and `deny` cannot be configured simultaneously (throws at runtime).
4. No match = deny.
5. The wildcard `*` matches any string.
6. Each Agent's permissions are fully independent — no inheritance, no propagation (the temporary Skill sub-Agent created by `call_skill_sub_agent` reuses the caller's tool set without a second permission pass, which is an intentional exception).

Matching dimensions: `tools` by tool name (e.g. `rm`), `skills` by skill id, `mcps` by server name, `subagents` by `function.name`.

## Built-in tools (20 classes)

All built-in tools are `SdkCallbackTool` subclasses, instantiated by the Scope using `ToolEnv` (one set of instances per Scope, with its `cwd` injected). Relative paths are always resolved against `ToolEnv.cwd`, never depending on the global `process.cwd()`.

| Tool | Description |
|------|------|
| `cwd` / `readFile` / `inspectFile` / `writeFile` / `mkdir` / `rm` / `glob` / `ls` / `exist` / `rename` / `copy` / `findText` | filesystem operations (`readFile` supports an optional `range` for line/column slicing; `inspectFile` returns a structural overview via streamed scan, not limited by the 300KB read threshold) |
| `exec` / `exec_async` | run commands (`exec` supports `timeout`; `exec_async` returns asynchronously immediately and supports shell redirect/pipelines) |
| `downloadFile` | download from a URL and save |
| `batchEdit` / `edit` | batch / single text replacement in files (`batchEdit` echoes back only unmatched items) |
| `sleep` | wait a specified number of milliseconds |

Tools injected based on config / model conditions:

| Tool | Injection condition |
|------|----------|
| `generateImage` | only when `defaultImageModel` is configured |
| `viewImage` | only for vision models (the Agent's `modelId` resolves to `Model.vision === true`) |

Tool availability is declared by each tool's own `isAvailable(config, definition)` and filtered during the `buildTools` / `filter` stage; the discovery layer does no filtering.

Tool output protection: `AppConfig.maxToolOutput` (in characters, default 32768) is the unified ceiling; on overflow each tool handles it itself — `exec` dumps `stdout.log` / `stderr.log` separately (with head/tail previews per stream), `findText` / `glob` / `ls` dump `result.json` (with a head preview), and `readFile` only warns and suggests batched reads via `range`. Dumps go to `<tmpdir>/ai-zen/tool-output/<tool>-<timestamp>-<random>/`, one directory per call. Note that 300KB is a **read** threshold (whether a file can be read), distinct from the output threshold.

`SdkCallbackTool` abstract base class:

```ts
abstract class SdkCallbackTool extends Tool {
  readonly env: ToolEnv;
  isAvailable?(config: AppConfig, definition: AgentDefinition): boolean;
  abstract call(input: unknown, ctx?: ToolCallContext): unknown | Promise<unknown>;
  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent>;  // strings passed through / content blocks passed through / others JSON-serialized
  resolve(p: string): string;   // resolve a relative path against env.cwd
}
```

## Core entity types

| Entity | Description | Storage |
|------|------|------|
| `Endpoint` | API endpoint (baseUrl + apiKey) | `config.json` |
| `Model` | Model configuration, bound to one Endpoint | `config.json` |
| `ImageModel` | Image-generation model configuration | `config.json` |
| `AgentDefinition` | an interactive AI persona (prompt, permissions, optional tool signatures); having a `function` makes it a SubAgent; `custom: true` marks it as user-defined (init skips syncing built-in prompts) | `agents/*.json` |
| `ToolEnv` | `{ cwd, config }`, injected when constructing built-in tools | in-memory |
| `SdkCallbackTool` | abstract base class for built-in tools | in-memory |

## Built-in plugins

| Plugin | Description |
|------|------|
| `AutoMigratePlugin` | Automatically triggers task migration when context overflows; actual migration is delegated to the injected `TaskMigrationService` |
| `AutoRefreshToolsPlugin` | Re-refreshes the tool list before each `send()` |
| `ContextGuardPlugin` | Context safety guard; throws `ContextOverflowError` before a request when the hard limit (`maxTokens × ratio`) is exceeded |
| `UnknownToolHintPlugin` | MCP smart hint for unknown tools (registered explicitly via `agent.use`) |

## ConfigManager and factory defaults

```ts
import { ConfigManager } from "@ai-zen/agents-sdk";

const mgr = new ConfigManager("~/.ai-zen/config.json");
const { config, agent, subAgent } = await mgr.bootstrap();   // one-shot init (idempotent)
```

- Preset endpoints (OpenAI / Zhipu / DeepSeek), 7 models (including the vision model `vision: true`), 3 image models, and default options.
- Factory-default MCP servers (`socket-pty`, `chrome-devtools`) are written to `~/.ai-zen/mcp.json` on first run; existing files are not overwritten.
- All `ensure*` operations do not overwrite existing files, so user configuration is never lost.

## Task migration (TaskMigrationService)

The migration service only handles "how to migrate", reusing the passed-in `agent`'s own model to generate the handoff document; `AutoMigratePlugin` only handles "when to trigger".

```ts
import { TaskMigrationService, AutoMigratePlugin } from "@ai-zen/agents-sdk";

agent.use(new AutoMigratePlugin({
  service: new TaskMigrationService({ onMigrated: (mctx) => { /* save the old history */ } }),
  maxTokens: 250_000,
}));
```

- Strategy `strategy`: `omit` (default, marks history `omit: true` to keep it auditable) / `prune` (physically removes).
- A single `migrate()` call can override the default strategy.
- Does not rebuild the Agent, only rebuilds the message list; a failed migration does not lose the original messages.

## Consumption pattern (complete)

See the "Consumption pattern (complete example)" and "Boundary with Core" sections in [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md).

## Related documentation

- [Quick Start](getting-started.md)
- [Architecture](architecture.md)
- [Core API](core.md) — low-level runtime API
- [MCP](mcp.md) — the SDK's MCP connection management
- [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) — source of truth for the SDK design
