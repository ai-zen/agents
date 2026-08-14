# Changelog

## [3.4.0] - 2026-08-14

### ⚠️ Breaking

- **`Tool` base class slimmed down — no longer requires passing `function` / `type` via its constructor** — the `Tool` constructor is removed entirely; `type` now defaults to `"function"`, and `function` becomes a field declared by the base class but **assigned by each subclass** (via a class-body field or `this.function = ...` in its own constructor). `exec(ctx)` remains the only abstract method. Subclasses extending or implementing `Tool` must now own their `function` definition themselves
- **`CallbackTool` callback no longer bound via `this` injection** — the callback signature changed from `(this: ToolCallContext, parsed_args)` to `(parsed_args, ctx: ToolCallContext)`. `Tool.exec` now calls `this.callback(ctx.parsed_args, ctx)` explicitly instead of `this.callback.call(ctx, ...)`. Consumers previously relying on `this` (e.g. `this.agent`, `this.signal`, `this.preventDefault()`) must read them from the second argument `ctx` instead
- **`AgentToolLazy.buildAgent` no longer bound via `this` injection** — its signature changed from `(this: ToolCallContext, parsedArgs)` to `(parsedArgs, ctx: ToolCallContext)`. Use `ctx.agent` (instead of `this.agent`) to access the parent Agent

### 🛠 Optimized

- **Tool definition now lives with its implementation (`function` colocated with `call`/`exec`)** — instead of passing a separate `function` object through the base constructor, each tool now declares its own `function` definition next to its business logic (`call`), keeping the definition and implementation together and eliminating the redundant two-place maintenance
- **Sub-agent tools honor the execution abort signal** — `AgentTool` and `AgentToolLazy` now listen for `ctx.signal` and call `agent.abort()` on the child agent when it fires, letting a long-running sub-agent be stopped when the parent tool call is aborted

### 🗑 Deprecated

- **`CodeTool` marked `@deprecated`** — string-code tools (defined via `new Function`) lack type safety and clear parameter mapping. Prefer `CallbackTool` (typed closure) or a custom `Tool` subclass. Kept for backward compatibility, not deleted

### ✅ Tests

- Updated `Tool.test.ts` to the new contract (subclasses provide `function` via a class-body field or `this.function = ...`); updated `CallbackTool` / `Agent` / `AgentContext` tests for the explicit ctx parameter and the redeclared `Tool` field; added a sub-agent abort-linkage test. Core suite: **198 passed**, **17 skipped**

## [3.3.1] - 2026-08-13

### ♻️ Refactored

