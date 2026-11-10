---
title: Architecture
description: Six packages, their one-way dependency direction, the agents-server process model and protocol surface, why the protocol is its own package, build/test order, and the <aiZenDir> on-disk layout.
outline: deep
---

# Architecture

AI-Zen Agents is a **pnpm monorepo** (workspace root `@ai-zen/agents-workspace`, private, `2.0.0`). Six packages under `packages/` matter for this document:

| Package | Version | Role |
|---------|---------|------|
| `@ai-zen/agents-core` | 4.5.5 | Conversation runtime kernel |
| `@ai-zen/agents-sdk` | 1.1.0 | Business capability layer |
| `@ai-zen/agents-protocol` | 0.1.0 | The wire contract between the two processes: method/event names, payload shapes, error codes, frames, discovery file, `callOnce` |
| `@ai-zen/agents-server` | 0.1.0 | Resident server: session orchestration / archives / workspaces |
| `@ai-zen/agents-client` | 0.1.0 | Connection layer to the server |
| `@ai-zen/agents-testing` | 0.1.0 | Private, test doubles (a fake OpenAI-compatible streaming endpoint) |

(`packages/` also holds `test-project` (a private fixture package) and the directories `test-home` and `webui` — neither of those has a `package.json`, so neither is a package. The CLI and the desktop app live in **separate repositories**, not in this monorepo.)

## Layering and dependency direction

Dependencies are **one-way**, never reversed:

```
@ai-zen/agents-core ←──────── @ai-zen/agents-sdk ←──── @ai-zen/agents-server ←── bin: agents-server
      ↑ (types only)                                         ↑
@ai-zen/agents-protocol ←──────────┬─────────────────────────┘
      ↑                            │
@ai-zen/agents-client ──────────────┴──→ @ai-zen/cli / desktop main
```

All three are facts in `package.json`: `sdk` depends on `core`; `server` depends on `sdk` **and**
`protocol`; `client` depends on **nothing but** `protocol` (one entry in `dependencies`). `protocol`'s
only edge to `core` is an `import type` (the shape of `Message` / `Usage` / `ToolCall`), erased at
compile time — so its runtime dependencies are `node:*` only.

**There is no edge between `client` and `server`**: neither depends on the other, both depend only
on `protocol`. That is not maintained by discipline ("only use a certain subpath"), it is guaranteed
by structure — and that is the whole reason the protocol became its own package.

### What each layer owns, and what it does not

- **core** — Owns: the conversation runtime (`Agent` / `Message` / `Tool` / `ToolCallContext`, the plugin and event system). Does not own: permissions, the filesystem, configuration, persistence — its `src/` imports no `node:*` builtin module at all. Its only dependencies are `openai` and `@ai-zen/event-bus`.
- **sdk** — Owns: the business capability layer. Capability pipeline (discover → filter → instantiate), permission model, MCP lifecycle, task handoff and migration, built-in tools, `ConfigManager`. Depends on `@ai-zen/agents-core`, `@modelcontextprotocol/sdk`, `dayjs`, `openai`. Does not own: processes and connections, session archives, workspaces, or anything about what a client looks like.
- **protocol** — Owns: the **wire contract** between the two processes. How to find each other (the shape and atomic I/O of `<aiZenDir>/run/server.json`), how to talk (JSON-lines frame codec, the `hello` handshake, `callOnce`), and what shapes travel (method tables, event tables, param/result types, the error-code table, `PhaseInfo`, the type exit for the data model). Does not own: any business judgement, any state machine, any UI concept — no line here knows how a session stays alive, only what it looks like **on the wire**.
- **server** — Owns: session orchestration (`SessionManager`), archives (`FileSessionStore`), workspaces (`service/workspace/workspace.ts`), server-side reads/writes of configuration and agent definitions (`ConfigService`), the asset listing (`AssetService`), the event outlet (`EventHub`), and the `Daemon` that puts all of it on one TCP connection. Its `dependencies` hold two entries: `@ai-zen/agents-sdk` and `@ai-zen/agents-protocol`. Does not own: any UI stack (no ink / react / terminal library — the package boundary is the process boundary), and no process-level globals (cwd / global config path / global locale). Both hard constraints are in the header comment of `packages/server/src/index.ts`; the only exception is the composition root `src/cli.ts`.
- **client** — Owns: **everything** that has to happen on the client side between a front end and the server: service discovery and spawning, one TCP connection, two facades (sessions, config), two judgements (whether to hand up the cwd, what state the server is in). Its `dependencies` hold **exactly one** entry: `@ai-zen/agents-protocol`. Does not own: the server implementation (`Daemon` / `SessionManager` / agent assembly), and it reads no process-level globals.
- **CLI / desktop main** — Owns: rendering and input. Both depend only on `@ai-zen/agents-client` (plus protocol types).

