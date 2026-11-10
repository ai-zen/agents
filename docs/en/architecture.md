---
title: Architecture
description: Five packages, their one-way dependency direction, the agents-server process model and protocol surface, why the ./protocol subpath exists, build/test order, and the <aiZenDir> on-disk layout.
outline: deep
---

# Architecture

AI-Zen Agents is a **pnpm monorepo** (workspace root `@ai-zen/agents-workspace`, private, `2.0.0`). Five packages under `packages/` matter for this document:

| Package | Version | Role |
|---------|---------|------|
| `@ai-zen/agents-core` | 4.5.5 | Conversation runtime kernel |
| `@ai-zen/agents-sdk` | 1.1.0 | Business capability layer |
| `@ai-zen/agents-server` | 0.1.0 | Resident server: session orchestration / archives / workspaces |
| `@ai-zen/agents-client` | 0.1.0 | Connection layer to the server |
| `@ai-zen/agents-testing` | 0.1.0 | Private, test doubles (a fake OpenAI-compatible streaming endpoint) |

(`packages/` also holds `test-project` (a private fixture package) and the directories `test-home` and `webui` — neither of those has a `package.json`, so neither is a package. The CLI and the desktop app live in **separate repositories**, not in this monorepo.)

## Layering and dependency direction

Dependencies are **one-way**, never reversed:

```
@ai-zen/agents-core ← @ai-zen/agents-sdk ← @ai-zen/agents-server
                                                    │
                                          @ai-zen/agents-server/protocol
                                                    │
                                        @ai-zen/agents-client
                                                    │
                      @ai-zen/cli ──────────────────┴──── desktop/main
```

The header comment of `packages/server/src/index.ts` writes this chain as `@ai-zen/cli` / `desktop/main → agents-server → agents-sdk → agents-core`; the header comment of `packages/client/src/index.ts` writes its upper half: `client → @ai-zen/agents-server/protocol` (**not** the server body). Both are facts in `package.json` `dependencies`: `server` depends only on `sdk`, `client` depends on `server`, `sdk` depends on `core`.

### What each layer owns, and what it does not

- **core** — Owns: the conversation runtime (`Agent` / `Message` / `Tool` / `ToolCallContext`, the plugin and event system). Does not own: permissions, the filesystem, configuration, persistence — its `src/` imports no `node:*` builtin module at all. Its only dependencies are `openai` and `@ai-zen/event-bus`.
- **sdk** — Owns: the business capability layer. Capability pipeline (discover → filter → instantiate), permission model, MCP lifecycle, task handoff and migration, built-in tools, `ConfigManager`. Depends on `@ai-zen/agents-core`, `@modelcontextprotocol/sdk`, `dayjs`, `openai`. Does not own: processes and connections, session archives, workspaces, or anything about what a client looks like.
- **server** — Owns: session orchestration (`SessionManager`), archives (`FileSessionStore`), workspaces (`service/workspace/workspace.ts`), server-side reads/writes of configuration and agent definitions (`ConfigService`), the asset listing (`AssetService`), the event outlet (`EventHub`), and the `Daemon` that puts all of it on one TCP connection. Its `dependencies` hold **exactly one** entry: `@ai-zen/agents-sdk`. Does not own: any UI stack (no ink / react / terminal library — the package boundary is the process boundary), and no process-level globals (cwd / global config path / global locale). Both hard constraints are in the header comment of `packages/server/src/index.ts`; the only exception is the composition root `src/cli.ts`.
- **client** — Owns: **everything** that has to happen on the client side between a front end and the server: service discovery and spawning, one TCP connection, two facades (sessions, config), two judgements (whether to hand up the cwd, what state the server is in). Does not own: the server implementation (`Daemon` / `SessionManager` / agent assembly), and it reads no process-level globals.
- **CLI / desktop main** — Owns: rendering and input. Both depend only on `@ai-zen/agents-client` (plus protocol types).

### There are no reverse edges

This can be checked with grep (commands come from `packages/server/README.md` and `packages/client/README.md`):

- `agents-server` does not appear anywhere under `packages/sdk/src` or `packages/core/src`;
- `packages/server/src` holds no import of `agents-client` (`protocol/host.ts` and `protocol/index.ts` only mention it in comments);
- `packages/client/src` holds no import of `@ai-zen/agents-server` (the main entry); see "The two disciplines of the `client` package" below.

