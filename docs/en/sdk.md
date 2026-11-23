---
title: SDK
description: The capability face and the runtime — the three-stage pipeline and five capability sources of a Scope, four-dimensional permissions as disclosure, three-level model resolution, handoff's two methods and two strategies, the plugins attached to an Agent, the three peer-session tools, the two background tools, and when a container is disposed.
outline: deep
---

# SDK

`@ai-zen/agents-sdk` is two halves behind one package name.

- The capability face turns the kernel into an `Agent` that can do something: capabilities discovered from disk, a model resolved from configuration, permissions, handoff.
- The runtime keeps those `Agent`s alive and lets them talk to each other: one resident `Agent` per session, facts forwarded outward, `post()` from one session to another.

The kernel (`@ai-zen/agents-core`) sits underneath both. This page covers what this package adds around it, and the boundary of each addition.

| Half | Members |
|---|---|
| Capability face | `createAgent`, `SdkAgent`, `Scope` + its five capability sources (`allInOne`), `PermissionEvaluator`, `ConfigManager`, `AgentRepository`, `HandoffService` + `HandoffGuardPlugin`, `completeOnce`, the built-in tools and their output guard |
| Runtime | `AgentRuntime` (`wake` / `post` / `status` / `openPeer` / `kill` / `close` / `observe` / `get` / `sessionOf` / `aliveOn`), `Scopes`, `RuntimePeerSessions` |

```bash
pnpm add @ai-zen/agents-sdk
```

## How to use

Three steps: put the configuration file and the factory entries where they belong (`config.bootstrap()`), build a `Scope` and attach capability sources to it (`Scope(...).use(...allInOne())`), then build an `Agent` from an id (`createAgent`).

```ts
import { ConfigManager, DEFAULT_AGENT_ID, Scope, allInOne, createAgent } from "@ai-zen/agents-sdk";

const base = "/path/to/data";
const config = new ConfigManager(`${base}/config.json`);
// puts config.json, the default AgentDefinition, mcp.json and the factory skills in place in one call
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

agent.send({ content: "What is a Scope?", priority: "low", source: { kind: "user" } });
void agent.start();
await idle;

console.log(agent.messages.at(-1)?.content);
agent.stop();
await scope.dispose();
```

The `Scope` needs two facts: where to read configuration from (`getConfig`), and which directory this container counts as (`cwd`) — capabilities are discovered under that directory. `allInOne()` attaches all five sources at once. Once built, the `Agent` behaves exactly as in the kernel: `send()` to deliver, `start()` to run, wait for `state:idle`, `stop()` to finish, and `dispose()` on the container when done.

For capabilities without the runtime, `Scope` plus `createAgent` is enough — no `AgentRuntime`, no host. That usage is in [Core and Scope alone](scope.md) (the code there was run, including the part where a definition with no `permissions` gets no tools at all).

For two sessions that talk to each other, use `AgentRuntime`: it assembles the `Agent`s, keeps the register of what is alive, and `post()` sends one sentence to another session, which goes from idle to working on its own and back to idle. That one is in [Getting Started](getting-started.md).

## Layering: what this package does not do

| Not here | Where |
|---|---|
| database, tables, migrations | the host |
| connections, discovery files, credentials | the host |
| user-facing copy, language, i18n | the host |
| session rows | the host — inside this package a session is an opaque identity string |

The rule for judging the layering: this package never imports the host. Sessions travel as `string`; what a session is called is asked through a port and never stored. Code that needs to know "who is alive", "who knows whom", "when is it assembled, when is it disposed" belongs to the runtime; code that reads and writes files, writes rows, forwards events, verifies credentials or renders copy belongs to the host.

The reverse also holds: an `as unknown as` cast, or a fake instance conjured up to satisfy something in this package, means a port is missing — the port belongs here, implemented by the caller.

## The four ports the runtime borrows

`AgentRuntime` does none of these four things itself, but each one has to be done somewhere.

