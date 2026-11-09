# Changelog

All notable changes to `@ai-zen/agents-server` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions use SemVer.

## [0.1.0] - 2026-11-09

First extraction step. The package exists so that CLI and Desktop stop maintaining two
parallel implementations of the same session logic.

### Added

- Package skeleton (`@ai-zen/agents-server`): builds to `dist` with declarations, unit tests
  run with **isolation on** (an intentionally stricter default than `agents-sdk`, so that a
  hidden global fails loudly instead of being masked by leftover state).
- `service/progress/PhaseTracker` — the six-state generation phase machine
  (`connecting` / `queued` / `thinking` / `tool-calling` / `tool-waiting` / `streaming`) and
  `pendingToolCalls()`, moved out of the CLI.
- `protocol/` — transport-agnostic JSON-lines framing (`FrameDecoder` with a hard 8 MiB frame
  cap) and the single source of truth for wire shapes: a mandatory `hello` handshake carrying
  `protocol`, request/response frames with per-direction id spaces, and unsolicited events.
- `daemon/` — a resident listener bound to loopback, a mandatory handshake, and a discovery
  file (`<aiZenDir>/run/server.json`) carrying `pid` / `version` / `protocol` so clients can
  distinguish "crashed leftover" from "a different build is running" before connecting.
- `agents-server` bin: `serve` (default) / `status` / `stop`, single-instance protection, logs
  appended to `<aiZenDir>/logs/server.log`.

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
