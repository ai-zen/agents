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

`sdk` and `core` must never import this package:

```bash
grep -rn "agents-server" packages/sdk/src packages/core/src   # must be empty
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

This build has **no auth**. `Daemon.start()` refuses any host that is not
`127.0.0.1` / `::1` / `localhost` and throws. That is not a placeholder to be relaxed
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
| `{ id, method, params }` | both | request ids are allocated by the sender; each direction has its own id space |
| `{ id, ok, result \| error }` | both | reply to the above |
| `{ event, ... }` | server → client (later: both) | unsolicited, no reply expected |

Images currently ride inside `session.send` as OpenAI-compatible content blocks (`text` /
`image_url` / `file`) — base64 inlined, so the client must keep the whole frame under
`MAX_FRAME_BYTES` (8 MiB); an oversized frame is a protocol error and kills the connection.
The long-term answer is an `artifact.*` method pair (bytes over a side channel), at which
point the content-block assembly moves here, to the side that knows the endpoint and model.

Built-in methods: `ping`, `status`, `shutdown`. Everything else is injected by the
composition root through `DaemonOptions.handlers`, so the daemon skeleton stays free of
business logic.

## Session layer

`src/protocol/sessions.ts` is the wire contract for sessions — method names, params and the
session events (`session.phase`, `message.delta`, `turn.end`, `session.notice`,
`session.idChanged`, `session.question`, `session.subAgent.*`). `src/service/session/
SessionManager.ts` implements the live-session registry and the SDK-event → protocol-event
translation; `src/service/agent/` assembles the agent (config + Scope + capability
discovery) per workspace; `src/daemon/sessionHandlers.ts` registers `workspace.resolve` /
`workspace.files` / `events.watch` / `session.create` / `session.attach` / `session.send` /
`session.cancel` / `session.list` / `session.rename` / `session.remove` / `session.last` /
`session.subAgent.snapshot` / `session.question`+`session.answer` / `session.reload` /
`session.setAgent` / `session.close` / `session.keepAlive.set` / `session.handoff` /
`session.migrate` on a `Daemon`, and `src/cli.ts` wires all of it.

Agent assembly is **per workspace**: one Scope (one set of MCP connections and tool
discovery) is shared by every session in the same workspace, and never shared across
workspaces — project-level skills / tools / mcp hang off the workspace path.

Two plugins are installed regardless of the model's token thresholds: `AutoRefreshToolsPlugin`
(re-discovers capabilities so a server/skill/tool added mid-session becomes visible) and the
sub-agent guard installer. The refresh timing is a global config knob
(`autoRefreshTools`: `inner-loop-start` — default, before every request — / `outer-loop-start`
— once per turn — / `off`), because it trades freshness against one capability scan per
request. Guard / auto-migration come *after* that check: they only apply when the model
declares `tokenThresholds`, and returning early on "no thresholds" must not silently disable
tool refresh too.

### The workspace owns the cwd — and the agent's tool cwd

`workspace.resolve` takes an **optional** path, and who sends it depends on where the server
runs:

- **Client on the same machine (loopback)** — the client sends its own working directory. That
  is the user's actual intent ("I typed `ai` in this project") and it is what makes "reuse or
  create *this* directory's workspace, then resume its last conversation" work. The client only
  says *"I would like this directory"*; the server still normalises it, and the client keeps the
  **returned** path (`reset()` relies on it to open the next session in the same workspace).
- **Remote server** — nothing is sent, and the server answers with *its own* working directory:
  the `--workspace` flag, else the directory the daemon was started from (logged at startup, so
  "who decided this directory" is always answerable from the log). A laptop's cwd is a directory
  the server may not even have.

The handler never reads the process cwd itself — the composition root resolves the default once
and injects it as `defaultWorkspacePath`. The *client* makes the same call for project-scoped
`mcp.json` (`src/server-client/local-host.ts` is the single judge), because two separate
judgements would eventually disagree: the session in project A, the MCP config read from
somewhere else.

**The workspace path must reach `Scope` as its `cwd`.** `Scope` defaults to the *process's*
current directory, which on a daemon is wherever it happened to be spawned — one missing
argument gives you `@`-completion listing workspace B's files while `exec pwd` and every
relative read/write land in directory A. `AgentPaths.workspacePath` exists for exactly this.

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

### Two rounds, one session: `create` vs `attach`

`session.create` means **a new session** — if the id is already live it refuses
(`session-exists`), so that a client cannot silently take over a turn that is running.
`session.attach` means **that existing session**: live → join it, on disk → reload it from the
archive (`session-missing` if neither). The distinction exists because a session outlives its
clients: closing the terminal only drops the event subscription, while the session (and its
Agent and MCP connections) keeps running. Resuming "the last conversation" therefore arrives at
a *live* id — routing that through `create` is what used to make resume impossible.

`send` has a matching guard: while a turn is in flight, a second `send` is rejected with
`turn-busy`. Events are attributed by reading `session.turnId` **at emit time**, so two
concurrent turns would interleave their deltas under each other's ids.

### Asking the client something: `session.question`

Some decisions belong to the user, not to the server — auto-migration's "who writes the handoff
document" (`self` | `summary` | skip) is the first one. The event is deliberately **generic**:

```
session.question { questionId, kind, input, options?, params, allowSkip, fallback }
session.answer   { questionId, choice: string | null }
```

- `kind` says *what* is being asked; the client looks up its own wording (`kind + option id`)
  and its own picker. Adding a second kind is a client-side table entry, no protocol change.
- `params` carries whatever the client needs to render a title (today `{ promptTokens,
  handoffTokens }`) — a bag, not fixed fields, because the next question will want others.
- `fallback` is **what the server will use when nobody answers** (timeout, no watcher, or a
  client that does not know this `kind`). The asking party supplies it: only it knows which way
  is safe. For handoff-mode it is `null` = *do nothing*: deciding whether to migrate on the
  user's behalf is exactly the kind of overreach this API exists to avoid. (The old CLI
  defaulted to `self` when nobody could be asked; that is gone on purpose — the hard guard
  still interrupts a turn that grows past the limit.)

Three rules make waiting safe, and each has a reason:

- **Nobody watching ⇒ don't ask.** With no event subscribers the question is invisible, so
  `fallback` is returned immediately. Asking a question no one can see only wedges the turn.
- **Register before emitting.** Handlers run synchronously, so a fast client may answer inside
  the same event-loop tick.
- **Wait, but with a deadline** (`askTimeoutMs`, 5 min by default), and **clear the table on all
  three exits** (answered / timed out / released by `releaseQuestions`). "Not in the table" is
  the single test for "this answer came too late".

`releaseQuestions` resolves each pending question with **its own** `fallback` — not with one
shared value: "the turn is over" says nothing about what the user wanted.

### Not archiving is a bug: per-turn persistence

`settleTurn` writes the session to the archive **before** `turn.end`, then emits. The order is
the whole point: once a client sees `turn.end` it treats the turn as finished, so a session
missing from disk at that moment means "quit and come back and nothing happened". This is what
the old `ConversationPersistPlugin` did on every `onInnerLoopEnd`.

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
session (keep-alive applies), `save` / `saveAs` / migration still write to disk when called.

The two flags are deliberately separate things and must not be conflated:

| flag | scope | question it answers |
|---|---|---|
| `persistOnSettle` | one turn | does *this* turn get written (`migrate`'s mid-turn settle says no) |
| `persist` / `autoPersist` | the session | is *this conversation* worth archiving at all |

Archiving a one-off run is an explicit act, and it also must not steal the resume pointer:
`session.save { sessionId, setAsLast?: boolean }` (default `true`, i.e. the TUI's `/save`)
writes the file and leaves `last-session.json` alone when `false`.

### Keep-alive: who decides a session may be dropped

A session outlives its clients, but it must not live forever. Two facts decide it, and both are
required:

> A session stays only while the client **declares** it wants it (`keepAlive`) **and** at least
> one connection is actually watching it (`holders`). Otherwise it is reclaimed after a grace
> period.

- `keepAlive` is a **declaration** sent over the wire (`session.keepAlive.set`) — and a crashed
  process never gets to send it. Used alone, it means a `kill -9`ed client pins its session (and
  the agent plus message history behind it) in memory until the daemon restarts.
- `holders` is what the transport knows for free: `session.create` / `session.attach` register
  the calling connection, and that connection's close removes it. No frame, no client
  cooperation — the kernel guarantees the close (fin/rst on exit, crash or `kill -9`).
- `session.keepAlive.set { sessionId, on }` (idempotent). `on: false` makes the grace period
  **zero**: an idle session is closed immediately; one mid-turn is closed when that turn settles
  (dropping it mid-turn loses the turn's output *and* its archive).
- **New sessions start claimed.** The two mistakes are not equally bad: forgetting to release
  leaks a few megabytes, forgetting to claim drops the session the user is looking at.
- When the last holder of a claimed session goes away, the session gets a grace period
  (`DEFAULT_SESSION_IDLE_TIMEOUT_MS`, 60 s, `--session-idle-timeout`). It must cover the client's
  reconnect budget (~30 s worst case), otherwise a reconnecting client finds the session already
  reclaimed. The deadline **re-checks** the rule, so an `attach` arriving inside the window just
  cancels it, and a turn still running at the deadline defers the close to `turn.end`.
- The flag lives in **server memory**, per session; it is not persisted and not tied to a
  client identity. A TUI keeps exactly one session in it and maintains it automatically at the
  single place where it switches sessions; a future desktop / web shell may expose it as a
  user-managed pin list. Nothing in the server hard-codes "one at a time" — that constraint is
  a property of the TUI's usage, not of the protocol.
- **Closing is cheap and lossless**: the archive was written before `turn.end`, so a closed
  session is re-hydrated by `session.attach` straight from disk.
- `session.list` reports `live` (in server memory right now) — the old `keepAlive` field was the
  client's *declaration*, not a fact, and the list no longer carries it.

### The list is one list: `session.list { workspaceId, includeSaved? }`

A sidebar needs **all** sessions and, for each, whether it is running right now. That used to be
two methods (`session.list` = live sessions with a phase; `session.listSaved` = archived ids
only), so a client had to stitch them together — and could stitch the same session twice.
Now there is one method and one entry per session:

```
{ sessionId, agentId, title?, modelId?, messageCount, updatedAt, live, phase }
```

- **No message bodies.** The store keeps a per-session sidecar (`<id>.meta.json`) with exactly
  these counters, written together with the archive; listing reads the sidecar and never parses
  history. Archives written before the sidecar existed are read once and back-filled.
- **`includeSaved: false`** = live sessions only (no disk read).
- **Order** is `updatedAt` descending, ties broken by id descending — two sessions created in
  the same millisecond must not swap places on every refresh.

### `title` vs `id`

`id` is the identity (archive filename, `session.idChanged`, the resume pointer all point at it).
`title` is the name a human reads; renaming never moves the id. `session.rename { workspaceId,
sessionId, title }` works on archived sessions too (it does not require an `attach` first), and
`session.saveAs` — "save this conversation under another id" — carries the title along.

The same split applies to workspaces (`id` + `title`); `name` is kept for things whose `name`
*is* the identifier (a skill's frontmatter `name`, an `mcp.json` server key, and the SDK's
`AgentDefinition` / `Endpoint` / `Model`, which predate this rule).

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
them that way: `session.subAgent.started` / `.ended` carry a per-turn `index` (the label) and a
stable `subAgentId` (the client's selection key), `message.delta` grows an optional `subAgentId`,
and `session.subAgent.snapshot` returns that sub-agent's own transcript. Two invariants:

- **A sub-agent's deltas never move the main phase.** While a sub-agent runs, the main agent is
  waiting for the delegating tool to return; the phase must stay "waiting for tool X".
- **They only live for the current turn.** The registry is cleared when the turn settles (and on
  `reload` / re-key / close), matching what the client shows: a sub-agent is worth looking at
  while it runs, and its transcript is otherwise history. One exception: the *id* counter is not
  reset, so a client's stale selection can never attach to the next turn's `sub-1`.

### Notices: two channels, on one wire

Events carry **facts, never sentences**, and notices are no exception: a notice is
`{ level, code, params? }` — the client looks up `notice.<code>` in its own i18n table.
Codes are protocol (`SESSION_NOTICE_CODES` / `GLOBAL_NOTICE_CODES`): add new ones, never
repurpose an existing one.

The channel is the **namespace**, not a field:

| Event | Bound to | Rendered where |
|---|---|---|
| `session.notice` | a session (`sessionId` is required) | inside the conversation — disappears when you switch away |
| `global.notice` | nothing | app-level (status bar / banner) — must survive session switches |

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

- **`migrate` changes `sessionId`.** The old id is archived first (before pruning, so the
  full history survives), the handoff round is settled **on the old id**, and only then does
  the live session move to the new key. A client sees `turn.end` for the session it knows,
  and learns the new id from the method result.
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
  prunes, re-keys and then emits `session.idChanged` — that event is the only way a client
  learns about a new id when no request is in flight.
- **Nothing is archived by hooks.** `HandoffService` runs its hooks through `safeHook`,
  which logs and continues — a failed archive inside a hook would let the prune destroy the
  history anyway. Archive / prune / adopt are three ordered statements in
  `SessionManager.migrate()`, each free to fail loudly.
- **Progress is notices, not sentences.** `handoffWriting` / `handoffAutoDetected` /
  `migrationDegraded` / `handoffPath` / `handoffArchived` / `handoffMigrated` +
  `handoffMigratedHint` / `migrationSkipped`. The last three are easy to lose: the old CLI
  produced them as text through `HandoffService.log()`, and a text channel is exactly what
  gets dropped server-side (the server emits no prose).

## Config and agent definitions

`src/protocol/config.ts` is the contract for everything that changes **global** state and
belongs to no session: the config centre (`config.get` / `config.save` /
`config.reasoningPresets`, `config.mcp.get` / `config.mcp.save` scoped `global` | `project`)
and agent definitions (`agent.list` / `get` / `save` / `remove`, next to the older
`agent.model.set`). `ConfigService` wraps the SDK's `ConfigManager` / `AgentRepository`; every
path (`config.json`, `agents/`, `sub-agents/`, `mcp.json`, workspaces root) is injected by the
composition root.

Why this layer exists at all: the config centre used to read and write the **client's** disk.
With both ends on one machine that looks fine and fails silently — the UI reports success
while the server's agents keep using the old model. Three deliberate choices:

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
   terminal helpers belong to the client. `dependencies` holds `@ai-zen/agents-sdk` and
   nothing UI-shaped.
2. **No process-wide globals.** No current working directory, no global config paths, no
   global locale: everything comes in through constructor arguments. The single exception is
   `src/cli.ts` — the composition root — which is *allowed* to read `AI_ZEN_DIR` / `HOME` /
   `argv` and must immediately turn them into injected values.

```bash
grep -rn "process\.cwd()\|AI_ZEN_DIR\|refreshPaths\|setLocale\|getScope" packages/server/src \
  | grep -v "src/cli.ts"    # must be empty
