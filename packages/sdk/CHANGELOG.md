# Changelog

## [1.0.0-alpha.24] - 2026-10-29

> User tool files can no longer damage the host. `tools/` holds code that the SDK
> **evaluates in-process**, so a stray script in that directory used to be able to
> kill the process, hang startup, or silently rewrite project files.

### 💥 Breaking Changes

- **`tools/` is now explicitly a trusted-extension directory.** Files there are
  still `import()`-ed in-process, so the SDK cannot sandbox them: a top-level
  synchronous infinite loop or a native `process.kill()` still takes the host
  down. Anything untrusted belongs in an MCP server, which is the out-of-process
  extension path. This is documented in `discover.ts` next to the guards.

### 🛡️ Fixed — user tool loading is now fail-safe

Real-world incident that motivated this release: a one-off developer script
(`process.exit(2)` when called without arguments) was dropped into
`.ai-zen/tools/`. Every startup imported it during session creation, so the CLI
process was killed mid-initialization and the last drawn frame stayed on screen —
it looked like a hang. Another script in the same directory rewrote PNG assets at
module top level on every startup. All four such files are now skipped or
neutralised.

- **Static pre-check: files without `export` are never evaluated.** A module with
  no `export` cannot export a `Tool`, so `normalizeToolExport()` was already going
  to discard it — the only difference is that the old code found out *after*
  evaluating it, i.e. after the side effects had happened. Reading the source
  first costs one `fs.readFile` and buys complete immunity from that class of
  file. Read failures fail open (the file is still imported) so an unreadable but
  valid tool is never silently dropped.
- **`process.exit` / `process.abort` are suppressed during evaluation.** They are
  swapped for a thrown `UserToolExitError`, which lands in the existing
  `try/catch` and rejects just that one file. The originals are restored in a
  `finally` — the guard must never outlive the import, or the host itself could
  not exit. What was saved is the *current* value, not the value at module load,
  so nested/concurrent discoveries restore correctly.
- **`console.log` / `info` / `debug` are redirected to stderr while evaluating.**
  stdout belongs to the host's UI; a tool file writing to it tears an Ink frame
  apart. This is also why the stray scripts visibly corrupted the TUI.
- **Per-file import timeout (`importTimeoutMs`, default 5000).** A module whose
  top-level `await` never settles no longer blocks startup. A timeout only stops
  *waiting* — ESM evaluation cannot be cancelled, so the module may still finish
  later; this is stated at the call site rather than pretended away.

### 🔧 Changed

- Rejections are reported through `getLogger().warn/error` (previously the
  failure path logged at `error` only). No new notification API was added: hosts
  that want these on screen should tee their `Logger`, which is a single hook that
  covers every SDK subsystem at once instead of one callback per feature.

### ✅ Tests

- `discover.test.ts` 16 → 21 cases. The five new ones pin each hazard: a file
  without `export` is skipped **without being evaluated** (asserted via a
  side-effect marker file), a top-level `process.exit(2)` neither kills the host
  nor prevents later files from loading, top-level `console.log` does not reach
  stdout, a never-settling top-level `await` times out, and `process.exit` /
  `console.log` are restored afterwards.
- Full suite: 57 files / 617 passed / 6 skipped.

## [1.0.0-alpha.23] - 2026-10-29

> The SDK is now English-only. Every model-facing and user-facing string is a
> fixed English literal: no i18n layer, no locale field in `AppConfig`, no
> runtime language switching. This is a performance boundary, not a convenience
> choice — SDK behaviour and performance must not vary with the user's language.

### 💥 Breaking Changes

- **Language is a performance boundary, not a translation gap.** `Model.tokenThresholds.handoff` / `guard` and `AppConfig.maxToolOutput` are absolute token / character counts, so a localized tool schema is a different token count and would make handoff and context-guard trip at different amounts of real content for the same `config.json`. Tool descriptions are also re-sent on every request, so a token delta is a standing cost rather than a one-off, and per-language prompt-cache prefixes would strip benchmarks of the single variable they rely on.

- **All tool schema descriptions are now English.** 270 hardcoded Chinese string literals across 39 source files were translated. Tool names, parameter keys, enum values and identifiers were already English and are unchanged.
- **The factory system prompt no longer forces a reply language.** The hardcoded `reply in Chinese` directive was removed and replaced with a language-neutral instruction — `Always reply in the same language the user writes in.` The model now follows the user's language per message instead of per installation, which is what a locale dimension could never express.
- **Factory assets are English.** The default Agent and SubAgent prompts, the factory handoff Skill (`skills/handoff/SKILL.md`), the fallback handoff template, and the factory catalog (endpoint / model / MCP server descriptions) are all English. `DEFAULT_AGENT_DEFINITION` and `DEFAULT_SUBAGENT_DEFINITION` keep their shape — only the text changed, so no consumer code needs updating.
- **Upgrade behaviour.** `bootstrap()` rewrites the factory prompt in `agents/default.json`; Agents marked `custom: true` are untouched. Conversation archives keep their original text: a conversation copies its system message at creation time and never re-derives it from the factory definition, so existing archives stay exactly as they were.

### 🔧 Changed

- Runtime-injected guidance (`UnknownToolHintPlugin`), tool results, error messages, and the `[handoff]` / `[autoMigrate]` / `[usertools]` / `[sdk]` log lines are English. Log prefixes are preserved.
- The `⚠️ Unverified` placeholder marker is now spelled identically in the handoff Skill and in the `HandoffService` summary-mode instruction; the two previously differed in letter case, which let the model emit either form.
- `CHANGELOG.md` is English-only.

### ✅ Tests

- 167 assertions across 43 test files updated. Case count and assertion strictness unchanged — several assertions became more specific rather than looser.
- Full suite: 57 files / 612 passed / 6 skipped, identical to alpha.22. `tsc --noEmit` clean, build clean.
- Change verified as text-only: every removed line in the diff contained CJK characters, so no logic, signature or control flow was touched.

### 📄 Docs

- Design docs under `docs/` stay Chinese; `README.md` (English) and `README.zh.md` (Chinese) keep their existing split.

## [1.0.0-alpha.22] - 2026-10-28

> Abort strategy (`abortedMessageStrategy` / `abortedToolRoundStrategy`) moved from "each caller passes its own params"
> to a **config entry**: written into `config.json`, read automatically by `createAgent()`.

### 🚀 New Features

