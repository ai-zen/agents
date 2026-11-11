# @ai-zen/agents-server

AI-Zen Agents Server — the session/workspace service shared by CLI and Desktop.

Both front-ends should only *render and read input*; session orchestration, capability
assembly, persistence and task migration live here.

## Source of Truth

Dependency direction (one-way, never reversed):

```
@ai-zen/cli ─────┐
                 ├──→ @ai-zen/agents-server ──→ @ai-zen/agents-sdk ──→ @ai-zen/agents-core
desktop/main ────┘
```

Both front ends reach this package through `@ai-zen/agents-client`. The wire contract is **not a
package**: it is this package's own type files, `src/protocol/` (types only — method/event name
unions, payload types, error-code unions), exposed as `@ai-zen/agents-server/protocol` for
`import type`. Everything with runtime behaviour (frame codec, error-code predicate, loopback
predicate, version constant, discovery-file I/O, `callOnce`) lives in `src/wire/` on this side —
and each client has its own copy under `packages/client/src/wire/`. Only types are shared.

`sdk` and `core` must never import this package:

```bash
grep -rn "agents-server" packages/sdk/src packages/core/src   # must be empty
```

## The contract: `src/protocol/` (types) and `src/wire/` (runtime)

The wire contract is **not a package** — it is this package's type files. Two directories, two jobs:

| | Holds | Runtime exports |
|---|---|---|
| `src/protocol/` | method/event **name unions**, payload types, error-code unions, frame shapes, phase shapes, the type-only re-export of the data model | **none** — every file is `type`/`interface` only |
| `src/wire/` | frame codec (`encodeFrame` / `FrameDecoder` / `MAX_FRAME_BYTES` / `MAX_PAYLOAD_BYTES` / `ProtocolError`), error-code predicate (`codedError` / `isCodedError` / `codeOf`), loopback predicate, `PROTOCOL_VERSION`, discovery-file I/O, `callOnce`, `DEFAULT_MIGRATION_STRATEGY` | yes |

