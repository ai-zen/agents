# @ai-zen/agents-host

## What it is

A local, resident service. It keeps sessions in one SQLite file, serves them over one WebSocket, and
does the client side of the work: notices, questions, uploaded files, search, credentials.

It is the half of the product that survives a restart. Agents themselves are not its business — it
starts them through `@ai-zen/agents-sdk` and remembers nothing about which of them is alive. The
process is a single `HostApp`, assembled once in `src/app.ts`; its command line is `src/cli.ts`.

## How to use

```bash
npx -y @ai-zen/agents-host@alpha serve
```

That is the whole startup: it creates the data root (`AI_ZEN_DIR`, default `~/.ai-zen`), writes the
database and a factory configuration, prints the address it listens on, and records itself in
`<data root>/run/host.json`:

```
Listening on ws://127.0.0.1:8790
Version: 0.2.0-alpha.0
Discovery file: /home/you/.ai-zen/run/host.json
Logs: /home/you/.ai-zen/logs
Credential file: /home/you/.ai-zen/run/token
```

A local instance also writes one usable credential into `run/token`, so a client on the same machine
does not have to be handed one. For anything else — a public instance, or a device on another
machine — mint one and keep the plaintext, because it is printed once:

```bash
agents-host token create --note "laptop"
```

Then talk to it. Every client speaks tRPC over that WebSocket, and the three calls below are the
whole shape of driving a session: create the row, deliver a message, read the session back.

```ts
// 1. a session row, and nothing else: no agent is woken, nothing is delivered
const { session } = await api.session.create.mutate({ workspaceId: "w1", agentId: "default" });

// 2. this one needs a live agent on that session; waking it first is the caller's job
const { messageId } = await api.agent.send.mutate({
  workspaceId: "w1",
  agentId: "default",
  sessionId: session.id,
  messageId: "m-1",
  content: "read the file",
});

// 3. the row, the live state, the messages and the inbox in one answer
const view = await api.session.open.query({ sessionId: session.id });
```

Two pieces of wiring are easy to get wrong. The credential travels in the **handshake frame**
(`connectionParams` as `{ token }`), never in the query string; a connection that fails that check
reaches no procedure and is closed. And the facts arrive on one subscription (`events`), not by
polling — a client that only calls queries will look frozen.

There is no client in this repository. The terminal client lives in another one, and
`@ai-zen/agents-client` — the package that builds a typed `TRPCClient<AppRouter>` for you — is
private (it is inlined into its clients). If you are writing your own, that package is what you are
re-implementing: one WebSocket, tRPC over it, the token in the handshake, the `events` subscription,
and `data.hostCode` mapped back to an error code.

## How it is put together

### What the host owns

| Domain | Holds |
|---|---|
| `session` | Session rows, messages, rewind, removal, the one-shot session (`session.transient`) |
| `workspace` | Project rows — one working directory each — plus the file list a client needs for `@` mentions |
| `agent` | The procedures that reach the live object: wake, deliver, the two gates, abort, kill, clear the inbox |
| `connection` / `credential` | Every connection needs a credential; credentials are hashed in the database and can be revoked |
| `notice` / `question` / `asset` / `search` | Client odds and ends: notices with a lifetime, questions waiting for an answer, uploaded files, full-text search |
| `handoff` | Starting and cancelling a handoff, and the state a client reads while one runs |
| `config` / `mcp` / `agentDefinition` | The editable files on disk: endpoints, models, image models, presets, MCP entries, agent definitions |
| `i18n` | User-visible text, rendered where it is produced |
| `infra` | Database, one-row-one-JSON tables, the event bus, errors, files, paths, version, the discovery file |

### What the host does not do

It does not install an agent, keep the register of who is alive, decide when an ability container is
disposed, judge whether a config is valid, merge MCP configuration, or manage connecting and
reconnecting. Those belong to `@ai-zen/agents-sdk`; the host hands it four ports (how to build a
container, how to open a session row, what a session is called right now, where to log) and otherwise
only reads and writes files, tables and events. If a piece of host code starts answering "which
config is in effect" or "which server should this connect to", it belongs one layer down.

### The contract surface

Every client talks to one thing: a tRPC router served over a single WebSocket (`applyWSSHandler` in
`src/app.ts`), with one subscription for the facts the host publishes. The routers are grouped by
domain in `src/modules/api/`:

| Router | Procedures |
|---|---|
| `session` | `list` `create` `open` `rename` `pin` `setAutoHandoff` `setThresholds` `setModel` `setThinkingLevel` `rewind` `remove` `transient` |
| `workspace` | `list` `create` `files` `rename` `remove` |
| `agent` | `wake` `send` `pause` `resume` `abort` `kill` `clearInbox` |
| `asset` | `upload` `get` `list` |
| `notice` | `list` `clear` `clearOne` |
| `question` | `list` `answer` |
| `handoff` | `start` `cancel` |
| `search` | `messages` `sessions` |
| `scope` | `reload` |
| `config` | `get` `setDefaults` `setGlobal`, plus `endpoint.*` `model.*` `imageModel.*` `presets.set` |
| `mcp` | `list` `save` `remove` |
| `agentDefinition` | `list` `get` `create` `update` `remove` `reset` |
| `host` | `version` `upgrade` `shutdown` |
| `events` | one subscription, not a domain of actions |

Each procedure declares its own input and output on the procedure itself; there is no second list of
shapes anywhere.

### The event stream

`src/modules/events.ts` holds the one union of facts pushed to clients. Every entry is a change, never
a stage:

