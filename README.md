# AI-Zen Agents

## What it is

A self-hosted runtime for LLM agents. An agent here is a process-local object with an inbox and two
loops; everything else in this repository either gives that object abilities, keeps it alive and
reachable, or writes down what it did.

Four layers, and each one can be deleted from the top down: a client can be replaced by a script, the
host can be replaced by an empty implementation, and the layers below keep behaving the same.

## How to use

Build it and run the suite:

```bash
pnpm install
pnpm test
```

`pnpm test` builds `testing`, `logger`, `host` and `client` first, then runs each package's suite in
turn. A single package is tested from its own directory, where `npm test` runs the type check and then
the suite. The end-to-end suite stays out of `npm test` and is run by hand:

```bash
cd packages/host
npm run pretest                                 # tsc --noEmit -p tsconfig.test.json
npx vitest run                                  # domain tests: no ports, no real disk
npx vitest run --config vitest.e2e.config.ts    # a real host: real port, real disk, real WebSocket
```

Run a host:

```bash
pnpm build-host
node packages/host/dist/cli.js serve            # 127.0.0.1:8790 by default
node packages/host/dist/cli.js token create     # a credential for a client on another machine
```

Installed, the same entry point is the `agents-host` bin, so the commands read `agents-host serve`,
`agents-host stop`, `agents-host token create`, `agents-host token list`, `agents-host token revoke`.
A host keeps its database, config, assets and run files under one data root — `AI_ZEN_DIR`, default
`~/.ai-zen` — and writes `run/host.json`, `run/token` and `run/next-version.json` there. The listening
address rules, the credential file and the contract surface are in
[`packages/host/README.md`](packages/host/README.md).

Build an agent without any of that:

```ts
import { ConfigManager, DEFAULT_AGENT_ID, Scope, allInOne, createAgent } from "@ai-zen/agents-sdk";

const config = new ConfigManager(`${base}/config.json`);
await config.bootstrap();          // config.json, a default agent, factory skills
// …fill in the endpoint and the key, then:
const scope = new Scope({ getConfig: () => config.read(), agentsDir: `${base}/agents`, cwd: base })
  .use(...allInOne({}));
await scope.init();
const agent = await createAgent(scope, DEFAULT_AGENT_ID, { lifetime: "one-shot" });
console.log((await agent.runOnce({ content: "hi", priority: "low", source: { kind: "user" } })).at(-1)?.content);
```

That is the criterion below, exercised: no host in sight. The full version, with the three traps that
catch people, is in [`packages/sdk/README.md`](packages/sdk/README.md).

No user interface ships here. The terminal client and the desktop app live in their own repositories
and embed `@ai-zen/agents-client`, which owns the connection: find a host or launch one, read the
credential, keep the WebSocket alive across a restart of either side. Their own state — screens, key
bindings, what to do when a session has no live agent — stays on their side of the wire.

## How it is put together

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

Only the host has a contract surface, and it has two halves. The first half is procedures grouped by
domain: `session.*` for the rows, `agent.*` for what the live object does, `workspace.*`, `asset.*`,
`notice.*`, `question.*`, `handoff.*`, `search.*`, `scope.*`, `config.*`, `mcp.*`,
`agentDefinition.*`, `host.*`. The second half is one subscription that carries every fact the host
publishes, so a client never polls for a change it was not told about.

### The criterion the layering is judged by

Without the host, `@ai-zen/agents-core` plus `@ai-zen/agents-sdk` alone can assemble agents that are
event-driven, resident, and able to talk to each other: one is woken from materials handed to it,
then takes entries from its inbox and runs with nobody waiting on the call, goes back to idle, and
another session can post to it. This is the one test the split has to pass. When a piece of code only
exists because the host happens to be there — who is alive, when an ability container is torn down,
what a session is called — the fix is to move it down into the runtime, not to add a second path in
the host.

### Packages

