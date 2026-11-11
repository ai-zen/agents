---
title: Architecture
description: Five packages and two applications, their one-way dependency direction, what each layer owns and refuses, a 44-method / 15-event protocol surface, why the contract is the server's type files, the client's transport/facade/session layers, the server's directory layout, the single rule behind a session's lifetime, the four parts of SessionManager, the <aiZenDir> on-disk layout, build/test order, what this round of refactoring changed, and the gaps that remain.
outline: deep
---

# Architecture

AI-Zen Agents is a **pnpm monorepo** (workspace root `@ai-zen/agents-workspace`, private, `2.0.0`). Five packages under `packages/` matter for this document:

| Package | Version | Role |
|---------|---------|------|
| `@ai-zen/agents-core` | 4.6.0-alpha.0 | Conversation runtime kernel |
| `@ai-zen/agents-sdk` | 1.2.0-alpha.0 | Business capability layer |
| `@ai-zen/agents-server` | 0.1.0-alpha.0 | Resident server: session orchestration / archives / workspaces |
| `@ai-zen/agents-client` | 0.1.0-alpha.0 | Connection layer to the server |
| `@ai-zen/agents-testing` | 0.1.0 | Private, test doubles (a fake OpenAI-compatible streaming endpoint) |

(`packages/` also holds `test-project` (a private fixture package) and the directories `test-home` and `webui` — neither of those has a `package.json`, so neither is a package. The CLI and the desktop app live in **separate repositories**, not in this monorepo, but each has its own place in the dependency graph below.)

## Layering and dependency direction

Dependencies are **one-way**, never reversed:

```
@ai-zen/agents-core ←──────────── @ai-zen/agents-sdk ←──────── @ai-zen/agents-server ←── bin: agents-server
      ↑ (runtime)                                               ↑
@ai-zen/agents-client ───────────────────────→(import type only)─┘
      ↑
@ai-zen/agents-client ←── bin: ai (cli) / desktop main
```

Read `A ← B` as "B depends on A". Every edge is a fact in `package.json` —

