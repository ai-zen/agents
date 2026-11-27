# AI-Zen Agents

A self-hosted runtime for LLM agents. Once assembled, an agent stays resident: it processes one batch per delivery, returns to idle when the batch finishes, and waits for the next one. It can also be used for a single call with a single answer. Models are reached through OpenAI-compatible endpoints, and sessions, messages, credentials and capabilities all stay on your own machine.

## One call

The smallest use is two packages, one request, one answer:

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
await config.bootstrap(); // create directories, config.json and the default agent

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

No host is needed here — no database, no resident process, no network interface, just one request and one answer. A host is a resident service on a machine, described under "Turning it into a service". `core` is the agent itself (queue, request and tool loop, event stream); `sdk` assembles it from files.

`bootstrap()` writes a `config.json` with four factory endpoints, all of whose `apiKey` fields are empty; fill one in and it runs. The default agent is bound to `deepseek-flash`.

## The same agent, resident

Dropping `lifetime` makes it resident: it no longer ends with that one call, and waits for deliveries once assembled.

```ts
const agent = await createAgent(scope, DEFAULT_AGENT_ID);

agent.on("state:idle", () => {
  console.log(agent.messages.at(-1)?.content);
});

void agent.start();
agent.send("look at this directory");
agent.send("check the scripts in package.json"); // queued behind the first, does not interrupt it
```

`send()` returns as soon as the entry is queued. The agent works in the background, returns to idle when the batch finishes, and `state:idle` appears in the event stream; while the queue still holds entries it does not report idle.

- An idle agent sends no requests, does not poll and uses no CPU; it stays resident in memory
- Deliveries go into a queue and are not lost while the agent works. They are queued by priority: high is taken at the boundary between tool executions in the current batch, low waits until the batch ends
- Three ways to stop: `abort()` interrupts the in-flight request and stops taking further entries for this batch; `stop()` accepts no new input and terminates once the drain is processed; `kill()` terminates immediately and discards the queue
- The event stream is the only way to observe it: `started`, `messageAdded`, `delta`, `toolStarted`, `state:idle`, … Each event carries this agent's own monotonic sequence number and timestamp, and interfaces, logs and other agents all learn what happened by subscribing to it

`core` has no `run()` entry that takes input and returns a result, and no polling interface. A one-shot call is a wrapper over the resident form: `runOnce()` starts it, delivers one message, waits for idle and closes it.

**Tools do not block either.** The direct consequence of being resident is that a future result has a receiver: `async_exec` starts a command and returns immediately, and when the command ends (normal exit, killed by timeout, failed to start) its output and exit status are delivered back into the session as a new message. The agent may be idle at that moment; the message wakes it to carry on.

The same path serves three cases:

| When the result arrives | What is delivered |
|---|---|
| An `async_exec` command finishes | Output and exit status (killed by timeout is stated) |
| `async_timeout` reaches its deadline | A deadline reminder |
| An MCP server-side task reaches a terminal state | A notice pointing at `get_mcp_task_result` |

All three are delivered at high priority, for reliability rather than importance: whoever waits for the result is often polling (`sleep`, fetching repeatedly), a low-priority entry would wait for the end of the batch, and the batch is exactly where the polling sits — so the result could never get in.

Three matching constraints: a one-shot agent lacks both background tools, because it has no receiver that exists later; when the session is gone the notice is dropped and one line is logged, never reviving the session; `stop()` / `kill()` terminate the commands and timers outstanding under that session, leaving no orphans.

## Adding capabilities: put files in directories

22 tools are built in, covering file reading and writing, command execution, search, background commands and image generation and viewing. To add your own, put files in the directories:

```ts
.use(...allInOne({
  toolsPaths: [`${base}/tools`],
  skillsPaths: [`${base}/skills`],
  subAgentsPaths: [`${base}/sub-agents`],
  mcpPaths: [`${base}/mcp.json`],
}))
```

A tool is one file exporting an object with `function` and `exec`:

```js
// tools/echo.mjs
export default {
  function: {
    name: "echo",
    description: "Return the input unchanged",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  async exec(args) {
    return args.text;
  },
};
```

Changes take effect after `scope.refresh()`; in a host, `autoRefreshTools` decides when (before every request / at the start of each batch / only on `/reload`).

**What can be added is decided by permissions.** The `permissions` field of an agent definition has four dimensions — `tools`, `skills`, `mcps`, `subagents` — each written as either `allow` or `deny`, with `*` supported:

```json
"permissions": {
  "tools": { "deny": ["rm", "exec"] },
  "skills": { "allow": ["*"] },
  "mcps": { "allow": ["fs-server"] },
  "subagents": { "allow": [] }
}
```

Names outside the list never appear in the model's tool list. The model does not see them and therefore does not call them — this is not a rejection after the call happens. A dimension that is absent means everything in it is denied.

## Progressive disclosure: only entry points in the list

Skills already use progressive disclosure: the list carries one `load_skill` entry point and the body is read when it is needed. The same approach is extended here to MCP servers and sub-agents, each with a single entry point as well.

The tool list is sent with every request, so loading capabilities makes it longer. None of these three kinds put their content in the list; they contribute one entry point each:

| Entry point | When it enters the context |
|---|---|
| `load_skill` | When a procedure is needed: that skill's body |
| `load_mcp` | When a server is needed: connect and fetch its tools, resources, prompts and skills |
| `call_mcp_tool` | Calling a concrete tool on that server, with its own schema |
| `read_mcp_resource` · `get_mcp_task_result` | Reading a resource, fetching the result of a long task |
| Each sub-agent's own entry point | Delegating: the sub-agent runs in its own context |

However many MCP servers and skills are configured, the length of this agent's tool list does not change. Candidate names are enums, so the model selects instead of guessing; with no server configured the parameter degrades to free text and the description says so.

Connections are on demand as well: discovery only reads configuration files and establishes nothing; the connection is made at `load_mcp`; with `include_manifest=false` it connects without fetching the manifest.

## Turning it into a service

A host is responsible for three things outside the process: sessions and history persisted (surviving process exit), several clients connected at once, and sessions talking to each other. It owns the database, sessions, workspaces and credentials, exposes an interface on the loopback address, and assembles sessions into agents on demand.

```bash
pnpm -r --filter '@ai-zen/agents-host...' build

node packages/host/dist/cli.js serve            # listens on loopback port 8790 by default
node packages/host/dist/cli.js token create     # mint a credential for another device; plaintext shown once
node packages/host/dist/cli.js token list
node packages/host/dist/cli.js token revoke <id>
node packages/host/dist/cli.js stop
```

`serve` prints the listen address, version, discovery file and log directory; a local instance also provides a credential file that local clients read directly, so no credential has to be minted for them. Other arguments: `--port <n>`, `--host <addr>`, `--public` (accept non-loopback origins), `--ai-zen-dir <dir>`.

The database stores a digest of each credential; the plaintext cannot be read back after creation. The terminal client `@ai-zen/cli` is one consumer of these interfaces: a single executable with a pipeline mode and an interactive mode.

A host does not preload every session: a session has no agent before it is used, so a client wakes it and then delivers. Waking fills exactly one gap, "the row exists but the agent does not", and never creates a session. Process exit does not affect sessions either — the history is in the database, and the next wake reloads it together with the entries that were never taken.

## Sessions talking to each other

Three tools: `create_session`, `post_message`, `read_session_status`.

- Sessions are peers: one opened from another has its own history, tools and model, and is not a function call inside the parent
- Sending does not block: `post_message` returns once delivered, a busy peer still receives it, and it is taken at the peer's next tool boundary
- Both directions: the opened session has these three tools as well, minus `create_session`, so nesting stops at one level
- `read_session_status` answers busy/idle, name and the last sentence; it does not copy history — ask with `post_message` if you need the full text

The purpose is parallelism: several sessions each responsible for a part, passing results to each other; or opening a new session for a long task while the current one keeps talking to the user.

## Handoff when the context fills, not compression