- **`innerLoopTasks` split into dual-set semantics** — added `innerLoopsTasks` (all tasks of one `send` group: every round's assistant plus each tool result, kept for the whole run and cleared when `run()` ends, for whole-group tracking) and `innerLoopTasks` (current in-flight round tasks: recorded at inner-loop start, cleared on completion). `abort()` now only targets the **current round's active tasks** and no longer marks already-completed rounds as Aborted
- **Assistant placeholder uniformly appended at each inner-loop start** — `send()` no longer manually calls `append(Message.Assistant())`; `run()` checks the last message at the start of every inner loop and appends a Pending Assistant if absent, making `run()` self-contained whether called from `send()` (ending in User) or manually. The next round after tool calls is handled the same way at the next inner-loop start. `AgentTool` also drops its manual append. The strict "last message must be Assistant / must be Pending" validation is removed (replaced by auto-append); an empty message list still throws
- **Removed unused `Message` import in `AgentTool`**

### ✅ Tests

- **Added abort / dual-set / auto-append tests** — abort only affects the current round (completed rounds stay Completed); `innerLoopsTasks` keeps the whole group while `innerLoopTasks` only keeps the current in-flight round and both are cleared after `run()`; `run()` auto-appends Assistant for message lists ending in User or a completed Assistant. Test suite now at **215 tests**

## [3.3.0] - 2026-08-14

### ✨ Added

- **`onToolCall` blocking interception hook** — fired before every tool call execution. Returning a string rejects the tool: it is **not executed**, and the string (rejection reason) is returned to the LLM as the tool result while the conversation continues to the next round; returning `undefined` allows execution. The `ctx` received by the hook is the **same `ToolCallContext` instance** passed to `Tool.exec(ctx)`
- **New `ToolCallContext` fields** — `tool_call` (unified tool call shape; legacy `function_call` is wrapped as an id-less `{ function }`), `tool` (the matched registered tool, `undefined` if not registered), `signal` (abort signal for this tool execution; fires on `abort()`, tools can listen to truly interrupt)
- **`FunctionCallContext` backward-compatible alias** — `FunctionCallContext` is exported as a deprecated alias of `ToolCallContext` (the same class): old code importing it keeps working with `new` / `instanceof` / type annotations; new code should use `ToolCallContext`

### ♻️ Refactored

- **`FunctionCallContext` unified into `ToolCallContext`** — a single class now spans **interception decision → execution**: the same instance is passed to both the `onToolCall` hook (pre-execution interception) and `Tool.exec(ctx)` (actual execution); the old `onToolCall` interface was merged into the class. `function_call` is retained as a compatibility field equal to `tool_call.function`, so existing tool implementations (`ctx.parsed_args`, `this.function_call.name`, `preventDefault()`) keep working unchanged
- **`ToolCallContext.toolCall` renamed to `tool_call`** — snake_case for consistency with `function_call` / `parsed_args`

### 🔧 Changed

- **`ToolCallContext` constructor now takes `tool_call`** (with optional `tool`) instead of `function_call`; JSON argument parsing happens in the constructor, and with `allowJsonParseError=false` an invalid payload throws before the interception hook (the tool is marked `Error` without passing the hook)

### 📄 Docs

- **README / README.zh updated** — added an `onToolCall` hook section, rewrote the `ToolCallContext` section (field table + interception → execution semantics), and updated the conversation-flow diagram
- **Root README / README.zh updated** — `ToolCallContext` API table description now reads "unified tool-call context spanning interception → execution"

### ✅ Tests

- **Added `onToolCall` hook tests** — reject → tool not executed → reason returned to the LLM → continues to the next round; allow → normal execution; the hook and `Tool.exec` receive the **same instance**; parallel tool calls are intercepted independently
- **Added `ToolCallContext` tests** — unified `tool_call` + compatibility `function_call` fields; `FunctionCallContext` alias equivalence (`=== ToolCallContext`, constructible / `instanceof` / type annotation). Test suite now at **212 tests**

## [3.2.1] - 2026-08-13

### 📄 Docs

- **README translated to English** — the main `README.md` is now English-first, with the original Chinese content preserved as `README.zh.md`; the license statement was corrected from ISC to MIT
- **Package metadata standardized** — added an English `description` to `package.json`

## [3.2.0] - 2026-08-03

### ✨ Added

- **`inner-loops-start` / `inner-loops-end` events** — start/end events for a whole group of inner loops (one `send`, including multiple rounds of tool calls); each fires once per `send` and carries the current complete `messages`. Distinguished from the per-round `inner-loop-start` / `inner-loop-end` by the plural form: subscribers get both the "user + assistant placeholder ready" and the "full result" timing
- **`onInnerLoopsStart` / `onInnerLoopsEnd` async hooks** — correspond to the events above by name; awaited before/after the whole group of inner loops respectively (the per-round counterparts are `onInnerLoopStart` / `onInnerLoopEnd`)

## [3.1.0] - 2026-07-26

### ✨ Added

- **`Message.id` field** — unique message identifier, auto-generated in the constructor (prefers `globalThis.crypto.randomUUID`; falls back to timestamp + random in legacy environments without crypto, compatible with both Node.js and Web). The id stays stable for the lifetime of an instance: in-place mutation during streaming keeps the same object, `JSON.stringify` persistence carries it automatically, and it survives read-back. At the interface level `id` is optional (the slim allowlist object sent to the model by `formatHistory` excludes internal fields; types remain compatible)

### 🔧 Changed

- **`Message.rewrite` parameter type changed from `Message` to `AgentNS.Message`** — the method only reads/writes `content`/`raw_content`, depending on the interface rather than the implementation class, eliminating the type mismatch where slim objects could not be passed to `rewrite`

## [3.0.1] - 2026-07-26

### ♻️ Refactored

- **`CallbackTool` now `extends Tool` instead of `implements Tool`** — inherits the `Tool` abstract class and delegates to `super()` in the constructor, ensuring `toBeInstanceOf(Tool)` passes

### ✅ Tests

- **Integration test model name updated** — `deepseek-chat` → `deepseek-v4-flash`

## [3.0.0-alpha.1] - 2026-07-19

### 💥 Breaking Changes

- **Renamed the `onBeforeSend` hook to `onInnerLoopStart`** — more clearly expresses the hook's semantics at the start of an inner loop
- **Added the `onInnerLoopEnd` hook** — invoked at the end of an inner loop, useful for post-processing
- **Renamed the `"run"` event to `"inner-loop-start"`** — aligned with hook naming, clearer semantics
- **Renamed the `"run-end"` event to `"inner-loop-end"`** — aligned with hook naming, clearer semantics

### 🛠 Optimized

- In `Agent.ts`, the variable `matchTools` was renamed to `matchedTool` for cleaner naming
- Added inner-loop comments, improving code readability

### Migration Guide

If you use any of the following APIs, update accordingly:

| Old name | New name |
|----------|----------|
| `onBeforeSend` | `onInnerLoopStart` |
| `events.on("run", ...)` | `events.on("inner-loop-start", ...)` |
| `events.on("run-end", ...)` | `events.on("inner-loop-end", ...)` |