| Port | What the caller provides |
|---|---|
| `openScope(cwd, peers)` | build a `Scope` for that directory |
| `open(input)` | build a session: write the row, fix the identity, hand back `WakeMaterials` |
| `nameOf(sessionId)` | the session's current name, read off its row; `undefined` = no such session |
| `log` | a `LogSink`; nothing is logged without one |

`WakeMaterials` is everything needed to assemble one `Agent`, handed down from above: `cwd`, `agentId`, `modelId` / `modelParams`, `lineage`, `history`, the `waiting` `InboxEntry`s not yet taken last time, and the plugins this session wants (optional). None of it is fetched by the runtime: the copy of the history and of the untaken entries that lives in the database is known only to the host, and three-level model resolution is implemented in exactly one place, `createAgent`.

## Scope: one container per directory

A `Scope` holds the configuration, the working directory, the `AgentDefinition` directory, the plugins, and the tools those plugins produce. It runs a three-stage pipeline for every `Agent` — `discover` → `candidates` → `instantiate` — so what an `Agent` may use is fixed at the moment it is built, not at every call.

```ts
const scope = new Scope({ getConfig: () => config.read(), agentsDir, cwd })
  .use(...allInOne({ toolsPaths, skillsPaths, subAgentsPaths, mcpPaths }));
await scope.init();
```

`getConfig` is a port, not a snapshot: when the configuration changes, `refresh()` reads it again instead of the container being rebuilt. `use()` has to come before `init()`; calling `use()` after `init()` throws.

| Member | What it does |
|---|---|
| `init()` | read the configuration once, run the first discovery, then lock plugin registration |
| `refresh()` | read the configuration again and make every plugin discover again |
| `dispose()` | release the plugins in reverse order (disconnecting MCP connections, for instance) |
| `filter(definition, options?)` | collect the candidate names from every plugin, remove `exclude`, then filter through the four-dimensional permissions |
| `instantiate(filtered)` | turn names into tool instances, then de-duplicate by tool name |
| `buildTools(definition, options?)` | the two steps above in one |

`filter` deals in names only and builds no tools; `exclude` means "this layer should not see this name" (a `SubAgent` excluding itself while resolving its own tools, to prevent recursion), and it applies before permissions.

## The five capability sources

`allInOne(options)` returns the five standard plugins in this order — built-in tools, user tools, skills, MCP, `SubAgent`.

| Plugin | Source |
|---|---|
| `BuiltinToolsScopePlugin` | the built-in tool set; each tool declares its own availability (`isAvailable`) |
| `UserToolsScopePlugin` | tool scripts found on disk |
| `SkillsScopePlugin` | the skills directory, and the tools that load skills |
| `McpScopePlugin` | MCP servers |
| `SubAgentsScopePlugin` | `SubAgent` definitions on disk; one definition expands into one delegation tool |

When two sources offer a tool with the same name, the one registered later stays (`instantiate` de-duplicates by tool name, keeping from the back). That is de-duplication of tool names, not "everything from the later source beats the earlier one": skills, MCP servers and `SubAgent`s are each judged in their own dimension, and none of them overwrites another's names.

The `allInOne` options: `skillsPaths`, `toolsPaths`, `subAgentsPaths`, `mcpPaths`, `logger`, `mcpTaskNotice`. To drop or replace one source, build the plugins one by one and `use()` them — that form is also in [Core and Scope alone](scope.md). With no `logger` nothing is logged at all: the four plugins that read disk report "this file could not be read" to it.

## Permissions: four dimensions, and disclosure

Four dimensions, each independent, each either `{ allow: [...] }` or `{ deny: [...] }`, with `*` supported. No match means denied; a dimension with no policy at all means denied; the whole `permissions` missing means all four denied — allowing by default is a dangerous default.

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

`allow` and `deny` cannot both appear in one dimension; writing both throws. Matching: `tools` by tool name, `skills` by skill id, `mcps` by server name, `subagents` by the function name of that delegation tool.

Filtering applies to candidate names before instantiation, so a denied capability is not "held back at call time" — the model never sees it. What it cannot see it will not make up, and will not keep trying.

