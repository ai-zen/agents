---
title: AI-Zen Agents
description: The front page of AI-Zen Agents — the four layers (kernel, capability face and runtime, host, clients), the criterion the split is judged by, the packages in this repository, and where to read next.
outline: deep
---

# AI-Zen Agents

A self-hosted runtime for LLM agents. An agent here is a process-local object with an inbox and two
loops; everything else in this repository either gives that object abilities, keeps it alive and
reachable, or writes down what it did.

## The four layers

```
terminal client · desktop app                    separate repositories, each inlines
        │                                        @ai-zen/agents-client
        │  one WebSocket; tRPC over it, one event stream back
        ▼
@ai-zen/agents-host      session rows and messages, workspaces, connections and credentials,
        │                notices, assets, questions, search, user-visible text
        │  procedures in, events out
        ▼
@ai-zen/agents-sdk       capability surface: scope, built-in tools, skills, subagents, MCP,
        │                peer sessions. Runtime: wake an agent, keep the register of what is
        │                alive, post between sessions, dispose a scope
        ▼
@ai-zen/agents-core      one agent: inbox, outer loop, inner loop, an input gate and an output
                         gate, event names, plugin hooks
```

Each layer can be replaced as a whole from the top down: a client can be replaced by a script, the
host can be replaced by an empty implementation, and the layers below keep behaving the same. The
clients are not in this repository — the terminal client and the desktop app live in their own
repositories and embed `@ai-zen/agents-client`, which is the only piece of them that lives here.

Only the host has a contract surface, and it has two halves. The first half is procedures grouped by
domain: `session.*` for the rows, `agent.*` for what the live object does, `workspace.*`, `asset.*`,
`notice.*`, `question.*`, `handoff.*`, `search.*`, `scope.*`, `config.*`, `mcp.*`,
`agentDefinition.*`, `host.*`. The second half is one subscription that carries every fact the host
publishes, so a client never polls for a change it was not told about.

## The criterion the layering is judged by

Without the host, `@ai-zen/agents-core` plus `@ai-zen/agents-sdk` alone can assemble agents that are
event-driven, resident, and able to talk to each other: one is woken from materials handed to it, then
takes entries from its inbox and runs with nobody waiting on the call, goes back to idle, and another
session can post to it. This is the one test the split has to pass.

When a piece of code only exists because the host happens to be there — who is alive, when a
capability container is torn down, what a session is called — the fix is to move it down into the
runtime, not to add a second path in the host.

## Packages

| Package | Does | Does not |
|---|---|---|
| `@ai-zen/agents-core` | Runs one agent: the inbox, the outer loop that takes entries in batches, the inner loop that sends a request and runs tools, the input and output gates with their switches and readers, the event names, the plugin hooks | Know about sessions, workspaces, storage, network, credentials, language, config files, or capability discovery |
| `@ai-zen/agents-sdk` | Two halves. Capability surface: a scope per directory holding tools, skills, subagents, MCP servers and the three peer-session tools; three-level model resolution; handoff. Runtime: wake an agent from stored materials, keep the register of who is alive, post a message to another session, dispose a scope when its last session ends | Touch a database, a connection, a credential, a session row, or a user-visible string; it knows a session only as an opaque identity |
| `@ai-zen/agents-host` | Rows and tables in one SQLite file, connections and credentials, client odds and ends (notices, assets, questions, search), user-visible text and language, the single-instance discovery file, the command line | Install an agent, keep the register of who is alive, decide when a scope is disposed, judge whether a config is valid, merge MCP configuration, or manage connecting and reconnecting |
| `@ai-zen/agents-client` | The connection to a host: launching one, reading the discovery and credential files, credentials, reconnect | Be published (`private: true`, inlined into the terminal and desktop builds); be imported by `core` or `sdk` |
| `@ai-zen/agents-logger` | One process, one log file, zero dependencies; `info` / `warn` / `error` behind one port | Be constructed anywhere except the assembly root |
| `@ai-zen/agents-testing` | Test doubles shared by the packages, re-exporting `@ai-zen/fake-llm` so call sites keep one import | Enter a production dependency graph |
| `@ai-zen/fake-llm` | An OpenAI-compatible fake endpoint: hand it one target message and it streams back the delta sequence that message would have arrived as | Reach a real provider, or hold any opinion about what a model should answer |

## Reading from here

| Page | Holds |
|---|---|
| [Getting Started](getting-started.md) | From zero: install, test, start a host, mint a credential, connect a client, and a minimal agent that never touches the host |
| [Architecture](architecture.md) | Why the split is where it is: the criteria for the four layers, the four questions and five criteria for live objects, which direction facts and materials travel, and where events and persistence land |
| [Core API](core.md) | The kernel: one agent's inbox, its two loops, its two gates, the event names, the plugin hooks |
| [SDK](sdk.md) | The capability face and the runtime: scopes, model resolution, handoff, waking an agent, posting to another session |

## License

MIT.