- **`AppConfig` gained two strategy fields** (`types/index.ts`):
  - `abortedMessageStrategy?: "keep" | "drop"` — whether to keep the thinking / body text an interrupted assistant has already emitted. `keep` lets the model continue from the half-finished output in the next round instead of "losing memory and starting over".
  - `abortedToolRoundStrategy?: "fill" | "drop"` — how to normalize an interrupted / incomplete tool round. `fill` keeps the whole round and supplies a reason for unfinished results, guaranteeing that `tool_calls` and results pair up one-to-one.
- **Factory defaults are `keep` + `fill`** (`DEFAULT_APP_CONFIG`): `keep` is a product-level decision (the library-level default in core is still `drop`); `fill` matches the core default and changes no behavior.
- **`createAgent()` takes the strategy from `scope.config`**: priority is "explicit parameter > `scope.config` > core default". Upstream consumers (CLI / Desktop) no longer have to read the config themselves and forward another round of params, and child Agents inherit the same strategy naturally when created.
- **Config migration now fills in the strategy fields** (`migrateConfig`): a missing or invalid `abortedMessageStrategy` / `abortedToolRoundStrategy` is always written back as the factory default (`changed` set to true, `ensureDefaultConfig()` persists it once). So "what the config file says is what runs at runtime", and no client needs a `?? "keep"`-style fallback anymore.

### ✅ Tests

- Full suite **57 files / 612 cases passing** (6 skipped; 608 cases in alpha.21).
- `migrate.test.ts` 20 → 22 cases: filling in missing strategy, rewriting invalid values, keeping valid values as is with `changed=false`; the existing "no migration needed, returns the original object" case now also covers the strategy fields.
- `createAgent.test.ts` 6 → 8 cases: strategy taken from `scope.config`, explicit params overriding the config, falling back to the core default when config has no value (`drop` / `fill`).

## [1.0.0-alpha.21] - 2026-10-28

### 🚀 New Features

- **Handoff/migration now supports cancellation (`AbortSignal`)** — previously `handoff()` / `migrate()` had no means of aborting once started, and pressing Ctrl+C in the host could not stop them:
  - the standalone model request in `summary` mode had no cancellation point at all;
  - `self` mode could be interrupted by `agent.abort()`, but the abort was misjudged as "the model produced no document", so it retried one round and then degraded to `summary` for another round — the user thought it was cancelled while two extra rounds of full input were burned.

  `HandoffParams` now gains `signal?: AbortSignal`, honored by both executors:

  - `summary`: `signal` is passed as the **RequestOptions (second argument)** to `chat.completions.create`, so the request is genuinely aborted;
  - `self`: after every `agent.send()` it **actively checks** `aborted` (because `abort()` does not throw), and on cancellation throws `HandoffAbortedError` — **no retry, no degradation**;
  - `runHandoff()` adds cancellation points between phases; when `migrate()` is cancelled it **leaves the session history untouched** (no fake "already migrated" state left behind).

- **Exported `HandoffAbortedError`** — cancellation gets its own type, so callers can handle "the user pressed Ctrl+C" and "the handoff genuinely failed" separately: the former ends quietly, only the latter should raise an error.

### 🔧 Fixed

- **Cleaned up the half-written handoff document on cancellation** — only the file created in this run is deleted (an existing file with the same name is left alone). A half-finished artifact is worse than none: the next round's receiver would read it as a real handoff.

### ✅ Tests

- Full suite **57 files / 608 cases passing** (6 skipped).
- `HandoffService.test.ts` **24 → 30 cases**: signal forwarded as RequestOptions, cancelled summary writes nothing, cancelled self neither retries nor degrades, half-finished cleanup, cancelled migrate leaves history unchanged, and the normal path is not broken when nothing is cancelled.
- Destructive verification: removing the cancellation check in `self` turns the "no retry, no degradation" case red.

## [1.0.0-alpha.20] - 2026-10-27

### 🚀 New Features

- **`createAgent(scope, agentId, options?)` gained a third parameter that forwards the abort-related strategies** — previously the SDK did not expose core's `abortedToolRoundStrategy` / `abortedToolRoundReason` at all, so callers were stuck with the defaults. This release surfaces three fields (with the new exported type `CreateAgentOptions`, also supported by the `SdkAgent` constructor):
  - `abortedToolRoundStrategy?: "drop" | "fill"` — normalization strategy when a tool round is interrupted (or its results are incomplete) (core default `fill`);
  - `abortedToolRoundReason?: string` — the reason filled in for unfinished tool results under the `fill` strategy;
  - `abortedMessageStrategy?: "drop" | "keep"` — **new capability**: whether to keep the content / thinking an interrupted assistant has already emitted (core default `drop`). With `keep`, the half sentence from a user interruption still enters the next round's context, so the model can continue instead of "losing memory and starting over"; rounds with tool calls are still governed by `abortedToolRoundStrategy` and are unaffected.

### ⚠️ Dependency

- Upgraded `@ai-zen/agents-core` to `4.5.3` (adds `abortedMessageStrategy` and `reconcileAbortedMessages()`).

### ✅ Tests

- Full suite **57 files / 602 cases passing** (6 skipped).

## [1.0.0-alpha.19] - 2026-10-27

### 🔧 Fixed

- **Logging no longer bypasses `getLogger()`: logs such as `[load_mcp]` went straight to the host terminal** — 4 modules previously ran `const log = getLogger()` at **module top level**, and `getLogger()` at the time returned `{ info: console.log, ... }`. At the moment the module was evaluated, the **function reference** of `console.log` was frozen into the constant; afterwards the host's `setLogger()` swapped the internal `currentLogger` variable, which **could not change the already captured reference**. Consequence: whatever the host did to take over logging, it did not help — when the CLI's Ink TUI loaded MCP, `load_mcp` dumped the entire tools / resources list outside the render area and shredded the interface into garbled output.

  All 4 sites now **fetch the logger at runtime** (`getLogger().info(...)` etc.), so `setLogger()` takes effect immediately:

  - `scope/plugins/mcp/mcpTools.ts` — two `[load_mcp]` info logs (summary + full list);
  - `scope/plugins/skills/discover.ts` — one `[skills]` warn;
  - `agent-plugins/AutoMigratePlugin.ts` — one `[autoMigrate]` error;
  - `scope/plugins/skills/skillTools.ts` — the top-level snapshot was **never called** (dead code) and was deleted together with the `getLogger` import.

  With this, all 10 log call sites in the SDK go through the single `getLogger()` exit; whatever the host installs via `setLogger()` is what gets used, and no console bypass remains.

### ✅ Tests

- Full suite **57 files / 602 cases passing** (6 skipped).
- End-to-end comparison: with the same code "evaluate the module first → then `setLogger` → call `load_mcp`", the old version wrote logs straight to stdout and left the log file empty; the new version keeps stdout clean and writes the logs fully to disk.

