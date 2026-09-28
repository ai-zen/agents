# Changelog

## [1.0.0-alpha.0] - 2026-09-30

### 💥 Breaking Changes

- **`Provider` renamed to `Scope` (fully removed, no compatibility alias)** — `runtime/Provider.ts` is migrated to `scope/Scope.ts`. All `provider` fields / params / variables are renamed to `scope`: `SdkAgent.provider` → `SdkAgent.scope`, `createAgent(scope, …)`, `createModel(scope, …)`, `createSubAgentTool(def, scope)`. `FilterOutput` / `ExcludeOptions` / `FilterOptions` move from `runtime/Provider` to `scope/Scope` accordingly.
- **Capability sources "delegated" to `ScopePlugin` (new capability-plugin contract)** — `Scope` degrades to a pure orchestration container: it only holds `config` / `cwd` / `env` / `agentsDir` and orchestrates the three-stage pipeline (discover → filter → instantiate). The four capability sources previously hard-coded in `Provider.refresh/filter/instantiate` are split into **5 standard plugins**, each self-containing its discovery state and instantiation logic:
  - `BuiltinToolsScopePlugin` (`id: "builtin"`) — 20 built-in tool classes
  - `UserToolsScopePlugin` (`id: "user-tools"`) — `tools/*.js`
  - `SkillsScopePlugin` (`id: "skills"`) — `SKILL.md` + `load_skill` / `call_skill_sub_agent`
  - `McpScopePlugin` (`id: "mcp"`) — `mcp.json` + a private `McpConnectionManager` + `load_mcp` / `call_mcp_tool` / `read_mcp_resource`
  - `SubAgentsScopePlugin` (`id: "subagents"`) — `sub-agents/*.json`
- **`Scope` no longer accepts capability-source paths, nor exposes an aggregated candidate set** — `new Provider({ config, cwd, agentsDir, skillsPaths, toolsPaths, subAgentsPaths, mcpPaths })` → `new Scope({ config, cwd, agentsDir })`. Paths are now held by the plugins (pass absolute paths, or pass relative ones that each plugin joins against `scope.cwd` during `discover()`). `Scope` no longer has `builtinTools` / `userTools` / `subagents` / `skills` / `mcps` / `mcpManager` fields.
- **`Provider.create()` removed** — replaced by explicit assembly: `new Scope({...}).use(...plugins)` → `await scope.init()`. (The static `create` shortcut is removed for now, to be revisited later.)
- **Plugins must be assembled explicitly** — `Scope` registers no default plugins itself; without assembly it has "empty capabilities". The convenience factory `allInOne({ skillsPaths, toolsPaths, subAgentsPaths, mcpPaths })` always returns the 5 standard plugins for one-shot assembly.

### 🚀 New Features

- **New `ScopePlugin` extension point** — contract `{ id; discover?; candidates; instantiate; dispose? }`, an extension point independent of core's `AgentPlugin` (Agent runtime hooks):
  - `discover?(scope, { silent })` — stage 1 · discovery (may be async, re-scans internally)
  - `candidates(scope, definition)` — stage 2 · contribute four-dimension candidate names (including availability checks, e.g. a synchronous `isAvailable`)
  - `instantiate(scope, filtered)` — stage 3 · produce `Tool[]` from the allowed names after filtering
  - `dispose?()` — release (e.g. disconnect MCP)
- **New `Scope` API**: `use(...plugins)` (chainable, variadic), `getPluginById(id)` (for external code / plugins to query plugin state), `plugins` (read-only view), `init()` / `refresh({ silent })` / `filter()` / `instantiate()` / `buildTools()` / `dispose()`. Calling `use()` after `init()` throws.
- **`dispose()` symmetric with `init()`** — calls each plugin's `dispose()` in reverse order; `McpScopePlugin.dispose()` → `mcpManager.disconnectAll()`, so MCP long-lived connections no longer rely solely on an idle timeout.
- **`allInOne()` convenience factory** — always returns the 5 standard plugins; order is priority (`builtin → user-tools → skills → mcp → subagents`; on dedupe, later registrations override earlier ones, so user tools can still override same-named built-in tools).
- **`McpScopePlugin.hasConfig()`** — lets `UnknownToolHintPlugin` determine "whether MCP config exists" (replacing a direct read of `provider.mcpPaths`).

### 🛠 Optimized