`PermissionEvaluator` is the only implementation of that rule: `filter(candidates)` runs all four dimensions at once, `isAllowed(name, dimension)` judges one name, and `match(name, policy)` is a pure predicate that needs no instance.

## Definitions, configuration and models

| Member | What it manages |
|---|---|
| `ConfigManager` | `config.json` and the directories around it: reading and writing, factory defaults, recovery from a broken file, the reasoning preset table, factory skills, `mcp.json` |
| `AgentRepository` | one file per `AgentDefinition`, `<agentsDir>/<id>.json` |
| `createAgent(scope, agentId, options)` | a fully assembled `SdkAgent`: reads the definition, resolves the model, builds tools from the filtered candidates |
| `resolveModel` / `resolveModelParams` | session-level override > definition > `config.defaultModel`, the only implementation |
| `createModel` / `createModelFromConfig` | the `OpenAI` client, the model name and the request parameters |
| `completeOnce` | one non-streaming call with no tools and no history |

Three-level model resolution, the closer to "this one call" the higher the priority: the session-level override (this session said "use this model this time"), the model bound on the `AgentDefinition`, and `config.defaultModel` as the fallback. All three empty means there really is no model, and `createAgent` fails outright rather than quietly picking a factory model — otherwise the user believes the one in the config is in use while the requests and the bill land somewhere else.

Resolution produces a value plus a preset, because the parameters follow the preset: the parameters come from the level the model came from, never mixed across levels. Once a session has switched models, the parameters on its `AgentDefinition` were written for the old model (they may carry a `thinking` shape only the old model understands), and mixing them in sends old parameters to a new model. So a session that switched models carries nothing and lets the model use its own factory parameters.

The `createAgent` options:

| Option | What it does |
|---|---|
| `modelId` / `modelParams` | the session-level override, and the parameters that belong to that same level |
| `lifetime` | `"one-shot"` builds an `Agent` that dies after one run; resident by default |
| `canOpenPeers` | whether this session may open peer sessions at all (see below) |
| `abortedToolRoundStrategy` / `abortedMessageStrategy` | the two interruption strategies; when omitted they come from `config.json`, and only then from the kernel default |

`SdkAgent` is an `Agent`, carrying `scope` and `definition` on the side (the definition in effect, with the resolved model written into it), plus `useModel(modelId, modelParams?)` — swap the model and its parameters in place without killing the `Agent`: memory, inbox, the two switches and the request in flight are all untouched, and the next request reads those three cells fresh.

## Handoff: write the document, then change hands

`HandoffService` is two halves: write a handoff document first, then decide whether to replace memory with it.

| Method | What it does |
|---|---|
| `handoff(params)` | give the `Agent` an instruction to write that document; nothing else about the session changes |
| `migrate(params)` | write the document, compute the new memory and commit it |

Who writes it comes in two modes: `self` (the same `Agent`, in its own session — the default) and `summary` (serialise the history and make one separate model call, with no tools and no original session context). There is no automatic transition between them: whichever is asked for is what runs, and failing is reported as failure — switching to another writer would make a failed handoff look like a success.

The old memory is dealt with by one of two strategies: `omit` (mark it `omit: true` and keep it, never sending it to the model again — the default) and `prune` (delete it physically, leaving only the template messages from the definition).

The memory after the swap has exactly two parts: the template (the system prompt messages) and one handoff breakpoint at the end — `role: system`, `hidden`, whose body carries only the document path. That shape is computed inside the SDK; `commitMemory` only decides where it lands: without it the SDK replaces `agent.messages` in place, with it the SDK touches not a byte and the caller persists.

`HandoffGuardPlugin` guards that batch: the only write allowed in it is the handoff document itself, every other write tool is refused, with a sentence the model can understand and act on. It also watches whether that write actually happened (`arm` returns a result and a "this batch is over" promise; after `disarm` everything is allowed again). It protects the working directory from being mangled; it is not a sandbox — shell commands can still write files.

