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

### Design notes

- **No i18n here.** The machine emits facts (`{ kind, tools }`); turning them into
  "Waiting for edit, exec…" stays in the client. Same rule as
  `conversation-commands/registry.ts` storing `descriptionKey` instead of text.
- **No process-wide state.** Constructible with nothing but arguments, so tests need no
  temp `AI_ZEN_DIR`, no `refreshPaths()`, no `setLocale()`.
