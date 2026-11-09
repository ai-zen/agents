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

## Two hard constraints (machine-checkable)

1. **No UI stack here.** The package boundary is the process boundary — `ink`, `react` and
   terminal helpers belong to the client. `dependencies` in `package.json` should hold
   `@ai-zen/agents-sdk` and nothing UI-shaped.
2. **No process-wide globals.** No `process.cwd()`, no global config paths, no global
   locale: everything comes in through constructor arguments.

```bash
grep -rn "process\.cwd()\|AI_ZEN_DIR\|refreshPaths\|setLocale\|getScope" packages/server/src
# must be empty
```

That second grep *is* the definition of "locally instantiable": any module in this package
can be built in a test with two or three fakes and nothing else.

## Status

`0.1.0` — extraction in progress. What has moved so far:

| Source (CLI) | Here |
|---|---|
| `cli/src/tui/phase.ts` (state machine only) | `src/service/progress/PhaseTracker.ts` |

Text/formatting stays client-side on purpose: this layer emits facts
(`{ kind, tools }`), not sentences.
