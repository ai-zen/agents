# Getting started

## Requirements

- Node.js 24 or newer: the host uses the built-in `node:sqlite`
- pnpm, when building from source
- An OpenAI-compatible endpoint and its key

The data root is the only writable directory tree in the runtime. It is taken from `AI_ZEN_DIR` and defaults to `~/.ai-zen`. The host and the command line read the same place.

## The terminal client

```bash
npm i -g @ai-zen/cli
ai
```

`ai` (also `aiz` and `zen`) opens the interactive interface. It looks for a host in this order: an explicit address from `--server <url>`, then the `AI_ZEN_SERVER_URL` environment variable, then the address in `<data root>/run/host.json` together with the credential in `<data root>/run/token`. When nothing is reachable it starts one with `npx -y @ai-zen/agents-host@<version range> serve --ai-zen-dir <data root>` and waits for it to listen.

Two modes, one per process:

| Invocation | Mode |
|---|---|
| With positional arguments, or stdin / stdout is not a TTY | Pure stdio: one call, only the final assistant text on stdout, logs and progress on stderr |
| No arguments and both stdin and stdout are TTYs, or `--tui` | Interactive interface |

Common arguments:

```bash
ai "which build scripts does this repo use"   # one call, nothing persisted
ai --save "read src and summarise it"         # one call, but written into a real session
ai --new                                     # open the interface on a new session
ai --server ws://192.168.1.10:8790           # connect to a specific host
ai --server-status                           # print host status; does not start one, does not open the interface
```

Exit codes: `0` success; `1` failure after the run has started; `2` the command itself was wrong (for example `--tui` without a TTY).

## Endpoints

The first start writes `<data root>/config.json`. Its four factory endpoints all have an empty `apiKey`:

| Endpoint id | Address |
|---|---|
| `openai` | `https://api.openai.com/v1` |
| `bigmodelcn` | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | `https://api.deepseek.com/v1` (declares the Files API, so local files are uploaded rather than inlined) |
| `opencode-go` | subscription endpoint; its model list ships with the SDK |

Fill in the key of the one you use and it runs. The default agent is bound to `deepseek-flash`, which belongs to the `deepseek` endpoint.

## Starting a host from source

```bash
pnpm install
pnpm -r --filter '@ai-zen/agents-host...' build

node packages/host/dist/cli.js serve
```

On start it prints five lines: listen address, version, discovery file, log directory, credential file. Other arguments:

| Argument | Meaning |
|---|---|
| `--port <n>` | Port, default 8790 |
| `--host <addr>` | Listen address |
| `--public` | Listen on all interfaces, for clients beyond this machine |
| `--ai-zen-dir <dir>` | Data root, overriding `AI_ZEN_DIR` |

```bash
node packages/host/dist/cli.js token create --note "laptop"
node packages/host/dist/cli.js token list
node packages/host/dist/cli.js token revoke <id>
node packages/host/dist/cli.js stop
```

A local instance writes a credential for local clients into `<data root>/run/token`, so `token create` is not needed on the same machine. Credentials for other machines can only be created with `token create`; the plaintext appears in that output once. The database stores a digest.

## Without a host

A host is not required. `core` and `sdk` alone assemble a complete agent: built-in tools, user tools, skills, sub-agents, MCP, four permission dimensions, both context thresholds and handoff all live in these two packages, with `core` providing the queue, the request-and-tool loop and the event stream. Nothing you use day to day is missing.

What is missing are the things that outlive a process: sessions and history on disk, several clients at once, and sessions posting to each other (the last one is provided by `AgentRuntime`, but the four ports it borrows from a host are yours to implement).

A minimal single call is a few lines:

```bash
pnpm add @ai-zen/agents-core @ai-zen/agents-sdk
```

```ts
import {
  ConfigManager,
  DEFAULT_AGENT_ID,
  Scope,
  allInOne,
  createAgent,
} from "@ai-zen/agents-sdk";

const base = "/path/to/data";
const config = new ConfigManager(`${base}/config.json`);
await config.bootstrap();

const scope = new Scope({
  getConfig: () => config.read(),
  agentsDir: `${base}/agents`,
  cwd: base,
}).use(...allInOne({}));
await scope.init();

const agent = await createAgent(scope, DEFAULT_AGENT_ID, { lifetime: "one-shot" });
const messages = await agent.runOnce("classify this error log");
console.log(messages.at(-1)?.content);
```

No database, no resident process, no network interface. `bootstrap()` creates the directories, `config.json`, the default agent, the default sub-agent and the factory skills; existing files are never overwritten.

## Next

- It should stay resident, take repeated deliveries, and wake when a result comes back: [Agent](agent.md)
- It needs your own tools, skills or sub-agents: [Capabilities](capabilities.md)
- It needs MCP: [MCP](mcp.md)
- It needs multiple clients, sessions talking to each other, survival across restarts: [Host](host.md)
