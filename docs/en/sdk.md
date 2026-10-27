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
- The optional third argument passes interrupt behaviour through: `createAgent(scope, agentId, { abortedMessageStrategy: "keep" })` keeps the **partial reasoning/content of an aborted turn** in the next context (default `drop`); `abortedToolRoundStrategy` / `abortedToolRoundReason` control tool rounds. See the "Aborted messages" section in [`core.md`](core.md).

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
| `cwd` / `read` / `inspect_file` / `write` / `mkdir` / `rm` / `glob` / `ls` / `exist` / `rename` / `copy` / `find_text` | filesystem operations (`read` supports an optional `range` for line/column slicing; `inspect_file` returns a structural overview via streamed scan, not limited by the 300KB read threshold) |
| `exec` / `spawn` | run commands (`exec` supports `timeout`; `spawn` returns asynchronously immediately and supports shell redirect/pipelines) |
| `download_file` | download from a URL and save |
| `batch_edit` / `edit` | batch / single text replacement in files (`batch_edit` echoes back only unmatched items). **Never run `edit` calls in parallel on the same file** — each call reads the old content and writes it back, so they overwrite each other; use `batch_edit` to submit all changes to one file in a single call. Parallel `edit` is only safe across different files |
| `sleep` | wait a specified number of milliseconds |

Tools injected based on config / model conditions:

