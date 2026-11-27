# Host

The host is a resident process: it owns the database, sessions, workspaces, assets and credentials, and exposes an interface on the loopback address. It does not think and does not call models — that is the agent's job. It makes sessions exist, gives agents a place to be assembled, and lets several clients see the same facts.

## Starting

```bash
node packages/host/dist/cli.js serve                 # local instance, listens on 127.0.0.1:8790
node packages/host/dist/cli.js serve --public        # public instance, all interfaces
node packages/host/dist/cli.js serve --port 9000 --host 127.0.0.1
node packages/host/dist/cli.js serve --ai-zen-dir /srv/ai-zen
```

On start it prints five lines: listen address, version, discovery file, log directory, credential file. If a host is already serving, this process prints its address and exits without taking the port.

The data root comes from `AI_ZEN_DIR` or `--ai-zen-dir` and defaults to `~/.ai-zen`:

```
~/.ai-zen/
├── config.json        endpoints, models, default model, context thresholds, refresh timing
├── agents/            agent definitions
├── sub-agents/        sub-agent definitions
├── skills/            skills
├── tools/             user tools
├── mcp.json           MCP servers
├── ai-zen.db          sessions, messages, input queue, workspaces, assets, credentials, notices
├── logs/
└── run/
    ├── host.json      who is serving right now (address, port, pid)
    ├── token          plaintext credential for local clients
    └── next-version.json  which version the next start should run
```

## Credentials

| Case | What to do |
|---|---|
| Local client | On start the host writes a usable plaintext credential to `run/token`; the client reads it |
| Another machine | `token create --note <text>` mints one; the plaintext appears only in that output and is handed over by hand |
| Inspect and revoke | `token list`, `token revoke <id>` |

The database stores a digest; the plaintext cannot be read back after creation. The local credential is not rotated on restart: as long as the database still accepts it, it keeps being delivered — otherwise the value a client read last time would stop working the moment the host restarts.

## Sessions

A session is one row in the database plus some messages. It exists indefinitely: process restarts and agent termination do not affect it.

| Field | Meaning |
|---|---|
| `agentId` | Which definition it uses |
| `modelId` | Which model this session uses; `null` means no usable model is currently reachable |
| `thinkingLevel` | Thinking level; `null` follows the definition |
| `autoHandoff` | Whether crossing the soft line hands off automatically or asks first |
| `handoffThreshold` / `guardThreshold` | Session-level threshold overrides; `null` uses the values on the model definition |
| `lineage` | Which session opened this one; `null` means a user created it |
| `name`, `nameSource` | The name, and where it came from (placeholder, automatic, user, handoff archive) |

A workspace is a directory. A session belongs to a workspace and its agent works in that directory: the `cwd` decides how capability directories resolve and where the handoff document is written.

## Waking and delivering are two actions

| Action | Does | Does not |
|---|---|---|
| `agent.wake` | Reads the materials from the database, assembles the session into an agent, registers it, starts it | Deliver anything; create a session |
| `agent.send` | Puts one item into a live session | Create or revive a session; without an agent it returns `not_found` |

A client therefore wakes first and delivers second. Waking fills exactly one gap, "the row exists but the agent does not": a session has no agent before it is first used, and none after the process exits. The history is in the database, and the next wake reloads it together with the entries that were never taken, so the queue survives as well.

Waking is idempotent: if the agent is already alive the same one is returned; if assembly is in progress, two arriving wakes wait for the same assembly and cannot produce two agents writing the same memory.

## Sessions talking to each other

While assembling the runtime, the host injects the capability behind three tools: `create_session`, `post_message`, `read_session_status`.

- Peers, not children: a session opened from another has its own history, tools and model
- One level only: the opened session lacks `create_session` alone, so nesting stops there
- Non-blocking: `post_message` returns once delivered; a busy peer still receives it and picks it up at its next tool boundary
- `read_session_status` answers busy/idle, name and last sentence only; it never copies history

Two reasons for a failed delivery: `gone` (the session no longer exists) and `dead` (the row exists but no agent is alive).

## Client access

`@ai-zen/agents-client` is the single implementation of "where to connect and what to authenticate with":

1. Explicit address (`--server` or `AI_ZEN_SERVER_URL`) and explicit credential (`AI_ZEN_SERVER_TOKEN`) win
2. Otherwise read `run/host.json` and `run/token` under the data root
3. If no host answers, start one: the caller's entry point if it provided one (the desktop app ships the host inside its own build), otherwise `npx -y @ai-zen/agents-host@<version range> serve`
4. After starting, poll the address until it listens

`run/next-version.json` is where upgrades land: the host does not restart itself, so which version to run next can only be written to a file and read by whatever starts it. When a pin exists that version is used; otherwise the client's own range applies.

## Questions and notices

Both attach to sessions:

- **Notices**: failures, threshold crossings, handoff outcomes. They go into the `notice` table, so a client sees the history of them as soon as it connects
- **Questions**: when a person has to decide — which handoff executor to use after crossing the soft line, a form requested by an MCP server — the host raises a question and waits. Questions are live only and are not persisted: if the process dies the question dies with it, and there is no second table

A one-shot call (`ai "…"`) has nobody to ask, so that path installs no question board: questions stay pending rather than being answered on the user's behalf.

## Interface

A WebSocket on the loopback address speaking tRPC. Sessions, messages, queues, configuration, MCP, credentials, assets, search and handoff are each a group of procedures. There is no HTTP page and no static content: this layer serves clients only.

Messages go into an FTS5 full-text index, falling back to substring matching when a keyword is too short for the index. Sessions are searched by name, which is not indexed and is a full-table `LIKE` scan.

## Public instances

`--public` makes the host listen on all interfaces so clients beyond this machine can connect. In that case:

- No credential is written to `run/token`; the plaintext can only be obtained by a person running `token create`
- The host speaks plain WebSocket and does not provide TLS; for encryption, put a reverse proxy in front
- Upgrades use `run/next-version.json`: write the target version there and the next start picks it up
