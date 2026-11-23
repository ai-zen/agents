---
title: SDK
description: The capability face and the runtime — the three-stage pipeline and five capability sources of a capability container, four-dimensional permissions as disclosure, three-level model resolution, handoff's two methods and two strategies, agent plugins, the three peer-session tools, the two background tools, and when a container is disposed.
outline: deep
---

# SDK

`@ai-zen/agents-sdk` is two halves behind one package name.

- The capability face turns the kernel into an agent that can do something: capabilities discovered from disk, a model resolved from configuration, permissions, handoff.
- The runtime keeps those agents alive and lets them talk to each other: one resident agent per session, facts forwarded outward, `post` from one session to another.

The kernel (`@ai-zen/agents-core`) sits underneath both. This page covers what this package adds around it, and the boundary of each addition.

| Half | Members |
|---|---|
| Capability face | `createAgent`, `SdkAgent`, `Scope` + its five capability sources (`allInOne`), `PermissionEvaluator`, `ConfigManager`, `AgentRepository`, `HandoffService` + `HandoffGuardPlugin`, `completeOnce`, the built-in tools and their output guard |
| Runtime | `AgentRuntime` (`wake` / `post` / `status` / `openPeer` / `kill` / `close` / `observe` / `get` / `sessionOf` / `aliveOn`), `Scopes`, `RuntimePeerSessions` |

```bash
pnpm add @ai-zen/agents-sdk
```

## Layering: what this package does not do

| Not here | Where it lives |
|---|---|
| storage, tables, migrations | the host |
| connections, discovery files, credentials | the host |
| user-visible copy, languages, i18n | the host |
| session rows | the host — a session is an opaque identity string here |

The rule the layering is measured by: this package never imports the host. A session is passed around as a `string`; what that session is called is asked from a port, never stored. If a piece of code needs to know "who is alive", "who knows whom", or "when to build and when to tear down", it belongs to the runtime. If it reads or writes files, writes rows, relays events, validates credentials or renders copy, it belongs to the host.

Conversely, an `as unknown as` cast that fakes an instance of something in this package means a port is missing: the port should be declared here and implemented by the caller.

## The four ports the runtime borrows

`AgentRuntime` does none of these four itself, but each of them has to happen somewhere.

| Port | What the caller provides |
|---|---|
| `openScope(cwd, peers)` | build a capability container for that directory |
| `open(input)` | create a session: write the row, choose the identity, hand back `WakeMaterials` |
| `nameOf(sessionId)` | the session's current name, read from its row; `undefined` = no such session |
| `log` | a `LogSink`; omit it and nothing is logged |

`WakeMaterials` is everything needed to assemble one agent, given from above: `cwd`, `agentId`, `modelId` / `modelParams`, `lineage`, `history`, the `waiting` entries not taken last time, and the plugins this session wants mounted (optional). None of it is fetched by the runtime itself: the history and the untaken entries exist in storage only the host can read, and the three-level model resolution has exactly one implementation, in `createAgent`.

## Scope: one container per directory

A `Scope` holds the configuration, the working directory, the agent-definition directory, the plugins, and the tools that came out of them. It runs a three-stage pipeline per agent — `discover` → `candidates` → `instantiate` — so what an agent can use is decided when that agent is built, not when each call arrives.

```ts
const scope = new Scope({ getConfig: () => config.read(), agentsDir, cwd })
  .use(...allInOne({ toolsPaths, skillsPaths, subAgentsPaths, mcpPaths }));
await scope.init();
```

`getConfig` is a port rather than a snapshot: after a configuration change, `refresh()` reads it again instead of rebuilding the container. `use()` must happen before `init()`; after `init()` it throws.

| Member | What it does |
|---|---|
| `init()` | reads the configuration once, runs the first discovery, then locks plugin registration |
| `refresh()` | reads the configuration again and lets every plugin discover again |
| `dispose()` | disposes the plugins in reverse order (disconnecting MCP servers, for instance) |
| `filter(definition, options?)` | collects candidate names from every plugin, drops `exclude`, then applies the four permission dimensions |
| `instantiate(filtered)` | turns names into tool instances, then deduplicates by tool name |
| `buildTools(definition, options?)` | the two steps in one call |

`filter` is a pure name operation and builds nothing; `exclude` means "this layer must not see that name" (a subagent resolving its own tools excludes itself, which is what keeps delegation from recursing), and it is applied before permissions.

## The five capability sources

`allInOne(options)` returns the five standard plugins in this order — built-in tools, user tools, skills, MCP, sub-agents.

