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
| — | `src/protocol/` frames + message shapes |
| — | `src/daemon/` listener, handshake, discovery file |

Text/formatting stays client-side on purpose: this layer emits facts
(`{ kind, tools }`), not sentences.
