---
title: Architecture
description: The core / sdk layering, pnpm monorepo structure, module dependency direction, and conversation flow of AI-Zen Agents.
outline: deep
---

# Architecture

AI-Zen Agents is a **pnpm monorepo**, split into two public subpackages (`@ai-zen/agents-core` and `@ai-zen/agents-sdk`) and orchestrated by the private workspace root `@ai-zen/agents-workspace`.

## Layered overview

```
Upper-layer apps (CLI / Desktop)
        │
        ▼
@ai-zen/agents-sdk  ──►  @ai-zen/agents-core  ──►  official openai SDK
 (capability pipeline / Provider / MCP / built-in tools) (Agent runtime)   (LLM API)
        │
        ▼
LLM API / MCP servers (openai SDK / @modelcontextprotocol/sdk)
```

- **Core** is the "kernel" of the framework: it only cares about general conversation-runtime abstractions and is unaware of business concerns such as permissions or the filesystem.
- **SDK** is the "engine layer": it provides unified capabilities for CLI / Desktop, holding the capability pipeline, Provider, MCP, and built-in tools.

## Subpackage responsibilities

| Package | Version | Responsibility |
|----|------|------|
| `@ai-zen/agents-core` | 4.1.0 | `Agent` / `Message` / `Tool` / `ToolCallContext`, plugin mechanism (`AgentPlugin` + `HookResult` + `dispatchHook`), event system |
| `@ai-zen/agents-sdk` | 0.9.1 | `Provider` global context, capability pipeline (discover → filter → instantiate), permission model, MCP lifecycle, task migration, built-in tools, `ConfigManager` |

> The workspace root package `@ai-zen/agents-workspace` is private and version `2.0.0`. This version number is not consistent with the independent versions of the two public subpackages; it is only used for workspace orchestration.

## SDK internal module layering

```
types        ← pure types, zero business dependencies (includes ToolEnv, permissions, MCP types)
config       ← ConfigManager + constants: read/write config.json + migration + atomic writes + factory defaults
crud         ← capability entity CRUD (AgentDefinition, etc.; sessions/drafts are persisted by each client)
capabilities ← capability discovery and assembly (built-in + user + MCP + Skill + SubAgent)
runtime      ← Provider + model factory + Agent assembly + MCP connection management + task migration + SdkCallbackTool
plugin       ← Agent plugins (autoMigrate / autoRefreshTools / contextGuard / unknownToolHint)
shared       ← logging, errors
```

**Dependency direction**:

```text
plugin → runtime → capabilities → crud → config → types
              │
              └──→ shared
              └──→ @ai-zen/agents-core
```

Upper layers depend on lower layers, not the other way around; modules at the same layer do not depend on each other. For third-party dependency relationships, see [`packages/sdk/docs/sdk-design.md`](../../packages/sdk/docs/sdk-design.md) (the single source of truth for the SDK design).

## Core runtime design

### Plugins are the only extension point

`AgentContext` no longer offers any `onXxx` constructor hooks. **Plugins (`agent.use(plugin)`) are the only way to extend an Agent.** All hooks go through `dispatchHook`:

1. First emit **non-blocking** kebab-case events (`agent.events.emit`, notification only, no intervention);
2. Then **block** by calling plugin hooks in registration order; any one returning a string short-circuits.

`HookResult = string | void | Promise<string | void>`:

- **string** → short-circuit (reject / interrupt / provide a result; semantics depend on the hook);
- **undefined / void** → allow (continue to the next plugin or default behavior).

### Conversation flow (one `send()`)

```
send(content)
  ├── onBeforeSend hook → may reject
  ├── append User message
  └── run()
        ├── onInnerLoopsStart hook (once per send)
        ├── inner loop (continues as long as there are tool calls)
        │     ├── prepend an Assistant placeholder (Pending)
        │     ├── onInnerLoopStart hook (before each request)
        │     ├── client.chat.completions.create(...) (official SDK streaming)
        │     ├── parseStreamData() → content / reasoning_content / tool_calls
        │     ├── handleToolCall() → perform tool call
        │     │     ├── onToolCall interception hook → may reject
        │     │     ├── onUnknownTool plugin → fallback hint
        │     │     └── Tool.exec(ctx) run the matched tool
        │     └── onInnerLoopEnd hook
        ├── onInnerLoopsEnd hook
        └── return this.messages
  └── onAfterSend hook
```

A single `ToolCallContext` instance spans "interception decision (`onToolCall`) → execution (`Tool.exec`)".

## SDK capability pipeline: three stages

```
1. Discover (refresh)    discoverBuiltinTools / discoverUserTools / discoverSubAgents / discoverSkills / discoverMcpServers
2. Filter                safety pre-filter + four-dimension permission filter + tool isAvailable filter
3. Instantiate           name → Tool instance / dynamic tool / SubAgent lazy build / dedupe
```

`Provider` is the sole entry object of the SDK, holding configuration, paths, `cwd`, model factory, and the MCP manager. Each `Provider` binds to one working directory (`cwd`), enabling parallel multi-session operation without interference. See [SDK](sdk.md).

## Parallel multi-session

Built-in tools use `ToolEnv.cwd` as the base for relative paths and **no longer depend on the global `process.cwd()`**. CLI / Desktop can hold multiple `Provider`s at the same time, serving sessions in different working directories.

```
Desktop (workspaces.json)
   │ one Provider per workspace (1:1)
   ▼
Provider(cwd) ──ToolEnv──▶ tool instance (cwd/config injected)
   │
   ▼
createAgent(provider, agentId) → SdkAgent (parallel send)
```

## Related documentation

- [Core API](core.md) — runtime public API and implementation details
- [SDK](sdk.md) — capability-layer public API
- [Retrieval & RAG](rag.md) — retrieval capability status
- [MCP](mcp.md) — MCP integration and lifecycle
- [`packages/sdk/docs/sdk-design.md`](../../packages/sdk/docs/sdk-design.md) — source of truth for the SDK design
