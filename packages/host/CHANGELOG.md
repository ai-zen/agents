# Changelog

All notable changes to `@ai-zen/agents-host` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions use SemVer.

## [0.2.0-alpha.1] - 2026-11-23

> Not `0.1.0-alpha.9`: `0.1.0` is already published, and every `0.1.0-alpha.*` sorts below it, so
> another alpha in that line would be a step backwards. The minor is bumped instead.
>
> The host became a thin shell. `0.1.0` shipped it as the place where a session's behaviour was
> decided: it framed its own protocol on the socket, kept a six-state phase machine for the UI, and
> held every answer the engine could not give. Installing a live agent, keeping the register of who
> is alive, mirroring their state and deciding when a container is torn down all moved one layer
> down into `@ai-zen/agents-sdk`. What is left here is storage, connections, credentials and the
> client's odds and ends — the host now hands the runtime four ports (how to build a container, how
> to open a session row, what a session is called right now, where to log) and otherwise only reads
> and writes files, tables and events.

### Added

- **Three orthogonal calls.** `session.create` writes the row and does nothing else — no agent is
  woken and nothing is delivered. `agent.wake` fills the one cell "the row exists, its agent does
  not", and is a no-op when an agent is already alive, because rebuilding would swap out a session
  that is working. `agent.send` delivers only to an agent that is alive and answers `not_found`
  otherwise: a delivery neither creates a session nor revives one, and "wake first, then send" is
  the client's orchestration rather than a fallback here.
- **`handoff.start` takes a `kind`**: `document` writes the document and changes nothing else about
  the session (a notice carrying the path is all that appears), while `swap` then replaces the
  memory and leaves the old one as an ordinary session beside it. `mode` (`self` / `summary`) stays
  the caller's explicit choice, and omitting `kind` behaves like `swap`, which is what this call did
  before the field existed. `handoff.cancel` closes the output gate and does not reopen it — a
  cancelled handoff leaves the session exactly where it was until the user resumes it.
- **`scope.reload`** — re-read the configuration into every container that already exists, which is
  what "a change takes effect without killing a session" needs behind it.
- **`config.setGlobal`** carries the language and the auto-naming switch (`autoTitle`), so both are
  patched as configuration of the whole process rather than per-connection state. The host has one
  language, read from the live configuration; a connection does not carry one, so reconnecting
  cannot change what the host says.
- **`session.removed`** as a fact of its own, beside `session.changed`: the client that asked for
  the deletion switches screens by itself, and every other connected client learns that the row is
  gone instead of inferring it from a list.
- **One thing per call.** `notice.clearOne` clears one notice by id beside `notice.clear` for a
  scope; `host.shutdown` stops the process, and asking "are you sure" is the client's step, since
  only the client knows what the user is doing.
- **Client odds and ends, each in its own domain**: `question.list` / `question.answer` for the one
  blocking question a session may be waiting on, `notice` with a scope and a level, `asset.upload` /
  `asset.get` / `asset.list` for uploaded files, and `search.messages` / `search.sessions`. Each is
  answered from the host, and none of them is a mirror of something the client already holds.

### Changed

- **The contract surface is a tRPC router** served over one WebSocket, grouped by domain with each
  procedure declaring its own input and output: `session` (`list` `create` `open` `rename` `pin`
  `setAutoHandoff` `setThresholds` `setModel` `setThinkingLevel` `rewind` `remove` `transient`),
  `agent` (`wake` `send` `pause` `resume` `abort` `kill` `clearInbox`), `workspace`, `asset`,
  `notice`, `question`, `handoff`, `search`, `scope`, `config`, `mcp`, `agentDefinition`, `host`,
  and one `events` subscription. The hand-rolled JSON-lines framing, the mandatory `hello`
  handshake and the six-state generation phase machine are gone with it: the phase was a client
  concept assembled on the host, and a fact that the client can build out of `agent.status` and the
  tool events does not need a second home.
- **The session row carries identity and nothing else** — its id, name and whether that name was
  automatic, pinned, project, agent, model, thinking level, the two thresholds, the auto-handoff
  switch, lineage and the two timestamps. Working / idle, the two gates and "is there an agent at
  all" are read from the live object and pushed as events; none of them is a column, so none of them
  can go stale while a client is not polling.