- **`UnknownToolHintPlugin` constructor now takes `{ scope }`** — it learns the MCP config via `scope.getPluginById(McpScopePlugin.ID)?.hasConfig()`; behavior semantics are unchanged (config present but `call_mcp_tool` denied → hint about permission; available → guide usage; no config → just hint that it doesn't exist).
- **`AutoRefreshToolsPlugin`** — now goes through `agent.scope.refresh()` / `agent.scope.buildTools()`.
- **Progressive-disclosure (lazy-loading) design unchanged** — the schema of `load_skill` / `call_skill_sub_agent` / `load_mcp` / `call_mcp_tool` / `read_mcp_resource`, enum disclosure (`createDisclosureParam`), the `include_manifest` switch, `touch` renewal, and `call_skill_sub_agent` reusing the parent tool set while excluding itself to prevent recursion — all **preserved verbatim**, merely moved from `Provider.instantiate()` to the `instantiate()` of `SkillsScopePlugin` / `McpScopePlugin`. Permission semantics are unchanged (denying `load_*` on the `tools` dimension cuts off the disclosure channel; denied skills/mcps never enter an enum).

### 📄 Docs

- Added [`docs/sdk-design-v1.md`](docs/sdk-design-v1.md) (the v1 design source of truth, covering the Scope / ScopePlugin architecture, the five plugins, and a migration guide); the old doc is renamed to [`docs/sdk-design-v0.md`](docs/sdk-design-v0.md).

### ✅ Tests

- All tests migrated to Scope + ScopePlugin: `capabilities.test.ts` rewritten to be organized by plugin dimension (built-in / SubAgent / Skill / MCP / user tools + lifecycle), with `createAgent` / `createModel` / `SdkAgent` / `UnknownToolHint` / `AutoRefreshTools` / `subAgentTools` / `integration` / `e2e-*` updated accordingly. SDK suite: **498 passed / 2 skipped** (including chat / view-image e2e against the real DeepSeek API).

## [0.12.0] - 2026-09-29

### 🚀 New Features

- **Unified tool output protection (`maxToolOutput`)** — `AppConfig` gains `maxToolOutput?: number` (in characters, default 32768; the factory `DEFAULT_APP_CONFIG` already writes this value). New output-protection skeleton `guardOutput()` (`capabilities/implements/builtin/outputGuard.ts`): tools declare their policy via three callbacks — `isOverLimit(content)` (the tool reads config itself to decide, including a combined measure), `dump(dir, content)` (the dumped-file list; the default is "warn only, no dump"), `buildWarning(ctx)` (the return body, with preview and stats); the skeleton only does two things: "decide → return as-is when under the limit / dump when over". The dump directory is `<os.tmpdir()>/ai-zen/tool-output/<tool>-<timestamp>-<random>/`, isolated and non-overwriting per call, with no self-cleanup (relying on the OS's policy for temp directories). Wired into:
  - **`exec`** — when `stdout + stderr` combined exceed the limit, they are dumped to separate files `stdout.log` / `stderr.log`, returning a warning + head/tail preview per stream (1000 chars each) + char/line counts; the original `exitCode` / `killed` / `terminated` fields are preserved;
  - **`findText`** — dumps `result.json`, returns a warning + head preview (1000 chars); the existing `maxMatches` / `maxFileSize` / `maxLineLength` params are unchanged;
  - **`glob` / `ls`** — dumps `result.json`, returns a warning + head preview, and hints how to narrow the scope (a more precise `pattern` / `exclude`, or switching to `glob`);
  - **`readFile`** — does **not** dump on overflow, only returns a warning and suggests batched reads via `range`.
  - Also exports `headPreview()` / `headTailPreview()` for tools to build previews as needed (the preview text is generated by each tool itself).
- **`readFile` gains a `range` param (optional)** — `range: [startLine, startCol, endLine, endCol]`, all 0-based, with `-1` meaning the last index; e.g. `[0, 0, 100, -1]` means "read from line 0 col 0 through line 100's last column". The 300KB read threshold is unchanged — the read threshold (whether a file can be read) and the output threshold (whether to dump) are independent.
- **New `inspectFile` tool (`InspectFileTool`)** — surveys a file's structural overview without reading content, complementing `readFile`'s `range` (look at the structure first, then decide the read range). Returns `path` / `bytes` / `lines` / `chars` / `maxCol` / `lineIndexOfMaxCol` (0-based) / `avgCol` / `lineEnding` (`LF` / `CRLF` / `mixed`); an optional `withColCountMap: true` returns a "line index → column count" object map. Streamed scan, **not limited by the 300KB read threshold**; columns are counted as characters, excluding the line-ending newline; on overflow the detail is not dumped, only the overview plus a hint that "the file scale exceeds the processable range". Built-in tool classes increased from 19 to 20.
- **`batchEdit` output slimmed down** — successful items no longer echo the old and new text; when all succeed it returns `{ result: "success", replacedCount }`; when there are unmatched items it returns `{ result: "partial", replacedCount, failed: [{ oldText, newText, reason }] }`, echoing only the problematic old and new text, so large blocks aren't echoed back to inflate the output.
- **`AgentDefinition` gains a `custom` field** — when `true`, SDK init does not touch the Agent's built-in content (e.g. the default prompt). The factory `DEFAULT_AGENT_DEFINITION` carries `custom: false`: `ensureDefaultAgent()` **syncs only the factory prompt** when `custom !== true` (user changes to `name` / `permissions` / `modelId` etc. are preserved), and when the prompt is identical it writes nothing and leaves `updatedAt` untouched (randomly generated message `id`s are ignored in the comparison to avoid timestamp drift).
- **Default Agent prompt adjusted** — the original rules are replaced by two: ① when a user decision is needed, ask only one question at a time; ② the current conversation is Node.js-driven, so you can write Node.js scripts to perform complex tasks and run them via the `exec` tool.

### ✅ Tests

- Added `outputGuard.test.ts` (skeleton: return as-is under the limit / dump + warning over the limit / warn-only without `dump` / directory isolation / `headPreview` and `headTailPreview`), `InspectFileTool.test.ts` (overview fields, the `colCountMap` map, CRLF and mixed, no trailing newline on the last line, empty files, files over 300KB, detail-overflow degradation, directories and non-existent paths), and overflow/range-read cases for each tool; `ConfigManager.bootstrap.test.ts` covers `custom: true` skipping, syncing only the prompt, and not writing when identical. SDK suite: **499 passed / 6 skipped**

## [0.11.0] - 2026-09-28

### 💥 Breaking Changes

- **`createCallSkillSubAgentTool` drops the third param `provider`** — the Skill sub-agent no longer re-resolves its tool set via `provider.buildTools(parent.definition, …)`; instead it **reuses the parent Agent's tool set directly** (`ctx.agent.tools`), excluding only `call_skill_sub_agent` itself: as a one-shot conversational clone, the Skill sub-agent reuses the caller's capabilities without a second permission pass, while also preventing chained skill self-recursion. Callers that passed a `Provider` must drop that argument

### 🚀 New Features

- **Skill sub-agent brought into the unified delegation boundary** — `call_skill_sub_agent` is now backed by `AgentToolLazy` (previously an in-place `CallbackTool`), so it shares the same `onSubAgentStart` / `onSubAgentEnd` plugin hooks and `sub-agent-start` / `sub-agent-end` events as regular SubAgent tools. Consumers that plug guards into `ctx.subAgent` (e.g. a context guard) and those that render sub-agent streaming output (e.g. the CLI) now cover this path

### 🛠 Optimized

- **Skill sub-agent construction consolidated into `buildAgent`** — the sub-agent's initial messages (`System(SKILL.md content)` + `User(task)`) are now decided by `buildAgent` (leveraging core 4.3.0's optional `messages`); the previously hand-written abort linkage and return-value handling are deleted, delegated to the tool base class for a unified implementation
- **Validation failures now throw** — a missing `skill_id`, or a Skill that doesn't declare `sub-agent: true`, now throws an error (previously it returned a hint text); the normal path is constrained by the `skill_id` enum, so it isn't triggered
- **Dependency `@ai-zen/agents-core` bumped to `^4.3.0`** — the dependency declaration stays `workspace:^`, expanded to `^4.3.0` by pnpm at publish time. core 4.3.0 makes `AgentToolLazy.messages` optional

### ✅ Tests

- The `createCallSkillSubAgentTool` cases in `skillTools.test.ts` are rewritten around `AgentToolLazy`: tool contract unchanged, unknown Skill throws, non-sub-agent Skill throws, delegation boundary (`onSubAgentStart` and `sub-agent-start` dispatch, the child reusing the parent tool set while excluding itself, initial messages drawn from SKILL.md and `task`); SDK suite: **463 passed / 6 skipped**

## [0.10.0] - 2026-09-28

### 🚀 New Features

- **`load_mcp` gains an `include_manifest` switch (optional boolean, default `true`)** — the default behavior is unchanged verbatim (returns the full `{ tools, resources }` manifest, with tools carrying the full `inputSchema`); passing `false` explicitly only establishes the connection and returns a summary `{ server, connected, tools: count, resources: count }`, without any tool/resource definitions. It serves the "connection has gone stale after a process restart, but the manifest already exists in context" scenario: rebuild the connection only, without re-injecting tens of KB of tool definitions into the context, saving tokens. The full manifest stays inside `McpConnectionManager`, and `call_mcp_tool` / `read_mcp_resource` behavior is unchanged; the `server` param enum, the tool-name table, and `DYNAMIC_TOOL_NAMES` are all unchanged (the prefix-cache structure is unaffected). The failure-path and already-connected-path semantics are identical in both modes; `docs/sdk-design.md` §9 updated accordingly

### 🛠 Optimized

- **Dependency `@ai-zen/agents-core` bumped to `^4.2.0`** — the dependency declaration stays `workspace:^`, expanded to `^4.2.0` by pnpm at publish time. core 4.2.0 adds the sub-agent delegation blocking hooks `onSubAgentStart` / `onSubAgentEnd` and renames the existing `sub-agent` event to `sub-agent-start` (a core-side breaking change); the SDK doesn't listen to that event internally, so no source adaptation is needed. Consumers listening to that event must rename accordingly

### ✅ Tests

- `mcpTools.test.ts` gains 4 cases: silent + not connected, silent + connected, explicit `true`, silent + connection failure; SDK suite: **461 passed / 6 skipped**

## [0.9.4] - 2026-09-20

### 🔧 Fixed

- **MCP `sse` transport switched to a real SSE connection (`SSEClientTransport`)** — previously `http` and `sse` were handled together, both using `StreamableHTTPClientTransport` (Streamable HTTP: POST to send messages + an optional SSE stream), which made legacy HTTP+SSE servers declared as `type: "sse"` (GET to open the SSE stream, POST to the endpoint to send messages) actually run on a mismatched protocol stack. Now they are split by transport: `http` → `StreamableHTTPClientTransport`, `sse` → `SSEClientTransport` (both built-in official SDK implementations). `headers` are still passed through via `requestInit`, applied uniformly by the SDK to the SSE stream setup (GET) and message-sending (POST) requests; the error behavior when `url` is missing is unchanged. The `McpServerConfig.transport` comment and `docs/sdk-design.md` §10/§11 updated accordingly

### ✅ Tests

- Verified against a real MCP server (`packages/test-project/mcp-servers/sse-server.mjs`, legacy HTTP+SSE protocol): connection setup, tool discovery (`echo` / `add`), tool calls, and disconnect/reconnect; and confirmed the runtime transport instance is `SSEClientTransport`

## [0.9.3] - 2026-09-01

### 🔧 Fixed

- **`createAgent` no longer pollutes the Agent definition template (`definition.messages` reference isolation)** — when creating an Agent, `definition.messages` is now snapshot (`[...(definition.messages ?? [])]`) instead of being referenced directly. Previously the definition array was passed straight to `AgentContext.messages` (a mutable runtime array), so during a conversation `append()` would write the full conversation history back into `definition.messages`, causing:
  - the task-migration `prune` branch to expand the polluted "full history" instead of the template → old messages were neither physically deleted nor marked `omit`, yet the newly injected breakpoint message was visible;
  - the `omit` branch's `preserveCount` to equal the full length because `definition.messages` and `agent.messages` pointed to the same array → history messages could not be marked `omit`;
  - `/new` to copy from the polluted template, so a new conversation inherited the old history.
  - Also fixes a crash when creating an Agent whose definition lacks a `messages` field (`undefined`) (with a `?? []` fallback).

### ✅ Tests

- `createAgent.test.ts` gains: `append` does not pollute `definition.messages` (reference isolation); an Agent whose definition lacks a `messages` field is created normally

## [0.9.2] - 2026-08-31

### 🎯 Optimized

- **Default Agent prompt refactored (`DEFAULT_AGENT_DEFINITION`)** — streamlined and stylistically unified:
  - the persona is set to "witty and humorous, rigorous and reliable"
  - the original 8 principles are compressed into one core rule: whenever you hit any situation that is unclear, uncertain, contradictory, or that might affect the result, stop immediately and ask the user directly, rather than filling in the gaps yourself, guessing, or forcing ahead
  - a new "terse" principle: state only the result and necessary explanation; the execution process (tool calls, reads/writes, searches, etc.) is already visible to the user, so don't restate it, to save tokens
  - guards retained: proactively call tools, report faithfully, and act only within the scope you've been assigned
  - injects "current operating system" info, dynamically using `process.platform` to adapt to different platforms
- **`ViewImageTool` gains a local-URL check** — a new `isLocalUrl()` rejects the `file://` protocol and http(s) URLs pointing to local loopback addresses (`localhost`/`127.0.0.1`/`[::1]`/`0.0.0.0`) (API providers cannot download them), erroring early in the call; `function.description` and the `path_or_url` param description now add "local URLs are not supported; use a file path for local images"

## [0.9.1] - 2026-08-28

### 🔧 Fixed

- **SDK-produced messages now always carry an `id`, aligned with core 4.1.0's required `Message.id`** — `TaskMigrationService.createPostMessages()` returns a `Message.User`, and the default agent / sub-agent definitions (`DEFAULT_AGENT_DEFINITION` / `DEFAULT_SUBAGENT_DEFINITION`) build their messages via `Message.System` / `Message.User`. This removes the last places where a bare object literal `{ role, content }` was assigned to `AgentNS.Message`, which would now fail to compile under core 4.1.0 (where `Message.id` is non-optional). Consumers no longer need to patch a missing `id` on SDK-generated messages (e.g. a desktop-side `ensureId` bridge)
- **No breaking change to public API** — only internal message construction was switched to the `Message` factory methods; exported types and method signatures are unchanged

### ✅ Tests

- SDK suite re-checked green against core 4.1.0 (`Message.id` required)

## [0.9.0] - 2026-08-28

### 🎯 Optimized

- **`TaskMigrationService.migrate` gains a `strategy` switch** — controls how history is handled after migration:
  - **`omit` (default)**: history messages are marked `omit: true` (kept in `agent.messages` for audit/replay, but `Agent.formatHistory()` filters them out), and a "conversation breakpoint" message (handoff doc + handover instructions, role=user) is appended as the new context start. The sequence sent to the model becomes `[definition.messages, breakpoint message]`. Reuses Core's existing `omit` mechanism — no Core changes needed.
  - **`prune`**: physically drops history, keeping only `definition.messages` + breakpoint message (the previous replace behavior).
  - The default can be set via `strategy` when constructing `TaskMigrationService`, and overridden per `migrate()` call (`MigrationStrategy` type is exported).
  - `agent.messages` is rebuilt via a **shallow copy** to avoid mutating objects referenced by `definition.messages` (prevents polluting the template).
  - `historyText` (fed to the model to generate the handoff doc) now **filters omitted history**, so repeated migrations don't re-feed old omitted history to the model.
  - `AutoMigratePlugin` still only decides *when* to trigger — no changes needed.

### ✅ Tests

- `TaskMigrationService` / `AutoMigratePlugin` assertions updated to the omit semantics (history marked omit + trailing breakpoint + system prompt preserved).
- New case: `historyText` filters already-omitted history.
- New case: `strategy=prune` (constructor default + `migrate` param override) physically drops history.

## [0.8.0] - 2026-08-24

### ⚠️ Breaking

- **`TaskMigrationService` is now an instantiated, self-contained migration service** — it holds no model call of its own: `migrate()` reuses the passed `agent`'s own `client` / `model` / `modelConfig` to generate the handoff document, so it needs no `Provider` and no standalone "migration Agent" object (and no duplicated `config + modelId` model wiring). `migrate()` is an instance method that serializes history, calls the model to generate the handoff document, and replaces `agent.messages`.
  - `TaskMigrationServiceOptions` = `{ client?, model?, modelConfig?, onBeforeMigrate?, onMigrated?, logger? }` — pass `client`/`model`/`modelConfig` to override the model call used for the handoff; when omitted, `migrate()` falls back to the passed `agent`'s own config
  - `migrate({ agent, promptTokens?, maxTokens? })` — `agent` is the only runtime param (its `client`/`model`/`modelConfig` back the model call); the migration hooks are flat on the service instance (no `hooks` wrapper)
- **`AutoMigratePlugin` narrowed to a trigger-only role** — constructor takes `{ service, maxTokens }`; it only detects token overflow in `onAfterSend` and delegates to `service.migrate({ agent, promptTokens, maxTokens })`. No hooks on the plugin.
- **Removed** — `TaskMigrationService.createAgentDefinition` (the service calls the model directly, so a standalone migration Agent definition is unnecessary) and `BuildMigrationAgentOptions`; `MigrationContext` no longer carries `migrationAgent` (records `model` instead).
- **New exports** — `MigrationContext`, `TaskMigrationServiceOptions`.

### 🛠 Optimized

- `serializeMessages` moved from `AutoMigratePlugin` private to `TaskMigrationService` public static.
- The pure-tool statics (`createPrompt` / `createPostMessages` / `serializeMessages`) remain `static`; the instance `migrate()` reuses the passed `agent`'s model client. The "should migrate" check (`promptTokens > maxTokens`) lives in `AutoMigratePlugin` (the trigger side), not on the service.
- Migration failure still leaves `agent.messages` unchanged (atomic); hook errors are caught and logged, never interrupting the migration flow.

### ✅ Tests

- `TaskMigrationService`: statics (`createPrompt` / `createPostMessages` / `serializeMessages`) + `migrate` (model call, hook contexts, failure atomicity) — all green.
- `AutoMigratePlugin`: trigger-only behavior (overflow → `service.migrate`; below threshold / no usage → no model call).

## [0.7.1] - 2026-08-25

### 🚀 New Features

- **`FindTextTool` (findText) gains three-layer output protection** — prevents search results from blowing up the context window:
  - **`maxMatches`** (default 200) — caps the total number of matches; once reached, scanning stops and the result is marked `truncated`
  - **`maxFileSize`** (default 300KB, aligned with `ReadFileTool`) — files larger than this are **skipped** rather than rejected, so an oversized file doesn't block the whole search
  - **`maxLineLength`** (default 200) — each matched line's `content` and the regex `match` substring are truncated (with a trailing `…`)
  - All three are optional parameters that can be overridden by the caller; when truncated the result returns `{ truncated: true, totalMatches, results }`, while non-truncated results keep the original JSON array shape (backward compatible)

## [0.7.0] - 2026-08-14

### ⚠️ Breaking

- **`@ai-zen/agents-core` upgraded to 4.0.0** — the SDK now runs on the **official OpenAI SDK**: `createModel(provider, modelId)` returns `{ client, model, modelConfig }` (an `openai` client + model name + params spread into the request) instead of a `ChatCompletionModel`; `SdkAgent` / `createAgent` construct with `{ client, model, modelConfig }`; `GenerateImageTool` calls `client.images.generate`
- **Plugin mechanism promoted to core** — `AgentPlugin` / `SendContext` / `HookResult` now live in `@ai-zen/agents-core` (re-exported by the SDK for compatibility). `SdkAgent` no longer implements its own `use` / `init` / hook iteration, and the `onUnknownTool` property hack is gone — it inherits everything from Core `Agent`
- **`SdkAgent.defaultUnknownTool` override removed** — the MCP-aware unknown-tool hint moved out of the class into a standalone plugin (see `UnknownToolHintPlugin` below); Core `Agent` now keeps only a simple built-in hint
- **`SdkAgent.permissions` field removed** — the Agent no longer carries its own `permissions` copy; read `agent.definition.permissions` instead (single source of truth). `AutoRefreshToolsPlugin` and `call_skill_sub_agent` were updated accordingly
- **`ContextGuardPlugin` default `ratio` changed from 1.2 to 1.5** — the guard now trips at 50% over `maxTokens` (user setting) instead of 20%

### 🚀 New Features

- **`UnknownToolHintPlugin`** — new standalone plugin providing the MCP-aware unknown-tool hint (replaces the removed `SdkAgent.defaultUnknownTool` override). Register explicitly: `agent.use(new UnknownToolHintPlugin({ provider }))`; without it, unknown tools fall back to Core's simple built-in hint
- **`Model.vision` field + self-declared tool availability** — models can be marked `vision: true`. `SdkCallbackTool` gains `isAvailable(config, definition)`: tools **self-declare** availability by directly inspecting the full app config and agent definition (e.g. `GenerateImageTool` requires `defaultImageModel`, `ViewImageTool` requires a vision model). All **19 built-in tools** live in `BUILTIN_TOOL_CLASSES` (discovery does no filtering); `Provider.filter`/`buildTools` take the `AgentDefinition` and call `isAvailable` at build time (when the model is already known) to filter the final tool set — no hard-coded tool names, and no runtime duplication (vision checks live only in `ViewImageTool.isAvailable`)
- **`ViewImageTool`** — let the Agent view/analyze an image (vision models only): a network URL returns an `image_url` content block; a local path is auto-uploaded via the Files API (`client.files.create`, `purpose: "user_data"`) and returned as a `file` content block (no base64). Always registered as a built-in candidate; filtered out by `buildTools` for non-vision models (a runtime check remains as a defensive guard)
- **`GenerateImageTool` returns a plain string** — it always returns JSON text with the image URLs plus `viewImage` / `downloadFile` hints; how the generated image is consumed (view / download / forward) is left to the model and the caller, instead of forcing image content blocks on vision models
- **`SdkCallbackTool.exec` passes content-section arrays through** — aligned with Core's `Tool.exec` returning `AgentNS.MessageContent`; other values are still JSON-serialized

### 🎯 Optimized

- `createAgent` / `subAgentTools` / `skillTools` adapted to the new Agent constructor (`{ client, model, modelConfig }`)
- The plugins (`AutoMigratePlugin` / `AutoRefreshToolsPlugin` / `ContextGuardPlugin` / `UnknownToolHintPlugin`) now type their hooks from core's `AgentPlugin` / `HookResult`

### ✅ Tests

- Adapted `createModel` / `SdkAgent` / `Provider` / `createAgent` / `AutoRefreshToolsPlugin` / `ContextGuardPlugin` / `skillTools` / e2e tests to the core 4.0.0 API — all green (incl. real DeepSeek API e2e)

## [0.6.0] - 2026-08-14

### ⚠️ Breaking

- **`SdkCallbackTool` constructor no longer takes `function` — construction is now `super({ env })` only** — the tool definition (`function`) is declared by each tool as a **class-body field**, colocated with its `call` implementation. The constructor now takes an options container (`SdkCallbackToolOptions`, currently containing `env` as its core field and open to future extension). Any custom tool previously writing `super({ function, env })` must move its `function` definition into a class-body field and call `super({ env })`. `SdkCallbackToolOptions` is exported for external consumers
- **`SdkCallbackTool.call` now forwards the full `ToolCallContext`** — `call(input)` becomes `call(input, ctx?)`. Concrete tools may read the second argument (e.g. `ctx?.signal`) for abort support. This is additive (optional argument), so existing single-argument `call`s keep compiling
- **`@ai-zen/agents-core` upgraded to 3.4.0** — the `Tool` base class no longer requires passing `function`/`type` via its constructor; `CallbackTool` / `AgentToolLazy.buildAgent` no longer use `this`-injection and now receive `(parsed_args, ctx)`. SDK callbacks that previously read `this.agent` now read `ctx.agent` instead (`call_skill_sub_agent` in skillTools, `buildAgent` in subAgentTools)

### 🛠 Optimized

- **All 18 built-in tools now declare their `function` definition as a class-body field** — the definition lives next to the `call` implementation (single source of truth), instead of being passed separately through the constructor
- Aligned SDK tool context access with core's explicit `(parsed_args, ctx)` convention
- **Per-tool abort signal support** — high-value tools now honor interruption via `ctx?.signal`:
  - **`sleep`** — listening for abort on the wait timer, returning early so a long wait is interrupted instead of blocking
  - **`exec`** — killing the child process on abort (marking `terminated: "aborted"` distinct from `"timeout"`), with a fallback to avoid hanging if the signal kills the shell
  - **`downloadFile`** — passing the signal to `fetch`, and cleaning up any partially-written file on abort
  - **`generateImage`** — passing the signal to the image-model request (the underlying `fetch` already supports it), returning an aborted result on interruption
  - **`glob` / `findText`** — checking `ctx.signal` during directory-tree traversal (and after each file read), stopping the scan early and returning the partial results with an `aborted` flag when interrupted
- **MCP tool signal forwarding** — `call_mcp_tool` and `read_mcp_resource` now forward `ctx.signal` into the underlying MCP SDK `callTool` / `readResource` request options, so a remote call can be interrupted
- **Sub-agent abort linkage** — sub-agent tools (`AgentTool`, `AgentToolLazy`; used by `createSubAgentTool` and `call_skill_sub_agent`) now listen for the outer `ctx.signal` and call `agent.abort()` on the child agent, so a long-running sub-agent is stopped when the parent call is aborted

### ✅ Tests

- Updated `SdkCallbackTool` / `capabilities` tests for the new `function` assignment and `super({ env })` construction; added a test asserting `SdkCallbackTool.call` receives the forwarded `ToolCallContext`
- **Added abort tests** for `sleep` (early return + immediate abort), `exec` (child killed + `terminated: "aborted"`), `downloadFile` (abort cleanup of the partial file), `generateImage` (aborted result), `glob`/`findText` (early scan stop), plus MCP `callTool`/`readResource` signal forwarding and sub-agent abort linkage. SDK suite now at **435 passed**, **3 skipped**; core at **198 passed**, **17 skipped**

## [0.5.7] - 2026-08-13

### 🛠 Optimized

- **`@ai-zen/agents-core` dependency upgraded to 3.3.1** — dual-set inner-loop task semantics + unified Assistant placeholder at inner-loop start; SDK 426 tests (incl. real DeepSeek e2e) all pass, fully compatible

## [0.5.6] - 2026-08-14

### 🚀 New Features

- **`AgentPlugin` gains the `onToolCall` interception hook** — corresponding to Core 3.3.0's `onToolCall` hook: fired before every tool call execution, receiving the **same `ToolCallContext` instance** that is passed to `Tool.exec(ctx)`. Returning a string rejects the tool (not executed; the reason is returned to the LLM as the tool result and the conversation continues to the next round); returning `undefined` allows execution. Multiple plugins run in registration order and any one returning a string rejects (short-circuit). `SdkAgent.send()` wraps this hook into plugin iteration before delegating to `super.send()`, isomorphic with the existing inner-loop hooks, and clears it afterwards

### 🛠 Optimized

- **`@ai-zen/agents-core` dependency upgraded to 3.3.0** — `FunctionCallContext` was unified into `ToolCallContext` (a single class spanning interception decision → execution). SDK internal references (`SdkCallbackTool.exec`, skill / sub-agent tool callbacks) are synced to `ToolCallContext`, while the deprecated `FunctionCallContext` alias is retained for backward compatibility

## [0.5.5] - 2026-08-13

### 📄 Docs

- **README translated to English** — the main `README.md` is now English-first, with the original Chinese content preserved as `README.zh.md`
- **Package metadata standardized** — `description` unified to English across packages

## [0.5.4] - 2026-08-05

### 🚀 New Features

- **`ExecAsyncTool` (exec_async) now uniformly uses shell parsing** — removed the manual word-splitting logic on Unix; all platforms now execute via `spawn(command, [], { shell: true })`. The tool description explicitly tells the agent it does not capture output itself; to retain/inspect output, use shell redirection to a file (`>` / `>>`) in the command, and shell syntax such as pipes (`|`) is supported

### 🎯 Optimized

- **`ExecTool` (exec) `timeout` is now required** — schema `required` expanded from `["command"]` to `["command", "timeout"]`; the `call()` type signature is `timeout: number` (required), with double validation at runtime (throws on missing / non-positive / non-finite). With `timeout` required, commands are always protected by a timeout and cannot run indefinitely
- **Timeout reason clearly reported to the agent** — when `exec` is killed by a timeout (`error.killed` is `true`), the returned structure adds a `terminated: "timeout"` field. This compensates for Node not automatically writing a timeout notice to stderr, letting the agent clearly determine that the command was terminated by a timeout and respond accordingly

## [0.5.3] - 2026-08-05

### 🚀 New Features

- **Default mcp.json with socket-pty released on init** — `ConfigManager.bootstrap()` adds `ensureDefaultMcpConfig()`, which on first run writes a default MCP config (incl. the socket-pty terminal server, `command: npx -y @ai-zen/socket-pty mcp`) to `~/.ai-zen/mcp.json`; idempotent, does not overwrite if the file exists. Added `readMcpConfig()` / `writeMcpConfig()` methods, and exported `DEFAULT_MCP_CONFIG` constant
- **`load_mcp` passes through server description** — `McpServerConfig` gains an optional `description?` field, no longer discarded by `discoverMcpServers`; the `server` parameter enum in `load_mcp` is built as `- {id}: {description}` so the LLM can see each server's description (isomorphic with `load_skill`)
- **New `ContextGuardPlugin` context safety guard** — before each inner loop's request (`onInnerLoopStart`, outside the try block in Core), checks the previous round's `usage.prompt_tokens`; when it exceeds `maxTokens × ratio` (default 1.2, i.e. 20% over threshold), throws `ContextOverflowError` to interrupt the conversation, preventing context runaway from reading oversized files. Responsibilities are separated from `AutoMigratePlugin` and the ranges complement each other; no Core changes needed

### 🆕 New Exports

- `DEFAULT_MCP_CONFIG` (constants), `ContextGuardPlugin`, `ContextOverflowError`

## [0.5.2] - 2026-08-03

### 🚀 New Features

- **`AgentPlugin` gains `onInnerLoopsStart` / `onInnerLoopsEnd` hooks** — corresponding to Core 3.2.0's whole-group inner-loop start/end hooks (each fires once per `send`). `SdkAgent.send()` wraps these two hooks into plugin iteration before/after delegating to `super.send()`, isomorphic with the per-round `onInnerLoopStart` / `onInnerLoopEnd`. Plugins can access the current agent, the sent content, and the message snapshot via `ctx`

## [0.5.1] - 2026-08-03

### 🛠 Optimized

- **`@ai-zen/agents-core` dependency upgraded and switched to a range version** — from `workspace:*` (replaced with the exact version `3.0.1` at publish time) to `workspace:^` (published as `^3.1.0`). Since core 3.1.0, `Message` auto-generates an `id` in the constructor, so messages passed through the SDK carry a stable id; the range version means subsequent core minor/patch upgrades no longer require a separate SDK release

## [0.5.0] - 2026-07-29

### 💥 Breaking Changes

- **All built-in tools are now classes** — the 17 built-in tools changed from singleton `CallbackTool` instances to classes (`CwdTool`, `ReadFileTool`, `WriteFileTool`, `ExecTool`, etc., PascalCase naming) extending the new abstract base `SdkCallbackTool`. The `BUILTIN_TOOLS` singleton registry was replaced with the `BUILTIN_TOOL_CLASSES` class registry (`Array<new (env: ToolEnv) => SdkCallbackTool>`)
- **`generateImage` classed as `GenerateImageTool`** — removed the factory function `createGenerateImageTool(config)`; constructor signature unified with other built-in tools as `(env: ToolEnv)`. Still conditionally registered via `config.defaultImageModel`, not part of the static `BUILTIN_TOOL_CLASSES` registry
- **`discoverBuiltinTools` signature changed** — from `discoverBuiltinTools(config: AppConfig)` to `discoverBuiltinTools(env: ToolEnv)`, instantiating tool classes with `env`
- **`Provider` gains `cwd` and `env`** — `cwd` defaults to `process.cwd()` and is the base for relative path resolution; `env: ToolEnv` (`{ cwd, config }`) is established at construction and used by `refresh()` to instantiate built-in tools. **Tools no longer depend on the global `process.cwd()`**; each Provider can be bound to a different working directory
- **Conversation/draft product layer removed** — `Conversation` / `Draft` types, `ConversationRepository`, `DraftRepository`, `AutoDraftPlugin`, and their tests were all removed. Conversation and draft persistence are delegated to each consumer (CLI/Desktop), which may reuse `EntityRepository`
- **`index.ts` export changes** — removed `Conversation`/`Draft`/`ConversationRepository`/`DraftRepository`/`AutoDraftPlugin`/`BUILTIN_TOOLS`/`execAsyncTool`/`sleepTool`/`createGenerateImageTool`; added `ToolEnv`, `SdkCallbackTool`, `BUILTIN_TOOL_CLASSES`, `GenerateImageTool`, and the 17 tool classes

### 🚀 New Features

- **`ToolEnv` interface** — tool environment `{ cwd, config }`, injected at tool construction, serving as the base for relative path resolution and config reads
- **`SdkCallbackTool` abstract base** — `env` constructor injection + subclass `call()` + `exec()` bridge + `resolve()` relative path resolution (public, easy to call directly in tests)

### 🎯 Optimized

- **Multi-session parallelism** — `cwd` moved down to the Provider (`ToolEnv.cwd`); multiple Providers can serve sessions in different working directories in parallel without interference
- **Per-Provider tool instances** — each Provider instantiates its own set of tools via `discoverBuiltinTools(env)`, eliminating global singleton state

## [0.4.0] - 2026-07-29

### 💥 Breaking Changes

- **`load_mcp` return value changed from plain text to structured JSON** — now returns `{ tools, resources }`, where tools include the complete `inputSchema` (parameter JSON Schema) and resources include `uri`, `name`, `description`, `mimeType`. The LLM gets precise parameter structure instead of guessing from description text
- **`load_mcp` no longer returns a `prompts` field** — prompts are for the UI layer and are not exposed to Agents
- **`createLogger()` replaced with the global singletons `getLogger()` / `setLogger()`** — logging no longer supports multiple instances; all SDK-internal modules uniformly obtain the same instance via `getLogger()`
- **`index.ts` export changes** — `createLogger` → `getLogger` / `setLogger`

### 🎯 Optimized

- **`load_mcp` prints the full manifest to the log after a successful connection** — complete JSON with tools, resources, and prompts, for easier debugging
- **SDK-internal logging unified** — `console.warn`/`console.error` in `mcps.ts`, `skills.ts`, `usertools.ts`, and `McpConnectionManager.ts` all changed to `getLogger().warn`/`getLogger().error`

## [0.3.4] - 2026-07-27

### 🎯 Optimized

- **`AutoMigratePlugin` hook renamed** — `onHandoff` → `onMigrated`, with clearer semantics: use `onBeforeMigrate` before migration (at which point `agent.messages` is still the full old history) and `onMigrated` after migration completes (the handoff document has been injected)
- **`conversation-runner.ts` save logic fixed** — saving the old conversation moved from `onMigrated` (formerly `onHandoff`) to `onBeforeMigrate`, ensuring the complete old conversation history is saved rather than the post-migration new messages

## [0.3.3] - 2026-07-27

### 🎯 Optimized

- **Default SubAgent System Prompt gains two mandatory requirements**:
  1. Refuse to execute when information is unclear/ambiguous/missing; ask for clarification
  2. Point out contradictions when conflicting information is present; ask for clarification
- **Default Agent System Prompt adds a principle**: "Ask when contradictory — if the user's instructions contain contradictions, point them out and request clarification instead of deciding on your own"
- **Default SubAgent `function.description` and `task` parameter description** updated in sync, emphasizing that unclear information will lead to refusal

## [0.3.2] - 2026-07-26

### 💥 Breaking Changes

- **All `EntityRepository` methods are now async** — `list()`, `read()`, `write()`, `delete()` now return `Promise`, requiring `await`
- **All `DraftRepository` methods are now async** — `read()`, `write()`, `delete()` require `await`
- **All `ConfigManager` methods are now async** — `read()`, `write()`, `ensureDirs()`, `ensureDefaultAgent()`, `ensureDefaultSubAgent()`, `ensureDefaultConfig()`, `bootstrap()` all require `await`
- **`createAgent()` is `async` again** — as the underlying repositories became async, `createAgent(provider, agentId)` requires `await`
- **`AutoDraftPlugin.checkDraftForRestore()` is now async** — requires `await`

### 🎯 Optimized

- **Synchronous file I/O fully eliminated** — all `existsSync`, `readFileSync`, `writeFileSync`, `readdirSync`, `mkdirSync`, `unlinkSync`, `renameSync` in production code replaced with the `fs.promises` async API, avoiding event-loop blocking
- **`skillTools.ts`** — `readdirSync` in the tool callback replaced with `fs.promises.readdir`

### ✅ Tests

- 7 test files updated in sync to `async`/`await`; test helpers also use `fs.promises`

## [0.3.1] - 2026-07-26

### 💥 Breaking Changes

- **`Provider` moved to `runtime`, merging `Capabilities`** — deleted `capabilities/Capabilities.ts` and the original `runtime/Provider.ts`; Provider now directly exposes `filter()`, `buildTools()`, `instantiate()`, `refresh()`
- **`getMcpManager()` removed** — `mcpManager` changed from a lazy getter to being constructed directly as `new McpConnectionManager()` (when mcpPaths exist), a `readonly` property
- **Field renames** — `builtinInstances` → `builtinTools`, `userInstances` → `userTools`, `subagentDefs` → `subagents`
- **`createModel` signature changed** — from `createModel(config, modelId)` to `createModel(provider, modelId)`; callers no longer need the `.config` destructure
- **`SdkAgent` drops the `caps` field** — only `provider` remains

### 🚀 New Features

- **User tool ESM support** — removed the `node:vm` sandbox, uniformly using `import()` to load `.js` / `.mjs` files; each `refresh()` appends a timestamp querystring to prevent caching
- **`CallbackTool` replaces `createToolFromObject`** — the `{ function, exec }` format maps directly to `CallbackTool`

### 🎯 Optimized

- **Default Agent system prompt updated** — condensed to five principles: think hard, be truthful, follow instructions, safety first, win battles
- **Default SubAgent `function.description` optimized** — emphasizes that the main Agent must provide complete task context

### 🗑 Removed

- Deleted `capabilities/Provider.ts` (moved back to `runtime/Provider.ts`)
- Deleted the `createToolFromObject` utility function
- Deleted `TODO.md` and `TODO2.md`
- Test fixtures migrated from `.js` to `.mjs`

## [0.2.6] - 2026-07-20

### 🔧 Fixed

- **Default SubAgent function name and description insufficient for the LLM to recognize it as a sub-agent** — `function.name` changed from `general_assistant` to `sub_agent_default`; `function.description` rewritten with detailed wording, clarifying the sub-agent identity and capability boundary. The parameter name changed from `query` to `task` to align with the design spec; the system prompt clarifies the role
- **`DEFAULT_SUBAGENT_ID` changed from `general-assistant` to `sub-agent-default`** — filename matches the function name for easy recognition

## [0.2.5] - 2026-07-20

### 🔧 Fixed

- **`DEFAULT_SUBAGENT_DEFINITION` missing `permissions` config** — the default SubAgent `general-assistant` had no permissions, so every dimension effectively became `deny: ['*']`, making it completely unable to use any tool/skill/MCP/SubAgent. Now completed per the design spec, with only the `subagents` dimension set to `deny: ['*']` to prevent recursive calls

## [0.2.4] - 2026-07-20

### 🔧 Fixed

- **`load_skill` no longer injects a System message** — instead returns the full SKILL.md content plus the Skill directory path and file list directly in the tool return value, fully transparent to the LLM
- **`SkillInfo` gains a `dirPath` field** — records the absolute path of the directory containing SKILL.md
- **`McpConnectionManager.doConnect` calls methods on demand per server capabilities** — only invokes the corresponding method for declared capabilities, avoiding Method not found for undeclared ones
- **`McpConnectionManager.doConnect` wraps each list call in try/catch** — a failure to fetch one capability does not affect the others

## [0.2.3] - 2026-07-20

### 🔧 Fixed

- **`AgentRepository` — uses `EntityRepository` instead of direct file operations** — adopting the base repository for unified logic

## [0.2.2] - 2026-07-20

### 🔧 Fixed

- **`SdkAgent.send()` — `ctx.messages` no longer references `this.messages` directly** — changed to a shallow-copied snapshot, ensuring the message array is owned solely by the agent
- **`AutoMigratePlugin` — no longer creates a new Agent instance** — directly replaces the `agent.messages` array, preserving all references, plugin bindings, and event listeners
- **`AutoMigratePlugin` — adds a log notice before migration** — uses `log.warn` to output the migration start notice

### 🎯 Optimized

- **`AutoMigratePlugin` — `onHandoff` signature simplified** — from `(doc, oldAgent, newAgent)` to `(doc, agent)`, since the agent is the same object
- **`TaskMigrationService.createPrompt()` — streamlined prompt** — explicitly requires only the handoff document as output, no explanations

### ✅ Tests

- Added exact assertions for the message array **length before/after migration** (3 before → 2 after)
- Added assertions that the message array **length and content stay unchanged** on migration failure