### Agent assembly is per workspace

Inside `server`, one workspace shares one `Scope` (one set of MCP connections and one capability discovery), and it is **never shared across workspaces** — the cache key is the workspace path and the value is a `Promise` (concurrent session creation shares one initialization). Both halves have a reason: splitting per session would add one set of MCP connections per session, while sharing across workspaces would hand project A's project-level skills / tools / mcp to project B. See the header comment of `packages/server/src/service/agent/SessionAgentFactory.ts`.

## Server process model

### A resident process, single instance

`agents-server` is the bin of `@ai-zen/agents-server` (`dist/cli.js`), with subcommands `serve` (the default) / `status` / `stop`.

Before starting, `serve` reads the discovery file: if the pid is alive and answers `ping`, it prints `already running on <host>:<port>` and exits with code 1; if the pid is gone, it removes the leftover file and continues. The **single-instance decision is made only on the server**; the client does not reimplement it (header comment of `packages/client/src/ensure-server.ts`).

### The discovery file

Located at `<aiZenDir>/run/server.json`; the shape is `ServerDescriptor` in `packages/server/src/protocol/discovery.ts`:

| Field | Meaning |
|-------|---------|
| `pid` | Detects "did it crash last time" — if the process is gone, the leftover file is removed |
| `host` / `port` | Where to connect (a port may be taken, in which case the server falls back to an OS-assigned one, so it must never be guessed) |
| `protocol` | Protocol version, a cheap pre-check before connecting |
| `version` | Server package version, used for drift warnings and diagnostics |
| `startedAt` | Start timestamp |
| `schema` | Schema version of the discovery file, currently always `1` |

Writes are atomic (write `.tmp`, then `rename`) so a client never reads half a JSON document; a missing or corrupt file reads back as `null` ("not running").

### Transport and handshake

- **TCP + JSON-lines**: one JSON object per line, terminated by `\n`; the frame ceiling is 8 MiB, and an oversized frame is a protocol error that kills the connection (`packages/server/src/protocol/frames.ts`). JSON-lines was chosen so the protocol can be driven by hand with debugging tools and dropped as-is into WebSocket text frames and stdio.
- **The first frame must be `hello`**: the client opens with `{ kind: "hello", protocol, client: { name, version } }` and the server replies with the same shape, carrying `ok` and `server: { name, version, protocol, pid, startedAt }`. There is **no exception** — even though this build has no authentication yet, the handshake still comes first, otherwise "add auth later" would mean rewriting how every client connects (header comment of `packages/server/src/protocol/messages.ts`).
- After that each direction carries two kinds: request/response `{ id, method, params }` → `{ id, ok, result | error }`, and events `{ event, ... }`, pushed by the server, with no `id` and no reply expected.
- The protocol version is `PROTOCOL_VERSION = 1`; any incompatible field change bumps it, and there is no "best-effort" compatibility mode.

### Loopback only

`Daemon.start()` asserts on the host: anything that is not a loopback address throws and refuses to start (`packages/server/src/daemon/Daemon.ts`). The judgement `isLoopbackHost()` lives in `packages/server/src/protocol/host.ts` and accepts `localhost`, `::1`, and the whole `127.0.0.0/8` range (per RFC 1122, not just `127.0.0.1`).

This is not a placeholder: this build has **no authentication**, and the server exposes `exec` (arbitrary command execution), so an unauthenticated port reachable from off-machine would hand a shell to the whole LAN. The default is `127.0.0.1:8790`; `--port 0` lets the OS pick.

### Division of labour inside the process

- `src/cli.ts` is the **composition root**: the only place allowed to read env / argv (`AI_ZEN_DIR`, `HOME`, command-line flags). It resolves paths into values and injects them; `src/service/` and `src/daemon/` read no globals.
- `src/daemon/` handles only "byte stream → frame → method call": `Daemon` itself carries just `ping` / `status` / `shutdown`, and the rest of the method table is injected by the composition root through `DaemonOptions.handlers`.
- `src/service/` is the business side: session orchestration, archives, workspaces, configuration, assets, events.
- `src/protocol/` is the wire contract (next section) and has **zero external dependencies**.

