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

Binary payloads (images, oversized tool output) are meant to travel through an
`artifact.*` method pair rather than being inlined into text frames.

Built-in methods: `ping`, `status`, `shutdown`. Everything else is injected by the
composition root through `DaemonOptions.handlers`, so the daemon skeleton stays free of
business logic.

## Session layer

`src/protocol/sessions.ts` is the wire contract for sessions — method names, params and the
three session events (`session.phase`, `message.delta`, `turn.end`). `src/service/session/
SessionManager.ts` implements the live-session registry and the SDK-event → protocol-event
translation; `src/service/agent/` assembles the agent (config + Scope + capability
discovery) per workspace; `src/daemon/sessionHandlers.ts` registers `workspace.resolve` /
`events.watch` / `session.create` / `session.send` / `session.cancel` / `session.list` /
`session.handoff` / `session.migrate` on a `Daemon`, and `src/cli.ts` wires all of it.

Agent assembly is **per workspace**: one Scope (one set of MCP connections and tool
discovery) is shared by every session in the same workspace, and never shared across
workspaces — project-level skills / tools / mcp hang off the workspace path.

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
- **Nothing is archived by hooks.** `HandoffService` runs its hooks through `safeHook`,
  which logs and continues — a failed archive inside a hook would let the prune destroy the
  history anyway. Archive / prune / adopt are three ordered statements in
  `SessionManager.migrate()`, each free to fail loudly.

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
| `cli/src/handoff-service.ts` (the hooks around the SDK's handoff flow) | `src/service/handoff/` |
| — | `src/protocol/` frames, message and session shapes |
| — | `src/daemon/` listener, handshake, discovery file, session handlers |
| — | `src/service/session/SessionManager.ts` (live sessions + event fan-out) |

Text/formatting stays client-side on purpose: this layer emits facts
(`{ kind, tools }`), not sentences.
