---
title: Getting Started
description: From zero to the first message out: install and test, start a host (agents-host serve and its options), mint a credential (token create and run/token), connect a client, and two ways to run without a host (core alone, and core plus Scope).
outline: deep
---

# Getting Started

This page goes from an empty directory to "the first message is out". The two roads can be taken
separately: one starts a host and lets a client from another repository connect to it; the other
assembles an agent out of `core` and `sdk` alone, with no host in the picture.

## Prerequisites

| Item | Notes |
|---|---|
| Node.js | The host uses `node:sqlite` (`packages/host/src/infra/db.ts`), so the runtime needs that module |
| pnpm | This repository is a pnpm workspace (`pnpm-workspace.yaml`); everything under `packages/*` hangs off it |
| A model endpoint | The kernel runs on the official `openai` package: an `OpenAI` client, a model name and an array of messages are enough to construct an agent |

## Install and test

```bash
pnpm install
pnpm test
```

`pnpm test` builds `testing`, `logger`, `host` and `client` first, then runs each package's suite in
turn. A single package is tested from its own directory:

```bash
cd packages/core
npm run pretest      # tsc --noEmit -p tsconfig.test.json
npx vitest run
```

The host has a second suite that runs real processes and stays out of `npm test`:

```bash
cd packages/host
npx vitest run                                  # domain tests: no ports, no real disk
npx vitest run --config vitest.e2e.config.ts    # a real host: real port, real disk, real WebSocket
```

Package builds are wired at the root: `pnpm build-core`, `pnpm build-sdk`, `pnpm build-host`,
`pnpm build-client`, `pnpm build-logger`, `pnpm build-testing`.

## Start a host

```bash
pnpm build-host
node packages/host/dist/cli.js serve
```

Installed, the same entry point is the `agents-host` bin, so the command reads `agents-host serve`.
By default it listens on the loopback address, port 8790.

The options of `serve` (`packages/host/src/cli.ts`):

| Option | Meaning |
|---|---|
| `--port <n>` | Listen on that port. `0` lets the system assign one, and is only accepted here |
| `--host <addr>` | Listen on that address, overriding the one `--public` implies. It does not by itself change whether the instance counts as local; `--public` does |
| `--public` | Listen on all interfaces instead of the loopback address |
| `--ai-zen-dir <dir>` | The data root, written into `AI_ZEN_DIR` before anything else reads it |

A port that is explicitly given but is not an integer between 0 and 65535 is rejected by the command
line with the usage text and exit code 2; a port already in use makes startup fail rather than move to
another one.

`stop` stops the host recorded in `<data root>/run/host.json`, by pid, after one confirmation; `--yes`
skips that question for scripts.

## Mint a credential

A client presents a token in its handshake. Minting one is the host's own administrative action and
goes through the command line, which opens no service:

```bash
node packages/host/dist/cli.js token create --note laptop   # the plaintext is printed once
node packages/host/dist/cli.js token list                   # id and state
node packages/host/dist/cli.js token revoke <id>            # revoke one
```

The database keeps only the SHA-256 digest of that token; the plaintext appears once, at creation.
Revoking affects whether a later connection can be made, and does not reach back into a connection
that already shook hands.

A local instance also writes one usable token into `<data root>/run/token`, so a client on the same
machine can read it instead of being handed one. A public instance (`--public`) does not write that
file: on that machine credentials are minted by hand and handed to the devices that connect.

## Connect a client

This repository ships no user interface. A terminal client exists, and a desktop app exists, each in
its own repository, each embedding `@ai-zen/agents-client` into its own build.

Everything between a client and a host travels one WebSocket: tRPC runs over it, and the facts the
host publishes come back on one subscription over the same connection. The token goes in the
handshake frame (`connectionParams` as `{ token }`), never in a query string; a connection that fails
that check reaches no procedure and is closed with `unauthorized`.

The local case needs neither an address nor a token by hand: the client reads which host is serving
from `<data root>/run/host.json`, and the token from `run/token` beside it. Connecting to a host on
another machine means giving both an address and a token, and the token is the string `token create`
printed.

## A minimal agent without the host