| From | To | Shape |
|------|----|-------|
| `sdk` | `core` | runtime dependency |
| `server` | `core` + `sdk` | runtime dependencies, two entries in `dependencies` |
| `client` | `core` | runtime dependency, **the only** entry in `dependencies` |
| `client` | `server` | **types only**: a `peerDependencies` entry (the host must provide it) plus a devDependency (this repo's tests start a real Daemon); not a single runtime reference |
| `cli` / `desktop main` | `client` (the CLI additionally `sdk` / `core`) | application-side dependency. Both also declare `server` — they spawn it through `ensureServer`, so they need to locate its bin; in direction they are users of `client` |

### Three hard properties

Each one can be falsified with a command; none of them rests on "remember not to write that".

**① There is no runtime edge between `client` and `server`.** The client imports the server for
**types only** (shapes and names); the runtime pieces (frame codec, error-code judgement, loopback
judgement, discovery-file I/O, `callOnce`) are its own copy under `packages/client/src/wire/` — the
contract shares **types**, not code. So `dependencies` holds one entry, `core`;
`@ai-zen/agents-server` is a **peerDependency** (the host must provide it: the type surface comes
from it, and `ensure-server` needs `require.resolve` on its bin) plus a devDependency (this repo's
tests start a real Daemon).

```bash
# dependency table: agents-server / agents-sdk / agents-testing must not appear
node -e 'const d=require("./packages/client/package.json").dependencies; const bad=Object.keys(d).filter((k)=>/agents-(server|sdk|testing)$/.test(k)); if(bad.length) throw new Error(bad.join())'

# the artifact is the real verdict: core is the only runtime import
(cd packages/client && npm run build && grep -hoE '^import .* from "[^"]+";' dist/*.js | sed 's/.*from "//;s/";//' | sort -u)
# expect only @ai-zen/agents-core, ./xxx.js and node:*
```

`ensure-server.ts` is the one place in the package that calls
`require.resolve("@ai-zen/agents-server/package.json")`: it has to spawn `agents-server serve`, so
it must find that bin (and throws when the package is absent). That is a **deployment policy, not a
layering edge**, which is why it stays out of `dependencies`; an app that does not want that path can
inject its own `startServerProcess`, and then the `resolve` never runs.

**② The contract is types only, with zero runtime exports.** `packages/server/src/protocol/` holds
nothing but `type` / `interface`: wire shapes, the method-name and event-name unions, the error-code
union, the type exit for the data model. Everything with a runtime (frame codec, error-code
judgement, loopback judgement, version constant, discovery-file I/O, `callOnce`) lives in
`packages/server/src/wire/`.

```bash
grep -rn '^export \(const\|function\|class\|async function\)' packages/server/src/protocol/*.ts | grep -v '\.test\.'
# must be empty
```

**③ There is one shape of the data model, and the contract only re-exports types.** `Message` /
`Usage` / `ToolCall` / `ModelParams` are declared by `core` and re-exported **type-only** by the
contract's `model.ts`; wire payload shapes such as `PhaseInfo` are owned by the contract itself. The
client imports `core` directly for chunk folding (`applyChunk`) and usage summing (`sumUsage`) — it
imports them instead of copying a mirror.

```bash
# the contract may reference core in type position only
grep -rn '@ai-zen/agents-core' packages/server/src/protocol | grep -v '^\S*:[0-9]*: *\*'
# expect only the single `import type` in model.ts

# apart from relative paths and that one core import, the contract imports nothing
grep -rn 'from "' packages/server/src/protocol/*.ts | grep -v '\.test\.' | grep -v 'from "\./' | grep -v '@ai-zen/agents-core'
# must be empty
```

Why this deserves a hard property: the shape of `Message` is both the on-disk format (the archive
JSON) and the wire shape. Manufacturing a second "wire mirror" for it would be a second definition —
and a second definition is exactly what this project refuses. So it is declared in one place only.

### There are no reverse edges

- `agents-server` does not appear anywhere under `packages/sdk/src` or `packages/core/src`;
- `packages/server/src` holds no import of `agents-client`;
- production code under `packages/client/src` references `@ai-zen/agents-server` in `import type` position only; the runtime pieces are its own `src/wire/`, and the single `require.resolve` on it is in `ensure-server.ts`;
- `packages/server/src/protocol` contains no `domain/` / `daemon/` / `lib/` (the protocol knows no implementation on either side).

## What each layer owns, and what it refuses

| Package / app | Owns | Refuses |
|---|---|---|
| `core` | The conversation runtime: `Agent` / `Message` / `Tool` / `ToolCallContext`, the plugin and event system | Permissions, the filesystem, configuration, persistence — its `src/` imports no `node:*` builtin at all. Its only dependencies are `openai` and `@ai-zen/event-bus` |
| `sdk` | Business capability: the capability pipeline (discover → filter → instantiate), the permission model, MCP lifecycle, task handoff and migration, built-in tools, `ConfigManager` | Processes and connections, session archives, workspaces, anything about what a client looks like. Depends on `core`, `@modelcontextprotocol/sdk`, `dayjs`, `openai` |
| `server` | The wire **contract** (`src/protocol/`: the method-name and event-name unions, payload types, error codes, the phase shape, the type exit for the data model — types only, zero runtime exports) and its **runtime pieces** (`src/wire/`: frame codec, `hello` handshake, error-code judgement, loopback judgement, version constant, discovery-file I/O, `callOnce`), plus session orchestration, archives, workspaces, server-side reads/writes of configuration and agent definitions, the asset listing, the event outlet, and the `Daemon` that puts all of it on one TCP connection | Any UI stack (no ink / react / terminal library — the package boundary is the process boundary), and no process-level globals (cwd / global config path / global locale). Both hard constraints are in the header of `packages/server/src/index.ts`; the only exception is the composition root `src/cli.ts` |
| `client` | **Everything** that has to happen on the client side between a front end and the server: service discovery and spawning, one TCP connection, two facades (sessions, config), the **session-stream state machine** (the part of "thinking" all three front ends must agree on), two judgements (whether to hand up the cwd, what state the server is in) | Rendering, localisation, process-level globals, any local read/write of server-side data |
| `cli` (separate repo) | Rendering and input (ink), slash commands and the session layer, drawing the state of a `SessionStream` | Session orchestration, archives, workspaces, config writes — those live on the server. It depends on `client`, plus `sdk` / `core` (the app needs business types such as `AgentDefinition` and **runtime enums** such as `Role` / `MessageStatus`) |
| `desktop main` (separate repo) | Application-level facts (`app.getVersion()` as `clientInfo`), spawning the server, subscribing to events and turning that state over to the renderer | The server implementation itself. Its event translator is now a thin adapter over `SessionStream` |

## The protocol surface: 44 methods / 15 events

Method and event names are **string-literal union types**, not runtime constant tables — they are
declared in `packages/server/src/protocol/`, which holds types only and not a single line of
runtime code. **Counting rule**: one member of a union is one entry; param/result types do not
count; the three built-in methods (`ping` / `status` / `shutdown`) **do** count; notice codes are
not events, they are enums inside `session-notice` / `server-notice` payloads.

| Namespace | Count | Declared in |
|----------|------|--------|
| `workspace.*` | 6 | `WorkspaceMethod` in `sessions.ts` |
| `session.*` | 21 | `SessionMethod` in `sessions.ts` |
| `events.watch` | 1 | `EventMethod` in `sessions.ts` (connection-level, belongs to no session) |
| `config.*` | 7 | `ConfigMethod` in `config.ts` |
| `agent.*` | 5 | `AgentMethod` in `config.ts` |
| `asset.*` | 1 | `AssetMethod` in `assets.ts` |
| built-in `ping` / `status` / `shutdown` | 3 | `DaemonMethod` in `daemon.ts` |
| **total** | **44** | |

There are **15** events, in three unions, all in `sessions.ts`:

| Union | Count | Names | Notes |
|----|------|--------|------|
| `AgentEventName` | 8 | `open`, `chunk`, `parsed`, `tool-call-end`, `error`, `finally`, `sub-agent-start`, `sub-agent-end` | verbatim core `Agent.events` names; the timing is copied from core too |
| `SessionEventName` | 6 | `session-phase`, `session-turn-end`, `session-notice`, `session-question`, `session-id-changed`, `session-title-changed` | server-derived / server's own actions |
| `ServerEventName` | 1 | `server-notice` | the server's own notice (belongs to no session) |
| **total** | **15** | | |

Five properties that matter here:

- Event payloads carry **facts** only (phase kind, tool name, body text) — never prose. Rendering
  into a language is the client's business.
- The eight `AgentEventName` members are core's own names; the server forwards each at the very
  moment core emits it, renaming nothing. `open` / `parsed` / `error` / `finally` are unused by
  today's client but are still sent — the protocol surface is core's public fact.
- **core's `chunk-parsed` and `message` never go on the wire**: the former is "the text delta you
  get by folding `chunk`", the latter is covered by `tool-call-end` and the turn-end snapshot.
- The ordering is hard: `error` before `finally`, `finally` before `session-turn-end`. Those are
  two different events, not a rename.
- `send` returns `turnId` immediately; the rest of the turn travels as events.

The parameters, results and semantics of each method and event are **not** copied here — the
definition site (`packages/server/src/protocol/sessions.ts` / `config.ts` / `assets.ts` /
`daemon.ts`) is the only description, and the semantics that need more room live in
`packages/server/README.md`.

## Why the contract is the server's type files

`packages/server/src/protocol/` holds nothing but `type` / `interface`: the wire shapes, the
method/event name unions, the error-code union, and the type-only re-export of the data model.
**Zero runtime exports.** Everything with runtime behaviour (frame codec, error-code predicate,
loopback predicate, version constant, discovery-file I/O, `callOnce`) lives in
`packages/server/src/wire/`.

**Why it is not a package of its own** (and not something in core): which methods / events /
payloads exist is **what the server provides**, so it belongs inside the server — there is no
separately installable unit. One-line criterion: if it describes what the server provides, it
belongs to the server; if other processes must execute it, it is code.

**Why a client never drags the server runtime in**: the client only does `import type` (shapes and
names); the runtime pieces are its own copies under `packages/client/src/wire/`. Only types are
shared, never code. Hence `@ai-zen/agents-client` has exactly one entry in `dependencies`
(`@ai-zen/agents-core`), and `@ai-zen/agents-server` is its **peerDependency** (the host must
provide it: the type face comes from it, and `ensure-server` spawns its bin) plus a devDependency
(tests start a real Daemon). Installing the client does not pull in openai or the MCP SDK.

**The desktop main process is a bundle artifact**, the same reason in practical clothes: it imports
only the types of `@ai-zen/agents-server/protocol`, so no bundler follows daemon / archives /
workspaces into the installer.

Two details:

- **`export type *` instead of listing symbols**: listing them means every new method needs a new
  line, and forgetting one yields "exports nothing" — a mistake no gate catches.
- **The contract re-exports the data-model types too** (`Message` / `Usage` / `ToolCall` /
  `ModelParams`, see `model.ts`), because the on-disk format and the wire shape are the same thing.

`client` re-exports that layer **as types** (`export type * from "@ai-zen/agents-server/protocol"`
in `packages/client/src/index.ts`), so an upper layer only has to know one package — and it is
**not** a second definition.

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

1. **It has exactly one runtime dependency edge, `core`** — `core` holds the **only** implementations of chunk folding (`applyChunk`), usage summing (`sumUsage`) and the role enum (`AgentNS.Role`), so the client imports them instead of copying a mirror; the contract with the server is **types only** (`import type`, see hard property ①), not a dependency. At runtime core's artifact only loads `@ai-zen/event-bus`; `openai` appears in core in type position only. `devDependencies` holds three more workspace packages, all for types and test cases only; none reaches the artifact.
2. **The emitted runtime dependency graph must be closed**: after `npm run build`, external imports in `dist/*.js` may only be `@ai-zen/agents-core`; everything else is a sibling relative path or `node:*` — **no `@ai-zen/agents-server`**.

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
  protocol/     the wire contract (types only): method-name / event-name unions, payloads, error codes, phase shape, data-model exit
  wire/         the contract's runtime pieces: frame codec, error-code judgement, loopback judgement, version constant, discovery-file I/O, callOnce
  daemon/       transport and wiring: Daemon / wire (transport abstraction) / params / *Handlers
  cli.ts        composition root (the only reader of env / argv)
  index.ts      the package barrel (`export *`; a name clash fails the build — that is the point)
```

The **dividing line** between `domain/` and `lib/` is this: `domain/` holds **business objects** (they know what a session or a workspace is, and are allowed to know the rules), while `lib/` holds **generic parts with no business semantics** — `phase.ts` is the generation-phase state machine, `events.ts` is connection fan-out, and neither knows about sessions, archives or the handshake. `EventHub` is barely 50 lines, but do not merge it away: `watcherCount()` carries a real business decision (if nobody is watching, do not ask the client anything), and the user of that decision is `QuestionBroker`.

Two more:

- **`daemon/` handles only "byte stream → frame → method call"**: `Daemon` itself carries just `ping` / `status` / `shutdown`, and the rest of the method table is injected by the composition root through `DaemonOptions.handlers`. This layer does **no business orchestration** — it validates parameter shapes and wires things up; any decision that needs to read another object belongs to `domain/` (e.g. "removing a workspace must close its live sessions" is `SessionManager.closeWorkspace`).
- **`cli.ts` is the composition root**: the only place allowed to read env / argv (`AI_ZEN_DIR`, `HOME`, command-line flags); it resolves paths into values and injects them, while `domain/`, `lib/` and `daemon/` read no globals. **`index.ts` is an `export *` barrel**, not a manifest of methods.

The wire contract is not in `src/daemon/` or `src/domain/` — it is `src/protocol/` in this same package (types only), with the runtime pieces in `src/wire/`.

### Agent assembly is per workspace

Inside `domain/agent/`, one workspace shares one `Scope` (one set of MCP connections and one capability discovery), and it is **never shared across workspaces** — the cache key is the workspace path and the value is a `Promise` (concurrent session creation shares one initialization). Both halves have a reason: splitting per session would add one set of MCP connections per session, while sharing across workspaces would hand project A's project-level skills / tools / mcp to project B. See the header of `packages/server/src/domain/agent/SessionAgentFactory.ts`.

## Server process model

### A resident process, single instance

`agents-server` is the bin of `@ai-zen/agents-server` (`dist/cli.js`), with subcommands `serve` (the default) / `status` / `stop`.

Before starting, `serve` reads the discovery file: if the pid is alive and answers `ping`, it prints `already running on <host>:<port>` and exits with code 1; if the pid is gone, it removes the leftover file and continues. The **single-instance decision is made only on the server**; the client does not reimplement it (header of `packages/client/src/ensure-server.ts`).

### The discovery file

Located at `<aiZenDir>/run/server.json`; the shape is `ServerDescriptor` in `packages/server/src/wire/discovery.ts`:

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

- **TCP + JSON-lines**: one JSON object per line, terminated by `\n`; the frame ceiling is 8 MiB, and an oversized frame is a protocol error that kills the connection (`packages/server/src/wire/frames.ts`). JSON-lines was chosen so the protocol can be driven by hand with debugging tools and dropped as-is into WebSocket text frames and stdio.
- **The first frame must be `hello`**: the client opens with `{ kind: "hello", protocol, client: { name, version } }` and the server replies with the same shape, carrying `ok` and `server: { name, version, protocol, pid, startedAt }`. There is **no exception** — even though this build has no authentication yet, the handshake still comes first, otherwise "add auth later" would mean rewriting how every client connects (header of `packages/server/src/protocol/messages.ts`).
- After that each direction carries two kinds: request/response `{ id, method, params }` → `{ id, ok, result | error }`, and events `{ event, ... }`, pushed by the server, with no `id` and no reply expected.
- The protocol version is `PROTOCOL_VERSION = 1`; any incompatible field change bumps it, and there is no "best-effort" compatibility mode.

### Loopback only

`Daemon.start()` asserts on the host: anything that is not a loopback address throws and refuses to start (`packages/server/src/daemon/Daemon.ts`). The judgement `isLoopbackHost()` lives in `packages/server/src/wire/host.ts` and accepts `localhost`, `::1`, and the whole `127.0.0.0/8` range (per RFC 1122, not just `127.0.0.1`).

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
| `EventBridge.ts` | the streaming shadow / the sub-agent column | SDK events → protocol events. Depends only on `agent.events` + `hub`, **needs neither the session table nor the store** |
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
| `<aiZenDir>/run/server.json` | Service discovery file | `descriptorPath` in `src/wire/discovery.ts` |
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
| `build-server` | `pnpm --filter @ai-zen/agents-server build` |
| `build-client` | `pnpm --filter @ai-zen/agents-client build` |
| `test` | `pnpm build-testing && pnpm build-server && pnpm build-client`, then the `test` script of `testing` → `core` → `sdk` → `server` → `client`, in that order |

**Why that order**: packages resolve each other through `dist`, not through source paths. Every package's `main` / `types` / `exports` point into `dist/`, pnpm only symlinks the workspace packages into `node_modules` (the symlink lands on the package's `package.json`, which resolves into `dist`), and no package declares `paths` or any other source mapping; each `build` is `prebuild` (`rimraf ./dist`) followed by `tsc`. Until an upstream package has emitted `dist`, a downstream one cannot even see its types.

Which gives these operating rules:

- **Changed the contract** (`packages/server/src/protocol/`) → run `pnpm build-server`. The contract is the server's type files and ships with the server; what `client` reads through `@ai-zen/agents-server/protocol` is `dist/protocol/*.d.ts`.
- **Changed the client layer** (`packages/client/src/`) → run `pnpm build-client`.
- Neither script includes core / sdk (those are separate scripts). A clean checkout needs `build-core` → `build-sdk` → `build-server` → `build-client`.
- **`pnpm test` builds `testing` / `server` / `client` explicitly**; the artifacts of `core` / `sdk` must already be there from `build-core` / `build-sdk`, otherwise the packages that depend on them fail to resolve during `pretest` (`tsc --noEmit`) and `vitest`. The client's tests start a **real Daemon**, so the `server` `dist` must be present too.
- To run a single package's tests: `pnpm --filter @ai-zen/agents-server test` (same precondition: its upstream `dist` is there).

## Known gaps / unfinished

- **The desktop main process already uses `SessionStream`** (`desktop@49c82c1`; `events.ts` went from 838 to 665 lines): the hand-written delta accumulation, sub-agent merging, whole-snapshot replacement on settle and `failed` terminal check are all gone. What remains is "feed the event in / map it out to `ChatStreamEvent`". The two pieces **not** moved are desktop-only facts, not duplication: ① the body of the `user` event (the protocol never pushes user messages); ② the id of the placeholder assistant message (render's `v-for` key needs one, and the state machine deliberately gives streamed messages no id).
- **`SessionStream` is still missing three exits** (each of which forces a small, commented workaround in the desktop `events.ts`): ① a stable id for the streamed message (main now mints one per turn); ② a public way to *discard* a session's accumulated stream (main now swaps in a fresh `new SessionStream()`); ③ `applySnapshot` does not align `state.turnId` (main compares against the snapshot itself to detect a stale slot).
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
- [`packages/sdk/docs/sdk-design-v1.md`](../../packages/sdk/docs/sdk-design-v1.md) — source of truth for the SDK design