Cancellation recognises only the `signal` the caller passes in: the service holds no cancellation handle of its own. Cancellation surfaces as `HandoffAbortedError`, with no degradation and no quiet re-run in another mode — that would burn a whole extra full request. `handingOff` says "this service is running a handoff right now", and the auto-handoff plugin stands aside accordingly, so a handoff does not trigger an auto handoff that triggers another handoff.

## Plugins attached to an `Agent`

Attached to the `Agent`, not to the container.

| Plugin | What it does |
|---|---|
| `AutoMigratePlugin` | on the way to idle, looks at the last answer's `prompt_tokens` and calls `migrate()` if it crossed the soft line; it holds the `HandoffService` and `handoffTokens`, and `resolveMode` decides who writes this time |
| `AutoRefreshToolsPlugin` | rediscovers capabilities and rebuilds the tool table from what it found; by default before every request, configurable to once per batch |
| `ContextGuardPlugin` | the hard line: refuse the request when usage before it exceeds `guardTokens`; it does not stand aside for a handoff batch |
| `SubAgentGuardInstallerPlugin` | installs the same hard line on `SubAgent`s — guarding only the main session guards nothing |
| `HandoffGuardPlugin` | the write guard for a handoff batch |
| `UnknownToolHintPlugin` | a hint when the model calls a tool that does not exist (most useful on the MCP side) |
| `AssetTransportPlugin` | materialises assets for the current model, and rebuilds the copy being sent against the model actually used |

Both usage lines are absolute numbers: `handoff` (soft — hand off once `prompt_tokens` after a response exceeds it) and `guard` (hard — refuse before a request that exceeds it). `guard` should be clearly larger than `handoff`, leaving room for the extra requests of a handoff batch; to loosen it, raise the number — there is no implicit multiplier.

## Peer sessions

A `PeerSession` is another session an `Agent` opens for itself: its own `Agent`, its own context, its own usage, and it stays in the session list afterwards.

On the model side there are three tools, and they implement nothing themselves.

| Tool | What it does |
|---|---|
| `create_session` | open a `PeerSession` and return `{ sessionId, label }` at once |
| `read_session_status` | whether it is working or idle, whether it is still alive, what it is called, a summary of its last message |
| `post_message` | put one message into that session's inbox |

`PeerSessionsScopePlugin` takes a `PeerSessionPort` with three methods — `create` (returns at once), `status` (reads now plus a summary of the last sentence), `post` (delivers without waiting for a result, the same name and the same meaning as `AgentRuntime.post()`) — and produces no tools at all without the port. The runtime implements exactly this port (`RuntimePeerSessions`), so those three tools work with no host present.

Delivery does not look at the relationship between the two sessions, and the receipt only says the message reached the other side's inbox. Refusals are structured so the model can read them and change tack: `gone` (no such session) and `dead` (the row exists but no `Agent` stands behind it, so nobody will take it); creation can also be refused with `depth_exceeded` and `model_unresolved`, plus `too_many_peers` when the port enforces a limit itself.

Nothing about a `PeerSession`'s history is returned — neither a summary nor a message count: the model gets a short piece of the last sentence only, so it cannot import another session's record as its own context.

Preventing nesting is structural, not checked at call time: an `Agent` that was itself opened as a `PeerSession` gets `canOpenPeers: false` from `createAgent` and therefore has no `create_session` — opening a `PeerSession` is one level deep only, and the model cannot even try. `post_message` and `read_session_status` remain, because peers talk in both directions. The rule lands through `exclude` and does not touch the `permissions` in the definition: that file is configuration the user edits, and this rule does not live there.

## The two background tools

Two built-in tools that return at once and report later.

| Tool | What it does |
|---|---|
| `async_exec` | run a shell command in the background; its output and exit status arrive as a new message in this session |
| `async_timeout` | a timer; when it fires, a message carrying the task id arrives |