```

That grep *is* the definition of "locally instantiable": any module here can be built in a
test with two or three fakes and nothing else.

## Status

`0.1.0` — extraction in progress.

| Source (CLI) | Here |
|---|---|
| `cli/src/tui/phase.ts` (state machine only) | `src/service/progress/PhaseTracker.ts` |
| `cli/src/session-store.ts` + 旧 `session-pointer.ts` | `src/service/store/` (port + file impl + legacy migration) |
| project paths derived from `cwd` | `src/service/workspace/workspace.ts` |
| `cli/src/agent-creator.ts` (config + Scope + capability discovery) | `src/service/agent/` |
| `cli/src/config.ts` + `cli/src/agents-store.ts` (config / MCP / agent definition I/O) | `src/service/config/` + `src/protocol/config.ts` |
| `cli/src/tui/file-index.ts` (`@` completion, scanning the client's disk) | `src/service/workspace/FileIndex.ts` |
| `cli/src/model-switch.ts` (write `AgentDefinition.modelId` + clear thinking params) | `SessionAgentFactory.setModel` (`agent.model.set`) |
| `cli/src/conversation-persist-plugin.ts` (per-turn autosave) | `SessionManager.settleTurn` + `writeSession` |
| `cli/src/auto-migrate-confirm.ts` (the three-way picker's server half) | `SessionManager.askQuestion` (`session.question` / `session.answer`) |
| — | `session.keepAlive.set` / `session.close` / `session.setAgent`, the keep-alive + holder reclaimer (`SessionManager.scheduleReclaim`) |
| `cli/src/sub-agent-guard-plugin.ts` | `sdk/src/agent-plugins/SubAgentGuardInstallerPlugin.ts` |
| `cli/src/handoff-service.ts` (the hooks around the SDK's handoff flow) | `src/service/handoff/` |
| — | `src/protocol/` frames, message and session shapes |
| — | `src/daemon/` listener, handshake, discovery file, session handlers |
| — | `src/service/session/SessionManager.ts` (live sessions + event fan-out) |

Text/formatting stays client-side on purpose: this layer emits facts
(`{ kind, tools }`), not sentences.