## [1.0.0-alpha.18] - 2026-10-22

### 💥 Breaking Changes

- **The single source of truth for the model became `AgentDefinition.modelId`, and `AppConfig.defaultModel` was removed** — the model previously had two sources: `modelId` in the Agent definition took priority, falling back to `config.defaultModel` when missing. Clients such as the CLI also kept another copy of the model name in the **session archive** for display. Once the three values diverged, a silent mismatch appeared where "the UI says DeepSeek while the request goes to GLM": the user saw a 401 but could not switch back no matter what (the switch command judged "already the current model" from the display layer and returned immediately, while the actual model never changed). Now:
  - the `defaultModel` field was removed from `AppConfig`, and from the factory config as well; `migrateConfig` **clears** the old field on disk (one-time, it never reappears after being written);
  - `createAgent` reads only `definition.modelId` and **throws when it is missing**, with no implicit fallback left;
  - `ViewImageTool.isAvailable` / `resolveModelAndEndpoint` dropped the `defaultModel` fallback as well; a failed lookup now counts as "no endpoint", letting the caller take a degradation path instead of guessing a model.
- **`DEFAULT_AGENT_DEFINITION.modelId = "deepseek-flash"` (new export `DEFAULT_MODEL_ID`)** — the factory default Agent ships with a model ID, usable right after install, no longer relying on a default from the config layer.
- **Upgrade compatibility: `ensureDefaultAgent()` fills in `modelId` for legacy Agents that lack it** — it first reuses the old `config.defaultModel` (if that model is still in the list), otherwise falls back to the factory `deepseek-flash`, so upgrading does not change the model the user is currently using.

### ✅ Tests

- Full suite **57 files / 602 cases passing** (6 skipped).
- New/rewritten highlights: `createAgent` must throw when `modelId` is missing, `ensureDefaultAgent` backfills and persists it, `migrateConfig` removes deprecated fields without mutating the original object in place, `resolveModelAndEndpoint` returns a `null` endpoint on a miss, and the MCP / image tools resolve endpoints via `ctx.agent.model` (no longer falling back to a default model).

## [1.0.0-alpha.16] - 2026-10-22

### 💥 Breaking Changes

- **Upgraded `@ai-zen/agents-core` to `4.5.2`: fixed fields in the request body are no longer overridden by `modelParams`** — core used to spread the model params **last** in the request body (`{ model, messages, tools, stream, stream_options, ...modelConfig }`), and `modelConfig` comes from the user-editable `Model.defaultParams` / `AgentDefinition.modelParams`. Any key of the same name then took effect silently: the worst case was `stream: false`, which turned streaming off while the caller was still parsing an async stream, failing the whole round outright. The order is now reversed, so fixed fields always win, while non-fixed keys (`temperature` / `reasoning_effort` / vendor-specific `thinking`, etc.) pass through as before.

  Actual impact on this SDK: writing `model` / `messages` / `tools` / `stream` / `stream_options` in `AgentDefinition.modelParams` now has no effect at all. Normal configuration (temperature, thinking params) is unaffected.

### ✅ Tests

- 3 new cases on the core side (non-fixed keys pass through, fixed keys are ignored, the request body contains only framework fields when there is no `modelConfig`). The SDK itself: **57 files / 600 cases passing** (6 skipped).

## [1.0.0-alpha.15] - 2026-10-22

### 💥 Breaking Changes

- **The SDK no longer "consumes" reasoning levels; only the table itself remains** — alpha.14 pushed the entire "level → request params" resolution into the SDK runtime: `applyReasoningEffort` / `modelLevels` / `resolveReasoningEffort` / `resolveModelParams`, plus `Scope.reasoningPresets` injection, storing level names on the Agent, and looking up the table at runtime to assemble params. But `low` / `high` / `max` / `off` are **product semantics, not protocol facts**; the only thing the SDK objectively knows is "what the request params look like" — which `defaultParams` already carries. Now:
  - **the entire API of `shared/reasoning.ts` was removed** (`applyReasoningEffort` / `modelLevels` / `presetOf` / `readReasoningEffort` / `resolveReasoningEffort` / `resolveModelParams`), along with `Scope.reasoningPresets`;
  - **kept**: the **definition and factory content** of the reasoning presets (`ReasoningPresets` / `ReasoningPreset` / `ReasoningPatch` types, `config/reasoning-presets.ts`, `ConfigManager.readReasoningPresets()` / `ensureReasoningPresets()`) — it is an **asset shared by clients** such as the CLI / desktop app (knowledge like "Zhipu 5.3 only accepts low/high/max" should not be written out again by every client), but it is only **data**; the SDK does not use it to generate request params.
- **`AgentDefinition.reasoningEffort` → `AgentDefinition.modelParams?: ModelParams`** — the Agent-level override changed from "a level name" to "concrete params". The client reads the table, takes the level patch, and expands it into `modelParams` **when writing the config**. So **config is the fact**: no table lookups or inference at runtime.
- **`createModel(scope, modelId, overrides?: ModelParams)`** — the third parameter changed from `Pick<AgentDefinition, "reasoningEffort">` to a bare params object, and internally it is just one line:
  ```ts
  modelConfig = { ...model.defaultParams, ...overrides };
  ```
  Shallow merge (nested objects are replaced wholesale); without overrides it returns `defaultParams` as is. From now on the SDK interprets no key names and does not even know what `thinking` / `reasoning_effort` are. A SubAgent given its own `modelId` likewise applies its own `modelParams`.
- **`Model.reasoningPreset` was kept**, with the semantics changed to "a key referencing the preset table", so clients can tell which levels that model offers; the SDK only guarantees that it can be read and written with the model config and synced from the factory — it does not consume it.

### 🔧 Fixed

- **Migrated the legacy `Model.reasoning` field (left over from alpha.13)** — models without `custom` were overwritten wholesale by the factory definition, but **those marked `custom: true` were kept in place**, leaving behind a `reasoning` nobody recognized, and because `reasoningPreset` was missing the client judged them "not adjustable". `ConfigManager.read()` now deletes that legacy field and restores `reasoningPreset` from the factory model with the same id; ids not in the factory list (genuinely custom models) are only cleaned, not restored. Only the "legacy field exists" case is handled, so a `reasoningPreset` the user removes later is not restored over and over.

### ✅ Tests

- `src/runtime/createModel.test.ts` added 6 cases locking down the merge semantics: no overrides returns as is, empty overrides equal no overrides, same-name keys override while other keys are kept, with no `defaultParams` on the model the overrides are everything, **shallow merge does not deep merge** (switching levels leaves no old sub-keys behind), and two Agents with their own sets do not affect each other.
- `src/config/migrate.test.ts` added 6 cases (19 in total).
- Removed `src/shared/reasoning.test.ts` (26 cases; the runtime resolution is gone); `src/config/reasoning-presets.test.ts` (11 cases) is kept — the table is still in the SDK.
- Full suite **57 files / 600 cases passing** (6 skipped).

