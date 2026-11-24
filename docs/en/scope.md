---
title: Core and Scope alone
description: No AgentRuntime, no host — a Scope needs only a function that returns the config, a directory of agent definitions and a cwd; plugins are attached by the caller, and createAgent is enough to run a round.
outline: deep
---

# Core and Scope alone

`Scope` is the container for capabilities. It does not depend on `AgentRuntime`, and it does not depend on a host. It asks for three things: a function that returns the config, a directory of agent definitions, and a `cwd`. Plugins are attached explicitly — `Scope` attaches no default plugin of its own.

The code below was run to check it: a fake endpoint (`@ai-zen/fake-llm`) stood in for the model, a constant object stood in for `config.json`, and one definition file stood in for the agent. The last `assistant` message came back holding exactly what the fake endpoint said.

```ts
import { Scope, allInOne, createAgent } from "@ai-zen/agents-sdk";

// Where the config comes from is the caller's business: a constant here, a file elsewhere.
// It is a function rather than a snapshot so that `scope.refresh()` can read the current one.
const config = {
  endpoints: [{ id: "local", name: "Local", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "..." }],
  models: [{ id: "m1", name: "M1", endpointId: "local", modelName: "gpt-4o-mini" }],
  defaultAgent: "writer",
};

const scope = new Scope({
  getConfig: () => config,
  agentsDir: "/path/to/agents", // one file per definition: <agentsDir>/<id>.json
  cwd: "/path/to/project",
}).use(...allInOne());

await scope.init();

// One-shot: run one message, wait for idle, close, hand back what this run produced
const agent = await createAgent(scope, "writer", { lifetime: "one-shot" });
const messages = await agent.runOnce("Are you there?");
console.log(messages.at(-1)?.content);

await scope.dispose();
```

About the endpoint fields: `baseUrl` and `apiKey` are required; `capabilities` states what the endpoint
can do (e.g. `filesApi`); `headers` are extra headers sent with every request; `providerSessionHeader`
names the header that carries the session identifier.

Some providers route traffic and match prompt caches by a stable session identifier, and require it in a
specific header. That is what `providerSessionHeader` is for: every request then carries the current
Agent's `providerSessionId` (one per live Agent, each SubAgent its own):

```ts
endpoints: [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/inference/go/v1",
    apiKey: "...",
    providerSessionHeader: "x-opencode-session", // without it the answer is 400
  },
];
```

The main Agent uses its session's id (the same string across restarts, so the cache survives), and the
auxiliary naming request carries the same one. A hand-written key of the same name in `headers` wins.

Outgoing requests carry our own `User-Agent` (`ai-zen-agents/<version>`) rather than pretending to be a
generic SDK; a same-named key in `headers` wins over it.

`<agentsDir>/writer.json` is one definition:

```json
{
  "id": "writer",
  "name": "Writer",
  "messages": [{ "role": "system", "content": "Answer in one sentence." }],
  "modelId": "m1",
  "permissions": { "tools": { "allow": ["*"] } }
}
```

`permissions` cannot be left out. Missing means nothing is allowed: the same definition without that field gives `buildTools()` nothing; with `tools.allow: ["*"]` and only `BuiltinToolsScopePlugin` attached it gives 20. Both were measured.

## You choose which capabilities are attached

`allInOne()` attaches all five sources at once; you can also attach only some of them — every source is a `ScopePlugin`:

```ts
import { BuiltinToolsScopePlugin, SkillsScopePlugin, Scope } from "@ai-zen/agents-sdk";

const scope = new Scope({ getConfig: () => config, agentsDir, cwd }).use(
  new BuiltinToolsScopePlugin(), // the built-in tools: read, write, run a command
  new SkillsScopePlugin(), // skills
);
```

| Plugin | What it contributes |
|---|---|
| `BuiltinToolsScopePlugin` | the built-in tools |
| `UserToolsScopePlugin` | tools written by the user (`tools/`) |
| `SkillsScopePlugin` | skills |
| `McpScopePlugin` | MCP servers and the five tools they are spread into |
| `SubAgentsScopePlugin` | sub-agents |

With no plugin attached `Scope` still works: `filter()` / `buildTools()` come back empty, the agent holds no tools and is left with the model and the session. The reverse holds too — plugins attached but no `permissions` in the definition also leaves it with none.

## The resident kind

`lifetime: "one-shot"` means "run once and be gone". To keep one `Agent` taking the next message, omit that option and finish it yourself:

```ts
const agent = await createAgent(scope, "writer");
const idle = new Promise<void>((resolve) => {
  const off = agent.on("state:idle", () => {
    off();
    resolve();
  });
});

void agent.start(); // resolves only when the agent dies; it cannot be awaited here
runtime.agent.send("Are you there?");
await idle;
agent.stop();
```

## When `AgentRuntime` is the right thing

What is above is enough for a process that talks to one `Agent`. These are the things `Scope` does not do, and they are `AgentRuntime`'s work:

several sessions alive at once that need to talk to each other (`AgentRuntime.post()`); a register of what is alive (`get()` / `status()` / `aliveOn()`); one `Scope` shared by the sessions of a directory, and when those containers are disposed (`scope:appeared` / `scope:gone`); forwarding an agent's events to an observer.

That usage is in the runtime section of the [SDK](sdk.md) page and in [Getting Started](getting-started.md).
