# Changelog

All notable changes to `@ai-zen/agents-host` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions use SemVer.

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