## [1.0.0-alpha.14] - 2026-10-22

### 💥 Breaking Changes

- **Reasoning capability declaration moved from "model fields" to a "preset table"** — alpha.13 expressed vendor differences with `Model.reasoning: { efforts, disable? }`, which resulted in three structural flaws: `disable` carried two meanings (both the way to turn it off and the capability itself), `off` was assembled rather than declared (`disable ? ["off", ...efforts] : efforts`), and a global `ReasoningEffort` enum pretended every vendor's levels were equivalent. It is now a declarative table of **level → request-param patch**:
  - added `<basePath>/reasoning-presets.json` (sibling of `config.json`); factory content lives in `config/reasoning-presets.ts`;
  - `Model.reasoning?` → **`Model.reasoningPreset?: string`** (references a preset name; absent = not adjustable);
  - the type of `AgentDefinition.reasoningEffort` changed from `ReasoningEffort` to **`string`** (level names are defined by the preset table; no more fake enums pretending uniformity);
  - removed the `ReasoningEffort` / `ReasoningCapability` types and the `capabilityOf` / `modelEfforts` / `modelAllowedEfforts` / `isReasoningEffort` functions;
  - function signatures now all start with `(model, presets, …)`: `readReasoningEffort(model, presets, params?)`, `applyReasoningEffort(model, presets, level, params?)`, `resolveReasoningEffort(model, presets, definition?)`, `resolveModelParams(model, presets, definition?)`;
  - `Scope` gained `reasoningPresets` (injected alongside `config`, not a global singleton).

  In exchange, three structural guarantees, all stemming from the table's shape with zero branches in the code: ① selectable levels = `Object.keys(levels)`; ② whether reasoning can be turned off = whether the table has an `off` key; ③ "which param keys belong to reasoning" = the union of keys appearing anywhere in the table (used to strip stale values before writing, so `max` → `off` no longer leaves `reasoning_effort` behind, and switching a model's preset does not regurgitate the previous param set).

- **`applyReasoningEffort` validates levels more strictly** — a level absent from the preset now throws immediately (the old version returned an "unsupported level" message for models without a declared capability), and the error message includes the preset name and the list of available levels.

### 🚀 New Features

- **`ConfigManager.readReasoningPresets()` / `ensureReasoningPresets()`** — read/write of the preset table plus factory sync. Sync granularity is **per individual preset**, with rules isomorphic to factory model sync: a missing file writes the seed; presets marked `custom: true` are frozen; unmarked ones are overwritten by the factory version; user-created non-factory presets are always preserved. `bootstrap()` calls it automatically. When the file is missing or corrupt, `readReasoningPresets()` falls back to the factory seed, so upper layers never get an empty table.
- **`presetOf(model, presets)` / `modelLevels(model, presets)`** — preset lookup and reading of available levels (`modelLevels` replaces the old `modelEfforts` + `modelAllowedEfforts` pair: `off` is now just another row in the table, with no split between "level" and "off").
- **The package entry now also exports `TokenThresholds` / `ReasoningPatch` / `ReasoningPreset` / `ReasoningPresets`** — alpha.13 was missing exports for these types (the original `7b10196` patch is merged into this release).

### ✅ Tests

- `src/shared/reasoning.test.ts` rewritten (26 cases): protocol facts of the factory tables (the OpenAI table has no `thinking` key, `zhipu-5.3` has no `off`, DeepSeek turns reasoning off via `thinking.type`), adjustable levels = the table's keys, lookup picks the most specific match, stale keys are stripped on write, round-trip consistency, an invalid Agent declaration falls back to the model default, and prototype-chain names (`constructor`) have no effect.
- `src/config/reasoning-presets.test.ts` added (11 cases): file location, first-time release, idempotent runs do not write, entries not marked `custom` are overwritten, entries marked `custom` are frozen, user-created presets are preserved, corrupt / array content falls back to the seed, and `bootstrap()` releases it as a side effect.

### 📄 Docs

- `docs/{zh,en}/sdk.md`: the "reasoning effort" section was rewritten as "reasoning presets", covering the preset table structure, a factory preset comparison table, the three structural guarantees, a table of the new APIs, and a `Scope` injection example.
- Also fixed examples that had been stale since alpha.13: `ContextGuardPlugin({ maxTokens, isSuspended })` → `{ guardTokens }`, `AutoMigratePlugin({ maxTokens })` → `{ handoffTokens }`, and the old "handoff turn guard relaxed × 2" description.

## [1.0.0-alpha.13] - 2026-10-22

### 💥 Breaking Changes

- **`Model.maxContextTokens` / `maxContextChars` → `Model.tokenThresholds: { handoff, guard }`** — The old names were misleading all along (they were neither a context window nor a single concept). Now split into two **absolute values**:
  - `handoff`: the soft line — once `prompt_tokens` after a response returns exceeds it, task handoff is triggered (`AutoMigratePlugin`);
  - `guard`: the hard line — if usage before a request exceeds it, `ContextOverflowError` is thrown and the turn is aborted (`ContextGuardPlugin`).
  - `maxContextChars` was dropped outright (the character metric predates the token metric; keeping both only leaves "which one decides" ambiguous for good).
  - Migration is performed by `config/migrate.ts`: `ConfigManager.read()` migrates on read, `ensureDefaultConfig()` writes to disk only when a difference is detected: `maxContextTokens` → `handoff`, `maxContextChars` → `floor(/4)`, and when `guard` is missing it is derived once as 1.5x (preserving pre-migration behavior); the old keys are removed right after.
- **All of `ContextGuardPlugin`'s `ratio` / `suspendedRatio` / `isSuspended` were removed** — they were merely artifacts of "relative thresholds". Now `new ContextGuardPlugin({ guardTokens })` with one absolute number is enough: to loosen it, just make the number larger. The cost is that **handoff turns no longer get the extra 2.0x relaxation**; if that buffer is needed, configure a larger `guard` (the default is `handoff × 1.5`, written as an integer).
- **`ContextOverflowError(promptTokens, guardTokens)`** — dropped the three derived fields `maxTokens` / `ratio` / `threshold` and now exposes the exceeded `guardTokens` directly.
- **`AutoMigratePlugin`'s `maxTokens` → `handoffTokens`**, `AutoMigrateTriggerInfo.maxTokens` → `handoffTokens`, and `HandoffService`'s `HandoffParams.maxTokens` / `HandoffContext.maxTokens` → `handoffTokens` (field rename only, semantics unchanged: the handoff threshold).

