---
title: Architecture
description: Five packages and two applications, their one-way dependency direction, what each layer owns and refuses, a 44-method / 17-event protocol surface, why the protocol is its own package, the client's transport/facade/session layers, the server's directory layout, the single rule behind a session's lifetime, the four parts of SessionManager, the <aiZenDir> on-disk layout, build/test order, what this round of refactoring changed, and the gaps that remain.
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

(`packages/` also holds `test-project` (a private fixture package) and the directories `test-home` and `webui` — neither of those has a `package.json`, so neither is a package. The CLI and the desktop app live in **separate repositories**, not in this monorepo, but each has its own place in the dependency graph below.)

## Layering and dependency direction

Dependencies are **one-way**, never reversed:

```
@ai-zen/agents-core ←──────────── @ai-zen/agents-sdk ←──────── @ai-zen/agents-server ←── bin: agents-server
      ↑ (types only)                                               ↑
@ai-zen/agents-protocol ←─────────────────────────────────────────┘
      ↑
@ai-zen/agents-client ←── bin: ai (cli) / desktop main
```

Read `A ← B` as "B depends on A". All five edges are facts in `package.json` —

| From | To | Shape |
|------|----|-------|
| `sdk` | `core` | runtime dependency |
| `protocol` | `core` | **only** one `import type` in `model.ts` (the shape of `Message` / `Usage` / `ToolCall`), erased from the artifact |
| `server` | `sdk` + `protocol` | runtime dependencies, two entries in `dependencies` |
| `client` | `protocol` | runtime dependency, **the only** entry in `dependencies` |
| `cli` / `desktop main` | `client` (the CLI additionally `sdk` / `core`) | application-side dependency. Both also declare `server` — they spawn it through `ensureServer`, so they need to locate its bin; in direction they are users of `client` |

### Three hard properties

Each one can be falsified with a command; none of them rests on "remember not to write that".

**① There is no edge between `client` and `server`.** Both depend only on `protocol`; neither depends on the other.

```bash
# the dependency table: one entry, the protocol
node -e 'const d=require("./packages/client/package.json").dependencies; if(Object.keys(d).join()!=="@ai-zen/agents-protocol") throw new Error(Object.keys(d).join())'

# the source: apart from comments and that one exception file, agents-server must not appear
grep -rn 'agents-server' packages/client/src --include=*.ts | grep -v '\.test\.' | grep -v 'ensure-server\.ts' | grep -v '^\S*:[0-9]*: *\*'
# must be empty
```

The single exception is `ensure-server.ts`: to spawn an `agents-server serve` it has to know where that bin lives, so it calls `require.resolve("@ai-zen/agents-server/package.json")` (and throws when that package is absent). That is a **deployment strategy, not a layer**: it is not in `dependencies` — the host applications (CLI / desktop) install the server package anyway, and an application that wants nothing to do with this edge can inject its own `startServerProcess`, in which case that `resolve` never runs. The consumption point is that single file.

**② `protocol` has zero third-party runtime dependencies.** It depends on `core` for types only, and that is an `import type`, erased from the artifact.

```bash
# the source: after dropping tests, node:* and the type-only edge, only relative paths remain
grep -rn '^import\|^\} from' packages/protocol/src | grep -v '\.test\.' | grep -v 'node:' | grep -v 'agents-core'

# the artifact side is the real verdict
(cd packages/protocol && npm run build && grep -hoE '^import .* from "[^"]+";' dist/*.js | sed 's/.*from "//;s/";//' | sort -u)
# expect only ./xxx.js and node:*
```

**③ `protocol` is the single exit for the data model.** `Message` / `Usage` / `ToolCall` / `ModelParams` / `PhaseInfo` all come from the protocol; no client reaches into `core` for them.

```bash
grep -rn '@ai-zen/agents-core' packages/client/src --include=*.ts | grep -v '\.test\.' | grep -v '^\S*:[0-9]*: *\*'
# must be empty
```

Why that deserves a hard property: the shape of `Message` is both the on-disk format (the archive JSON) and the wire shape. Building a second "wire mirror" for it would be a second definition — the one thing this project refuses most.

### There are no reverse edges