Both only deliver: the model holds no second tool to "check the result" or "wait for the result", and does not poll. The result comes back to the same session through one `send()`, at low priority, so it never lands in the batch currently running. The task id comes from a per-`Agent` counter (`async_exec-1`, `async_timeout-2`), and when the `Agent` stops or is killed, everything still running is torn down.

A one-shot `Agent` gets neither (`ASYNC_TASK_TOOL_NAMES` is removed at assembly): by the time the result returns, its call stack is gone and there is nobody to send it to. That is the same rule the kernel states for "resident versus one-shot", applied at the step where tools are chosen.

## Scopes: when a container is disposed

`Scopes` holds the register of `Scope`s: one container per `cwd`, shared by every session in that directory.

| Member | What it does |
|---|---|
| `for(cwd)` | the container for that directory, built on first use |
| `dispose(cwd)` | dispose it — refused while sessions in that directory are still alive |
| `refreshAll()` | make every container already built read the configuration again; reports how many were refreshed and which were not |
| `disposeAll()` | dispose everything, for process exit |

There is no idle timer, no reference counting and no automatic collection: a container lives because somebody holds it, and it is disposed when somebody disposes it. "Nobody is using it" is not a decidable state. Disposal refuses rather than taking other things down with it — taking things down with it would quietly kill a session halfway through its work.

"Configuration changes take effect immediately" lands here: when the configuration changes, the runtime makes every container already built read it again, and each container makes its plugins discover again; the MCP side reconciles by definition, disconnecting what was deleted or changed and touching not a byte of what did not change. Directories nobody has used are not among them — they have no container, and the next `for` builds one from the new configuration.

## The runtime: wake and post

`AgentRuntime` keeps one resident `Agent` per session and forwards the kernel's facts outward.

| Member | What it does |
|---|---|
| `wake(sessionId, materials)` | assemble, register, start; idempotent, concurrent calls share one assembly |
| `post({ from, to, content })` | put one sentence into another session's inbox; returns `{ ok: true }` or a reason (`gone` / `dead`) |
| `status(sessionId)` | whether it is working or idle, whether it is still alive, what it is called, a summary of its last message |
| `openPeer({ from, prompt, agentId?, modelId?, label? })` | open a `PeerSession`, wake it, hand it the first sentence, return at once |
| `kill(sessionId)` | unregister, kill, report that it is gone |
| `close()` | kill everything and dispose every container |
| `observe(listener)` | subscribe to facts; returns the unsubscribe function |
| `get(sessionId)` / `sessionOf(agent)` / `aliveOn(cwd)` | snapshots: which `Agent`, which session, which sessions are alive in that directory |
| `scopes` / `peerSessions` | the `Scope` register, and the `PeerSessionPort` this runtime implements |

`post()` neither creates nor revives a session: if the target has no `Agent`, nothing was delivered, and how to tell the user is the sender's decision. The two refusal reasons must stay apart — `gone` means the session is gone, `dead` means the row is there but nobody is taking. Delivery priority is low: a sentence that arrives from elsewhere should not be slipped between the tool calls of the batch in hand.

Facts are one discriminated union: `resident:appeared` and `resident:gone` (the runtime's own two), `scope:appeared` / `scope:refreshed` / `scope:gone` (from the `Scope` register), plus every kernel event of every `Agent` — names and payloads unchanged, with a `sessionId` added.

There is no "wait until it is done" on the runtime: a resident session is never done, it goes from working to idle and can be sent to again at any moment. Nothing in the runtime waits for a caller; a `send()` is what wakes a session up. An assembly that fails throws and leaves no register entry — a half-assembled session in the register tells the outside world "it is alive" while it cannot even take a message.

## Reading on

- [Getting Started](getting-started.md) — the smallest `Agent` without a host, and two sessions talking to each other
- [Core and Scope alone](scope.md) — capabilities without the runtime
- [Architecture](architecture.md) — the four layering tests, the four questions for live objects, the direction of facts and materials
- [Core API](core.md) — what this package sits on: inbox, the two loops, the two switches, events and hooks
- [MCP](mcp.md) — where server configuration comes from, how a connection is made, how tools reach the model
