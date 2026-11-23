# @ai-zen/agents-sdk

## What it is

`@ai-zen/agents-sdk` puts an agent together and keeps it running. It reads the configuration and the
agent definitions from disk, decides which model answers, which tools, skills, MCP servers and
sub-agents that agent may use, and hands you a started agent in a few lines.

It also lets those agents talk to each other: open another one, put a sentence in its queue, watch
what happens.

It owns no storage, no connections and no user-visible text. Where messages are written, who may
connect and what a person reads on screen belong to the host — this package only asks the caller for
the few things it cannot know itself.

## How to use

```bash
pnpm add @ai-zen/agents-sdk
```

The shortest path to a working agent. Everything except the endpoint and the key is factory
configuration, written for you by `bootstrap()`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager, DEFAULT_AGENT_ID, Scope, allInOne, createAgent } from "@ai-zen/agents-sdk";

const base = mkdtempSync(join(tmpdir(), "my-agent-"));

const config = new ConfigManager(join(base, "config.json"));
await config.bootstrap();  // config.json, a default agent, a default sub-agent, factory skills

const current = await config.read();
await config.write({
  ...current,
  // the only thing you have to fill in: where the model lives and the key for it
  endpoints: current.endpoints.map((endpoint) => ({
    ...endpoint,
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-…",
  })),
});

const scope = new Scope({
  getConfig: () => config.read(),
  agentsDir: join(base, "agents"),
  cwd: base,
}).use(...allInOne({}));
await scope.init();

const agent = await createAgent(scope, DEFAULT_AGENT_ID, { lifetime: "one-shot" });
const messages = await agent.runOnce({
  content: "What does this package do?",
  priority: "low",
  source: { kind: "user" },
});
console.log(messages.at(-1)?.content);

await scope.dispose();
```

Three things trip people up, and all three are in the code above:

- `config.read()` is **asynchronous**. A missing `await` hands you a promise, and everything
  downstream quietly sees an empty configuration.
- `createAgent()` builds a **resident** agent by default, and `runOnce()` refuses anything that is not
  `lifetime: "one-shot"`. Pass that option when you want one answer and you are done.
- the factory configuration has three endpoints and eight models, and the default agent is bound to
  one of them. Patching a single endpoint's `baseUrl` leaves the other models pointing at theirs, and
  model resolution fails with `Endpoint "x" is not configured` — patch them as a batch, as above.

An agent that should stay alive and take one more message at any time is built the same way minus
`lifetime: "one-shot"`: `push()` a message, listen for `state:idle`, and `stop()` when done. There is
no "deliver and wait" on a resident agent — it can be pushed by anyone at any time, so there is
nothing for a wait to attach to. The kernel page explains why.

Two agents talking to each other: see the example at the end of this file.

## How it is put together

Two halves behind one package name.

- The capability face turns the kernel into an agent that can do something: capabilities discovered
  from disk, a model resolved from configuration, permissions, handoff.
- The runtime keeps those agents alive and lets them talk to each other: one resident agent per
  session, facts forwarded outward, `post` from one session to another.

The kernel itself (`@ai-zen/agents-core`) is underneath both: an `Agent`, its loop, its two gates,
its events and hooks. This package adds what one particular product needs around it — and nothing
that belongs to a host.

| Half | Members |
|---|---|
| Capability face | `createAgent`, `SdkAgent`, `Scope` + its five capability sources (`allInOne`), `PermissionEvaluator`, `ConfigManager`, `AgentRepository`, `HandoffService` + `HandoffGuardPlugin`, `completeOnce` |
| Runtime | `AgentRuntime` (`wake` / `post` / `status` / `openPeer` / `kill` / `observe`), `Scopes`, `RuntimePeerSessions` |

### What it deliberately does not do

| Not here | Where it lives |
|---|---|
| storage, tables, migrations | the host |
| connections, discovery files, credentials | the host |
| user-visible copy, languages, i18n | the host |
| session rows | the host — a session is an opaque identity string here |

The rule the layering is measured by: this package never imports the host. A session is passed
around as a `string`; what that session is called is asked from a port, never stored. If a piece of
code needs to know "who is alive", "who knows whom", or "when to build and when to tear down", it
belongs to the runtime, not the host. If it reads or writes files, writes rows, relays events,
validates credentials or renders copy, it belongs to the host.

Conversely, an `as unknown as` cast that fakes an instance of something in this package means a port
is missing: the port should be declared here and implemented by the caller.

#### The four ports the runtime borrows

`AgentRuntime` does none of these itself, but each of them has to happen somewhere:

| Port | What the caller provides |
|---|---|
| `openScope(cwd, peers)` | build a capability container for that directory |
| `open(input)` | create a session: write the row, choose the identity, hand back `WakeMaterials` |
| `nameOf(sessionId)` | the session's current name, read from its row; `undefined` = no such session |
| `log` | a `LogSink`; omit it and nothing is logged |

`WakeMaterials` is everything needed to assemble one agent, given from above: `cwd`, `agentId`,
`modelId` / `modelParams`, `lineage`, `history` and the `waiting` entries not taken last time.

### Scope: one container per directory

A `Scope` holds the configuration, the working directory, the agent-definition directory, the
plugins, and the tools that came out of them. It runs a three-stage pipeline per agent
(`discover` → `candidates` → `instantiate`), so what an agent can use is decided when that agent is
built, not when each call arrives.

```ts
const scope = new Scope({ getConfig: () => config.read(), agentsDir, cwd })
  .use(...allInOne({ toolsPaths, skillsPaths, subAgentsPaths, mcpPaths }));
