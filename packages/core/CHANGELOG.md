# Changelog

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