| Plugin | Source |
|---|---|
| `BuiltinToolsScopePlugin` | the built-in tool set; each tool declares its own availability (`isAvailable`) |
| `UserToolsScopePlugin` | tool scripts found on disk |
| `SkillsScopePlugin` | skill directories, plus the tools that load a skill |
| `McpScopePlugin` | MCP servers |
| `SubAgentsScopePlugin` | sub-agent definitions on disk, exposed as one delegation tool each |

When two sources offer a tool of the same name, the later registration stays (`instantiate` deduplicates by tool name, scanning from the end). That is tool-name deduplication, not "the later source beats the earlier one at everything": skills, MCP servers and subagents are each judged on their own dimension, and none of them renames another.

`allInOne` options: `skillsPaths`, `toolsPaths`, `subAgentsPaths`, `mcpPaths`, `logger`, `mcpTaskNotice`. To drop or replace one source, construct the plugins one by one and `use()` them. Without a logger nothing is logged: the four plugins that read disk report "this file could not be read" to it.

## Permissions: four dimensions, and disclosure

Four dimensions, each independent, each `{ allow: [...] }` or `{ deny: [...] }`, with `*` supported. No match means denied; a dimension with no policy at all means denied; with the whole `permissions` object missing, all four deny — allowing by default is a dangerous default.

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

One dimension cannot set both `allow` and `deny`; doing so throws. Matching: `tools` by tool name, `skills` by skill id, `mcps` by server name, `subagents` by the function name of that delegation tool.

Filters are applied to candidate names before instantiation, so a denied capability is not merely refused when called — the model never sees it. What it cannot see, it does not invent and does not keep trying.

`PermissionEvaluator` is the only implementation of that rule: `filter(candidates)` runs all four dimensions at once, `isAllowed(name, dimension)` judges one name, and `match(name, policy)` is the pure rule without an instance.

## Definitions, configuration and models

| Member | What it owns |
|---|---|
| `ConfigManager` | `config.json` and the directories beside it: read, write, factory defaults, recovery of a broken file, reasoning presets, factory skills, `mcp.json` |
| `AgentRepository` | one agent definition per file, `<agentsDir>/<id>.json` |
| `createAgent(scope, agentId, options)` | one assembled `SdkAgent`: definition read, model resolved, tools built from the filtered candidates |
| `resolveModel` / `resolveModelParams` | session override > definition > `config.defaultModel`, the only implementation |
| `createModel` / `createModelFromConfig` | the `OpenAI` client, the model name and the request parameters |
| `completeOnce` | one non-streaming call with no tools and no history |

Three levels of model resolution, nearer to "this time" first: the session-level override (this session said "use this model"), the model bound to the agent definition, and `config.defaultModel` as the fallback. All three empty means there really is no model, and `createAgent` throws instead of quietly picking a factory model — otherwise the user believes they are on the configured model while the request and the bill land somewhere else.

The resolution produces a value and a level, because the parameters have to follow the level: parameters come from whichever level supplied the model, and levels are never mixed. Once a session switches model, the parameters on the agent definition were written for the old model (they may carry a `thinking` shape only that model accepts), and mixing them in means sending the old parameters to the new model. So a session that switches model carries no parameters at all and lets the model use its own factory defaults.

`createAgent` options:

| Option | What it does |
|---|---|
| `modelId` / `modelParams` | the session-level override, and the parameters belonging to that same level |
| `lifetime` | `"one-shot"` builds an agent that runs once and dies; resident by default |
| `canOpenPeers` | whether this session may open further peer sessions (see below) |
| `abortedToolRoundStrategy` / `abortedMessageStrategy` | the two interruption strategies; when omitted they come from `config.json`, and only then from the kernel defaults |

`SdkAgent` is an `Agent` that also carries `scope` and `definition` (the definition as it is in effect, with the resolved model written into it), plus `useModel(modelId, modelParams?)` — change model and parameters in place without killing the agent: memory, queue, both gates and the in-flight request stay untouched, and the next request reads those three fields from the top.

## Handoff: write the document, then change hands

`HandoffService` has two halves: write a handoff document, then decide whether to replace the memory with it.

| Method | What it does |
|---|---|
| `handoff(params)` | gives the agent one instruction to write the document, and changes nothing else about the session |
| `migrate(params)` | writes the document, then computes the new memory and commits it |

Two modes for who writes the document: `self` (the same agent, in its own session — the default) and `summary` (one separate model call over a serialized history, no tools and no original context). There is no automatic transition between them: whichever one was asked for is the one that runs, and failing is failing — switching executors mid-way would make a failed handoff look like a successful one.

Two strategies for the old memory: `omit` (marked `omit: true` and kept, no longer sent to the model — the default) and `prune` (physically removed, leaving only the template messages from the definition).