await scope.init();
```

`getConfig` is a port rather than a snapshot: after a configuration change, `refresh()` reads it
again instead of rebuilding the container. `use()` must happen before `init()`.

### The five capability sources

`allInOne(options)` returns the five standard plugins in this order — built-in tools, user tools,
skills, MCP, sub-agents — so a later source wins when two of them offer the same name.

| Plugin | Source |
|---|---|
| `BuiltinToolsScopePlugin` | the built-in tool set; each tool declares its own availability (`isAvailable`) |
| `UserToolsScopePlugin` | tool scripts found on disk |
| `SkillsScopePlugin` | skill directories, plus the tools that load a skill |
| `McpScopePlugin` | MCP servers (see below) |
| `SubAgentsScopePlugin` | sub-agent definitions on disk, exposed as one delegation tool each |

`allInOne` options: `skillsPaths`, `toolsPaths`, `subAgentsPaths`, `mcpPaths`, `logger`,
`mcpTaskNotice`. To drop or replace one source, construct the plugins one by one and `use()` them.

### Permissions

Four dimensions, each independent, each `{ allow: [...] }` or `{ deny: [...] }`, with `*` supported.
No match means denied; a dimension with no policy at all means denied. Filters are applied to
candidate names before instantiation, so a denied capability is not merely refused when called — the
model never sees it.

```json
{
  "permissions": {
    "tools": { "allow": ["*"] },
    "skills": { "deny": ["deploy"] },
    "mcps": { "allow": ["github"] },
    "subagents": { "allow": ["reviewer"] }
  }
}
```

`PermissionEvaluator` is the only implementation of that rule (`filter`, `isAllowed`, `match`).

### Definitions, configuration and models

| Member | What it owns |
|---|---|
| `ConfigManager` | `config.json` and the directories beside it: read, write, factory defaults, recovery of a broken file, reasoning presets, factory skills, `mcp.json` |
| `AgentRepository` | one agent definition per file, `<agentsDir>/<id>.json` |
| `createAgent(scope, agentId, options)` | one assembled `SdkAgent`: definition read, model resolved, tools built from the filtered candidates |
| `resolveModel` / `resolveModelParams` | session override > definition > `config.defaultModel`, the only implementation |
| `createModel` / `createModelFromConfig` | the `OpenAI` client, the model name and the request parameters |
| `completeOnce` | one non-streaming call with no tools and no history |

`createAgent` options: `modelId` and `modelParams` (the session-level level), `lifetime`
(`"one-shot"` for an agent that runs once and dies), `canOpenPeers`, and the two interruption
strategies `abortedToolRoundStrategy` / `abortedMessageStrategy`, which fall back to the configuration
and then to the kernel defaults.

Model resolution never mixes levels: the parameters come from whichever level supplied the model, so
a session that switches model does not carry the previous model's parameters.

`SdkAgent` is an `Agent` that also carries `scope` and `definition` (the definition as it is in
effect, with the resolved model written into it), plus `useModel(modelId, modelParams?)` to change
model and parameters in place without killing the agent.

### Handoff

`HandoffService` writes a handoff document, and optionally replaces the memory with it.

| Method | What it does |
|---|---|
| `handoff(params)` | gives the agent one instruction to write the document, and changes nothing else about the session |
| `migrate(params)` | writes the document, then computes the new memory and commits it |

Two modes for who writes the document: `self` (the same agent, in its own session — the default) and
`summary` (one separate model call over a serialized history). Two strategies for what happens to the
old messages: `omit` (marked and kept out of later requests — the default) and `prune` (physically
removed). `commitMemory` decides where the new memory lands: without it the SDK splices
`agent.messages` in place, with it the caller stores it.

`HandoffGuardPlugin` is the guard for the handoff batch: during it, the only write that passes is the
one to the handoff document itself; every other write tool is refused with a sentence the model can
read and act on. It also observes whether that write happened (`arm` returns an outcome and a
"batch over" promise; `disarm` lets everything through again). It is a guard against mistakes in the
workspace, not a sandbox: a shell command can still write files. Cancellation surfaces as
`HandoffAbortedError`, and it is never silently retried with the other mode.

### Agent plugins

Mounted on an agent, not on the container: `AutoMigratePlugin` (hand off when usage crosses the soft
line), `AutoRefreshToolsPlugin`, `ContextGuardPlugin` (refuse a request that would cross the hard
line), `SubAgentGuardInstallerPlugin` (install the guard on sub-agents too), `HandoffGuardPlugin`,
`UnknownToolHintPlugin`, `AssetTransportPlugin`.

### The runtime

`AgentRuntime` keeps one resident agent per session and forwards the kernel's facts.

| Member | What it does |
|---|---|
| `wake(sessionId, materials)` | assemble, register, start; idempotent, concurrent calls share one assembly |
| `post({ from, to, content })` | put one sentence in another session's inbox; answers `{ ok: true }` or a reason |
| `status(sessionId)` | whether it is working or idle, its name, an excerpt of the last thing it said |
| `openPeer({ from, prompt, agentId?, modelId?, label? })` | open a peer session, wake it, post the first prompt, return immediately |
| `kill(sessionId)` | unregister, kill, report that it is gone |
| `close()` | kill everything and tear every container down |
| `observe(listener)` | subscribe to the facts; returns an unsubscribe function |
| `get(sessionId)` / `sessionOf(agent)` / `aliveOn(cwd)` | the snapshots: which agent, which session, which sessions on that directory |
| `scopes` / `peerSessions` | the container registry, and the peer-session port this runtime implements |

Facts are a discriminated union: `resident:appeared` and `resident:gone` (the runtime's own two),
`scope:appeared` / `scope:refreshed` / `scope:gone` (from the container registry), and every kernel
event of every agent, unchanged in name and payload, with the `sessionId` added.

There is no "wait until it is done" on the runtime: a resident session is never done, it goes from
working to idle and can be pushed again at any moment. Nothing in the runtime waits for a caller; a
delivery is what wakes a session up.

#### Scopes: containers live by directory

`Scopes` owns the container registry: one container per `cwd`, shared by every session working in
that directory.

| Member | What it does |
|---|---|
| `for(cwd)` | the container for that directory, built on first use |
| `dispose(cwd)` | tear it down — refuses while any session is still alive on that directory |
| `refreshAll()` | let every already-built container re-read the configuration; reports how many were refreshed and which failed |
| `disposeAll()` | tear down everything, for process shutdown |

There is no idle timer, no reference counting and no automatic collection: a container lives because
someone holds it, and it is torn down when someone tears it down. "Nobody is using it" is not a
decidable state. Tearing down refuses rather than cascading, because a cascade would silently kill
sessions that are in the middle of work.

### Peer sessions

A peer session is another session an agent opens for itself, with its own agent, its own context and
its own usage, and it stays in the session list afterwards.

The model side is three tools (`packages/sdk/src/scope/plugins/peers/`):

| Tool | What it does |
|---|---|
| `create_session` | open a peer session and return `{ sessionId, label }` at once |
| `read_session_status` | whether it is working or idle, whether it is alive, its name, an excerpt of its last message |
| `post_message` | put one message in that session's inbox |

They implement nothing themselves. `PeerSessionsScopePlugin` takes a `PeerSessionPort` with three
methods — `create`, `status`, `send` — and without a port it produces no tools at all. The runtime
implements that port (`RuntimePeerSessions`), which is why the three tools also work when no host is
around.

Two rules are structural rather than validated at call time:

- an agent that was itself opened as a peer has no `create_session` on its hands: `createAgent` is
  called with `canOpenPeers: false` for it, so creating is one level deep and the model cannot even
  try. `post_message` and `read_session_status` stay, because peers talk both ways.
- a one-shot agent has neither of the three nor the two background tools: it has no identity to sign
  a message with, it can open nothing that anybody would own, and it is gone before a background
  result comes back.

`post_message` does not depend on the relation between the two sessions, and its receipt says only
that the message was accepted. Refusals are structured: `gone` (no such session) and `dead` (the row
exists, no agent behind it, so nobody will take it). Creating can also be refused with
`depth_exceeded` (this session was itself opened as a peer, or the caller is not a session at all)
or `model_unresolved`; `PeerSessionRejectReason` also carries `too_many_peers`, for a port that
enforces a limit.

Neither an excerpt of a peer's history nor a message count is ever returned: an excerpt is all the
model gets, so it does not start treating another session's transcript as its own context.

### Background tools

Two built-in tools return immediately and report later:

| Tool | What it does |
|---|---|
| `async_exec` | run a shell command in the background; its output and exit status are pushed back into the session as a new message |
| `async_timeout` | a timer; when it fires, a message carrying the task id is pushed back |

Both are in `scope/plugins/builtin/` (`AsyncExecTool`, `AsyncTimeoutTool`, `asyncTasks`). The result
comes back through a delivery into the same session, at low priority, so it never lands inside the
batch that is currently running. Task ids come from one counter per agent (`async_exec-1`,
`async_timeout-2`), and everything still running is reaped when the agent is stopped or killed.

A one-shot agent gets neither of them (`ASYNC_TASK_TOOL_NAMES` is stripped at assembly): the result
arrives after its call stack has returned, so there would be nobody to deliver it to. This is the same
rule the kernel states for resident versus one-shot, enforced where the tools are chosen.

### MCP

Four things live in `scope/plugins/mcp/`.

Discovery merges an ordered list of `mcp.json` files, nearest first: an earlier file wins for the
same server id, and a `disabled: true` entry in a nearer file cancels the definition in a farther
one. The five locations of the standard chain are assembled by the caller and passed as `mcpPaths`
(the host is the one that knows them), so this package merges exactly what it is given.

Connections are lazy and belong to `McpConnectionManager`: `load_mcp` connects a server and returns
its manifest, an unused connection is dropped after an idle timeout (30 minutes for stdio, 5 for
http), and `disconnect` / `disconnectAll` close them explicitly. A dropped transport marks the server
disconnected instead of reconnecting on its own — reconnecting happens when the model asks for that
server again, and the stale manifest is never shown as current. When the configuration changes,
`McpScopePlugin` reconciles: removed and changed servers are disconnected, unchanged ones are left
untouched.

The model side is five tools: `load_mcp`, `call_mcp_tool`, `read_mcp_resource`,
`get_mcp_task_result`, `cancel_mcp_task`.

Tasks are the long-running shape of an MCP call. A tool declares its task support
(`forbidden` / `optional` / `required`); when a call produces a task, `call_mcp_tool` returns the task
id at once, the server pushes status notifications, and the manager remembers which session started
the task. A terminal status (`completed` / `failed` / `cancelled`, see `isTerminalTaskStatus`) is
handed to `McpTaskNoticePort`, which the host implements: `sessionOf(agent)` says which session a
caller belongs to, `deliver(sessionId, notice)` puts the notice in its inbox. The result itself is
fetched by task id with `get_mcp_task_result`.

## Details

### Example: two sessions, one message between them

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

`peerSessions` on the runtime is the port those three tools end up talking to; `Scopes` is the
container registry the runtime owns, so the example does not construct it.

### Writing the configuration by hand

`bootstrap()` writes a usable configuration for you. If you would rather spell it out — for instance
because you ship your own defaults — this is the whole shape:

```ts
const config = new ConfigManager(`${base}/config.json`);
await config.write({
  endpoints: [
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-…" },
  ],
  models: [
    {
      id: "gpt-4o",
      name: "GPT-4o",
      endpointId: "openai",
      tokenThresholds: { handoff: 500_000, guard: 750_000 },
    },
  ],
  defaultModel: "gpt-4o",
});

const agents = new AgentRepository(`${base}/agents`);
await agents.write({
  id: "demo",
  name: "Demo",
  messages: [Message.System("Answer in one sentence.")],
  modelId: "gpt-4o",
  permissions: {
    tools: { allow: ["*"] },
    skills: { allow: ["*"] },
    mcps: { allow: ["*"] },
    subagents: { allow: ["*"] },
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
```

`tokenThresholds` are absolute input-token counts, not a percentage of the context window: crossing
the soft line starts a handoff, crossing the hard line refuses the request before it is sent.

### Testing

```bash
npm run pretest      # tsc --noEmit over src and the tests
npx vitest run       # the suite that depends on nothing outside this repository
```

Both are run from `packages/sdk`. `npm run test:e2e` runs the cases that need an API key or a real
MCP server; `npm test` must never need either. The fake endpoint used by the suite lives in
`@ai-zen/agents-testing` (which re-exports `@ai-zen/fake-llm`).

## License

MIT
