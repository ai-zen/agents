# Changelog

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
