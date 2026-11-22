# Changelog

All notable changes to `@ai-zen/agents-host` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions use SemVer.

## [0.1.0-alpha.8] - 2026-11-16

> Follows `@ai-zen/agents-core` 5.0.0-alpha.0. The host had grown a whole notion of "a segment" —
> a four-state run status, a send status, a delivery receipt that said whether the agent had been
> woken, and a rule that the database was flushed only once a segment settled. The engine never had
> that notion; it was invented here to cover for the fact that the host was waiting on a promise.

### Changed

- Persistence follows message events now: `messageAdded` / `messageChanged` / `messageRemoved`,
  one row at a time. Whoever pushed a message no longer matters — the row appears when the message
  appears. "Flush once the segment settles" is gone.
- UI state derives from the engine's three cells plus lifecycle events, not from a host-side run status.
- Context overflow is recognised from `denied` (structured `detail`), not from an exception name.
- The pending queue is read live from `inboxPending` instead of being mirrored from notifications:
  the engine emits nothing when an entry is taken, and a key is taken silently, so a mirror could
  diverge permanently and could never re-read itself back into agreement.
- Tools refresh on `onOuterLoopStart`; migration runs on `onIdle`.
- `source` on messages is a discriminated object; stored as JSON in a new `TEXT` column, with old
  string values upgraded on read.

### Removed

- `DeliveryReceipt` / `woke`, `RunStatus` four states, `SendStatus`, `ChatAgent` (the local duck-type
  shim that hid the engine's real surface from the type checker).

### Fixed

- Agents are actually killed when they should be: conversation deleted → `kill`; scope disposed →
  `killScope`; process shutdown → `disposeAll`. Previously they were only dereferenced, so a paused
  agent lived until the process died.
- The hidden cwd message injected at the start of a conversation now carries `source`.

## [0.1.0-alpha.7] - 2026-11-14

> Sub-agent output now crosses the wire. A delegated sub-agent runs inside its own `Agent` in this
> process; the host only ever told clients "it started" and "it ended". Everything the sub-agent
> said stayed in memory and was written to the database once, at the end — so a client watching
> the run got **not one character** until the sub-agent had already finished.
>
> The old in-process CLI did not have this problem: it held the sub-agent instance and subscribed
> to its own `chunk-parsed`. That is exactly what this release restores, one process boundary
> further out.

### Added

- **`message.delta` carries `toolCallId`** when the delta belongs to a sub-agent (`MessageDeltaPayload.toolCallId`,
  absent = main line). Clients route it to that sub-agent's own view instead of the main transcript.
- **Sub-agent messages are written while they stream** (same `streamWriteIntervalMs` cadence as the
  main line), so `message.list { toolCallId }` has content during the run and a mid-run crash no
  longer loses the whole thing.
- **`SubAgentSnapshot.messageCount` is live** — it now counts the sub-agent's messages as they
  appear instead of only at the end.

### 🐛 Fixed

- Sub-agent messages get their id **the first time the host sees them**, and the final row reuses
  it. Previously the id was assigned at persist time, so a streamed delta and the stored row would
  have been two different ids — a client would have shown every sub-agent message twice after a
  reload.

## [0.1.0-alpha.6] - 2026-11-14

> The status bar's blocks move to the client — the third and last step of "界面归界面，事实归宿主".
> alpha.5 still shipped `conversation.state.statusBlocks`, an assembled copy of eight facts. That
> copy was only true at the instant `conversation.state` was pulled, and a client only pulls it when
> it opens a conversation (or changes model, or reloads). So the context percentage, the model
> name, this turn's token count and the "tools running" indicator **stayed frozen at whatever they
> were when the conversation was opened** — for the whole session.
>
> Not a missing refresh: the same facts existed twice. Every one of them was already on the wire
> individually and already kept live by the client.

### ⚠️ Breaking

- **`conversation.state.statusBlocks` removed**, with `StatusBlock` / `StatusBlockId` /
  `STATUS_BLOCK_IDS` / `statusBlocksOf` / `StatusBlockInput`. The eight blocks need facts that
  already have a home in the contract: agent + model + thinking + folder in `ConversationView`,
  context + thinking + usage in `ConversationState`, tools + sub-agents in `run`.
- **`ConversationView` gains `agent: { agentId, name, available }`** — the two facts a client
  cannot derive (the name lives in the agent definition; "available" needs the model / endpoint /
  key check). `available` is still decided by `AgentService.describe`; `ConversationService` asks
  for the conclusion through a `describeAgent` port rather than reimplementing the check.

### 🐛 Fixed

- A client that never re-pulls state now sees live facts, because there is no second copy to go
  stale. The agent block degrades honestly: with the definition gone, `name` / `available` are
  `null` (say "unknown", do not invent a value).

## [0.1.0-alpha.5] - 2026-11-14

> The capability list is gone. `host.capabilities` existed to tell clients "what this build can
> do", but the only client that ever read it was the TUI's `/help` — and `/help` already had a
> local command table. A list that duplicates a list is a list that drifts: the host called it
> "项目", the CLI called it "工作区". So the method, its 252 copy entries and the `CapabilityView`
> shape are removed — **63 → 62 methods** — and the CLI's `/help` now costs zero round trips.
>
> `0.1.0-alpha.4` was published minutes earlier with the identical runtime code but with doc
> comments that still pointed at the removed method (they land in `dist/*.d.ts`, so they are part
> of what you read). Use **alpha.5**.
>
> Ships on `@ai-zen/agents-core@4.6.0-alpha.0` + `@ai-zen/agents-sdk@1.2.0-alpha.2` (both
> unchanged since the previous alpha, so this release is host-only).

### ⚠️ Breaking

- **`host.capabilities` removed** (63 → 62 methods), together with `hello.capabilities`,
  `CapabilityView` / `HostCapabilitiesResult` / `MethodDomain`, the `handlers/capabilities.ts`
  wiring and 252 `capability.*` strings. Nothing depended on it: the CLI's `/help` is local
  now, the Desktop never called it.
- **`host.reload` no longer takes `scope`** — the host is the only one who knows what is
  reloadable, so it decides; `reloadedOf()` is unconditionally `true`.
- **`StatusBlock.label` removed** — block names are client concepts ("sidebar" is not a host
  word). The CLI carries its own eight `status.block.*` strings.

### 🧹 Changed

- **i18n now has a consumer rule**: the 33 entries no production code ever emitted are deleted,
  and a guard test fails the suite if any entry has no reader. PLAN.md §7.5 keeps the 19 cases
  where the host *should* say something and currently says nothing — those are gaps, not strings.
- 4 exports with zero references removed, along with the long-dead `localizeCapabilities`.
- **Doc comments that still described the deleted capability list are gone** — six of them, two
  of which had drifted onto the *next* field and read as if they documented `defaultLanguage` /
  `requestStop`.
- The two real-process cases moved to `test:e2e` (out of the default suite's 759); test fixtures
  went "one file, one database" with one `db.tx()` table wipe.

## [0.1.0-alpha.1 … 0.1.0-alpha.3] - 2026-11-14

- **`agents-host` bin got its shebang** (alpha.1) — without it `npm i -g` installed a file the
  shell refuses to execute.
- **A configuration file that does not parse is reset to factory values** and written back, the
  broken one kept as `<name>.broken`, plus one warning notice naming the file (D32;
  alpha.2 / alpha.3). No fallback layers, no throwing upwards.

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