The memory after the swap is two pieces: the template (the system prompts) and one breakpoint message at the end — `role: system`, `hidden`, carrying only the document path. That shape is computed here; `commitMemory` only decides where it lands: without it the SDK replaces `agent.messages` in place, with it the SDK touches nothing and the caller stores it.

`HandoffGuardPlugin` is the guard for the handoff batch: during it, the only write that passes is the one to the handoff document itself; every other write tool is refused with a sentence the model can read and act on. It also observes whether that write happened (`arm` returns an outcome and a "batch over" promise; `disarm` lets everything through again). It is a guard against mistakes in the workspace, not a sandbox: a shell command can still write files.

Cancellation only honours the `signal` the caller passes in; the service holds no cancel handle of its own. Cancellation surfaces as `HandoffAbortedError`, with no downgrade and no silent retry in the other mode — that would burn one more full request for nothing. `handingOff` says "this service is running one right now", and the auto-migrate plugin steps aside on it, so a handoff cannot trigger an auto-migrate that triggers another handoff.

## Agent plugins

Mounted on an agent, not on the container.

| Plugin | What it does |
|---|---|
| `AutoMigratePlugin` | when the agent goes idle it reads the `prompt_tokens` of the last response and calls `migrate()` if that crossed the soft line; it holds the `HandoffService` and `handoffTokens`, and `resolveMode` decides who writes this time |
| `AutoRefreshToolsPlugin` | refreshes the tool list before each request by default (configurable to once per batch) |
| `ContextGuardPlugin` | the hard line: a request whose pre-flight usage exceeds `guardTokens` is refused; the handoff request does not get an exemption |
| `SubAgentGuardInstallerPlugin` | installs the same hard line on subagents — guarding only the main session is not guarding |
| `HandoffGuardPlugin` | the write guard for the handoff batch |
| `UnknownToolHintPlugin` | a hint when the model calls a tool that does not exist (mostly useful on the MCP side) |
| `AssetTransportPlugin` | rebuilds assets into real content for the current model; the copy that goes out is rebuilt for the model actually being sent to |

Both usage lines are absolute values: `handoff` (the soft line — after a response, a `prompt_tokens` above it triggers a handoff) and `guard` (the hard line — before a request, usage above it refuses the request). `guard` should be clearly larger than `handoff`, leaving room for the extra requests a handoff batch needs; to loosen it, change the number, because there is no implicit multiplier.

## Peer sessions

A peer session is another session an agent opens for itself: its own agent, its own context, its own usage, and it stays in the session list afterwards.

The model side is three tools, and they implement nothing themselves.

| Tool | What it does |
|---|---|
| `create_session` | open a peer session and return `{ sessionId, label }` at once |
| `read_session_status` | whether it is working or idle, whether it is alive, its name, an excerpt of its last message |
| `post_message` | put one message in that session's inbox |

`PeerSessionsScopePlugin` takes a `PeerSessionPort` with three methods — `create` (return as soon as it exists), `status` (read live plus an excerpt of the last line), `send` (deliver without waiting for a result) — and without a port it produces no tools at all. The runtime implements that port (`RuntimePeerSessions`), which is why the three tools also work when no host is around.

A delivery does not look at the relation between the two sessions, and its receipt says only that the message is in the other inbox. Refusals are structured so the model can read them and change plan: `gone` (no such session) and `dead` (the row exists, no agent behind it, so nobody will take it); creating can also be refused with `depth_exceeded` or `model_unresolved`, and a port that enforces a limit can add `too_many_peers`.

Neither an excerpt of a peer's history nor a message count is ever returned: the model gets one short excerpt of the last line, so it does not start treating another session's transcript as its own context.

Preventing nesting is structural, not validated at call time: an agent that was itself opened as a peer is built with `canOpenPeers: false`, so it has no `create_session` on its hands — creating is one level deep and the model cannot even try. `post_message` and `read_session_status` stay, because peers talk both ways. This is enforced with `exclude`, not by editing `permissions` in the definition: the definition file is user-editable configuration, and this rule does not live there.

## The two background tools

Two built-in tools return immediately and report later.

| Tool | What it does |
|---|---|
| `async_exec` | run a shell command in the background; its output and exit status are pushed back into the session as a new message |
| `async_timeout` | a timer; when it fires, a message carrying the task id is pushed back |

Both only deliver: the model has no second tool to "check the result" or "wait for the result", and does not poll. The result comes back through one delivery into the same session, at low priority, so it never lands inside the batch that is currently running. Task ids come from one counter per agent (`async_exec-1`, `async_timeout-2`), and everything still running is reaped when the agent is stopped or killed.

A one-shot agent gets neither of them (`ASYNC_TASK_TOOL_NAMES` is stripped at assembly): the result arrives after its call stack has returned, so there would be nobody to deliver it to. This is the same rule the kernel states for resident versus one-shot, enforced where the tools are chosen.