| Tool | Injection condition |
|------|----------|
| `generate_image` | only when `defaultImageModel` is configured |
| `view_image` | only for vision models (the Agent's `modelId` resolves to `Model.vision === true`) |

### Local file → content block (single entry point)

`fileToContentSection()` (in `shared/content-blocks.ts`, exported from the package entry) is the only entry point for turning a file into a content block. It takes `{ source, endpoint, model, signal?, maxInlineBytes?, deps? }` and returns `{ section, transport, bytes, warning? }`; `source` accepts four shapes — `path` / `url` / `data` (Uint8Array) / `base64`. The transport is chosen automatically:

| Condition | Result |
|---|---|
| http(s) URL | `image_url` (no upload, no inlining) |
| Endpoint declares `capabilities.filesApi` (only `deepseek` ships with it) | Upload via Files API → `file` block (`file_id`); falls back to base64 on failure |
| Other endpoints + image | `image_url` with a base64 data URL |
| Other endpoints + non-image | `file` block with `file_data` (base64 data URL) |
| Model has `vision === false` and the file is an image | Degrades to `text` (path hint only) |
| Inline payload > `maxInlineBytes` (default 8 MiB) and no upload capability | Error (never silently stuffed into the request) |

Notes:

- **Capability is no longer inferred from the endpoint id**: the old code hard-coded `endpoint.id === "deepseek"` and broke as soon as a user renamed the endpoint. It is now an explicit `Endpoint.capabilities.filesApi` flag
- **The endpoint is resolved from the current model** (`resolveModelAndEndpoint(config, ctx.agent.model)`): `file_id` is an endpoint-scoped resource, so uploading to the wrong endpoint yields not-found
- **Upload cache**: `endpoint id + absolute path + mtime + size → file_id` (max 200 entries), so the same file is not uploaded twice
- `view_image`, `call_mcp_tool` and `read_mcp_resource` all normalise media through this module: images/binary from MCP are no longer always inlined as base64 — endpoints with Files API capability get a `file_id`; a failed conversion degrades to a text note instead of dropping the media block
- In-memory sources (base64 provided by MCP) are **never decoded and re-encoded**: inline passthrough keeps the bytes identical, decoding only happens when an upload is actually needed, and the cache key is a sha256 of the content
- **Non-vision models degrade automatically**: when `Model.vision !== true`, images (including those returned by MCP) become a one-line text note, so `image_url` blocks are never rejected with a 4xx
- `call_mcp_tool` and `read_mcp_resource` share the same output guard: oversized text is dumped to `result.txt` and only a head/tail preview is returned, while media blocks stay in place
- **Public API**: `fileToContentSection` / `resolveModelAndEndpoint` / `supportsFilesApi` / `mimeOf` / `toDataUrl` / `base64ByteLength` / `contentHash` / `clearUploadCache` / `MIME_BY_EXT` / `DEFAULT_MAX_INLINE_BYTES` are all exported from the package entry, so upper-layer apps (CLI / Desktop) reuse them instead of re-deciding "upload or inline" on their own

Tool availability is declared by each tool's own `isAvailable(config, definition)` and filtered during the `buildTools` / `filter` stage; the discovery layer does no filtering.

Tool output protection: `AppConfig.maxToolOutput` (in characters, default 32768) is the unified ceiling; on overflow each tool handles it itself — `exec` dumps `stdout.log` / `stderr.log` separately (with head/tail previews per stream), `find_text` / `glob` / `ls` dump `result.json` (with a head preview), and `read` only warns and suggests batched reads via `range`. Dumps go to `<tmpdir>/ai-zen/tool-output/<tool>-<timestamp>-<random>/`, one directory per call. Note that 300KB is a **read** threshold (whether a file can be read), distinct from the output threshold.

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

## Model parameter overrides (`modelParams`)

The SDK has exactly one rule for model parameters: **shallow merge, no interpretation**.

```ts
// effective params = model defaults + Agent-level override
{ ...model.defaultParams, ...definition.modelParams }
```

| Layer | Field | Purpose |
|----|------|------|
| Model | `Model.defaultParams?: ModelParams` | model default request params (may include vendor-specific keys like `thinking`) |
| Agent | `AgentDefinition.modelParams?: ModelParams` | this Agent's override, shallow-merged onto the model params |

The SDK **interprets no keys at all**: it does not know `thinking` / `reasoning_effort`, nor what a "reasoning level" is. The merge is shallow (nested objects are replaced wholesale), so switching levels never leaves stale sub-keys behind.

The third argument of `createModel(scope, modelId, overrides?)` is that override, passed by `createAgent` from `definition.modelParams`; a SubAgent with its own `modelId` applies its own `modelParams` too. So the same model can serve different Agents with different parameters (coding Agent `reasoning_effort: "max"`, casual chat Agent `{ thinking: { type: "disabled" } }`) while the model's own `defaultParams` stay untouched.

### Then who owns "reasoning levels"?

Split in two, along the "data vs behavior" line:

- **The table (data) lives in the SDK**: the `ReasoningPresets` type, the factory content `FACTORY_REASONING_PRESETS`, and `ConfigManager.readReasoningPresets()` / `ensureReasoningPresets()`. For a practical reason — knowledge like "Zhipu 5.3 only accepts `low/high/max`, sending `disabled` errors out" should not be re-written by every client. The table is a **shared asset across CLI, desktop, …**.
- **Using the table (behavior) lives in the client**: read the table → restrict the selectable levels → **write** the chosen level's patch into `AgentDefinition.modelParams`. At runtime the SDK only merges once — **no lookup, no derivation**.

```json
// ~/.ai-zen/reasoning-presets.json — next to config.json, editable and extensible
{
  "zhipu-5.3": {
    "levels": {
      "low":  { "thinking": { "type": "enabled" }, "reasoning_effort": "low" },
      "max":  { "thinking": { "type": "enabled" }, "reasoning_effort": "max" }
    }
  }
}
```

`Model.reasoningPreset?: string` is a model's reference to one preset; clients use it to decide which levels to offer. **The SDK never uses it to build request parameters** — it only guarantees the field is read, written and factory-synced along with the model config (factory models must carry it, otherwise `syncManagedModels` would wipe it during whole-entry replacement).

Why split this way: `low` / `high` / `max` / `off` are **product semantics, not protocol facts** (the same word can mean different things across vendors), while the only objective thing the SDK knows is what the request parameters look like — and `defaultParams` already carries that. Hence **configuration is the fact**: the client expands a level at write time, and nobody needs to derive anything afterwards.

## Context thresholds (`tokenThresholds`)

`Model.tokenThresholds` has two lines, both **absolute values** (what you write is what is used, no multiplier):

| Field | Meaning | Consumer |
|------|------|--------|
| `handoff` | Soft line: after a response, `usage.prompt_tokens` above it triggers a task handoff | `AutoMigratePlugin` |
| `guard` | Hard line: before each request, usage above it throws `ContextOverflowError` and aborts the round | `ContextGuardPlugin` |

- `guard` should be clearly larger than `handoff` (factory value is `handoff × 1.5`, written as an integer) so the handoff round has room for 1–2 extra requests
- Neither value is the model's real context window: the window is a vendor fact, the thresholds are our policy for "what happens when usage reaches this line"
- Want it looser? Change the number. Making them absolute is exactly so the safety boundary is predictable instead of being implicitly multiplied by a ratio (the old `ratio` / `suspendedRatio` are gone)
- Legacy fields `maxContextTokens` (single value) and `maxContextChars` (character-based, dropped) are migrated by `ConfigManager.read()`: the former becomes `handoff`, the latter is folded into tokens via `floor(chars / 4)`, `guard` is filled in once at 1.5×, and the old keys are deleted; `ensureDefaultConfig()` only writes when it detects a difference

## Core entity types

| Entity | Description | Storage |
|------|------|------|
| `Endpoint` | API endpoint (baseUrl + apiKey + optional `capabilities.filesApi`) | `config.json` |
| `Model` | Model configuration, bound to one Endpoint; `reasoningPreset` is application-level metadata the SDK does not interpret | `config.json` |
| `ImageModel` | Image-generation model configuration | `config.json` |
| `AgentDefinition` | an interactive AI persona (prompt, permissions, optional tool signatures, optional parameter overrides `modelParams`); having a `function` makes it a SubAgent; `custom: true` marks it as user-defined (init skips syncing built-in prompts) | `agents/*.json` |
| `ToolEnv` | `{ cwd, config }`, injected when constructing built-in tools | in-memory |
| `SdkCallbackTool` | abstract base class for built-in tools | in-memory |

## Built-in plugins

| Plugin | Description |
|------|------|
| `AutoMigratePlugin` | Automatically triggers task migration when context overflows; actual flow is delegated to the injected `HandoffService` (`resolveMode` picks the executor, `busy` prevents recursion) |
| `AutoRefreshToolsPlugin` | Re-refreshes the tool list before each `send()` |
| `ContextGuardPlugin` | Context safety guard; throws `ContextOverflowError` before a request when usage exceeds `guardTokens` |
| `UnknownToolHintPlugin` | MCP smart hint for unknown tools (registered explicitly via `agent.use`) |

## ConfigManager and factory defaults

```ts
import { ConfigManager } from "@ai-zen/agents-sdk";

const mgr = new ConfigManager("~/.ai-zen/config.json");
const { config, agent, subAgent } = await mgr.bootstrap();   // one-shot init (idempotent)
```

- Preset endpoints (OpenAI / Zhipu / DeepSeek), 8 models (including vision models with `vision: true`), 3 image models, and default options.
- Factory-default MCP servers (`socket-pty`, `chrome-devtools`) are written to `~/.ai-zen/mcp.json` on first run; existing files are not overwritten.
- All `ensure*` operations do not overwrite existing files, so user configuration is never lost.

## Task handoff and migration (HandoffService)

Two layers, one pipeline:

- `handoff()` — stop the work, verify the real state, write the handoff document, validate it (degrade on failure). **Does not touch the session.**
- `migrate()` — `handoff()`, then clear history per `strategy` and inject a breakpoint message holding only the document path.

The document template is **not** in the code: it comes from the `handoff` skill (`~/.ai-zen/skills/handoff/SKILL.md`), released and version-synced by `ConfigManager.bootstrap()` (frontmatter `metadata.custom: "true"` opts out). The code only reads the skill, injects it, validates the file, and falls back to a minimal built-in template when the skill is missing.

Two executors: `self` (default — the original agent writes it in-session with full context and tools) and `summary` (one independent call, no tools). `self` degrades to `summary` one-way.

```ts
import { HandoffService, AutoMigratePlugin, ContextGuardPlugin } from "@ai-zen/agents-sdk";

const handoffService = new HandoffService({
  handoffDir: "/work/.ai-zen/handoffs",
  skillDirs: ["/work/.ai-zen/skills", "~/.ai-zen/skills"],
  onHandoff: (hctx) => { /* save the old history (now includes the handoff turn) */ },
  onMigrated: (hctx) => { hctx.agent.lastUsage = undefined; },
});

agent.use(new ContextGuardPlugin({ guardTokens: 375_000, isSuspended: () => handoffService.busy }));
agent.use(new AutoMigratePlugin({ service: handoffService, handoffTokens: 250_000 }));
```

- Strategy `strategy`: `omit` (default, marks history `omit: true` to keep it auditable) / `prune` (physically removes).
- `service.busy` makes the auto-migrate plugin step aside (no recursion); extra headroom comes from setting `guard` large enough (factory value `handoff × 1.5`), there is no implicit multiplier anymore.
- `HandoffGuardPlugin` is armed only inside the handoff turn: it blocks `edit` / `rm` / `rename` … and allows `write` only for the handoff file (soft rejections that steer the model back).
- Does not rebuild the Agent, only rebuilds the message list; a failed handoff does not lose the original messages.

## Consumption pattern (complete)

See the "Consumption pattern (complete example)" and "Boundary with Core" sections in [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md).

## Related documentation

- [Quick Start](getting-started.md)
- [Architecture](architecture.md)
- [Core API](core.md) — low-level runtime API
- [MCP](mcp.md) — the SDK's MCP connection management
- [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) — source of truth for the SDK design