This section uses `@ai-zen/agents-core` only: no database, no session row, no connection. The promise
from `start()` resolves when the agent dies, so waiting for one batch means waiting for `state:idle`.

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.openai.com/v1",
});

const agent = new Agent({
  client,
  model: "gpt-4o",
  messages: [Message.System("Answer in one sentence.")],
});

// on() returns the unsubscribe function; the handler receives the live message
const offFinished = agent.on("messageFinished", ({ message }) => {
  if (message.role === "assistant" && message.content) console.log(message.content);
});

// resolve when one batch is done and the queue is empty
const idle = new Promise<void>((resolve) => {
  const offIdle = agent.on("state:idle", () => {
    offIdle();
    resolve();
  });
});

agent.send("What does this package do?");

void agent.start();  // resolves only when the agent is dead
await idle;          // the batch in hand finished
agent.stop();        // drain what is queued, then die
offFinished();
console.log(agent.messages.at(-1)?.content);
```

Adding `@ai-zen/agents-sdk` on top puts two sessions in touch: `AgentRuntime` assembles an `Agent` and
keeps the register of what is alive, and `post()` puts one message in another session's inbox. The
receiving session goes from idle to working by that delivery, runs on its own and comes back to idle;
the posting side does not wait for it.

```ts
import {
  AgentRuntime,
  ConfigManager,
  PeerSessionsScopePlugin,
  Scope,
  allInOne,
  type RuntimeFact,
  type WakeMaterials,
} from "@ai-zen/agents-sdk";

// config.json and the two definitions "lead" and "helper" already exist under `base`
const base = "/path/to/data";
const config = new ConfigManager(`${base}/config.json`);
const names = new Map<string, string>();

const runtime = new AgentRuntime({
  openScope: async (cwd, peers) => {
    const scope = new Scope({ getConfig: () => config.read(), agentsDir: `${base}/agents`, cwd })
      .use(...allInOne({ mcpPaths: [`${base}/mcp.json`] }))
      .use(new PeerSessionsScopePlugin(peers)); // the peer tools need the port from the runtime
    await scope.init();
    return scope;
  },
  open: async (input) => {
    // a real host writes a session row here and decides the identity
    const sessionId = `session-${names.size + 1}`;
    names.set(sessionId, input.label ?? input.prompt);
    const materials: WakeMaterials = {
      cwd: base,
      agentId: input.agentId,
      modelId: input.modelId,
      lineage: input.lineage,
      history: [],
      waiting: [],
    };
    return { ok: true, sessionId, materials };
  },
  nameOf: async (sessionId) => names.get(sessionId),
});

runtime.observe((fact: RuntimeFact) => {
  if (fact.type === "messageFinished") console.log(fact.sessionId, fact.message.content);
});

names.set("lead", "lead");
names.set("helper", "helper");
await runtime.wake("lead", { cwd: base, agentId: "lead", lineage: null, history: [], waiting: [] });
await runtime.wake("helper", { cwd: base, agentId: "helper", lineage: null, history: [], waiting: [] });

// the helper is woken up by this delivery, runs on its own, and comes back to idle
console.log(await runtime.post({ from: "lead", to: "helper", content: "Say hi in one line." }));
console.log(await runtime.status("helper"));

await runtime.close();
```

The model here is resolved from `config.json`, which carries the endpoints, the models and their
keys. The runtime borrows four ports from the caller — build a `Scope` (`openScope`), open a session
(`open`), read what a session is called right now (`nameOf`), log — and the host provides exactly
these four. Replace them with empty implementations and this layer behaves the same.

For tools, skills and MCP without `AgentRuntime`, `Scope` plus `createAgent` is enough — that code is
in [Core and Scope alone](scope.md).

## Next

- [Architecture](architecture.md) — the criteria for the four layers, the four questions for live
  objects, where events and persistence land
- [Core API](core.md) — one `Agent`'s inbox, its two loops, its two switches, the plugin hooks
- [SDK](sdk.md) — `Scope`, model resolution, handoff, the runtime
- [Core and Scope alone](scope.md) — no `AgentRuntime`, no host
- [Deployment](deploy.md) — local and public instances, the three port levels, credentials, upgrades
