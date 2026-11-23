---
title: AI-Zen Agents
description: The front door of AI-Zen Agents — the four layers (kernel, capability face and runtime, host, client), the test the layering is judged by, the packages in this repository, and where to read from here.
outline: deep
---

# AI-Zen Agents

A self-hosted agent runtime. An agent here is an object inside a process, with an inbox and two loops; everything else in the repository either gives it capabilities, keeps it alive and reachable, or writes down what it did.

## The four layers

```
terminal client · desktop                 each in its own repository, each bundling
        │                                @ai-zen/agents-client into its own build
        │  one WebSocket; tRPC runs on it, an event stream comes back
        ▼
@ai-zen/agents-host      session rows and messages, workspaces, connections and credentials,
        │                notices, assets, questions, search, user-facing copy
        │  procedures in, events out
        ▼
@ai-zen/agents-sdk       capability face: Scope, built-in tools, skills, SubAgents, MCP, PeerSessions.
        │                runtime: wake an Agent, keep the register of what is alive, post to another session, dispose containers
        ▼
@ai-zen/agents-core      one Agent: the inbox, the outer loop, the inner loop, isInputPaused and isOutputPaused,
                         event names, plugin hooks
```

Every layer can be swapped out whole from the top down: the client can become a script, the host can become an empty implementation, and the behaviour of the layers below changes not a line. The client is not in this repository: the terminal client and the desktop app live in their own repositories, and this one only provides the layer they inline, `@ai-zen/agents-client`.

Only the host has a contract surface, and it has two halves. One is the procedures grouped by domain, where the first segment says what the path touches: `runtime.agent.*` and `runtime.scope.*` touch live objects inside the process; `config.*` needs nothing but a configuration file (`config.endpoints.*`, `config.models.*`, `config.imageModels.*`, `config.presets.update`, `config.agents.*`, `config.mcp.*`); the rest are business domains reading and writing their own things — `session.*`, `workspace.*`, `asset.*`, `notice.*`, `question.*`, `handoff.*`, `search.*`, plus `host.*` for the process itself and `events` for the one stream. The other half is a subscription: every fact the host produces travels through it, so a client never has to ask whether anything changed.

## The test the layering is judged by

Without the host, using only `@ai-zen/agents-core` and `@ai-zen/agents-sdk`, it is still possible to assemble an agent that is event driven, resident, and able to talk to another one: once a session is woken, taking `InboxEntry`s, running and going back to idle needs nobody waiting on the call stack; another session can send to it. That is the one test the layering has to pass.

If a piece of code exists only because the host happens to be there — who is alive, when a `Scope` is disposed, what a session is called — the answer is to move it into the runtime, not to open a second road inside the host.

## The packages in this repository

| Package | What it does | What it does not do |
|---|---|---|
| `@ai-zen/agents-core` | runs one `Agent`: the inbox, the outer loop that takes batch by batch, the inner loop that makes requests and runs tools, the `isInputPaused` / `isOutputPaused` cells with their methods and live reads, event names, plugin hooks | knows nothing of sessions and workspaces, touches no database or persistence of any kind, no network or credentials, no language or copy, reads no configuration file, does no capability discovery |
| `@ai-zen/agents-sdk` | two halves. Capability face: a `Scope` per directory, holding tools, skills, `SubAgent`s, MCP servers and the three `PeerSession` tools; three-level model resolution; handoff. Runtime: wakes an `Agent` from the `WakeMaterials` handed up, keeps the register of what is alive, `post()` to another session, disposes a container when its last session is gone | touches no database, no connections or credentials, no session rows, produces no user-facing copy; a session is an opaque identity to it |
| `@ai-zen/agents-host` | rows and tables in one SQLite file, connections and credentials, client odds and ends (notices, assets, questions, search), user-facing copy and language, the single-instance discovery file, the command line | does not build `Agent`s, does not track what is alive, does not decide when a `Scope` is disposed, does not judge whether the configuration is valid, does not compute the MCP merge, does not manage connecting or reconnecting |
| `@ai-zen/agents-client` | the connection to a host: launching one, reading the discovery file and the credential delivery file, where credentials come from, reconnecting | never published (`private: true`, bundled by the terminal and the desktop into their own builds); never imported by `core` or `sdk` |
| `@ai-zen/agents-logger` | one log file per process, zero dependencies; `info` / `warn` / `error` out of one door | is not created outside the assembly root |
| `@ai-zen/agents-testing` | test fixtures shared by several packages, re-exporting `@ai-zen/fake-llm` so call sites import one thing | never enters the production dependency graph |
| `@ai-zen/fake-llm` | an OpenAI-compatible fake endpoint: hand it one target message and it streams back the delta sequence that message would have arrived as | connects to no real provider, and has no opinion about what the model should answer |

## Where to read from here

| Page | What it covers |
|---|---|
| [Getting Started](getting-started.md) | from zero: install, run the tests, bring up a host, get a credential, connect a client — and the road that uses only `core` and `sdk` |
| [Architecture](architecture.md) | why the cut is where it is: the four layering tests, the four questions for live objects, the direction of facts and materials, where events and persistence land |
| [Core API](core.md) | the kernel: one `Agent`'s inbox, the two loops, the two switches, event names, plugin hooks |
| [SDK](sdk.md) | the capability face and the runtime: `Scope`, model resolution, handoff, waking and posting |
| [Core and Scope alone](scope.md) | no `AgentRuntime`, no host: how the capability layer is used on its own |
| [MCP](mcp.md) | where server configuration comes from, how a connection is made, how tools reach the model |

## License

MIT.