| Package | Does | Does not |
|---|---|---|
| `@ai-zen/agents-core` | Runs one agent: the inbox, the outer loop that takes entries in batches, the inner loop that sends a request and runs tools, the input and output gates with their switches and readers, the event names, the plugin hooks | Know about sessions, workspaces, storage, network, credentials, language, config files, or capability discovery |
| `@ai-zen/agents-sdk` | Two halves. Capability surface: a scope per directory holding tools, skills, subagents, MCP servers and the three peer-session tools; three-level model resolution; handoff. Runtime: wake an agent from stored materials, keep the register of who is alive, post a message to another session, dispose a scope when its last session ends | Touch a database, a connection, a credential, a session row, or a user-visible string; it knows a session only as an opaque identity |
| `@ai-zen/agents-host` | Rows and tables in one SQLite file, connections and credentials, client odds and ends (notices, assets, questions, search), user-visible text and language, the single-instance discovery file, the command line | Install an agent, keep the register of who is alive, decide when a scope is disposed, judge whether a config is valid, merge MCP configuration, or manage connecting and reconnecting |
| `@ai-zen/agents-client` | The connection to a host: launching one, reading the discovery and credential files, credentials, reconnect | Be published (`private: true`, inlined into the terminal and desktop builds); be imported by `core` or `sdk` |
| `@ai-zen/agents-logger` | One process, one log file, zero dependencies; `info` / `warn` / `error` behind one port | Be constructed anywhere except the assembly root |
| `@ai-zen/agents-testing` | Test doubles shared by the packages, re-exporting `@ai-zen/fake-llm` so call sites keep one import | Enter a production dependency graph |
| `@ai-zen/fake-llm` | An OpenAI-compatible fake endpoint: hand it one target message and it streams back the delta sequence that message would have arrived as | Reach a real provider, or hold any opinion about what a model should answer |

## Details

### Package builds

Wired at the root: `pnpm build-core`, `pnpm build-sdk`, `pnpm build-host`, `pnpm build-client`,
`pnpm build-logger`, `pnpm build-testing`.

### Repository layout

```
agents/
├── packages/
│   ├── core/          @ai-zen/agents-core
│   ├── sdk/           @ai-zen/agents-sdk
│   ├── host/          @ai-zen/agents-host
│   ├── client/        @ai-zen/agents-client
│   ├── logger/        @ai-zen/agents-logger
│   ├── testing/       @ai-zen/agents-testing
│   ├── fake-llm/      @ai-zen/fake-llm
│   ├── test-home/     a data root used by the sdk end-to-end tests
│   └── test-project/  a project directory and MCP servers used by the same tests
├── dev-docs/          PRD · TRD · PLAN · GLOSSARY · ARCHITECTURE · STYLE
├── docs/              the documentation site's pages, Chinese and English
└── scripts/           repository scripts
```

### Reading further

| File | Holds |
|---|---|
| [`dev-docs/PRD.md`](dev-docs/PRD.md) | What the user has to see, in fourteen volumes: where the requirements come from and the eight hard rules, the user decisions that cannot be overturned, nine volumes by object (session, control, peers, handoff, client, attachments, observation, text, non-goals), and an FAQ |
| [`dev-docs/TRD.md`](dev-docs/TRD.md) | The shape the implementation takes: the four layers and their criteria, the engine, live objects, host infrastructure |
| [`dev-docs/PLAN.md`](dev-docs/PLAN.md) | What is done, what is left, and what counts as done; also the decisions already taken that should not be reopened |
| [`dev-docs/GLOSSARY.md`](dev-docs/GLOSSARY.md) | One name per concept, with the names that are not allowed |

[`dev-docs/ARCHITECTURE.md`](dev-docs/ARCHITECTURE.md) and [`dev-docs/STYLE.md`](dev-docs/STYLE.md)
sit in the same directory: the first is the structure of the host and its criteria, the second is how
code and prose are written across the whole repository.

## License

MIT