## Scopes: when a container is disposed

`Scopes` owns the container registry: one container per `cwd`, shared by every session working in that directory.

| Member | What it does |
|---|---|
| `for(cwd)` | the container for that directory, built on first use |
| `dispose(cwd)` | tear it down — refuses while any session is still alive on that directory |
| `refreshAll()` | let every already-built container re-read the configuration, and report how many were refreshed and which failed |
| `disposeAll()` | tear down everything, for process shutdown |

There is no idle timer, no reference counting and no automatic collection: a container lives because someone holds it, and it is torn down when someone tears it down. "Nobody is using it" is not a decidable state. Tearing down refuses rather than cascading, because a cascade would silently kill sessions that are in the middle of work.

"Configuration changes take effect immediately" lands here: when the configuration changes, the runtime lets every already-built container read it again, and the container lets every plugin discover again; on the MCP side that reconciles against the definitions, disconnecting removed and changed servers and touching unchanged ones not at all. Directories nobody has used are not included — they have no container, and the next `for` builds one from the new configuration.

## The runtime: wake and post

`AgentRuntime` keeps one resident agent per session and forwards the kernel's facts.

| Member | What it does |
|---|---|
| `wake(sessionId, materials)` | assemble, register, start; idempotent, concurrent calls share one assembly |
| `post({ from, to, content })` | put one sentence in another session's inbox; answers `{ ok: true }` or a reason (`gone` / `dead`) |
| `status(sessionId)` | whether it is working or idle, whether it is alive, its name, an excerpt of the last thing it said |
| `openPeer({ from, prompt, agentId?, modelId?, label? })` | open a peer session, wake it, deliver the first prompt, return immediately |
| `kill(sessionId)` | unregister, kill, report that it is gone |
| `close()` | kill everything and tear every container down |
| `observe(listener)` | subscribe to the facts; returns an unsubscribe function |
| `get(sessionId)` / `sessionOf(agent)` / `aliveOn(cwd)` | the snapshots: which agent, which session, which sessions on that directory |
| `scopes` / `peerSessions` | the container registry, and the peer-session port this runtime implements |

`post` neither creates nor revives a session: if the target has no agent, the message was not delivered, and the sending side decides what to tell the user. The two refusal reasons must stay apart — `gone` is a session that no longer exists, `dead` is a row that exists with nobody to take the message. Delivery is low priority: a sentence that was posted should not wedge itself between the tool calls of the batch in hand.

Facts are a discriminated union: `resident:appeared` and `resident:gone` (the runtime's own two), `scope:appeared` / `scope:refreshed` / `scope:gone` (from the container registry), and every kernel event of every agent — unchanged in name and payload, with the `sessionId` added.

There is no "wait until it is done" on the runtime: a resident session is never done, it goes from working to idle and can be pushed again at any moment. Nothing in the runtime waits for a caller; a delivery is what wakes a session up. An assembly that fails throws and leaves no register entry — a half-assembled session in the register tells the outside world "it is alive" while it cannot even take a message.

## Example

```ts
import { ConfigManager, DEFAULT_AGENT_ID, Scope, allInOne, createAgent } from "@ai-zen/agents-sdk";

const base = "/path/to/data";
const config = new ConfigManager(`${base}/config.json`);
// puts config.json, the default agent definition, mcp.json and the factory skills in place
// in one call (existing files are never overwritten)
await config.bootstrap();

const scope = new Scope({
  getConfig: () => config.read(),
  agentsDir: `${base}/agents`,
  cwd: base,
}).use(...allInOne({ mcpPaths: [`${base}/mcp.json`] }));
await scope.init();

const agent = await createAgent(scope, DEFAULT_AGENT_ID);

const idle = new Promise<void>((resolve) => {
  const offIdle = agent.on("state:idle", () => {
    offIdle();
    resolve();
  });
});

agent.push({ content: "What is a Scope?", priority: "low", source: { kind: "user" } });
void agent.start();
await idle;

console.log(agent.messages.at(-1)?.content);
agent.stop();
await scope.dispose();
```

The version where two sessions talk to each other is in [Getting Started](getting-started.md): `AgentRuntime` assembles the agents and keeps the register of what is alive, `post` sends one sentence to another session, and the session that was posted to goes from idle to working on its own and back to idle.

## Reading on

- [Getting Started](getting-started.md) — the smallest agent without a host, and two sessions talking to each other
- [Architecture](architecture.md) — the four layering tests, the four questions for live objects, the direction of facts and materials
- [Core API](core.md) — what this package sits on: inbox, the two loops, the two gates, events and hooks
- [MCP](mcp.md) — where server configuration comes from, how a connection is made, how tools reach the model