- **A credential is required on every connection, hashed in the database, and checked in the
  handshake** (`connectionParams` as `{ token }`), never in a query string. A connection that fails
  the check reaches no procedure and is closed. Revoking affects later connections only. A local
  instance writes one usable credential to `run/token` so a client on the same machine can connect;
  a public instance does not. The command line gains `token create` / `token list` /
  `token revoke`, which open the database, do their work and close it without starting a service.
- **Failures that cross the wire are a `HostError` with one of eight codes** — `not_found`,
  `invalid_params`, `conflict`, `busy`, `unsupported`, `config_invalid`, `not_available`,
  `unauthorized` — carried beside the rendered message and its `details`, so a client branches on a
  code instead of on a sentence.

### Fixed

- **A refusal at the hard line now says so inside the session.** The guard refuses with one English
  sentence written for the model and the log, which left the session visibly doing nothing with
  nothing on screen explaining why. `GuardNoticePlugin` extends that guard without rewriting a line
  of its judgement and pushes one session-scoped notice (`code: "guard_blocked"`) carrying the
  numbers; a repeat with the same numbers is not repeated, and a permitted request forgets it.
- **Agents are killed when they should be**: deleting a session kills its agent before the row goes,
  disposing a container kills the sessions living on it, and shutting down kills everything before
  any container is torn down. Nothing upstream ends an agent on the host's behalf — a paused one has
  no timer and no reference count behind it — so each of those three has to do the killing itself.

### Renamed

- **The contract surface says what each path touches.** `agent.*` and `scope.*` became
  `runtime.agent.*` and `runtime.scope.*` — those need a live object; `config.agents.*` and
  `config.mcp.*` moved under `config.` — those need nothing but a configuration file; the rest are
  business domains reading and writing their own rows. Verbs settled on `create` / `update` /
  `delete` (`add`, `remove`, `save`, `clear`, `clearOne`, `setDefaults`, `setGlobal` and the
  `setModel` family are gone), and `agent.pause` / `resume` became `pauseOutput` / `resumeOutput`
  so the path names which of the two switches it moves.
- **`session.transient` → `runtime.agent.runOnce`.** That path builds no session row and no
  workspace row; it assembles a one-shot agent in a directory and runs it once. It belongs with the
  live objects, not with the session rows.
- Row types carry `Record` (`SessionRecord`, `WorkspaceRecord`, `AssetRecord`, `NoticeRecord`),
  configuration entries carry `Definition`, and the private helper that persists before enqueueing
  is called `send()` like its two neighbours.

## [0.1.0] - 2026-11-09

First extraction step. The package exists so that CLI and Desktop stop maintaining two
parallel implementations of the same session logic.

### Added

- Package skeleton (`@ai-zen/agents-host`): builds to `dist` with declarations, unit tests
  run with **isolation on** (an intentionally stricter default than `agents-sdk`, so that a
  hidden global fails loudly instead of being masked by leftover state).
- `service/progress/PhaseTracker` — the six-state generation phase machine
  (`connecting` / `queued` / `thinking` / `tool-calling` / `tool-waiting` / `streaming`) and
  `pendingToolCalls()`, moved out of the CLI.
- `protocol/` — transport-agnostic JSON-lines framing (`FrameDecoder` with a hard 8 MiB frame
  cap) and the single source of truth for wire shapes: a mandatory `hello` handshake carrying
  `protocol`, request/response frames with per-direction id spaces, and unsolicited events.
- `daemon/` — a resident listener bound to loopback, a mandatory handshake, and a discovery
  file (`<aiZenDir>/run/host.json`) carrying `pid` / `version` / `protocol` so clients can
  distinguish "crashed leftover" from "a different build is running" before connecting.
- `agents-host` bin: `serve` (default) / `status` / `stop`, single-instance protection, logs
  appended to `<aiZenDir>/logs/host.log`.

### Design notes

- **No authentication in this version, therefore loopback only.** `Daemon.start()` throws on
  any non-loopback host. The service can execute shell commands; an unauthenticated listener
  reachable from the network hands a shell to the LAN. The handshake exists anyway (and is
  mandatory) so that adding tokens/keys later touches the handshake payload only, not every
  client's connection logic.
- **No i18n here.** The phase machine emits facts (`{ kind, tools }`); turning them into
  "Waiting for edit, exec…" stays in the client.
- **No process-wide state.** Everything is constructor-injected; the only file allowed to read
  `AI_ZEN_DIR` / `HOME` is the `cli.ts` composition root, which immediately turns them into
  values.