| Event | Says |
|---|---|
| `message.added` | A message joined the transcript |
| `message.changed` | A message was updated in place (a stream filling in, a status flipping) |
| `message.removed` | A message was deleted |
| `subagent.message` | A subagent said something; it never reaches the database, so it is its own event |
| `agent.status` | The live agent went working or idle |
| `agent.paused` | One of the two gates was closed or opened, named by `side` |
| `agent.alive` | An agent was woken or killed |
| `agent.inbox` | The pending inbox of a session, whole |
| `session.changed` | A session row changed; the whole row is carried |
| `session.removed` | A session row is gone |
| `session.handoff` | A handoff started or finished for a session |
| `notice` | A notice was published, with its scope and its level |
| `notice.cleared` | Notices were cleared: one by id, all of a session, or everything |
| `question.asked` | A question is waiting for the user |
| `question.answered` | A question was answered, and is gone |

### The contract surface does not fill in for clients

Every procedure does exactly the one thing it is named for, and a client that wants two things makes
two calls. There is no draft session: a session row is created with `session.create`, and the text in
an input box is the client's state, not the host's. There is no wake-then-deliver shortcut: a session
with no live agent answers `not_found` on `agent.send`, and calling `agent.wake` first is the client's
orchestration. There is no confirmation step in `shutdown`, and no cost calculation in
`session.remove` — the counts are already in `session.open`, so the client counts, asks, then calls.
Deciding whether an unanswered blocking question should hold back the send button is likewise the
client's, since only it knows what the user is doing.

## Details

### The command line

| Command | Does |
|---|---|
| `agents-host serve` | Start serving. This is also what runs when no subcommand is given |
| `agents-host stop` | Stop the host recorded in `run/host.json`, by pid, after one confirmation |
| `agents-host token create` | Mint a credential and print its plaintext once |
| `agents-host token list` | List credentials with their state |
| `agents-host token revoke <id>` | Revoke one credential |
| `agents-host version` | Print the package version |
| `agents-host help` | Print usage |

Options, as parsed in `src/cli.ts`:

| Option | Command | Meaning |
|---|---|---|
| `--port <n>` | `serve` | Listen on that port. `0` lets the system assign one, and is only accepted here |
| `--host <addr>` | `serve` | Listen on that address, overriding the one `--public` implies. It does not by itself change whether the instance counts as local; `--public` does |
| `--public` | `serve` | Listen on all interfaces instead of the loopback address |
| `--ai-zen-dir <dir>` | all except `version` / `help` | Data root, written into `AI_ZEN_DIR` before anything reads it |
| `--yes` | `stop` | Skip the confirmation, for scripts |
| `--note <note>` | `token create` | A note stored with the credential, so a human can tell them apart |

The port has three levels: the flag, then `<data root>/host.json`, then `8790`. A port that is
explicitly given but is not a number between 0 and 65535 is rejected; a port already in use makes
startup fail rather than silently moving to another one. `token` never starts a service: it opens the
database, does its work and closes it.

### Data root and the files under `run/`

The data root is `AI_ZEN_DIR`, default `~/.ai-zen`:

```
<data root>/
├── ai-zen.db               the whole machine's database
├── assets/                 uploaded bytes
├── config.json             user config
├── host.json               the host's own settings (the port)
├── reasoning-presets.json  thinking-level presets
├── mcp.json                user-level MCP entries
├── agents/  sub-agents/  skills/  tools/  mcp-oauth/
├── logs/host.log
└── run/
    ├── host.json           discovery file: who is serving on this machine
    ├── token               local credential delivery file
    └── next-version.json   upgrade pin: which version to launch next
```

`run/host.json` is the only answer to "is a host running here, and where": pid, host, port, version,
local, startedAt. On startup it is read first — if that pid is alive, this process binds nothing and
reports the existing address; if the pid is gone, or the file is unreadable (in which case it is
deleted), this process starts its own server and rewrites the file once its port is bound. Liveness
is `kill(pid, 0)`, nothing else.

`run/token` is written by a local instance, which is the default: it carries one usable credential so
that a client on the same machine does not have to be handed one. If that credential has been
revoked or no longer exists, startup mints a new one and writes it back, otherwise the machine could
not connect to itself. A public instance (`--public`) does not write this file: on that machine
credentials are minted with `agents-host token create` and handed to the devices that connect.
Revoking affects only later connections; a connection that already shook hands stays.

`run/next-version.json` is the upgrade pin and is separate from the exit signal, because the two
answer different questions: the pin says which version to launch next, the exit code says whether
this exit was for an upgrade. The host neither installs packages nor re-executes itself — it
verifies that the requested version is obtainable, writes the pin, and exits with `75`.

### Errors on the wire

Failures that cross the wire are a `HostError` with one of eight codes — `not_found`,
`invalid_params`, `conflict`, `busy`, `unsupported`, `config_invalid`, `not_available`,
`unauthorized` — carried as `data.hostCode` beside the rendered message and its `details`.

### Tests

```bash
npm run pretest                                 # tsc --noEmit -p tsconfig.test.json
npx vitest run                                  # domain tests: no ports, no real disk
npx vitest run --config vitest.e2e.config.ts    # a real host: real port, real disk, real WebSocket
```

The default suite runs every `src/**/*.test.ts` and skips the end-to-end files, so it stays a gate
that only looks at the repository. The end-to-end suite runs only `src/**/*.e2e.test.ts`, each one
starting a host, connecting a real `ws` client and asking a local OpenAI-compatible endpoint for a
streamed answer, against a temporary data root. `npm test` runs the type check and the default suite;
`npm run test:e2e` runs the type check and the end-to-end suite.

## License

MIT