### 🚀 New Features

- **Reasoning effort capability bit** — effort levels were previously not modeled at all; the CLI could only hand-edit `defaultParams`, while each endpoint accepts a different value range (Zhipu's GLM-5.3 family errors out directly on `medium`, and also errors on `thinking.type = "disabled"`). Now there are three layers:
  - `Model.reasoning: { efforts: ReasoningEffort[], disable?: "thinking" | "effort-none" }` — the **physical capability ceiling**, declared per the vendor's official docs (to avoid 400s);
  - `AgentDefinition.reasoningEffort?: ReasoningEffort` — the actual effort level for that Agent, overriding the model's `defaultParams` at the `createModel` stage. So the same model can be given different strengths for different Agents (coding Agent `max`, chit-chat Agent `low`, chit-chat mini `off`).
  - Deliberately **did not** add an Agent-side effort whitelist (`reasoningEfforts`): it solves a non-problem (what actually causes 400s is endpoint capability, and that is already covered by the model declaration), yet introduces a "one s apart" naming trap and an extra layer of intersection rules.
- **`shared/reasoning.ts`** (public API, all exported from the package entry): `resolveReasoningEffort()`, `resolveModelParams()`, `applyReasoningEffort()` (writes per the declaration, throws on invalid levels), `modelEfforts()` / `modelAllowedEfforts()` / `readReasoningEffort()` / `isReasoningEffort()` / `capabilityOf()`, plus the `ReasoningEffort` / `ReasoningCapability` types.
- **Write shape is decided by the declaration**: `disable: "thinking"` → maintains both `thinking.type` and `reasoning_effort` (DeepSeek); `disable: "effort-none"` → writes only `reasoning_effort` (OpenAI has no `thinking` parameter, and writing it would be treated as an unknown parameter); no `disable` declared → writes only `reasoning_effort`, and `off` throws directly (Zhipu 5.3 family).
- **Factory models declare capabilities per the official docs** (the basis is recorded in the `constants.ts` comments):
  - `deepseek-flash` → `low/high/max`, can be disabled (`api-docs.deepseek.com/guides/thinking_mode`)
  - `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx` → `low/high/max`, **cannot be disabled** (`docs.bigmodel.cn/cn/guide/capabilities/thinking`)
  - `glm-4.7-flash` → not adjustable (thinking is forced; `reasoning_effort` is supported only in 5.2+)
  - `gpt-6-astra` / `gpt-6.1-sol` / `gpt-6-luna` → `minimal/low/medium/high`, can be disabled with `reasoning_effort: "none"`
  - Models with no declaration are all treated as non-adjustable; no guessing

### 🔧 Changed

- **`createModel(scope, modelId)` → `createModel(scope, modelId, overrides?: Pick<AgentDefinition, "reasoningEffort">)`** — the new optional third parameter is passed in by `createAgent` as `definition.reasoningEffort`. When omitted, behavior is exactly as before (returns the model's `defaultParams` unchanged).

### ✅ Tests

- Added 22 cases in `shared/reasoning.test.ts`: capability declarations match the factory list, `off` is available only for models with `disable`, GLM-5.3 throws for both `medium` and `off`, OpenAI never writes a `thinking` key, round-trip consistency, Agent override and fallback.
- Added 13 cases in `config/migrate.test.ts`: old-field migration (tokens / chars / both / neither / dirty values), `guard` derivation, no migration when already in the new shape, input arguments are not mutated, and untouched entries keep the same reference during partial migration.
- Full suite **57 files / 599 cases** passing (6 skipped), `tsc --noEmit` and `build` with zero errors.

### 📄 Docs

- `docs/{zh,en}/sdk.md` added a "Reasoning effort" section (the three-layer model, the factory declaration table, write shapes, public API), and the core entity table now includes `Model.reasoning` and the Agent's two effort fields.

## [1.0.0-alpha.12] - 2026-10-22

### 💥 Breaking Changes

- **`createReadMcpResourceTool(mcpManager)` → `createReadMcpResourceTool(mcpManager, env: ToolEnv)`** — aligned with `createCallMcpTool` from alpha.11: `env` is used to read `maxToolOutput` and to resolve the endpoint bound to the current model. Downstream code calling this factory directly must add the second argument.
- **`view_image` no longer depends on the `deepseek` endpoint** — previously local images were always uploaded to the endpoint with `id === "deepseek"`, and when it was not configured it failed with "no deepseek endpoint configured, cannot upload local images". Now it is decided by capability bit: endpoints declaring `capabilities.filesApi` go through upload, all others go through base64 inlining, so local images can be viewed without deepseek. The returned message changed accordingly (including the transport and the fallback notes).
- **`Endpoint` gained the optional field `capabilities`** — non-breaking at the type level (optional), but semantically important: absent means "no special capabilities", i.e. no upload.

### 🚀 New Features

- **Single unified entry point for "local file → content block": `shared/content-blocks.ts`**. This logic was previously scattered across three places each doing its own thing (`ViewImageTool` hardcoding the endpoint id, MCP media block normalization, and yet another implementation on the CLI side); it is now consolidated into one place:
  - `fileToContentSection({ source, endpoint, model, signal, maxInlineBytes, deps })` → `{ section, transport, bytes, warning? }`; `source` supports four kinds of sources: `path` / `url` / `data` (`Uint8Array`) / `base64`.
  - Decision chain: http(s) URL → `image_url`; endpoint has Files API → upload to get a `file_id` (**falls back automatically** to inlining on failure); other endpoints + image → `image_url` + base64 data URL; other endpoints + non-image → `file` block + `file_data`; non-vision model + image → text hint; inline over the limit and upload impossible → throw (never silently stuffed into the request body).
  - Companion helpers: `resolveModelAndEndpoint()` (looks up the model and endpoint by the model name sent to the API), `supportsFilesApi()`, `mimeOf()` / `toDataUrl()` / `base64ByteLength()` / `contentHash()`, `clearUploadCache()`, `DEFAULT_MAX_INLINE_BYTES` (8 MiB).
  - **Exported from the package entry `src/index.ts` as public API** (`fileToContentSection` / `resolveModelAndEndpoint` / `supportsFilesApi` / `mimeOf` / `toDataUrl` / `base64ByteLength` / `contentHash` / `clearUploadCache` / `MIME_BY_EXT` / `DEFAULT_MAX_INLINE_BYTES`, plus the `FileSource` / `FileToSectionInput` / `FileToSectionResult` / `ContentTransport` / `UploadFn` / `EndpointCapabilities` types). Upper-layer applications should reuse this directly when building media messages instead of each reimplementing "upload or inline".
  - Upload cache: path sources key on "endpoint id + absolute path + mtime + size", in-memory sources key on the content sha256 (the same image is never uploaded twice), capped at 200 entries.
  - `deps.upload` is injectable, which makes testing easier and lets the upload implementation be swapped.
- **`Endpoint.capabilities.filesApi` capability bit** — only `deepseek` is marked `true` out of the box (the description says so as well). The criterion changed from "is the endpoint id deepseek" to the capability bit, so user-built endpoints get upload just by declaring it.

### 🔧 Fixed

- **MCP media is no longer always base64-inlined**: `image` / `audio` / `resource.blob` from `call_mcp_tool` now go through the unified entry point; when the endpoint has Files API capability they are uploaded and sent as `file_id`, so the request body no longer keeps ballooning with history; a failed conversion **does not drop the block** but degrades to a text note, so the whole tool call does not fail over a media problem.
- **Binary resources from `read_mcp_resource` were silently dropped**: previously only `contents[].text` was concatenated, so `blob` content such as images / PDFs simply vanished. Added `resourceToMessageSection()` — note that `readResource`'s contents look like `{ uri, mimeType?, text|blob }` and have **no `type` discriminator field**, so `toMessageSection` cannot be reused (otherwise text resources would be JSON-ified); `blob` is handed to the unified entry point.
- **`read_mcp_resource` now has output protection**: it shares the same rules as `call_mcp_tool` — text over the limit is written to disk as `result.txt` and a head/tail preview is returned, while media blocks stay in place; the return shape is likewise "text only → string / contains media → content block array".
- **Non-vision model degradation**: when `Model.vision !== true`, images degrade to a one-line text hint (applies to both local-path sources and MCP in-memory base64 sources), so `image_url` is not rejected by the server with a 4xx.
- **`edit` concurrency guardrail**: the `edit` / `batch_edit` tool descriptions state explicitly that "parallel `edit` on the same file is forbidden; use `batch_edit` for multiple changes; only different files may be parallelized" — a description-level deterrent (no runtime lock introduced).

### ✅ Tests

- Added 16 cases in `shared/content-blocks.test.ts`; `mcpTools.test.ts` was extended to cover the unified media entry point, non-vision degradation, `read` over-limit disk writes, and order preservation in mixed content; the assertions in `ViewImageTool` / `EditTool` / `BatchEditTool` were synced to the new semantics.
- Full suite **55 files / 569 cases** passing (6 skipped), `tsc --noEmit` and `build` with zero errors.

### 📄 Docs

- `docs/{zh,en}/sdk.md` added a "Local file → content block (unified entry point)" section, plus the `Endpoint` capability bit and notes on MCP media / degradation / output protection.
- `docs/{zh,en}/mcp.md` synced on the media transport and output protection rules for `call_mcp_tool` / `read_mcp_resource`.


## [1.0.0-alpha.11] - 2026-10-20

### 💥 Breaking Changes

- **`createCallMcpTool(mcpManager)` → `createCallMcpTool(mcpManager, env: ToolEnv)`** — the new `env` is used only to read `maxToolOutput`, and is passed in by `McpScopePlugin.instantiate` as `scope.env`. Downstream code calling this factory directly must add the second argument.

### 🚀 New Features

- **`call_mcp_tool` output protection**: MCP tools are the channel most likely to spit out hundreds of KB or even several MB of JSON in one go, and previously it was returned completely raw. Now when the text portion exceeds `maxToolOutput` (default 32768 characters), the full text is written to disk as `result.txt` and only a warning plus a head/tail preview are returned (`outputTooLarge` / `chars` / `head` / `tail` / `files`). It reuses the same `outputGuard` skeleton and the same configuration rules as the built-in tools; no separate threshold.
- **Media content blocks are passed through as-is**: `image` → `image_url` (`data:<mimeType>;base64,...`), `audio` → `file` (`file_data`, inlined data URL), `resource.blob` routed by mimeType to `image_url` / `file`. Media **does not count toward the character count, is not written to disk, and is never dropped** — only text is protected.
- **Return shape**: text only → plain string (consistent with the past); contains media → content block array.

### 🔧 Fixed

- **Non-text content blocks were silently dropped**: the old implementation only took `type === "text"`, so `image` / `audio` / `resource` / `resource_link` were all thrown away, leaving the model knowing only that "a block was not given to me". Now media is passed through, `resource.text` is merged into the body, `resource_link` becomes a `[resource_link] name · uri · mimeType` clue, and unknown types (such as `tool_use`) degrade to JSON text.
- **Content block order**: blocks are mapped strictly one by one in the original order of MCP `content[]`, so text sandwiched between images also keeps its position. When over the limit, a single warning block takes the place of the original **first** text block, the remaining text goes to disk, and media stays exactly where it was — even if text sits between two images, the correspondence between captions and images is not scrambled.
- **Threshold rule**: the limit is judged on the **total** character count of all text, not block by block (otherwise N segments of 30k characters each would all pass individually while together they could still flood the context).

### ✅ Tests

- `mcpTools.test.ts` 38 cases (8 new for content block mapping, 4 for output protection, 4 for order preservation). Full suite **54 files / 542 cases** passing, `tsc --noEmit` and `build` with zero errors.

### 📄 Docs

- `docs/sdk-design-v1.md` §9 on `call_mcp_tool` gained the content block mapping table, the output protection rules, and the folding rule that preserves order when over the limit; `../docs/{zh,en}/mcp.md` and the website mirror were synced.


## [1.0.0-alpha.10] - 2026-10-20

### 💥 Breaking Changes

- **`TaskMigrationService` → `HandoffService`, split into two layers, `handoff()` / `migrate()`** — "handoff" (writing a handoff document) and "migration" (handoff + starting a new session) used to be mixed into one method; now the concepts and the API map one-to-one:
  - `handoff(params)`: stop work → verify → write the document → validate (fall back on failure). **Does not touch the session**;
  - `migrate(params)`: after `handoff()`, clears history and injects the breakpoint message according to `strategy`.
  - Types moved along: `MigrationContext` → `HandoffContext` (added `mode` / `requestedMode` / `handoffPath` / `migrating`), `TaskMigrationServiceOptions` → `HandoffServiceOptions` (added `handoffDir` / `mode` / `skillDirs` / `minHandoffBytes`).
  - Hooks renamed: `onBeforeMigrate` → `onBeforeHandoff`; added `onHandoff` (after the document is written, before history is cleared).
- **Handoff documents are now written by "the original agent in its own session" (`mode: "self"`, the default)**, rather than by a separate standalone summary call. The old implementation serialized the history into `[role]: content` and handed it to a call with no tools and no context of the original session, so tool names and call arguments were all lost during serialization, and the writing side could not verify branches/changes/test status — it could only infer them — which was the root cause of the poor document quality. The `self` turn today: the original agent keeps its full context and tools and can `read` / `exec` / `git status` to verify before writing to disk.
- **`summary` (the old standalone summary) is kept as an escape mode**, and serves as the **one-way** fallback target when `self` fails (no `write` tool / file missing or too small (retry once) / tool or guard error). The reverse never happens — that would add one more full request at the moment the context is the fullest.
- **`AutoMigrateOptions` gained `resolveMode`**, moving "who performs the handoff" from plugin inheritance to a callback: it returns a `HandoffMode` or `null` (skip this migration). The CLI's `AutoMigrateConfirmPlugin` subclass therefore degrades into a pure callback.

### 🚀 New Features

- **`HandoffGuardPlugin`**: a one-shot tool guard for the handoff turn. It only allows `write` to the handoff document (compared after normalizing to an absolute path) and rejects `edit` / `batch_edit` / `rm` / `rename` / `mkdir` / `copy`. A rejection returns a string (soft rejection) rather than throwing — a thrown error would be marked by core as Error + `isPreventDefault`, killing the whole handoff turn outright. The boundary is recorded honestly: it cannot stop `exec`; it lowers the probability of mistakes, it is not a sandbox.
- **`ContextGuardPlugin` gained `isSuspended` / `suspendedRatio`**: during the handoff turn (`service.busy`) the hard limit is relaxed from `× 1.5` to `× 2`, so the turn is neither killed by mistake nor left without the circuit breaker.
- **Factory Skill mechanism**: `ConfigManager.ensureFactorySkills()` releases / syncs `skills/handoff/SKILL.md` in `bootstrap()`. The overwrite policy mirrors `syncManagedModels` — frontmatter marked `metadata.custom: "true"` is treated as user-owned and never overwritten; otherwise it syncs with the version. The content is inlined as a string constant in `config/factory-skills.ts` (`tsc` compiles it directly, no need to bundle non-TS assets).
- **The single source of truth for the handoff template is now the Skill**: `HANDOFF_SECTIONS` / `createPrompt()` are removed, and the code keeps only "read the Skill → inject → validate the file → fall back to `FALLBACK_HANDOFF_TEMPLATE` when it cannot be read". The Skill only covers "how to write"; the code only covers "where to write and what capabilities are available" (this system has no template variable engine, and placeholders are not invented).
- `HandoffService.createHandoffFileName()` (`<YYYYMMDD-HHmmss>-<first 8 chars of session id>.md`), `createHandoffInstruction()`, `createPostMessages(handoffPath)` (the breakpoint **gives only the path**, which the receiving side `read`s).

### 🔧 Fixed

- **Infinite recursion triggered by handoff**: the handoff turn is itself a `send()`, and its `onAfterSend` re-enters `AutoMigratePlugin`. It now yields on `service.busy` (`handoff()` / `migrate()` share one lock, which also rejects re-entry).
- **The handoff turn being triggered by itself / killed by the guard**: handoff happens exactly at the moment the context is the fullest. Besides yielding on `busy`, `agent.lastUsage` is cleared before the handoff turn starts (defense in depth) and cleared by the caller after migration (otherwise the guard would use the handoff turn's usage to kill the first message of the new session by mistake).

### ✅ Tests

- Added `HandoffService.test.ts` (24 cases), `HandoffGuardPlugin.test.ts` (7 cases), `factory-skills.test.ts` (7 cases); rewrote `AutoMigratePlugin.test.ts`, `ContextGuardPlugin.test.ts` (added 4 `isSuspended` cases). The full suite of **54 files / 525 cases** passes, with zero errors from `tsc --noEmit` and `build`.

### 📄 Docs

- `docs/sdk-design-v1.md` §18 rewritten as "Task handoff (HandoffService)" (two-layer semantics, Template as the single source of truth, two kinds of executor, three safeguards for self-handoff, the interface, breakpoint gives only the path); the §17 plugin chapter, the directory tree and the consumption examples were synced.
- `README.md` / `README.zh.md`, `../docs/{en,zh}/sdk.md`, `architecture.md`, `getting-started.md` and the website mirror synced.


## [1.0.0-alpha.9] - 2026-10-14

### ⚠️ Dependency

- **`@ai-zen/agents-core` bumped to `^4.5.1`** — docs-only patch; no SDK source change.

### 📄 Docs

- Corrected the factory-defaults description in `docs/sdk-design-v1.md`: the preset **model count is 8** (was 7), and `DEFAULT_MCP_CONFIG` ships **two** servers (`socket-pty` + `chrome-devtools`).

## [1.0.0-alpha.8] - 2026-10-14

### ⚠️ Dependency

- **`@ai-zen/agents-core` bumped to `^4.5.0`** — picks up `AgentNS.Message.subAgentUsage` and the `sumUsage()` primitive. The skill sub-agent tool (`call_skill_sub_agent`) is built on `AgentToolLazy`, so it inherits the delegation-boundary stamping with no SDK source change.

## [1.0.0-alpha.7] - 2026-10-14

### ⚠️ Dependency

- **`@ai-zen/agents-core` bumped to `^4.4.0`** — picks up `AgentNS.Message.usage` (per-message token usage, stamped from the final stream chunk). No SDK source change; the `workspace:^` range resolves to `^4.4.0` on publish.

## [1.0.0-alpha.6] - 2026-10-13

### 💥 Breaking Changes

- **`exec_async` renamed to `spawn`** — the tool wraps `child_process.spawn` and returns `{ success, pid, message }`, so the new name matches both the implementation and the "start a process, get its pid" contract. It also pairs cleanly with `exec`: `exec` runs and **waits** (captures output, has a `timeout`), `spawn` starts and **returns immediately**. Permission lists, skill `allowed-tools` and any prompt naming `exec_async` must switch to `spawn`. The behaviour is otherwise unchanged — still shell-parsed, still does **not** capture output (redirect to a file if you need it).
- **Built-in tool classes renamed to match their new tool names** — `ReadFileTool` → `ReadTool`, `WriteFileTool` → `WriteTool`, `ExecAsyncTool` → `SpawnTool`, with the source files renamed to match. The classes re-exported from `@ai-zen/agents-sdk` change accordingly, so consumers importing them by name must update.

## [1.0.0-alpha.5] - 2026-10-13

### 💥 Breaking Changes

- **All built-in tool names unified on `snake_case`** — the multi-word tools that used camelCase were renamed. A tool name is the API contract the model sees and is matched **verbatim** by the permission system, so any `permissions.allow` / `deny` list, skill `allowed-tools` entry or prompt that names a tool must be updated:

  | old | new |
  |---|---|
  | `readFile` | `read` |
  | `writeFile` | `write` |
  | `inspectFile` | `inspect_file` |
  | `findText` | `find_text` |
  | `batchEdit` | `batch_edit` |
  | `downloadFile` | `download_file` |
  | `generateImage` | `generate_image` |
  | `viewImage` | `view_image` |

  Single-word tools (`cwd`, `edit`, `glob`, `ls`, `mkdir`, `rm`, `rename`, `copy`, `exec`, `exist`, `sleep`), the already-`snake_case` `exec_async`, the MCP / skill wrapper tools and core's `indexed_search` are unchanged. Tool descriptions and docs were updated in the same pass.

### 🔧 Changed

- **Dependency `@ai-zen/agents-core` bumped to `^4.3.2`** (carries the `indexedSearch` → `indexed_search` rename).

### 📄 Docs

- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.5`.

## [1.0.0-alpha.4] - 2026-10-13

### 🔧 Changed

- **Dependency `@ai-zen/agents-core` bumped to `^4.3.1`** (declared as `workspace:^`, expanded to `^4.3.1` at publish time). Pulls in core 4.3.1's fix for interrupted parallel tool rounds — the assistant message carrying `tool_calls` and its results now stay all-in or all-out, so an interrupted parallel tool call no longer leaves orphan `tool` results that the server rejects. `AgentContext` gains `abortedToolRoundStrategy` (default `"fill"`) and `abortedToolRoundReason`; set `agent.abortedToolRoundStrategy = "drop"` to drop the whole round instead

### 📄 Docs

- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.4`.

## [1.0.0-alpha.3] - 2026-10-03

### 🔧 Fixed

- **`generateImage` `model` parameter description no longer points at a host-CLI command** — the description used to read "the configured image models can be viewed via `aiz config show`". Since tool descriptions ship inside every request's `tools` payload, that hint propagated into **every layer** of the agent stack: the model would `exec("aiz config show")`, but the CLI resolves a bare `aiz config show` invocation as stdio mode with the instruction `config show` — i.e. a **brand-new agent** — whose own `generateImage` description repeats the very same hint, producing a self-referential recursion that keeps spawning nested agents. The parameter now reads "if the specified model does not exist, this tool returns the list of currently available models", which matches the actual `!imageModel` branch in `call()` and stops the model from shelling out to the host CLI.

### 📄 Docs

- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.3`.

## [1.0.0-alpha.2] - 2026-10-03

### 🚀 New Features

- **`chrome-devtools` added to the factory default MCP config** — `DEFAULT_MCP_CONFIG` now ships two servers instead of one: alongside `socket-pty`, a freshly released `~/.ai-zen/mcp.json` includes `chrome-devtools` (`npx -y chrome-devtools-mcp@latest`, Google's official `chrome-devtools-mcp`), so browser debugging and automation work out of the box — page navigation, performance traces, network and console inspection, screenshots. Existing `mcp.json` files are still never overwritten, so user configurations (including custom flags such as `--executablePath`) are untouched. Defined in `packages/sdk/src/config/constants.ts`, released by `ConfigManager.ensureDefaultMcpConfig()`.

### ✅ Tests

- `ConfigManager.bootstrap.test.ts` now asserts the factory-default `mcp.json` carries both `socket-pty` and `chrome-devtools` (the latter resolved from the `chrome-devtools-mcp` package via `npx`), covering both the `bootstrap()` and `ensureDefaultMcpConfig()` paths.

### 📄 Docs

- Factory-default MCP descriptions in `docs/zh/mcp.md` / `docs/en/mcp.md` and `docs/zh/sdk.md` / `docs/en/sdk.md` now list both `socket-pty` and `chrome-devtools`.
- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.2`.

## [1.0.0-alpha.1] - 2026-10-03

### 💥 Breaking Changes

- **Factory model catalog refreshed (verified against vendor sources on 2026-10-03)** — every stale or retired model ID in `DEFAULT_APP_CONFIG.models` is replaced:
  - **OpenAI**: `gpt-5.5` → `gpt-6-astra` / `gpt-6.1-sol` / `gpt-6-luna`
  - **Zhipu**: `glm-5.1` / `glm-5v-turbo` → `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx`
  - **DeepSeek**: `deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` → `deepseek-flash`. The two V4-Flash variants were retired by the vendor, and V4-Pro requests are routed to V4.1-Flash.
  - Defaults: `defaultModel` / `defaultMigrationModel` move from `deepseek-v4-flash` to `deepseek-flash`.
- **`Model.maxContextTokens` semantics clarified — it is the task-migration (handoff) trigger threshold, not the model context window** — `AutoMigratePlugin` does not estimate or learn: it only compares `usage.prompt_tokens` from the API response against this value. The previous comment read "context window token limit", which is why values had been filled in with raw window sizes. Values are now ~25% of the real window (250K for ≥1M-window models), except `glm-4.7-flash` (200K window) which uses 100K.

### 🚀 New Features

- **Managed model catalog sync (`custom` opt-out)** — `ConfigManager.ensureDefaultConfig()` now reconciles the factory catalog on every `bootstrap()`. Entries in `models` / `imageModels` that do **not** carry `custom: true` are dropped and replaced by the latest `DEFAULT_APP_CONFIG` definitions; entries marked `custom: true` are treated as user-owned and kept verbatim (user wins on id collision, no duplicates). A dangling `defaultModel` / `defaultImageModel` / `defaultMigrationModel` falls back to the factory default, so no reference is ever left pointing at a removed model. `endpoints` are never managed. The sync is idempotent — it only writes when something actually changed. Implemented in `ConfigManager.syncManagedModels`.
- **`Model` / `ImageModel` gained an optional `custom?: boolean` field** — marks an entry as user-owned so the factory sync leaves it untouched.

### ✅ Tests

- Added coverage for the model catalog sync: stale non-custom entries replaced, `custom: true` entries preserved, user version winning on id collision without duplication, image models reconciled, dangling default IDs falling back, and idempotency across repeated calls.
- E2E model IDs updated to the current vendor names (`deepseek-flash`).

### 📄 Docs

- Current-version references in `docs/zh` and `docs/en` updated to `1.0.0-alpha.1`.
- `DEFAULT_APP_CONFIG` row in `sdk-design-v0.md` updated to the new model catalog.

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