Two thresholds live on the model definition: `tokenThresholds.handoff` is the soft line, crossed which the agent hands off when idle; `tokenThresholds.guard` is the hard line, compared before every request, crossing which the request is rejected. The factory values are 40% and 80% of the window.

Once a line is crossed the agent stops advancing and does two things: verify the real state (read-only — `read`, `glob`, `find_text`, `git status`, `git diff`; no source changes, no commits), then write the result into a markdown document.

**The difference from compression is what the artifact is.**

| | Compression | Handoff |
|---|---|---|
| Artifact | A passage inside the model context, gone when this generation ends | A markdown file in the project: `<project>/.ai-zen/handoffs/<timestamp>.md` |
| Content | Whatever the model chooses to keep; the reader cannot tell what was dropped | Nine fixed sections: conversation breakpoint, task goal, current state, completed, not completed, key decisions, constraints and preferences, file index, first step for the next agent |
| Truthfulness | Inferred from the conversation | Verified before writing: branch and commit, uncommitted changes, whether tests pass, whether ports are open, whether dependencies are installed; anything unverifiable must be marked `⚠️ Unverified`, speculation is forbidden |
| Reviewable | No, only its shape | Yes: open and read it, diff two handoffs, put it in version control, hand it to someone else for review |

Three things follow:

- **Auditable**: anyone can read why it was done this way, what was really finished, and what was left open, without trusting a summary
- **Traceable**: the host records one handoff as three rows in the database — a breakpoint message carrying only the document path, a notice saying "handoff document written to <path>", and an archived session row with `nameSource` set to `handoff`; the original history is attached whole to that row and stays readable
- **Continuable by someone else**: the document is plain markdown and the breakpoint message carries only its path, so continuing does not depend on this runtime. A different developer, a different coding agent, a different machine — reading that document is enough to carry on

The memory after a handoff is "the original template plus one breakpoint message carrying only the document path". Without a host the old messages are marked `omit` and kept in the array, never sent again; with a host they are removed entirely, because they already live in the archived session.

The nine-section format and the writing rules are themselves a factory skill (`skills/handoff/SKILL.md`) and can be edited.

## Cost

Model calls are billed per request, so there are only two sources of cost: how many requests are made, and how long each one's input is.

| Mechanism | What it saves |
|---|---|
| Prefix caching | Request bodies are rebuilt from a whitelist with no message ids or timestamps, so the prefix sent for one conversation is byte-for-byte stable; when the endpoint declares `providerSessionHeader`, a stable identifier is sent as well (the host uses the session id, unchanged across restarts) and the provider can hit its cache |
| Progressive disclosure | Skill bodies, remote MCP tools and sub-agent details never enter the tool list; they enter the context only when used |
| Tool output ceiling | When a single tool output exceeds 32768 characters (configurable), the excess does not enter the context whole: tools such as `exec` write the full text to a file and the model gets a head/tail preview with the path |
| Delegation isolation | A sub-agent has its own history and tools; the parent receives only its last message plus accumulated usage, and the dozens of tool calls in between never enter the parent's context |
| Separate helper requests | Automatic session naming and handoff summaries go through one-shot calls: not streamed, no tools; naming sends only the last 2000 characters, and a cheaper model can be named for both |
| No request past the hard line | Above the hard line the request is rejected outright, paying nothing for a request that cannot succeed |
| Results delivered back | Long commands and timers need no polling with `sleep`, and every poll is a full-input request |
| Interruption without rework | A partial answer can be kept (`abortedMessageStrategy: keep`) and continued in the next request; a tool round is kept whole (`fill`), so one interruption does not redo the entire round |
| Usage recorded | Every assistant message carries the token usage of the request that produced it; adding them up gives the session's actual consumption |

A `self` handoff costs 1–2 extra full-input requests, those inputs being longer than usual; what it replaces is a history that keeps growing.

## Reference

### Packages