### There are no reverse edges

This can be checked with grep (commands come from `packages/server/README.md` and `packages/client/README.md`):

- `agents-server` does not appear anywhere under `packages/sdk/src` or `packages/core/src`;
- `packages/server/src` holds no import of `agents-client`;
- production code under `packages/client/src` holds no import of `@ai-zen/agents-server`; see "The three disciplines of the `client` package" below;
- `packages/protocol/src` contains no `service/` / `daemon/` / `domain/` (the protocol knows no implementation on either side).

### Agent assembly is per workspace

Inside `server`, one workspace shares one `Scope` (one set of MCP connections and one capability discovery), and it is **never shared across workspaces** — the cache key is the workspace path and the value is a `Promise` (concurrent session creation shares one initialization). Both halves have a reason: splitting per session would add one set of MCP connections per session, while sharing across workspaces would hand project A's project-level skills / tools / mcp to project B. See the header comment of `packages/server/src/service/agent/SessionAgentFactory.ts`.

## Server process model

### A resident process, single instance

`agents-server` is the bin of `@ai-zen/agents-server` (`dist/cli.js`), with subcommands `serve` (the default) / `status` / `stop`.

Before starting, `serve` reads the discovery file: if the pid is alive and answers `ping`, it prints `already running on <host>:<port>` and exits with code 1; if the pid is gone, it removes the leftover file and continues. The **single-instance decision is made only on the server**; the client does not reimplement it (header comment of `packages/client/src/ensure-server.ts`).

### The discovery file

Located at `<aiZenDir>/run/server.json`; the shape is `ServerDescriptor` in `packages/protocol/src/discovery.ts`:

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

- **TCP + JSON-lines**: one JSON object per line, terminated by `\n`; the frame ceiling is 8 MiB, and an oversized frame is a protocol error that kills the connection (`packages/protocol/src/frames.ts`). JSON-lines was chosen so the protocol can be driven by hand with debugging tools and dropped as-is into WebSocket text frames and stdio.
- **The first frame must be `hello`**: the client opens with `{ kind: "hello", protocol, client: { name, version } }` and the server replies with the same shape, carrying `ok` and `server: { name, version, protocol, pid, startedAt }`. There is **no exception** — even though this build has no authentication yet, the handshake still comes first, otherwise "add auth later" would mean rewriting how every client connects (header comment of `packages/protocol/src/messages.ts`).
- After that each direction carries two kinds: request/response `{ id, method, params }` → `{ id, ok, result | error }`, and events `{ event, ... }`, pushed by the server, with no `id` and no reply expected.
- The protocol version is `PROTOCOL_VERSION = 1`; any incompatible field change bumps it, and there is no "best-effort" compatibility mode.

### Loopback only

`Daemon.start()` asserts on the host: anything that is not a loopback address throws and refuses to start (`packages/server/src/daemon/Daemon.ts`). The judgement `isLoopbackHost()` lives in `packages/protocol/src/host.ts` and accepts `localhost`, `::1`, and the whole `127.0.0.0/8` range (per RFC 1122, not just `127.0.0.1`).

This is not a placeholder: this build has **no authentication**, and the server exposes `exec` (arbitrary command execution), so an unauthenticated port reachable from off-machine would hand a shell to the whole LAN. The default is `127.0.0.1:8790`; `--port 0` lets the OS pick.

### Division of labour inside the process

- `src/cli.ts` is the **composition root**: the only place allowed to read env / argv (`AI_ZEN_DIR`, `HOME`, command-line flags). It resolves paths into values and injects them; `src/service/` and `src/daemon/` read no globals.
- `src/daemon/` handles only "byte stream → frame → method call": `Daemon` itself carries just `ping` / `status` / `shutdown`, and the rest of the method table is injected by the composition root through `DaemonOptions.handlers`.
- `src/service/` is the business side: session orchestration, archives, workspaces, configuration, assets, events.
- the wire contract is **not** in this package — it lives in `@ai-zen/agents-protocol` (next section), which this package only depends on.

The two idle timeouts are different things: `--idle-timeout` covers the whole daemon (no connections left — exit after that long; off by default), `--session-idle-timeout` covers a single session (nobody watching it any more — reclaim it after that long).

Logs go to `<aiZenDir>/logs/server.log`: the daemon is spawned detached by a client, so it must never write to the client's terminal.

## The protocol surface: 45 methods / 12 events