The two idle timeouts are different things: `--idle-timeout` covers the whole daemon (no connections left — exit after that long; off by default), `--session-idle-timeout` covers a single session (nobody watching it any more — reclaim it after that long).

Logs go to `<aiZenDir>/logs/server.log`: the daemon is spawned detached by a client, so it must never write to the client's terminal.

## The protocol surface: 45 methods / 12 events

Method names and event names are `as const` tables shared by client and server. **Counting rule**: count the entries in those tables — one method-name literal is one method; parameter and result types do not count; the three built-in methods (`ping` / `status` / `shutdown`) **do** count as methods (they are called after the handshake like any other, they are merely implemented by `Daemon` itself); notice codes (`SESSION_NOTICE_CODES` / `GLOBAL_NOTICE_CODES`) do not count as events — they are enums inside the payload of `session.notice` / `global.notice`.

| Namespace | Count | Defined in |
|-----------|-------|------------|
| `workspace.*` | 6 | `WORKSPACE_METHODS` in `protocol/sessions.ts` |
| `session.*` | 22 | `SESSION_METHODS` in `protocol/sessions.ts` |
| `events.watch` | 1 | `EVENT_METHODS` in `protocol/sessions.ts` (connection-level, belongs to no session) |
| `config.*` | 7 | `CONFIG_METHODS` in `protocol/config.ts` |
| `agent.*` | 5 | `AGENT_METHODS` in `protocol/config.ts` |
| `asset.*` | 1 | `ASSET_METHODS` in `protocol/assets.ts` |
| Built-ins `ping` / `status` / `shutdown` | 3 | `DAEMON_METHODS` in `protocol/daemon.ts` |
| **Total** | **45** | |

There are **12** events, all in `SESSION_EVENTS` in `protocol/sessions.ts`: `session.phase`, `message.delta`, `session.toolCalls`, `session.messageAppended`, `turn.end`, `session.notice`, `session.question`, `session.idChanged`, `session.titleChanged`, `session.subAgent.started`, `session.subAgent.ended`, `global.notice`.

Five properties that matter at this level:

- Event payloads carry **facts** only (a phase kind, a tool name, a piece of text), never wording — turning them into "Connecting…" or "连接中…" is the client's job.
- `message.delta` is a **text stream** (each frame appends), while `session.toolCalls` is **assembly state** (each frame says "this is what it looks like now"). Different semantics stay in different events; one event carrying both would leave the client guessing which fields append and which replace.
- `session.messageAppended` carries **one complete message** (a tool result: `role: "tool"` + `tool_call_id` + content) and goes out one message at a time instead of waiting for a snapshot: core finalises tool results one by one, while a snapshot is only available after `turn.end` — and on a long turn the user stares at the argument card for minutes.
- `send` returns a `turnId` immediately and everything afterwards travels as events: a turn can run for minutes, and a request that only answered at the end would leave the client with nothing to render.
- Namespaces follow **what the method acts on**: `workspace.*` acts on the container, `session.*` on one conversation, `events.watch` belongs to the connection, and `asset.*` is read-only (assets are the user's filesystem; changing them is a different action).

The parameters, results and semantics of each method and event are **not** copied here — that is what `packages/server/README.md` is for. This document gives the classification and the size only.

## Why the `./protocol` subpath exists

`packages/server/package.json` `exports` has two entries:

```json
".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
"./protocol": { "types": "./dist/protocol/index.d.ts", "default": "./dist/protocol/index.js" }
```

The reason is in the header comment of `packages/server/src/protocol/index.ts`: what a client (`@ai-zen/agents-client`, and the desktop main process) needs is this **wire contract** — method-name constants, request/response shapes, frame encode/decode, the shape of the discovery file. It does **not** need the server body: `Daemon`, `SessionManager`, `SessionAgentFactory` and the rest would drag `@ai-zen/agents-sdk` (and with it agents-core, the MCP SDK and openai) into the client's dependency graph.

**The desktop main process is a bundle artifact**: the moment `@ai-zen/agents-server`'s main entry appears in its import graph, the entire server implementation is packed into the installer. So the protocol gets its own entry, and it becomes the only path a client is allowed to reference.

The acceptance criterion is hard: everything this entry exports must have **zero external dependencies**. `protocol/index.ts` only does `export *` from the eight modules in that directory (`frames` / `messages` / `daemon` / `sessions` / `config` / `assets` / `discovery` / `host`), and those modules import only their sibling modules and node builtins.

Two details:

- **`discovery` lives in the protocol too**: the shape and I/O of `<aiZenDir>/run/server.json` is likewise a cross-process contract (the server writes it, the client reads it to decide "should I connect, and to which port"); putting it under `daemon/` would suggest it is a server implementation detail. It has zero external dependencies as well, so it qualifies.
- **`export *` instead of listing symbols**: with an explicit list, every new method would need a new export line, and forgetting one means "exports nothing" — a mistake no gate would catch. `export *` makes this file a pure pass-through; the price is that a duplicate symbol is a compile error, which is exactly the reminder we want.

`client` re-exports this entry verbatim (`export * from "@ai-zen/agents-server/protocol"` at the end of `packages/client/src/index.ts`), so an upper layer only has to know one package and still holds method-name constants, result types and frame codecs — and it is **not** a second definition.

## The two disciplines of the `client` package

Both are among the "three hard constraints" in `packages/client/README.md` (items 1 and 3; item 2 is their verification method, quoted below).

### 1. Only `./protocol`, never the server body

Production code may only use the `@ai-zen/agents-server/protocol` subpath, for the same reason as the previous section (bundle artifact plus dependency graph). The check:

```bash
grep -rn '@ai-zen/agents-server"' src/ --include=*.ts | grep -v '\.test\.ts'   # must be empty
```

`*.test.ts` is the exception: a test case has to start a **real Daemon**, and only the main entry offers that; test code never reaches the artifact.

The companion constraint is that the emitted dependency graph must be closed: after `npm run build`, the external imports in `dist/*.js` may only be `@ai-zen/agents-server/protocol` (everything else is a sibling relative path or `node:*`). The one `import type … from "@ai-zen/agents-sdk"` in `config-port.ts` exists to give "what config and definitions look like" a shared type on both sides and is erased from the artifact. That is why `package.json` `dependencies` lists `@ai-zen/agents-sdk` even though nothing loads it at runtime.

### 2. No process-level globals

`aiZenDir` (the config root) and `clientInfo` (the identity claimed in the handshake) are both **injected by the composition root**: the CLI reads env once in `src/server-client/index.ts`, the desktop main process reads env / `app.getVersion()` once at startup. Both are "application-level facts", and this package is a library that cannot make that call — otherwise the desktop app would claim to be the CLI when it spawns the server.

## Build and test order

Scripts in the root `package.json`:

| script | What it does |
|--------|--------------|
| `build-core` | `pnpm --filter @ai-zen/agents-core build` |
| `build-sdk` | `pnpm --filter @ai-zen/agents-sdk build` |
| `build-server` | `pnpm --filter @ai-zen/agents-server build` |
| `build-client` | `pnpm build-server && pnpm --filter @ai-zen/agents-client build` |
| `test` | `pnpm build-testing && pnpm build-client`, then the `test` script of `testing` → `core` → `sdk` → `server` → `client`, in that order |

**Why that order**: packages resolve each other through `dist`, not through source paths. Every package's `main` / `types` / `exports` point into `dist/`, pnpm only symlinks the workspace packages into `node_modules` (the symlink lands on the package's `package.json`, which resolves into `dist`), and no package declares `paths` or any other source mapping; each `build` is `prebuild` (`rimraf ./dist`) followed by `tsc`. Until an upstream package has emitted `dist`, a downstream one cannot even see its types.

Which gives these operating rules:

- **Changed the protocol** (`packages/server/src/protocol/`) → run `pnpm build-server` first. Otherwise `tsc` in `client` cannot see the new method-name constants and result types — it reads the **artifact** of `@ai-zen/agents-server/protocol`.
- **Changed the client layer** (`packages/client/src/`) → run `pnpm build-client`. It bundles `build-server` itself, because client's protocol types come from server's artifact.
- **Neither `build-server` nor `build-client` includes core / sdk** (each is one `--filter`). A clean checkout needs `build-core` → `build-sdk` → `build-server` → `build-client`.
- **`pnpm test` builds only `testing` and `client`** (the latter brings `server` along); the artifacts of `core` / `sdk` must already exist from `build-core` / `build-sdk`, or the packages that depend on them fail to resolve during `pretest` (`tsc --noEmit`) and `vitest`.
- To run one package's tests: `pnpm --filter @ai-zen/agents-server test` (same precondition: upstream `dist` present).

## On-disk layout

The config root is written as `<aiZenDir>`: the `--ai-zen-dir` flag, else `AI_ZEN_DIR`, else `<HOME>/.ai-zen` (`parseArgs` in `packages/server/src/cli.ts`). It is resolved once, by the composition root, and injected as a value afterwards.

| Path | Contents | Source |
|------|----------|--------|
| `<aiZenDir>/config.json` | Global configuration (shape = the SDK's `AppConfig`) | `globalAgentPaths` in `service/agent/agentPaths.ts` |
| `<aiZenDir>/agents/` | Top-level agent definitions (one JSON per entity) | Same; `CONFIG_SUB_DIRS` in `sdk/src/config/constants.ts` |
| `<aiZenDir>/sub-agents/` | Sub-agent definitions | `subAgentsDir` injected into `ConfigService` in `src/cli.ts`; same `CONFIG_SUB_DIRS` |
| `<aiZenDir>/skills/` | Global skills | `globalSkillsDirs` in `agentPaths.ts`; `CONFIG_SUB_DIRS` |
| `<aiZenDir>/tools/` | Global user tools | `globalToolsDirs` in `agentPaths.ts`; `CONFIG_SUB_DIRS` |
| `<aiZenDir>/mcp-oauth/` | MCP OAuth credential directory | `CONFIG_SUB_DIRS` in `sdk/src/config/constants.ts` |
| `<aiZenDir>/mcp.json` | Global MCP configuration | `globalMcpFile` injected into `ConfigService` in `src/cli.ts`; the tail of `mcpConfigs` in `agentPaths.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/workspace.json` | Workspace identity and location (the id is frozen) | `service/workspace/workspace.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/sessions/<id>.json` | One session archive (body plus metadata, atomic write) | `service/store/FileSessionStore.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/sessions/<id>.meta.json` | The listing sidecar for that session (no body) | Same |
| `<aiZenDir>/workspaces/<workspaceId>/last-session.json` | "The last session of this workspace" pointer | Same |
| `<aiZenDir>/run/server.json` | Service discovery file | `descriptorPath` in `protocol/discovery.ts` |
| `<aiZenDir>/logs/server.log` | Daemon log (appended) | `openLog` in `src/cli.ts` |

A `workspaceId` looks like `<normalised directory name>-<first 8 hex of sha256(absolute path)>`, e.g. `/home/ubuntu/projects/ai-zen/cli` → `cli-3f9a1c2b`. It is only a **candidate for the first assignment** and is frozen once assigned: after an `mv` the id stays the same and the recorded path has to be rewritten explicitly with `workspace.relocate`, otherwise history dies the moment a directory is renamed (header comment of `workspace.ts`).

Project-level assets are not here — they hang off the workspace directory: `<ws>/.ai-zen/skills`, `<ws>/.ai-zen/tools`, `<ws>/.ai-zen/sub-agents`, and the MCP configuration priority chain is `<ws>/.mcp.json` → `<ws>/.ai-zen/mcp.json` → `<ws>/.agents/mcp.json` → `<aiZenDir>/mcp.json` → `~/.agents/mcp.json` (`agentPaths.ts`; order is priority, project level first).

## Related documentation

- [Core API](core.md) — runtime public API and implementation details
- [SDK](sdk.md) — capability-layer public API
- [Retrieval & RAG](rag.md) — retrieval capability status
- [MCP](mcp.md) — MCP integration and lifecycle
- [`packages/server/README.md`](../../packages/server/README.md) — the server: per-method semantics, session-layer details, operating notes
- [`packages/client/README.md`](../../packages/client/README.md) — the connection layer: three hard constraints plus grep checks
- [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) — source of truth for the SDK design