| Package | Responsibility |
|---|---|
| `@ai-zen/agents-core` | The agent itself: one input queue, a request and tool loop, one event stream. No configuration files, no disk writes |
| `@ai-zen/agents-sdk` | Capability assembly and configuration: turns definition files, tools, skills, sub-agents and MCP into a runnable agent; the resident runtime and handoff live here too |
| `@ai-zen/agents-host` | Resident process: database, sessions, workspaces, credentials and assets, plus the loopback interface |
| `@ai-zen/cli` | Terminal client, with a pipeline mode and an interactive mode |
| `@ai-zen/agents-client` | Client library for connecting to a host (internal package, used by `cli`) |
| `@ai-zen/agents-logger` | File-based logging implementation |
| `@ai-zen/fake-llm` | Fake model server for tests |

### Data root

Taken from `AI_ZEN_DIR`, defaulting to `~/.ai-zen`:

```
~/.ai-zen/
├── config.json        endpoints, models, default model, context thresholds
├── agents/            one definition per agent, file name is the id
├── sub-agents/        sub-agent definitions (agent definitions with a function field)
├── skills/            one directory per skill
├── tools/             one file per user tool
├── mcp.json           MCP servers
├── ai-zen.db          sessions, messages, workspaces, assets, credentials
├── logs/
└── run/               host.json (where to connect), token (local credential), next-version.json
```

### Agent definition

`<data root>/agents/default.json` is a complete agent: the system prompt in `messages`, the model in `modelId`, the capabilities in `permissions`, request parameters in `modelParams`.

```json
{
  "id": "default",
  "name": "Default Assistant",
  "messages": [{ "role": "system", "content": "You are a helpful assistant." }],
  "modelId": "deepseek-flash",
  "permissions": {
    "tools": { "allow": ["*"] },
    "skills": { "allow": ["*"] },
    "mcps": { "allow": ["*"] },
    "subagents": { "allow": ["*"] }
  },
  "modelParams": { "thinking": { "type": "enabled" } }
}
```

The model is resolved in three levels: session override > `modelId` in the definition > `defaultModel` in `config.json`. When all three are empty it fails and names the definition that has no bound model. `modelParams` is shallow-merged over the model's `defaultParams`, so one model can carry a high reasoning effort for a coding agent and thinking disabled for a chat agent.

### Capability directory layers

The nearest layer wins on a name collision:

1. `<project>/.ai-zen/skills`
2. `<project>/.agents/{skills,tools,sub-agents}`
3. `<data root>/{skills,tools,sub-agents}`
4. `~/.agents/skills`

MCP has five files instead (the project root `mcp.json`, `<project>/.ai-zen/mcp.json`, `<project>/.agents/mcp.json`, `<data root>/mcp.json`, `~/.agents/mcp.json`), merged into one effective list.

Tool files are `.js` / `.mjs` and are evaluated with `import()`, so loading them blocks `process.exit` and `process.abort`, redirects `console` to stderr, and abandons a single file that has not finished loading within five seconds.

### Built-in tools

`cwd`, `read`, `inspect_file`, `write`, `edit`, `batch_edit`, `find_text`, `glob`, `ls`, `exist`, `mkdir`, `rm`, `rename`, `copy`, `exec`, `spawn`, `sleep`, `download_file`, `async_exec`, `async_timeout`, `generate_image`, `view_image`.

A one-shot agent (`lifetime: "one-shot"`) lacks `post_message`, `create_session`, `read_session_status`, `async_exec` and `async_timeout`: it belongs to no session and has no receiver existing later, so those tools offer it only paths that must fail.

## Development

Build entries live at the repository root: `pnpm build-core`, `pnpm build-logger`, `pnpm build-sdk`, `pnpm build-host`, `pnpm build-client`, `pnpm build-fake-llm`. `pnpm test` builds the dependencies first and then runs the packages in order.

The end-to-end suites need real ports, real disks and real WebSockets, so they are not part of `pnpm test`:

```bash
cd packages/host
npx vitest run                                  # domain tests: no ports, no real disk writes
npx vitest run --config vitest.e2e.config.ts    # end to end
```

## License

MIT