Method names and event names are `as const` tables shared by client and server. **Counting rule**: count the entries in those tables — one method-name literal is one method; parameter and result types do not count; the three built-in methods (`ping` / `status` / `shutdown`) **do** count as methods (they are called after the handshake like any other, they are merely implemented by `Daemon` itself); notice codes (`SESSION_NOTICE_CODES` / `GLOBAL_NOTICE_CODES`) do not count as events — they are enums inside the payload of `session.notice` / `server.notice`.

| Namespace | Count | Defined in |
|-----------|-------|------------|
| `workspace.*` | 6 | `WORKSPACE_METHODS` in `sessions.ts` |
| `session.*` | 22 | `SESSION_METHODS` in `sessions.ts` |
| `events.watch` | 1 | `EVENT_METHODS` in `sessions.ts` (connection-level, belongs to no session) |
| `config.*` | 7 | `CONFIG_METHODS` in `config.ts` |
| `agent.*` | 5 | `AGENT_METHODS` in `config.ts` |
| `asset.*` | 1 | `ASSET_METHODS` in `assets.ts` |
| Built-ins `ping` / `status` / `shutdown` | 3 | `DAEMON_METHODS` in `daemon.ts` |
| **Total** | **45** | |

There are **12** events, in two tables inside `sessions.ts`: `SESSION_EVENTS` (11 entries, every value starts with `session.`) — `session.phase`, `session.delta`, `session.toolCalls`, `session.messageAppended`, `session.turnEnd`, `session.notice`, `session.question`, `session.idChanged`, `session.titleChanged`, `session.subAgent.started`, `session.subAgent.ended`; and `SERVER_EVENTS` (1 entry) — `server.notice`.

Five properties that matter at this level:

- Event payloads carry **facts** only (a phase kind, a tool name, a piece of text), never wording — turning them into "Connecting…" or "连接中…" is the client's job.
- `session.delta` is a **text stream** (each frame appends), while `session.toolCalls` is **assembly state** (each frame says "this is what it looks like now"). Different semantics stay in different events; one event carrying both would leave the client guessing which fields append and which replace.
- `session.messageAppended` carries **one complete message** (a tool result: `role: "tool"` + `tool_call_id` + content) and goes out one message at a time instead of waiting for a snapshot: core finalises tool results one by one, while a snapshot is only available after `session.turnEnd` — and on a long turn the user stares at the argument card for minutes.
- `send` returns a `turnId` immediately and everything afterwards travels as events: a turn can run for minutes, and a request that only answered at the end would leave the client with nothing to render.
- Namespaces follow **what the method acts on**: `workspace.*` acts on the container, `session.*` on one conversation, `events.watch` belongs to the connection, and `asset.*` is read-only (assets are the user's filesystem; changing them is a different action). Events follow the same rule: `session.*` are **session events** (their payload carries `sessionId`), `server.notice` is the **server's own notice** (it belongs to no session and must survive switching sessions) — the prefix alone tells you which table to look at, with no list to memorise.

The parameters, results and semantics of each method and event are **not** copied here — that is what `packages/server/README.md` is for. This document gives the classification and the size only.

## The protocol package: `@ai-zen/agents-protocol`

The contract used to live inside the server package, exposed as a subpath
(`@ai-zen/agents-server/protocol`). It is now a **standalone package** (`packages/protocol`), which is
why `packages/server/package.json` `exports` only keeps `.`.

**Why move it out**: a contract is **both sides' property**. Living inside one of them forces the
package graph to be `client → server`, so "the client must not drag in the server implementation" can
only be maintained by discipline (only use that subpath, keep the artifact graph closed) — and
**discipline rots, structure does not**. Once the contract is its own package, that edge simply does
not exist: `server` and `client` both depend only on `protocol`.

**The desktop main process is a bundle artifact**: the moment the main entry of
`@ai-zen/agents-server` shows up in its import graph, the whole server implementation (plus
`@ai-zen/agents-sdk`, the MCP SDK and openai) is packed into the installer. That is the practical
reason behind "a client may only depend on the contract".

The acceptance criterion is just as hard: everything this package exports must have **zero runtime
external dependencies**. `index.ts` only does `export *` from the package's own modules (`frames` /
`messages` / `daemon` / `sessions` / `config` / `assets` / `discovery` / `host` / `phase` / `errors` /
`model` / `call-once`), and those modules import only sibling modules and `node:*`; the single edge
that leaves the package is the `import type` into `@ai-zen/agents-core` in `model.ts` (erased at
compile time).

Three details:

- **`discovery` lives in the protocol too**: the shape and I/O of `<aiZenDir>/run/server.json` is
  likewise a cross-process contract (the server writes it, the client reads it to decide "should I
  connect, and to which port"); putting it under the server's `daemon/` would suggest it is a server
  implementation detail.
- **`export *` instead of listing symbols**: listing them means every new method needs a new line
  here, and forgetting one produces "exports nothing" — a mistake no gate would catch. `export *`
  makes this a pure passthrough; the price is that duplicate symbol names fail to compile — which is
  exactly the reminder we want.
- **The protocol now also re-exports the data-model types** (`Message` / `Usage` / `ToolCall`, see
  `model.ts`). The old rule was "the protocol deliberately does not know message shapes"; its cost
  was never accounted for: every client had to `import type … from "@ai-zen/agents-core"` just to
  read one message. The on-disk format and the wire shape are the same thing, so it is declared once.

`client` re-exports the package verbatim (`export * from "@ai-zen/agents-protocol"` at the end of
`packages/client/src/index.ts`), so an upper layer only has to know one package and still holds
method-name constants, result types, frame codecs and the data-model types — and it is **not** a
second definition.

## The three disciplines of the `client` package

All three are in `packages/client/README.md`.

### 1. At runtime it depends on the protocol package only

`dependencies` holds `@ai-zen/agents-protocol` and nothing else. That is now **structure** (there is
no edge between client and server), no longer discipline:

```bash
node -e 'console.log(Object.keys(require("./packages/client/package.json").dependencies))'
# exactly [ "@ai-zen/agents-protocol" ]
```

`devDependencies` holds three more workspace packages, all for types and test cases only (nothing
reaches the artifact): `agents-sdk` for `config-port.ts`'s `AppConfig` / `AgentDefinition` /
`ReasoningPresets` (an `import type`; absent from `dist/*.js`, present in `dist/*.d.ts`),
`agents-server` for the **real `Daemon`** in test cases, `agents-core` for the real `AgentNS.Role`
values used in test data.

### 2. The emitted runtime dependency graph must be closed

After `npm run build`, external imports in `dist/*.js` may only be `@ai-zen/agents-protocol`
(everything else is a sibling relative path or `node:*`). The one `import type … from
"@ai-zen/agents-sdk"` in `config-port.ts` only provides the shared type for "what config and
definitions look like" and is erased from the artifact.

### 3. No process-level globals

`aiZenDir` (the config root) and `clientInfo` (the identity claimed in the handshake) are both
**injected by the composition root**: the CLI reads env once in `src/server-client/index.ts`, the
desktop main process reads env / `app.getVersion()` once at startup. Both are "application-level
facts", and this package is a library that cannot make that call — otherwise the desktop app would
claim to be the CLI when it spawns the server.

## Build and test order

Scripts in the root `package.json`:

| script | What it does |
|--------|--------------|
| `build-core` | `pnpm --filter @ai-zen/agents-core build` |
| `build-sdk` | `pnpm --filter @ai-zen/agents-sdk build` |
| `build-protocol` | `pnpm --filter @ai-zen/agents-protocol build` |
| `build-server` | `pnpm build-protocol && pnpm --filter @ai-zen/agents-server build` |
| `build-client` | `pnpm build-protocol && pnpm --filter @ai-zen/agents-client build` |
| `test` | `pnpm build-testing && pnpm build-server && pnpm build-client`, then the `test` script of `protocol` → `testing` → `core` → `sdk` → `server` → `client`, in that order |

**Why that order**: packages resolve each other through `dist`, not through source paths. Every package's `main` / `types` / `exports` point into `dist/`, pnpm only symlinks the workspace packages into `node_modules` (the symlink lands on the package's `package.json`, which resolves into `dist`), and no package declares `paths` or any other source mapping; each `build` is `prebuild` (`rimraf ./dist`) followed by `tsc`. Until an upstream package has emitted `dist`, a downstream one cannot even see its types.

Which gives these operating rules:

- **Changed the protocol** (`packages/protocol/src/`) → run `pnpm build-protocol` first. Otherwise `tsc` in `server` and `client` cannot see the new method-name constants and result types — both read the **artifact** of `@ai-zen/agents-protocol`.
- **Changed the client layer** (`packages/client/src/`) → run `pnpm build-client`. It bundles `build-protocol` itself (the protocol is its direct dependency).
- **`build-server` also bundles `build-protocol`**, so one command recompiles the server after a protocol edit. Neither includes core / sdk (those are separate scripts). A clean checkout needs `build-core` → `build-sdk` → `build-protocol` → `build-server` → `build-client`.
- **`pnpm test` explicitly builds `testing` / `server` / `client`** (the last two bring `protocol` along); the artifacts of `core` / `sdk` must already exist from `build-core` / `build-sdk`, or the packages that depend on them fail to resolve during `pretest` (`tsc --noEmit`) and `vitest`.
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
| `<aiZenDir>/run/server.json` | Service discovery file | `descriptorPath` in `@ai-zen/agents-protocol`'s `discovery.ts` |
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