Clients import **only** `@ai-zen/agents-server/protocol` and only with `import type`; their own
runtime copies live in `packages/client/src/wire/`. Nothing is shared but shapes and names — which
is why `@ai-zen/agents-client` has zero runtime dependency on this package (the server is its
**peerDependency**: the host must provide it for the type faces and for spawning the bin; the SDK is
a peer for the same reason, `ConfigPort`'s public signature needs its config and agent shapes).

```bash
# the type face must stay free of runtime exports
grep -rn '^export \(const\|function\|class\|async function\)' packages/server/src/protocol   # must be empty
```

## Running the daemon

```bash
agents-server                      # foreground on 127.0.0.1:8790
agents-server --port 0             # let the OS pick a free port
agents-server --idle-timeout 1800000   # exit after 30 min with no connections
agents-server --workspace ~/proj   # default workspace when the client sends none
agents-server status               # print the discovery file + liveness
agents-server stop                 # ask the running one to shut down
```

Clients find it through `<aiZenDir>/run/server.json` (written atomically; removed on a clean
stop). The file carries `pid` + `version` + `protocol`, so a client can tell "crashed
leftover" from "different build still running" before it even connects. Logs go to
`<aiZenDir>/logs/server.log` — a daemon must never write to the client's terminal.

### v1 boundary: no authentication, therefore loopback only

This build has **no auth**. `Daemon.start()` accepts only loopback hosts — the whole
`127.0.0.0/8` block, `::1` and `localhost`, judged by `isLoopbackHost()` in `src/wire/host.ts` —
and throws for anything else. That is not a placeholder to be relaxed
casually: the service exposes `exec` (arbitrary command execution), so an unauthenticated
listener reachable from the network would hand a shell to the whole LAN. Exposing a port
means building auth first — there is no "open it for now" middle state.

The protocol is nevertheless **shaped** for auth: every connection's first frame must be
`hello { protocol, client }`, handshake failures carry machine-readable codes, and a
mismatched protocol version is rejected outright instead of "best-effort" interpreted.
Adding tokens/keys later changes the handshake payload only.

## Wire protocol

Transport-agnostic: **JSON-lines** (one JSON object per `\n`). It runs as-is over TCP,
WebSocket text frames and stdio, and can be driven by hand with `nc`:

```
→ {"kind":"hello","protocol":1,"client":{"name":"tui","version":"1.0.2"}}
← {"kind":"hello","ok":true,"server":{"version":"0.1.0","protocol":1,"pid":4180641,...}}
→ {"id":1,"method":"ping"}
← {"id":1,"ok":true,"result":{"pong":true}}
```

| Frame | Direction | Notes |
|---|---|---|
| `hello` | client → server, **first frame, mandatory** | version mismatch ⇒ connection closed |
| `{ id, method, params }` | client → server | one direction only; `id` is allocated by the client |
| `{ id, ok, result \| error }` | server → client | reply to the above |
| `{ event, ... }` | server → client | unsolicited, no reply expected |

There is deliberately **one direction only**: when the server needs to ask the client
something it emits `session-question` and gets the answer back through the `session.answer`
*method* — so frame `id`s are allocated by a single side and two directions can never collide.

Images and files do **not** ride inside `session.send`: a request frame that declares
`params.bytes` is followed on the same stream by exactly that many **raw bytes** (no separator, no
encoding), then line framing resumes.

```
→ {"id":7,"method":"content.upload","params":{"sessionId":"chat_1","bytes":4,"mime":"image/png","filename":"a.png"}}
→ <4 raw bytes>
→ {"id":8,"method":"ping"}
```

Why a binary tail instead of base64 inside the JSON: base64 costs a third more bytes and forces the
whole payload through a string. The length is declared once, the bytes are taken as they come.
Only the methods in `BINARY_METHODS` (`src/daemon/Daemon.ts`) may carry a payload; a `bytes` field
on any other method, a non-positive length, or a length above `MAX_PAYLOAD_BYTES` (64 MiB) is a
protocol error and kills the connection.

The content block that goes into `session.send` is produced **server-side**
(`content.upload` → SDK `fileToContentSection`): whether those bytes get uploaded as a `file_id`,
inlined as base64, or degraded to a text hint depends on the endpoint and model **that session**
is actually using. A frame carrying such a block still has to fit under `MAX_FRAME_BYTES`
(8 MiB) — the inline case puts base64 back into the JSON frame — so clients keep measuring it.

Built-in methods: `ping`, `status`, `shutdown`. Everything else is injected by the
composition root through `DaemonOptions.handlers`, so the daemon skeleton stays free of
business logic.

### The transport is replaceable — today exactly one implementation exists

`Daemon` never touches a socket. Its connection entry point takes a `Wire`
(`src/daemon/wire.ts`): six members, counted from what the daemon actually uses —
`write(text)`, `destroy()`, `destroyed`, `onData`, `onClose`, `onError`. Nothing else comes
along (`pause` / `resume` / half-close / `remoteAddress` … are unused, so they are not in the
interface: every extra member is an obligation for every future transport).

Chunks on a `Wire` are **raw bytes**. Undecoded on purpose: a payload may contain any byte value
(`0x0A` included), so decoding belongs at the frame layer where the bytes are actually sliced —
`FrameDecoder` splits lines on `\n` and payloads by declared length, and both decisions live in
that one place. The net adapter `socketWire()` is six one-line mappings and no `setEncoding`.

`FrameDecoder` hands out **one item at a time** (`push()` then `next()`): whether the bytes after a
frame are a binary payload is a question only the caller can answer (it knows the method), so the
decoder must not read ahead of that verdict.

Today's only implementation is **TCP**: `start()` wraps each `net.Socket` with
`socketWire()` and passes it to `Daemon.handleConnection(wire)`. WebSocket is **not
implemented** — there is no `ws` dependency and no WS listener in this package. Adding one
means (1) a new `Wire` implementation over `ws` text frames and (2) a listener that calls
`daemon.handleConnection(wire)` per connection; `Daemon` and `src/protocol/` do not change.
Authentication stays unsolved either way: the loopback assertion lives in the listener, not
in the `Wire`.

That "not a socket" claim is tested, not hoped for: `src/daemon/wire.test.ts` drives the
same `handleConnection()` with an in-memory duplex (two `PassThrough`s, no `vi.mock`) and
with a real `net.Socket`, running the identical handshake / call / event-push / close
scenario on both.

## Session layer

`src/protocol/sessions.ts` is the wire contract for sessions — method names, params and the
events, as three name unions: `AgentEventName` (core's own eight: `open`, `chunk`, `parsed`,
`tool-call-end`, `error`, `finally`, `sub-agent-start`, `sub-agent-end`), `SessionEventName`
(`session-phase`, `session-turn-end`, `session-notice`, `session-question`,
`session-id-changed`, `session-title-changed`) and `ServerEventName` (`server-notice`).
`src/domain/session/` holds the session as four collaborating classes:
`SessionManager.ts` (live-session registry, holders/reclaiming, turn lifecycle, catalogue,
handoff), `EventBridge.ts` (SDK events → protocol events), `Persistence.ts` (the archive shape
and every write path), `QuestionBroker.ts` (server → client questions). `src/lib/` holds the
business-free parts (`phase.ts` = phase state machine, `events.ts` = connection fan-out).
`src/domain/agent/` assembles the agent (config + Scope + capability
discovery) per workspace; `src/daemon/sessionHandlers.ts` registers the session and workspace
methods, `configHandlers.ts` / `agentHandlers.ts` / `assetHandlers.ts` / `contentHandlers.ts` the
rest, and `src/cli.ts` wires all of it.

**The method list has exactly one source of truth: `MethodApi` in `src/protocol/api.ts`** — one
entry per method, binding each name to its params and result. The name unions it must agree with
(`SessionMethod` / `WorkspaceMethod` / `EventMethod` / `ConfigMethod` / `AgentMethod` /
`AssetMethod` / `ContentMethod` / `DaemonMethod`) live in `sessions.ts` / `config.ts` / `assets.ts` /
`content.ts` / `daemon.ts`,
and two `Assert`s in `api.ts` fail the build if the two ever disagree. This README deliberately
does not copy the list: a copy is what goes stale, and a stale list is worse than no list. What
each method means is documented where it is defined; the sections below only carry the semantics
that need more room than a doc comment.

Agent assembly is **per workspace**: one Scope (one set of MCP connections and tool
discovery) is shared by every session in the same workspace, and never shared across
workspaces — project-level skills / tools / mcp hang off the workspace path.

Two things happen with tool plugins, and only one of them is unconditional: `AutoRefreshToolsPlugin`
is installed **regardless of token thresholds** (re-discovers capabilities so a server/skill/tool
added mid-session becomes visible), while guard / sub-agent guard / auto-migration come *after*
that check — they only apply when the model declares `tokenThresholds`, and returning early on
"no thresholds" must not silently disable tool refresh too. The refresh timing is a global config
knob (`autoRefreshTools`: `inner-loop-start` — default, before every request — /
`outer-loop-start` — once per turn — / `off`), because it trades freshness against one capability
scan per request.

### The workspace owns the cwd — and the agent's tool cwd

`workspace.resolve` takes an **optional** path, and who sends it depends on where the server
runs:

- **Client on the same machine (loopback)** — the client sends its own working directory. That
  is the user's actual intent ("I typed `ai` in this project") and it is what makes "reuse or
  create *this* directory's workspace, then resume its last conversation" work. The client only
  says *"I would like this directory"*; the server still normalises it, and the client keeps the
  **returned** path (the CLI's `reset()` uses it to open the next session in the same workspace).
- **Remote server** — nothing is sent, and the server answers with *its own* working directory:
  the `--workspace` flag, else the directory the daemon was started from (logged at startup, so
  "who decided this directory" is always answerable from the log). A laptop's cwd is a directory
  the server may not even have.

The handler never reads the process cwd itself — the composition root resolves the default once
and injects it as `defaultWorkspacePath`. The *client* makes the same call for project-scoped
`mcp.json` (`local-host.ts` in `@ai-zen/agents-client` is the single judge), because two separate
judgements would eventually disagree: the session in project A, the MCP config read from
somewhere else.

**The workspace path must reach `Scope` as its `cwd`.** `Scope` defaults to the *process's*
current directory, which on a daemon is wherever it happened to be spawned — one missing
argument gives you `@`-completion listing workspace B's files while `exec pwd` and every
relative read/write land in directory A. `AgentPaths.workspacePath` exists for exactly this.

### The workspace is a first-class object: named, id frozen, relocatable

`<aiZenDir>/workspaces/<workspaceId>/workspace.json` is the identity, and the id is **assigned
once and frozen** (`{ schema, id, path, title?, createdAt }`). `workspaceIdFor(path)`
(`<dirname>-<sha256(path)[0..8]>`) is only the *candidate* for the first assignment:

1. **fast path** — the record behind `workspaceIdFor(path)` exists **and** its `path` matches →
   use it. One file read, no directory scan; this is what a client startup hits.
2. **slow path** — otherwise scan `<workspacesRoot>` for a record whose `path` is this path and
   reuse **that** id. This is the only way back in after `mv ~/proj ~/proj2` (the frozen id is no
   longer `workspaceIdFor(currentPath)`), i.e. it is what keeps "renamed a directory ⇒ history
   gone" from happening.
3. **new** — neither matched → write a record with the derived id (shape unchanged). If that id
   is already held by *another* path (which relocation makes reachable, since ids no longer
   follow paths), take the next free one (`<id>-2`, …) instead of overwriting the record.

The path is compared only after `resolve()`, so relative paths, trailing slashes and `..` all
converge on one workspace.

Lifecycle methods, and the one place the path must still exist:

- `workspace.list` → `{ workspaceId, title?, path, pathExists }[]`, sorted by display name
  (`title ?? basename(path)`) then id — a total order, so two calls never disagree. `pathExists:
  false` means the directory was renamed/deleted/moved and the client should offer a repair.
- `workspace.rename` changes **only** `title` (id and path untouched; empty title is
  `bad-params`) — same name and meaning as `session.rename`.
- `workspace.relocate` rewrites `path`, keeping the id, so the sessions under that id become
  reachable again. The new path must already exist (`workspace-path-missing` — the server never
  `mkdir`s for the user) and must not be claimed by another record (`workspace-exists`).
- `workspace.remove` deletes `<workspacesRoot>/<id>/` **including `sessions/` and the pointer** —
  "delete this workspace and all its conversations" — and closes the live sessions of that
  workspace (otherwise their next turn would write the archive back and partly resurrect it).
  Idempotent: `removed: false` when it was not there.

`session.create` requires the **recorded** workspace path to still exist: with the directory gone
it fails with `workspace-path-missing` (message carries the path) instead of quietly creating an
empty directory the user would mistake for "resumed my project". (`workspace.relocate` also
requires a path to exist — its *new* one.) Read-only methods
(`session.attach` / `last` / `list` / `snapshot`, and `workspace.resolve` / `list` / `rename` /
`remove`) keep working: history lives in `workspaces/<id>/sessions/`, which has nothing to do
with whether that working directory still exists — and those are exactly the methods needed to
repair the record.

### Repairing a broken workspace is the **client's** job (deliberate)

When `workspace.list` reports `pathExists: false`, the server deliberately does **not** try to
guess where the directory went — not by basename, not by inode, not by "it looked like the same
project". The contract is:

- a GUI (desktop) shows the row with a warning and asks the user to **pick the new path**
  (`workspace.relocate`) or to **re-create the folder** at the recorded path (after which
  `pathExists` is true again and nothing else needs to happen);
- a CLI does **not** handle it at all: its workspace is `cwd`, the user typing `ai` in a moved
  directory is indistinguishable from a genuinely new project, and a wrong guess would silently
  attach someone's history to an unrelated directory — which is worse than an empty session.

Auto-detection was considered and rejected: inode identity only holds within one filesystem
(a copy+delete move breaks it), network filesystems may not keep it stable, and "the basename
looks the same" is a prediction, not a fact. One row that says "broken, fix me" is honest;
a silent wrong answer is not.

`workspace.files` returns the candidate list behind the client's `@`-completion. Entries are
relative to the workspace root, `/`-separated, and carry `dir` so the client knows whether to
append a trailing `/`. It is produced from **the server's** disk: `git ls-files -co
--exclude-standard` first (one call gives tracked + untracked *and* respects `.gitignore`),
`fs.glob` as the fallback for non-repos, 15s TTL cache keyed by workspace root, 20k entry cap.
Two details are load-bearing:

- **The root comes from the `workspace.json` record, never from the client.** The client only
  sends `workspaceId`; the id is a hash and cannot be reversed into a path, so the record is
  the only way back. A `workspaceId` that would escape the workspaces root is rejected.
- **Ancestor directories are synthesized** (`src/tui/chat.tsx` → `src`, `src/tui`). Without
  them the menu cannot be drilled into (`@src/` → keep listing), so it is a capability
  difference, not list padding.

### Capabilities on disk: `asset.list`

`asset.list { kind: "skill" | "tool", scope?, workspaceId? }` returns what capability discovery
would find — a **read-only** view (no CRUD lives here: assets are the user's files, and changing
them is a different action with its own permission story). It does **not** re-implement the scan:
`agentPaths.assetDirs` says which directories belong to which layer, and the SDK's
`discoverSkills` / `discoverUserToolFiles` do the scanning, so the panel and the agent can never
disagree about what is installed. Each entry carries its own `source` (`global` / `project`),
because `scope` defaults to *both* layers (project wins on a name clash, same priority order as
discovery). `scope: "project"` without a `workspaceId` is `bad-params`: project-level assets hang
off a workspace path, so there is no \"empty list\" answer — the caller forgot an argument. Without
a `workspaceId` you simply get the global layer only. One asymmetry worth knowing: `path` is a
**directory** for a skill (multi-file unit, `SKILL.md` inside) and a **file** for a tool; and
listing tools really does `import()` them (that is how discovery loads `Tool` instances).

### Two rounds, one session: `create` vs `attach`

`session.create` means **a new session** — if the id is already live it refuses
(`session-exists`), so that a client cannot silently take over a turn that is running.
`session.attach` means **that existing session**: live → join it, on disk → reload it from the
archive (`session-missing` if neither). The distinction exists because a session outlives its
clients: closing the terminal only drops the event subscription, while the session (and its
Agent and MCP connections) keeps running. Resuming "the last conversation" therefore arrives at
a *live* id, and `create` refuses a live id by design — so resume has to go through `attach`.

`send` has a matching guard: while a turn is in flight, a second `send` is rejected with
`turn-busy`. Events are attributed by reading `session.turnId` **at emit time**, so two
concurrent turns would interleave their deltas under each other's ids.

### `session.snapshot`: one resolution, three model facts

A reconnecting client gets one screenful of facts from `session.snapshot` instead of replaying
the event stream. The model part is a **single resolution's** output: `modelId` is the model
actually in use, `modelLevel` says which of the three levels it came from (`session` >
`agent` > `global`), and `modelParams` + `modelParamsLevel` are the params that same resolution
picked (`resolveModelParams` is keyed by the level `resolveModel` just produced — one call each,
no second pass). **`modelParams` and `modelLevel` come from the same resolution**, so a client
must not re-derive the level from "effective value + definition + default": that is a second
implementation of the priority order, and the first symptom is a settings screen showing "high"
while the request goes out with the old model's `thinking` block.

Two things worth knowing about `modelParams`:

- It is the **override layer**, not the merged request body — `session`'s copy when the model
  came from the session, the definition's `modelParams` when it came from the agent, and absent
  otherwise (the model's own `defaultParams` then apply). `global` has nowhere to store params,
  so that level never reports any — never borrowed from another level, because a session-level
  model sent with the previous model's params is a 400.
- `modelParamsLevel` travels with it (both present or both absent) and carries the same value as
  `modelLevel`: the pair exists so a client can show "this value" and "set at this level"
  together without inferring one from the other.

### Asking the client something: `session-question`

Some decisions belong to the user, not to the server — auto-migration's "who writes the handoff
document" (`self` | `summary` | skip) is the first one. The event is deliberately **generic**:

```
session-question { questionId, kind, input, options?, params, allowSkip, fallback }
session.answer   { questionId, choice: string | null }
```

- `kind` says *what* is being asked; the client looks up its own wording (`kind + option id`)
  and its own picker. Adding a second kind is a client-side table entry, no protocol change.
- `params` carries whatever the client needs to render a title (for handoff-mode today
  `{ promptTokens, handoffTokens }`) — a bag, not fixed fields, because the next question will want others.
- `fallback` is **what the server will use when nobody answers** (timeout, no watcher, or a
  client that does not know this `kind`). The asking party supplies it: only it knows which way
  is safe. For handoff-mode it is `null` = *do nothing*: deciding whether to migrate on the
  user's behalf is exactly the kind of overreach this API exists to avoid. Nobody is asked
  on the user's behalf — the hard guard still interrupts a turn that grows past the limit.

Three rules make waiting safe, and each has a reason:

- **Nobody watching ⇒ don't ask.** With no event subscribers the question is invisible, so
  `fallback` is returned immediately. Asking a question no one can see only wedges the turn.
- **Register before emitting.** Handlers run synchronously, so a fast client may answer inside
  the same event-loop tick.
- **Wait, but with a deadline** (`askTimeoutMs`, 5 min by default), and **clear the table on all
  three exits** (answered / timed out / released by `QuestionBroker.release`). "Not in the table" is
  the single test for "this answer came too late".

`release` resolves each pending question with **its own** `fallback` — not with one
shared value: "the turn is over" says nothing about what the user wanted.

### Not archiving is a bug: per-turn persistence

`settleTurn` writes the session to the archive **before** `session-turn-end`, then emits. The order is
the whole point: once a client sees `session-turn-end` it treats the turn as finished, so a session
missing from disk at that moment means "quit and come back and nothing happened".

Three details:

- **No user message ⇒ no write.** Otherwise `/load` fills up with empty sessions.
- **`send` / `handoff` set the flag; `migrate` must not.** `migrate` archives the *full* history
  before pruning; a second write at settle time would overwrite it with the pruned version.
- **A failed write is a notice (`persistFailed`), not an exception.** The settle path has no
  caller left to throw to, and "you thought it was saved" is the worst failure shape there is.

#### One-off sessions opt out: `session.create { persist: false }`

Per-turn persistence is right for a conversation, wrong for a *single question*. `ai "…"` (the
CLI's pipe mode) asks one thing and exits; archiving it would leave a session in `/load` and,
worse, move the workspace's "last session" pointer — the next TUI launch would resume a script's
output. So `session.create` takes `persist?: boolean` (default `true`): with `false` the settle
path skips the write and never touches the pointer. Everything else still holds — it is a live
session (it is held by the connection that created it), `save` / `saveAs` / migration still
write to disk when called.

The two flags are deliberately separate things and must not be conflated:

| flag | scope | question it answers |
|---|---|---|
| `persistOnSettle` | one turn | does *this* turn get written (`migrate`'s mid-turn settle says no) |
| `persist` / `autoPersist` | the session | is *this conversation* worth archiving at all |

Archiving a one-off run is an explicit act, and it also must not steal the resume pointer:
`session.save { sessionId, setAsLast?: boolean }` (default `true`, i.e. the TUI's `/save`)
writes the file and leaves `last-session.json` alone when `false`.

### Who decides a session may be dropped

A session outlives its clients, but it must not live forever. One fact decides it:

> A session stays only while at least one connection is actually watching it (`holders`).
> When the last holder goes away it is reclaimed after a grace period (`session.close`
> reclaims it immediately).

- `holders` is what the transport knows for free: `session.create` / `session.attach` register
  the calling connection, and that connection's close removes it. No frame, no client
  cooperation — the kernel guarantees the close (fin/rst on exit, crash or `kill -9`).
- `holders` is the *only* fact that decides lifetime. There is deliberately no declared
  counterpart: a flag the client had to send over the wire would be ANDed with `holders`, and a
  crashed process never gets to send that frame — used as a necessary condition, a `kill -9`ed
  client would pin its session (and the agent plus message history behind it) in memory until the
  daemon restarted, which is exactly the case `holders` already covers.
- When the last holder goes away the session gets a grace period (`DEFAULT_SESSION_IDLE_TIMEOUT_MS`,
  60 s, `--session-idle-timeout`). It must cover the client's reconnect budget (~30 s worst case),
  otherwise a reconnecting client finds the session already reclaimed. The deadline **re-checks**
  the rule, so an `attach` arriving inside the window just cancels it, and a turn still running at
  the deadline defers the close to `session-turn-end`.
- `session.close { sessionId }` is the **only** explicit way to say "I am done with this one" and
  it reclaims immediately (idempotent, `closed: false` when it was not live). A one-shot call
  (`ai "…"`) ends with it, otherwise every invocation would leave a live session behind until
  the grace period expires.
- **Closing is cheap and lossless**: the archive was written before `session-turn-end`, so a closed
  session is re-hydrated by `session.attach` straight from disk.
- `session.list` reports `live` (in server memory right now) — a fact, not a client declaration.

### The list is one list: `session.list { workspaceId, includeSaved? }`

A sidebar needs **all** sessions and, for each, whether it is running right now. Both live on the
same entry — `live` + `phase` next to the archive fields — so a client never stitches two sources
(and can never stitch the same session twice):

```
{ sessionId, agentId, title?, modelId?, effectiveModelId?, effectiveModelLevel?, messageCount, updatedAt, live, phase }
```

- **No message bodies.** The store keeps a per-session sidecar (`<id>.meta.json`) with exactly
  these counters, written together with the archive; listing reads the sidecar and never parses
  history. Archives written before the sidecar existed are read once and back-filled.
- **`includeSaved: false`** = live sessions only (no disk read).
- **Order** is `updatedAt` descending, ties broken by id descending — two sessions created in
  the same millisecond must not swap places on every refresh.
- **`updatedAt` is the time of the last *change*, not of the last *look*.** It is stamped where the
  archive is written, so `session.attach` / opening a session from a sidebar is **not** an
  activity: a continued session keeps the archived value, and only an actual archive write moves
  it. (The client reads it from this one field — no second copy anywhere.)

### `modelId` vs `effectiveModelId`: two facts, one response

`modelId` is the **session-level override** — the innermost level of the three-level resolution,
i.e. what `session.model.set` wrote into the archive. It is absent for most sessions, because
most sessions follow their agent definition or the global fallback, and its meaning stays exactly
that (`session.snapshot`'s `modelId` is something else: that one is the *effective* model).

`effectiveModelId` + `effectiveModelLevel` are the **resolved** model and the level it came from
(`session` > `agent` > `global`, single implementation: the SDK's `resolveModel`). They exist
because a sidebar's model dropdown has to show the current value: with only the override field,
every session that follows its definition renders as "no model selected". The fix belongs on the
server — a client that re-derives the value from "override + definition + default" is a **second
implementation of the priority order**, and the first symptom is a dropdown showing A while the
request goes out as B. Render `effectiveModelId`; take the "which level is in effect" badge from
`effectiveModelLevel` (same vocabulary as `session.snapshot`'s `modelLevel`).

Both fields are **omitted** when the server cannot resolve a model for that entry (the agent
definition was deleted, or all three levels are empty). They are never fabricated and never
fall back to `modelId` — a guessed model just makes the UI lie more confidently.

Cost: live entries read the model the server's own agent was built with (the resolution already
happened in `createAgent`) — free, and always consistent with `session.snapshot`. Archived
entries have no agent instance, so they go through the injected `resolveSessionModel`
(`agentId`'s definition + `AppConfig` + `resolveModel`). That resolver is asked **once per
`agentId`** (and per distinct session-level override, which is part of its input) within a single
`list` call — most workspaces keep one or two agents for all their sessions. It is deliberately
*not* cached across calls: config and definitions change, and a refresh must show the new answer.
A resolution that throws drops those two fields for that entry only; the rest of the list is
still returned (an archive can easily outlive the definition it was created under).

### `title` vs `id`

`id` is the identity (archive filename, `session-id-changed`, the resume pointer all point at it).
`title` is the name a human reads; renaming never moves the id. `session.rename { workspaceId,
sessionId, title }` works on archived sessions too (it does not require an `attach` first), and
`session.saveAs` — "save this conversation under another id" — carries the title along.

The same split applies to workspaces (`id` + `title`); `name` is kept for things whose `name`
*is* the identifier (a skill's frontmatter `name`, an `mcp.json` server key, and the SDK's
`AgentDefinition` / `Endpoint` / `Model`, which predate this rule).

### Automatic titles

After the **first** turn of a session settles, the server asks a model for a name and writes it
into the archive; `session-title-changed` tells clients about it (`session-turn-end` is already out — the
name never blocks anything). Three limits, each of them deliberate: it only runs when the title
is still empty (**a hand-renamed title is never overwritten**), it runs at most once per session
(failure just leaves the title empty — no retries, no error notice), and it is bounded by a 10s
timeout. The model is `AppConfig.defaultMigrationModel` when configured, otherwise the session's
effective model. `AppConfig.autoTitle: false` turns the whole thing off (a missing field means on).

### `session.remove`

Deletes the archive (and its sidecar). Idempotent: `removed: false` when it was not there — same
idiom as `agent.remove`. A live session is closed first, so a turn still running finishes in the
background but **never writes the archive back**: what the user deleted must not reappear.

### `session.setAgent`: same conversation, different agent

Agent identity belongs to the server (the agent runs there), so `/agent` cannot be done by
re-mounting a screen with a different `agentId` — `attach` returns a live session *as is* and
ignores that field, which is how "switched!" could be shown while the next turn still ran the
old agent. `session.setAgent` rebuilds the agent from the new definition, keeps
`agent.messages`, updates the session's `agentId`, and **writes the session once** (the archive
records `agentId`; skipping the write makes the next `attach` load the old agent back). It does
**not** invalidate the Scope: the Scope holds config and capability discovery, which are not
agent-specific, and invalidating it would evict every other session in the workspace.

### Sub-agents: a tool, not a session

Delegated sub-agents are *tool calls* (`AgentTool` / `AgentToolLazy`), and the protocol treats
them that way: `sub-agent-start` / `sub-agent-end` carry a per-turn `index` (the label) and a
stable `subAgentId` (the client's selection key), the raw `chunk` event grows an optional
`subAgentId` (so a client folds a sub-agent's transcript from the same stream the main one uses),
and `session.subAgent.snapshot` returns that sub-agent's own transcript. Two invariants:

- **A sub-agent's deltas never move the main phase.** While a sub-agent runs, the main agent is
  waiting for the delegating tool to return; the phase must stay "waiting for tool X".
- **They only live for the current turn.** The registry is cleared when the turn settles (and on
  `reload` / re-key / close), matching what the client shows: a sub-agent is worth looking at
  while it runs, and its transcript is otherwise history. One exception: the *id* counter is not
  reset, so a client's stale selection can never attach to the next turn's `sub-1`.

### The agent's own events go out verbatim: same names, same moments

Eight of the fifteen events are core's own (`AgentEventName`) and the server forwards them
**unchanged**, at the moment core emits them — renaming them on the wire would mean keeping a
translation table across protocol, server and client, and a table only ever drifts:

| Event | Fired by the server when |
|---|---|
| `open` | core `open` — the request is about to go out, once per inner loop |
| `chunk` | core `chunk` — one raw chunk arrived, **before** it is parsed |
| `parsed` | core `parsed` — the stream ended, `receiver` is final |
| `tool-call-end` | a `role: "tool"` message reached a finished status (payload: that message) |
| `error` | core `error` — the turn failed, **before** `finally` |
| `finally` | core `finally` — core is done with the turn |
| `sub-agent-start` / `sub-agent-end` | core's delegation boundary |

`open` / `parsed` / `error` / `finally` are unused by today's clients and are still sent: they are
core's public facts, and a client that later wants them (a "started" timestamp, a "core is done"
edge) must not need a server change. Payloads are minimal by design — `{ sessionId, turnId }`,
plus `chunk` for the raw piece (vendor shape, the protocol does not interpret it) and a flattened
`{ code, message }` for `error` (`Error` instances cannot go on the wire).

**core's `chunk-parsed` is not forwarded.** It carried the text/reasoning delta of one piece: a
derived copy of what the raw `chunk` already says, recomputed on the server and re-sent on the
wire, with its own payload type and its own `subAgentId` routing. Clients fold `chunk` with
core's `applyChunk` instead — one implementation, on both ends.

One timing is part of the contract: a failed turn goes `error` → `finally` → `session-turn-end`.
**`finally` and `session-turn-end` are two different events**: the former only says core is done,
the latter goes out after the archive is written, ids are swapped and the reclaim check has run
(`SessionManager.settleTurn`).

### Tool results go out the moment they settle

A tool result is the product of *executing* a tool, not of any chunk, so no client can fold it out
of the stream. It travels on `tool-call-end`:

```
{ event: "tool-call-end", sessionId, turnId, message }   // message: core's own Message
```

`message` is forwarded unchanged — the protocol does not interpret its fields, and there is no
"tool result event" shape to drift from core's message. Core emits `message` at its single append
point (`Agent.append`) and at the two places it finalises a message in place; the server uses that
only as the **trigger**, forwarding the one case clients need: a `role: "tool"` message that has
reached a finished status.

Why not wait for the snapshot: `session.snapshot` only exists after `session-turn-end`, and a turn
can run for minutes — the user would stare at the argument card without ever seeing what the tool
produced.

**Why there is no `message` event any more.** It used to forward every appended/finalised message
(the user message, the placeholder assistant, tool results) with `message.id` as the upsert key,
and it had **no subscriber on any client**: the user message is constructed by the client itself,
the placeholder is client-side folding state, and the tool result already travels on
`tool-call-end`. A derived copy of an existing fact is a second definition of that fact, and this
one dragged along an id-based upsert rule, a `subAgentId` variant and a pending→final two-phase
protocol that nothing on either end read.

### Notices: two channels, on one wire

Events carry **facts, never sentences**, and notices are no exception: a notice is
`{ level, code, params? }` — the client looks up `notice.<code>` in its own i18n table.
Codes are protocol (`SessionNoticeCode` / `ServerNoticeCode`): add new ones, never
repurpose an existing one.

The channel is the **namespace**, not a field:

| Event | Bound to | Rendered where |
|---|---|---|
| `session-notice` | a session (`sessionId` is required) | inside the conversation — disappears when you switch away |
| `server-notice` | nothing | app-level (status bar / banner) — must survive session switches |

Both go through the same `EventHub`, so a client needs **one** subscription. A
`workspace.notice` is the natural third if a notice ever belongs to a workspace but to no
particular session — adding it does not change these two.

Two design points worth keeping:

- `session.send` returns `{ turnId }` **immediately**; everything else arrives as events.
  A turn may run for minutes — a request/response `send` would leave the client with nothing
  to render and no sane timeout.
- Events carry **facts, never sentences** (`{ kind, tools }`, not "等待工具返回…"), so one
  server can serve a Chinese terminal and an English browser at the same time.

### Handoff: two methods, one round each

`session.handoff` writes a handoff document; `session.migrate` writes it **and opens a new
session**. The flow itself (stop → read the `handoff` skill → write → validate → degrade
`self` → `summary` → prune history → inject the breakpoint) lives in the SDK; this package
only adds the server-side effects: documents under `<workspace>/.ai-zen/handoffs/`,
notices instead of sentences, and the session-id switch.

Three things are worth knowing before touching it:

- **`migrate` has a `strategy`, and it decides identity.** `prune` (the default) physically drops
  the history, so the old segment only survives as an
  archive: the old id is archived first (before pruning), the handoff round is settled **on
  the old id**, and only then does the live session move to a new key. `omit` marks the old
  messages `omit: true` and keeps them, so nothing about the session changed — it **keeps its
  id** (no `idChanged`), `turnId` keeps counting, and the archive stays one file (written on
  settle). The two are not separate knobs: pruning means "these are two conversations",
  omitting means "same conversation, older messages are no longer sent".
- **Both are one round.** They bump `turnId` like `send` does, so phase/delta events belong
  to a real turn; the settling is owned by the method's promise (`settleDeferred`), because
  the SDK also emits `finally` for the handoff round itself.
- **Auto-migration mutates a turn that is already running.** When the model declares
  `tokenThresholds`, the factory installs `ContextGuardPlugin` (hard line, suspended while a
  handoff is in flight) and `AutoMigratePlugin` (soft line). The same `thresholds.guard` also
  feeds `SubAgentGuardInstallerPlugin`, which re-installs the guard on every delegated
  sub-agent from `onSubAgentStart` — a sub-agent is a fresh `new Agent()` that inherits no
  plugins and runs through `run()` (so `onBeforeSend` / `onAfterSend` never fire for it), and
  it recursively installs itself so grandchildren are covered too. The soft line fires *inside*
  `send()`, so it must not open a new turn and must not settle the outer one; it archives,
  prunes, re-keys and then emits `session-id-changed` — that event is the only way a client
  learns about a new id when no request is in flight.
- **Nothing is archived by hooks.** `HandoffService` runs its hooks through `safeHook`,
  which logs and continues — a failed archive inside a hook would let the prune destroy the
  history anyway. Archive / prune / adopt are three ordered statements in
  `SessionManager.migrate()`, each free to fail loudly.
- **Progress is notices, not sentences.** `handoffWriting` / `handoffAutoDetected` /
  `migrationDegraded` / `handoffPath` / `handoffArchived` / `handoffMigrated` +
  `handoffMigratedHint` / `migrationSkipped` — all `SessionNoticeCode`, so each one is a code a
  client renders with its own wording (the server emits no prose).

## Config and agent definitions

`src/protocol/config.ts` is the contract for everything that changes **global** state and
belongs to no session: the config centre (`config.get` / `config.save` /
`config.reasoningPresets`, `config.mcp.get` / `config.mcp.save` scoped `global` | `project`)
and agent definitions (`agent.list` / `get` / `save` / `remove`, next to the narrower
`agent.model.set`). `ConfigService` wraps the SDK's `ConfigManager` / `AgentRepository`; every
path (`config.json`, `agents/`, `sub-agents/`, `mcp.json`, workspaces root) is injected by the
composition root.

Why this layer exists at all: config must be read and written by the **side that owns it**.
If the client wrote its own disk, both ends on one machine would look fine and fail silently —
the UI reports success while the server's agents keep using the old model. Three deliberate choices:

- **Payloads are `unknown`.** The shape of `AppConfig` / `AgentDefinition` belongs to the SDK;
  a browser client should not have to install it to read a config. `unknown` becomes a real
  type at exactly one boundary — the handler — so the assertions live in one auditable place.
- **`config.save` is a whole-document overwrite.** No `syncManagedModels` on the write path:
  that is `bootstrap()`'s job, and re-syncing inside a save would silently revert the models
  the user just edited.
- **`agent.get` takes an optional `kind`.** The same id in `agents/` and `sub-agents/` is
  normal (both are called `default`), so a two-pane UI must say which pool it means; without
  it the lookup is top-level first, then sub-agent.

## Two hard constraints (machine-checkable)

1. **No UI stack here.** The package boundary is the process boundary — `ink`, `react` and
   terminal helpers belong to the client. `dependencies` holds `@ai-zen/agents-core` and
   `@ai-zen/agents-sdk` — no UI stack, no client.
2. **No process-wide globals.** No current working directory, no global config paths, no
   global locale: everything comes in through constructor arguments. The single exception is
   `src/cli.ts` — the composition root — which is *allowed* to read `AI_ZEN_DIR` / `HOME` /
   `argv` and must immediately turn them into injected values.

```bash
# 行首是 ` *` 的是**注释行**（`Daemon.ts` 的文件头用散文说了 `AI_ZEN_DIR`），`*.test.ts` 里的只
# 是用例名字 —— 门禁只该扫代码行，修的是命令而不是注释
grep -rn "process\.cwd()\|AI_ZEN_DIR\|refreshPaths\|setLocale\|getScope" packages/server/src \
  | grep -v "src/cli.ts" | grep -v '\.test\.' | grep -v '^\S*:[0-9]*: *\*'    # must be empty
```

That grep *is* the definition of "locally instantiable": any module here can be built in a
test with two or three fakes and nothing else.