- `agents-server` does not appear anywhere under `packages/sdk/src` or `packages/core/src`;
- `packages/server/src` holds no import of `agents-client`;
- production code under `packages/client/src` holds no import of `@ai-zen/agents-server` (apart from the exception above);
- `packages/protocol/src` contains no `domain/` / `daemon/` / `lib/` (the protocol knows no implementation on either side).

## What each layer owns, and what it refuses

| Package / app | Owns | Refuses |
|---|---|---|
| `core` | The conversation runtime: `Agent` / `Message` / `Tool` / `ToolCallContext`, the plugin and event system | Permissions, the filesystem, configuration, persistence — its `src/` imports no `node:*` builtin at all. Its only dependencies are `openai` and `@ai-zen/event-bus` |
| `sdk` | Business capability: the capability pipeline (discover → filter → instantiate), the permission model, MCP lifecycle, task handoff and migration, built-in tools, `ConfigManager` | Processes and connections, session archives, workspaces, anything about what a client looks like. Depends on `core`, `@modelcontextprotocol/sdk`, `dayjs`, `openai` |
| `protocol` | The wire contract: how to find each other (shape and atomic I/O of the discovery file), how to talk (frame codec, `hello` handshake, `callOnce`), and what shapes travel (method tables, event tables, param/result types, the error-code table, the phase shape, the type exit for the data model) | Any business judgement, any state machine, any UI concept — no line here knows how a session stays alive, only what it looks like **on the wire** |
| `server` | Session orchestration, archives, workspaces, server-side reads/writes of configuration and agent definitions, the asset listing, the event outlet, and the `Daemon` that puts all of it on one TCP connection | Any UI stack (no ink / react / terminal library — the package boundary is the process boundary), and no process-level globals (cwd / global config path / global locale). Both hard constraints are in the header of `packages/server/src/index.ts`; the only exception is the composition root `src/cli.ts` |
| `client` | **Everything** that has to happen on the client side between a front end and the server: service discovery and spawning, one TCP connection, two facades (sessions, config), the **session-stream state machine** (the part of "thinking" all three front ends must agree on), two judgements (whether to hand up the cwd, what state the server is in) | Rendering, localisation, process-level globals, any local read/write of server-side data |
| `cli` (separate repo) | Rendering and input (ink), slash commands and the session layer, drawing the state of a `SessionStream` | Session orchestration, archives, workspaces, config writes — those live on the server. It depends on `client`, plus `sdk` / `core` (the app needs business types such as `AgentDefinition` and **runtime enums** such as `Role` / `MessageStatus`) |
| `desktop main` (separate repo) | Application-level facts (`app.getVersion()` as `clientInfo`), spawning the server, subscribing to events and turning that state over to the renderer | The server implementation itself. Its event translator is now a thin adapter over `SessionStream` |

## The protocol surface: 44 methods / 17 events

Method names and event names are `as const` tables shared by client and server. **Counting rule**: count the entries in those tables — one method-name literal is one method; parameter and result types do not count; the three built-in methods (`ping` / `status` / `shutdown`) **do** count (they are called after the handshake like any other, they are merely implemented by `Daemon` itself); notice codes (`SESSION_NOTICE_CODES` / `SERVER_NOTICE_CODES`) do not count as events — they are enums inside the payload of `session-notice` / `server-notice`.

| Namespace | Count | Defined in |
|-----------|-------|------------|
| `workspace.*` | 6 | `WORKSPACE_METHODS` in `sessions.ts` |
| `session.*` | 21 | `SESSION_METHODS` in `sessions.ts` |
| `events.watch` | 1 | `EVENT_METHODS` in `sessions.ts` (connection-level, belongs to no session) |
| `config.*` | 7 | `CONFIG_METHODS` in `config.ts` |
| `agent.*` | 5 | `AGENT_METHODS` in `config.ts` |
| `asset.*` | 1 | `ASSET_METHODS` in `assets.ts` |
| Built-ins `ping` / `status` / `shutdown` | 3 | `DAEMON_METHODS` in `daemon.ts` |
| **Total** | **44** | |

There are **17** events, in three tables, all in `sessions.ts`:

| Table | Count | Event names | Meaning |
|-------|-------|-------------|---------|
| `AGENT_EVENTS` | 9 | `open`, `chunk`, `chunk-parsed`, `parsed`, `tool-call-end`, `error`, `finally`, `sub-agent-start`, `sub-agent-end` | Values are verbatim core `Agent.events` names, and they fire at core's own moments |
| `SESSION_EVENTS` | 7 | `session-phase`, `session-tool-calls`, `session-turn-end`, `session-notice`, `session-question`, `session-id-changed`, `session-title-changed` | Derived by the server / actions of the server itself |
| `SERVER_EVENTS` | 1 | `server-notice` | The server's own notice (belongs to no session) |
| **Total** | **17** | | |

Five properties that matter at this level:

- Event payloads carry **facts** only (a phase kind, a tool name, a piece of text), never wording — turning them into "Connecting…" or "连接中…" is the client's job.
- The ten `AGENT_EVENTS` are core's own names (`open` / `chunk` / `chunk-parsed` / `parsed` / `message` / `tool-call-end` / `error` / `finally` / `sub-agent-start` / `sub-agent-end`); the server forwards each one at the very moment core emits it, without renaming anything. `open` / `chunk` / `parsed` / `error` / `finally` are unused by today's client but are still sent — the protocol surface is core's public fact, and whether to use it is the client's business.
- The timing is hard: `chunk` precedes `chunk-parsed` for the same piece; `error` precedes `finally`; `finally` precedes `session-turn-end` (which only goes out after the server has written the archive, swapped ids and run the reclaim check). `finally` and `session-turn-end` are **two different events**, not a rename of one another.
- `chunk-parsed` is a **text stream** (each frame appends), while `session-tool-calls` is **assembly state** (each frame says "this is what it looks like now"). Different semantics stay in different events; one event carrying both would leave the client guessing which fields append and which replace.
- `message` carries **the messages the server itself constructs** (the user message, the placeholder assistant, tool results) — exactly the ones a client cannot fold out of `chunk`. The payload is one complete message and `message.id` is the upsert key, so a tool result may go out twice: `pending` before the tool runs and final afterwards. `tool-call-end` is still forwarded when a tool settles (today's clients draw tool cards from it); it goes away together with the client-side handler once clients read `message`.
- `send` returns a `turnId` immediately and everything afterwards travels as events: a turn can run for minutes, and a request that only answered at the end would leave the client with nothing to render.
- Namespaces follow **what the method acts on**: `workspace.*` acts on the container, `session.*` on one conversation, `events.watch` belongs to the connection, and `asset.*` is read-only (assets are the user's filesystem; changing them is a different action). Events follow the same rule: the `session-` prefix marks **session events** (derived by the server or actions of the server itself, payload carries `sessionId`), `server-notice` is the **server's own notice** (it belongs to no session and must survive switching sessions), and the ten `AGENT_EVENTS` describe **what happens to one Agent** (their names are core's names) — the name alone tells you which table to look at, with no list to memorise.

The parameters, results and semantics of each method and event are **not** copied here — the definition site (`packages/protocol/src/sessions.ts` / `config.ts` / `assets.ts` / `daemon.ts`) is the only description, and the semantics that need more room live in `packages/server/README.md`. This document gives the classification and the size only.

## Why the protocol is its own package

`@ai-zen/agents-protocol` (`packages/protocol`) is **a package of its own**, not a part of either side.

**There is exactly one reason**: a contract is **both sides' property**. Living inside one of them forces the package graph to be `client → server`, so "the client must not drag in the server implementation" can only be maintained by discipline — only use a certain subpath, keep the artifact graph closed. And **discipline rots, structure does not**. Once the contract has its own package, that edge does not exist at all: `server` and `client` both depend only on `protocol`, neither on the other. Today `packages/server/package.json` exposes just two entries in `exports` (`.` and `./package.json`, the latter so `ensure-server` can locate the bin) — there is no longer a hole opened "so that clients can reach in".

**The desktop main process is a bundle artifact**, which is the same reason in practical clothes: the moment the main entry of `@ai-zen/agents-server` shows up in its import graph, the whole server implementation (plus `@ai-zen/agents-sdk`, the MCP SDK and openai) is packed into the installer.

The acceptance criterion is just as hard: everything this package exports must have **zero runtime external dependencies**. `index.ts` only does `export *` from the package's own modules (`frames` / `messages` / `daemon` / `sessions` / `config` / `assets` / `discovery` / `host` / `phase` / `errors` / `model` / `call-once`), and those modules import only sibling modules and `node:*`; the single edge that leaves the package is the `import type` into `@ai-zen/agents-core` in `model.ts` (erased at compile time).

Three details:

- **`discovery` lives in the protocol too**: the shape and I/O of `<aiZenDir>/run/server.json` is likewise a cross-process contract (the server writes it, the client reads it to decide "should I connect, and to which port"); putting it under the server's `daemon/` would suggest it is a server implementation detail.
- **`export *` instead of listing symbols**: listing them means every new method needs a new line here, and forgetting one produces "exports nothing" — a mistake no gate would catch. `export *` makes this a pure passthrough; the price is that duplicate symbol names fail to compile — which is exactly the reminder we want.
- **The protocol re-exports the data-model types too** (`Message` / `Usage` / `ToolCall` / `ModelParams`, see `model.ts`), because the on-disk format and the wire shape are the same thing. That is the same statement as hard property ③ in another voice: **declare it once**, instead of letting every client go fishing in `core`.

`client` re-exports the package verbatim (`export * from "@ai-zen/agents-protocol"` at the end of `packages/client/src/index.ts`), so an upper layer only has to know one package and still holds method-name constants, result types, frame codecs and the data-model types — and it is **not** a second definition.

## The three layers of the `client` package

Inside the package the split is by "dirty / pure" and by responsibility. Whatever can be pure touches no I/O, so the state machine can be unit-tested directly.

| Layer | File | Responsibility |
|---|---|---|
| **Transport** | `transport/connection.ts` (`ServerConnection`) | **One connection per process**: every use checks `closed`, rebuilds when dead, re-subscribes to `events.watch` on the new connection, reports both disconnects and readiness upwards (`onClose` / `onOpen`). It does **not** retry — retrying is a session-layer rule |
| | `ensure-server.ts` | Reads `<aiZenDir>/run/server.json`; if liveness (`callOnce` asking `ping`) fails it spawns `agents-server serve` detached and polls until `ping` answers. It is the **only** place in the package that knows about `agents-server` (deployment strategy, not a layer) |
| | `socket-server-client.ts` | One TCP + JSON-lines connection: `hello` handshake, in-flight calls, event dispatch, disconnect notification |
| **Facade** | `facade/sessions.ts` (`RemoteSessions`, 27) | Typed thin wrapper over `session.*` (21) + `workspace.*` (6) |
| | `facade/config.ts` (`RemoteConfig`, 13) | `config.*` (7) + `agent.*` (5) + `asset.*` (1) |
| | `facade/coverage.test-d.ts` | Facade method set **===** protocol method-table key set; **100% coverage** is enforced by types: one method missing or one extra fails to compile |
| **Session** | `session/stream.ts` (`SessionStream`) | The **pure** state machine: messages / phase / model / usage / sub-agents / terminal failure for one turn. Zero I/O, zero timers, zero globals |
| | `session/channel.ts` (`SessionChannel`) | The dirty half: subscriptions, requests, reconnects (three invariants), re-`attach`, immediate reclaim on `close` |
| | `session/errors.ts` | The single judgement for "does this session still exist": `session-missing` and `unknown-session` **both count** as gone |

One more pure piece sits at the package root: `stream-merge.ts` (`mergeStreamedSnapshot`, the merge rule between local streaming deltas and a server snapshot, single implementation). It lives at the root because both front ends and the package itself use it explicitly. There is **no** "agent view" style view-layer file: the sub-agent column is a piece of data inside `SessionStreamState.subAgents`.

**Why the cut is where it is**: this block **is not presentation**. It decides whether the answer on screen comes up short, whether a failed sub-task is shown as a success, and whether the turn is actually over — three front ends would all get it wrong, and all get it wrong the same way. The pure/dirty boundary (`SessionStream` / `SessionChannel`) is the same cut as `PhaseTracker` (pure) / `SessionManager` (dirty): the pure one can be unit-tested, the dirty one only wires things up.

`SessionStream` has no `send()` and no "wait for this turn": **waiting happens in `SessionChannel.waitForTurn(turnId)`**. `session-turn-end` can land before the reply to `send()`, so folding both into one promise would require keeping a record of "turns already settled" inside it — which is exactly what `waitForTurn` does.

### Three hard constraints (each machine-checkable)

1. **At runtime it depends on the protocol package only** — see hard property ① under "Layering and dependency direction". `devDependencies` holds four more workspace packages, all for types and test cases only; none reaches the artifact.
2. **The emitted runtime dependency graph must be closed**: after `npm run build`, external imports in `dist/*.js` may only be `@ai-zen/agents-protocol`; everything else is a sibling relative path or `node:*`.

   ```bash
   cd packages/client && npm run build
   grep -hoE '^import .* from "[^"]+";' dist/*.js | sed 's/.*from "//;s/";//' | sort -u
   ```

   > The check must anchor on a leading `^import`. Without the anchor, the `import type … from "@ai-zen/agents-sdk"` inside this package's own doc comments is grepped by itself and you conclude "it drags sdk in" — this has actually happened once.

3. **No process-level globals**: `aiZenDir` (config root) and `clientInfo` (the identity claimed in the handshake) are both **injected by the composition root**. Both are application-level facts and this package is a library that cannot make that call — otherwise the desktop app would claim to be the CLI when it spawns the server.

## The `server` package's directories

```
packages/server/src/
  domain/       business objects, one subdirectory each
    session/      SessionManager + EventBridge + Persistence + QuestionBroker
                  (+ the LiveSession shape, AutoTitle, store/ archive port and implementation)
    workspace/  agent/  config/  asset/  handoff/
  lib/          generic parts with no business semantics: phase.ts (PhaseTracker), events.ts (EventHub)
  daemon/       transport and wiring: Daemon / wire / params / *Handlers
  cli.ts        composition root (the only reader of env / argv)
  index.ts      the package barrel (`export *`; a name clash fails the build — that is the point)
```

The **dividing line** between `domain/` and `lib/` is this: `domain/` holds **business objects** (they know what a session or a workspace is, and are allowed to know the rules), while `lib/` holds **generic parts with no business semantics** — `phase.ts` is the generation-phase state machine, `events.ts` is connection fan-out, and neither knows about sessions, archives or the handshake. `EventHub` is barely 50 lines, but do not merge it away: `watcherCount()` carries a real business decision (if nobody is watching, do not ask the client anything), and the user of that decision is `QuestionBroker`.

Two more:

- **`daemon/` handles only "byte stream → frame → method call"**: `Daemon` itself carries just `ping` / `status` / `shutdown`, and the rest of the method table is injected by the composition root through `DaemonOptions.handlers`. This layer does **no business orchestration** — it validates parameter shapes and wires things up; any decision that needs to read another object belongs to `domain/` (e.g. "removing a workspace must close its live sessions" is `SessionManager.closeWorkspace`).
- **`cli.ts` is the composition root**: the only place allowed to read env / argv (`AI_ZEN_DIR`, `HOME`, command-line flags); it resolves paths into values and injects them, while `domain/`, `lib/` and `daemon/` read no globals. **`index.ts` is an `export *` barrel**, not a manifest of methods.

The wire contract is not in this package — it lives in `@ai-zen/agents-protocol`, which this package only depends on.

### Agent assembly is per workspace

Inside `domain/agent/`, one workspace shares one `Scope` (one set of MCP connections and one capability discovery), and it is **never shared across workspaces** — the cache key is the workspace path and the value is a `Promise` (concurrent session creation shares one initialization). Both halves have a reason: splitting per session would add one set of MCP connections per session, while sharing across workspaces would hand project A's project-level skills / tools / mcp to project B. See the header of `packages/server/src/domain/agent/SessionAgentFactory.ts`.

## Server process model

### A resident process, single instance

`agents-server` is the bin of `@ai-zen/agents-server` (`dist/cli.js`), with subcommands `serve` (the default) / `status` / `stop`.

Before starting, `serve` reads the discovery file: if the pid is alive and answers `ping`, it prints `already running on <host>:<port>` and exits with code 1; if the pid is gone, it removes the leftover file and continues. The **single-instance decision is made only on the server**; the client does not reimplement it (header of `packages/client/src/ensure-server.ts`).

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
- **The first frame must be `hello`**: the client opens with `{ kind: "hello", protocol, client: { name, version } }` and the server replies with the same shape, carrying `ok` and `server: { name, version, protocol, pid, startedAt }`. There is **no exception** — even though this build has no authentication yet, the handshake still comes first, otherwise "add auth later" would mean rewriting how every client connects (header of `packages/protocol/src/messages.ts`).
- After that each direction carries two kinds: request/response `{ id, method, params }` → `{ id, ok, result | error }`, and events `{ event, ... }`, pushed by the server, with no `id` and no reply expected.
- The protocol version is `PROTOCOL_VERSION = 1`; any incompatible field change bumps it, and there is no "best-effort" compatibility mode.

### Loopback only

`Daemon.start()` asserts on the host: anything that is not a loopback address throws and refuses to start (`packages/server/src/daemon/Daemon.ts`). The judgement `isLoopbackHost()` lives in `packages/protocol/src/host.ts` and accepts `localhost`, `::1`, and the whole `127.0.0.0/8` range (per RFC 1122, not just `127.0.0.1`).

This is not a placeholder: this build has **no authentication**, and the server exposes `exec` (arbitrary command execution), so an unauthenticated port reachable from off-machine would hand a shell to the whole LAN. The default is `127.0.0.1:8790`; `--port 0` lets the OS pick.

The two idle timeouts are different things: `--idle-timeout` covers the whole daemon (no connections left — exit after that long; off by default), `--session-idle-timeout` covers a single session (nobody watching it any more — reclaim it after that long).

Logs go to `<aiZenDir>/logs/server.log`: the daemon is spawned detached by a client, so it must never write to the client's terminal.

## A session's lifetime has exactly one rule

> A connection holds it → it stays alive; the last holder goes away → reclaim after a grace period; `session.close` → reclaim immediately.

That is all of it, and **there is no second judgement**.

`holders` means "at this moment one connection is actually watching it": the transport registers it (`session.create` / `session.attach` register the calling connection) and removes it when that connection closes (hooked on `connection.onClose`). It requires no cooperation from the client — the disappearance of a connection is **guaranteed by the kernel** (a `kill -9`, a crash or a power cut all take that socket away). The grace period is `DEFAULT_SESSION_IDLE_TIMEOUT_MS` (60 s, `--session-idle-timeout`), long enough to cover the client's worst-case reconnect budget; at the deadline the rule is **re-checked**, so an `attach` arriving inside the window merely cancels the reclaim, and a turn still running pushes it to `session-turn-end`.

**Why there is no client-reported "keep-alive intent"**: that design used the conjunction of "the declared intent **and** a holder", and of those two facts only one survives the hardest case — a crashed process cannot send that frame, so the declaration stays at "keep it" forever and the session, together with its Agent and message history, pins itself in memory (this package runs on loopback, so the only reclaiming event would be a daemon restart); whereas a holder is a kernel-guaranteed fact that the very same crash cleans up. Taking the conjunction just made the unreliable half a necessary condition. The single "why" for this decision is the header of `SessionManager.ts`.

Two **behavioural consequences** must be booked, and must not be described as "one mechanism fewer, behaviour unchanged":

- switching away from a session while the connection stays up (the TUI's `/new`, `/load`, re-mounting after `rollback`) **must explicitly `close()` the old one**, otherwise the memory peak grows linearly with the number of switches until the grace period expires;
- a one-shot call (`ai "…"`) must `close()` when it finishes, otherwise every invocation leaves a live session behind on the resident daemon.
  Both exits are `SessionChannel.close()` (which `await`s `session.close()`, so the server reclaims on the spot).

## The four parts of `SessionManager`

The session under `domain/session/` is four classes plus one shape file, all taking their collaborators through constructor arguments (they never import each other). The criterion is not line count but **"who owns which fields of `LiveSession`"**:

| File | What it took | Responsibility |
|---|---|---|
| `SessionManager.ts` | the registry `sessions` / `holders` / reclaiming / the turn lifecycle (`beginTurn` / `settleTurn` / `failTurn`) / the catalogue (`list` / `last` / `rename` / `remove` / `rollback`) / handoff (`handoff` / `migrate` / `autoMigrate`) / `create` / `attach` / `close` / `dispose` | The registry and the turn lifecycle — "the batch of sessions I am currently managing" |
| `EventBridge.ts` | `toolCalls` / the streaming shadow / the sub-agent column | SDK events → protocol events. Depends only on `agent.events` + `hub`, **needs neither the session table nor the store** |
| `Persistence.ts` | `store` / `record` / `persistOnSettle` / `autoPersist` | The archive shape and every write path. **`recordOf` is the single definition of the archive shape** |
| `QuestionBroker.ts` | `questions` / `questionSeq` | Server → client questions: claiming, timeouts, releasing. The only component that needs `hub.watcherCount()` — **if nobody is watching, do not ask** |
| `LiveSession.ts` | — | The shape of that session, plus `AgentLike` / `SubAgentLike` / `AskQuestionSpec`. All four classes depend on it alone |

`LiveSession` is a separate file for the opposite reason of "split but still in one lump": leave the shape inside any one class and the other three have to import that class. The fields still live on one object (not four tables) — they are four faces of the same session, and four tables would mean four "look it up by id" paths, and state that cannot be found is the hardest state to explain.

`SessionManager` touches no files (only the `SessionStore` port) and reads no configuration (anything that needs "config + agent definition" is injected by the composition root as a narrow function). That boundary is what makes it testable: one fake agent is enough to run the whole event flow.

## On-disk layout

The config root is written as `<aiZenDir>`: the `--ai-zen-dir` flag, else `AI_ZEN_DIR`, else `<HOME>/.ai-zen` (`parseArgs` in `packages/server/src/cli.ts`). It is resolved once, by the composition root, and injected as a value afterwards.

| Path | Contents | Source |
|------|----------|--------|
| `<aiZenDir>/config.json` | Global configuration (shape = the SDK's `AppConfig`) | `globalAgentPaths` in `domain/agent/agentPaths.ts` |
| `<aiZenDir>/agents/` | Top-level agent definitions (one JSON per entity) | Same; `CONFIG_SUB_DIRS` in `sdk/src/config/constants.ts` |
| `<aiZenDir>/sub-agents/` | Sub-agent definitions | `subAgentsDir` injected into `ConfigService` in `src/cli.ts`; same `CONFIG_SUB_DIRS` |
| `<aiZenDir>/skills/` | Global skills | `globalSkillsDirs` in `agentPaths.ts`; `CONFIG_SUB_DIRS` |
| `<aiZenDir>/tools/` | Global user tools | `globalToolsDirs` in `agentPaths.ts`; `CONFIG_SUB_DIRS` |
| `<aiZenDir>/mcp-oauth/` | MCP OAuth credential directory | `CONFIG_SUB_DIRS` in `sdk/src/config/constants.ts` |
| `<aiZenDir>/mcp.json` | Global MCP configuration | `globalMcpFile` injected into `ConfigService` in `src/cli.ts`; the tail of `mcpConfigs` in `agentPaths.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/workspace.json` | Workspace identity and location (the id is frozen) | `domain/workspace/workspace.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/sessions/<id>.json` | One session archive (body plus metadata, atomic write) | `domain/session/store/FileSessionStore.ts` |
| `<aiZenDir>/workspaces/<workspaceId>/sessions/<id>.meta.json` | The listing sidecar for that session (no body) | Same |
| `<aiZenDir>/workspaces/<workspaceId>/last-session.json` | "The last session of this workspace" pointer | Same |
| `<aiZenDir>/run/server.json` | Service discovery file | `descriptorPath` in `@ai-zen/agents-protocol`'s `discovery.ts` |
| `<aiZenDir>/logs/server.log` | Daemon log (appended) | `openLog` in `src/cli.ts` |

There is **no per-front-end directory** under `<aiZenDir>`: a session belongs to a **workspace**, and the CLI and the desktop app share one set of data. The pointer is not keyed by cwd either — the workspace is the partition key, so it is a single pointer (`last-session.json`).

A `workspaceId` looks like `<normalised directory name>-<first 8 hex of sha256(absolute path)>`, e.g. `/home/ubuntu/projects/ai-zen/cli` → `cli-3f9a1c2b`. It is only a **candidate for the first assignment** and is frozen once assigned: after an `mv` the id stays the same and the recorded path has to be rewritten explicitly with `workspace.relocate`, otherwise history dies the moment a directory is renamed (header of `workspace.ts`).

Project-level assets are not here — they hang off the workspace directory: `<ws>/.ai-zen/skills`, `<ws>/.ai-zen/tools`, `<ws>/.ai-zen/sub-agents`, and the MCP configuration priority chain is `<ws>/.mcp.json` → `<ws>/.ai-zen/mcp.json` → `<ws>/.agents/mcp.json` → `<aiZenDir>/mcp.json` → `~/.agents/mcp.json` (`agentPaths.ts`; order is priority, project level first).

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
- **`pnpm test` explicitly builds `testing` / `server` / `client`** (the last two bring `protocol` along); the artifacts of `core` / `sdk` must already exist from `build-core` / `build-sdk`, or the packages that depend on them fail to resolve during `pretest` (`tsc --noEmit`) and `vitest`. The client's test cases start a **real Daemon**, so `server`'s `dist` must be there too.
- To run one package's tests: `pnpm --filter @ai-zen/agents-server test` (same precondition: upstream `dist` present).

## Known gaps / unfinished

- **The desktop main process already uses `SessionStream`** (`desktop@49c82c1`; `events.ts` went from 838 to 665 lines): the hand-written delta accumulation, sub-agent merging, whole-snapshot replacement on settle and `failed` terminal check are all gone. What remains is "feed the event in / map it out to `ChatStreamEvent`". The two pieces **not** moved are desktop-only facts, not duplication: ① the body of the `user` event (the protocol never pushes user messages); ② the id of the placeholder assistant message (render's `v-for` key needs one, and the state machine deliberately gives streamed messages no id).
- **`SessionStream` is still missing three exits** (each of which forces a small, commented workaround in the desktop `events.ts`): ① a stable id for the streamed message (main now mints one per turn); ② a public way to *discard* a session's accumulated stream (main now swaps in a fresh `new SessionStream()`); ③ `applySnapshot` does not align `state.turnId` (main compares against the snapshot itself to detect a stale slot).
- **Method-table naming is not uniform**: `EVENT_METHODS` (singular) against the other five method tables (plural). Purely a naming matter, and renaming it touches two call sites.
- **`Role` / `MessageStatus` are `enum`s in core (runtime values)**, so **applications** (CLI / desktop) depending on core is legitimate. Making applications depend on the protocol alone would mean dropping the data vocabulary into a lower-level package — judged not worth it this round, so not done.
- **A comment in `packages/sdk/src/config/constants.ts` still describes per-front-end runtime directories** (`~/.ai-zen/<front-end>/`), which contradicts the current rule that sessions belong to workspaces and `config.json` lives under `<aiZenDir>`.
- **If the settle snapshot fails** (connection dropped, session just reclaimed), the desktop still pushes `error` — same as before the refactor: the local approximation of that message has no stable id, so it cannot ride inside `done`. Someone should confirm in a real window that the error bar appears and the input box recovers.

## Related documentation

- [Core API](core.md) — runtime public API and implementation details
- [SDK](sdk.md) — capability-layer public API
- [Retrieval & RAG](rag.md) — retrieval capability status
- [MCP](mcp.md) — MCP integration and lifecycle
- [`packages/server/README.md`](../../packages/server/README.md) — the server: per-method semantics, session-layer details, operating notes
- [`packages/client/README.md`](../../packages/client/README.md) — the connection layer: three layers, three hard constraints plus grep checks
- [`packages/protocol/README.md`](../../packages/protocol/README.md) — the contract package: what is inside, three hard constraints
- [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) — source of truth for the SDK design
