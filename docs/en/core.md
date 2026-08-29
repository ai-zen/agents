---
title: Core API
description: The public API of @ai-zen/agents-core — Agent / AgentContext / Message / Tool / ToolCallContext, built-in tools, plugins, and the event system.
outline: deep
---

# Core API

`@ai-zen/agents-core` provides the basic abstractions needed to build LLM Agents, compatible with both Node.js and browsers. The runtime is **directly based on the official `openai` SDK** and does not maintain an internal request layer.

## Installation

```bash
npm install @ai-zen/agents-core
```

## Agent

`Agent` is the core class, extending `AgentContext`. It manages the conversation lifecycle and supports streaming, tool calls, and multi-turn recursive dialogs.

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({ apiKey: "sk-xxx", baseURL: "https://api.openai.com/v1" });
const agent = new Agent({ client, model: "gpt-4o", modelConfig: { temperature: 0.7 } });
agent.append(Message.System("You are an AI assistant."));
await agent.send("Hello.");
```

Constructor arguments are inherited from `AgentContext` (see below), where `client` and `model` are required.

Core methods:

| Method | Description |
|------|------|
| `use(plugin)` | Register a plugin |
| `init()` | Initialize all registered plugins (runs each plugin's `onInit`) |
| `send(content)` | Send a user message, returning the conversation message array |
| `run(ctx?)` | Drive one round of conversation (called internally by `send`) |
| `abort()` | Abort all in-progress inner-loop tasks for the current round |

Key fields:

| Field | Description |
|------|------|
| `events` | Event bus (non-blocking notifications) |
| `lastUsage` | Token usage of the most recent API response |
| `messages` | Message list (inherited from `AgentContext`) |
| `tools` | Tool list (inherited from `AgentContext`) |

## AgentContext

The base class for all Agents, holding core configuration.

```ts
interface AgentContext {
  client: OpenAI;                          // openai SDK client
  model: string;                           // model name sent to the API
  modelConfig: Record<string, unknown>;    // model parameters (temperature, etc., passed through into the request body)
  messages: AgentNS.Message[];             // message list
  tools: Tool[];                           // tool list
  allowJsonParseError: boolean;            // whether to allow JSON parse errors (default true)
}
```

Constructor signature: `{ client, model, modelConfig?, messages?, tools?, allowJsonParseError? }`.

- `append(message)` — append a message and return it.
- Extension should be done via **plugins** (`agent.use(plugin)`), not constructor hooks.

## Message

Create messages for various roles using static factory methods.

```ts
import { Message } from "@ai-zen/agents-core";

Message.System("You are an assistant.");          // system message
Message.User("Hello");                             // user message (plain text)
Message.Assistant();                               // assistant message (defaults to Pending, waiting for the AI reply)
Message.Tool(toolCall, "execution result");        // tool result
Message.Function(functionCall, "execution result");// function result
```

Multimodal user messages (text + image / file):

```ts
Message.User([
  { type: "text", text: "What is this?" },
  { type: "image_url", image_url: { url: "https://example.com/img.jpg", detail: "high" } },
]);

Message.User([
  { type: "text", text: "What is in this image?" },
  { type: "file", file_id: "file-api-xxxxxxxxxxxxxxxx" },
]);
```

`MessageStatus` enum: `Pending` / `Writing` / `Completed` / `Error` / `Aborted` / `Unknown`.

> Since core `4.1.0`, `AgentNS.Message.id` is required. Assigning a plain object literal to `Message` / `Message[]` will not compile; use the factory methods above.

## Tool (abstract base class)

To define a custom tool, extend `Tool`, declare the `function` definition in the class body, and implement `exec(ctx)`.

```ts
import { Tool, ToolCallContext } from "@ai-zen/agents-core";

class WeatherTool extends Tool {
  function = {
    name: "get_weather",
    description: "Query the weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  };

  async exec(ctx: ToolCallContext) {
    const { city } = ctx.parsedArgs;
    return `The weather in ${city} today is sunny, 22°C.`;
  }
}
```

`exec` returns `AgentNS.MessageContent`: it may return a string (text) or an array of content blocks (multimodal, such as `image_url` / `file`).

## Built-in tools

| Tool | Description |
|------|------|
| `CallbackTool` | Quickly define a tool with a callback function; callback signature `(parsedArgs, ctx)` |
| `CodeTool` | ⚠️ Deprecated. A string-code tool (`new Function`) that lacks type safety; kept for backward compatibility |
| `AgentTool` | Expose a sub-Agent as a tool; `{{variable}}` placeholders in template messages are replaced at call time |
| `AgentToolLazy` | Similar to `AgentTool`, but lazily builds the sub-Agent via `buildAgent(parsedArgs, ctx)` at execution time, avoiding recursive build problems |
| `IndexedSearchTool` | Keyword-based local search tool; automatically extracts an enum from entry keywords |

`CallbackTool` example:

```ts
import { CallbackTool } from "@ai-zen/agents-core";

const tool = new CallbackTool({
  function: { name: "calculator", description: "Calculate the sum", parameters: { /* ... */ } },
  callback(parsedArgs, ctx) {
    return parsedArgs.a + parsedArgs.b;   // ctx carries agent / signal, etc.
  },
});
```

## ToolCallContext

A single instance spans "interception decision → execution"; the `onToolCall` hook and `Tool.exec(ctx)` receive the same instance.

| Field | Description |
|------|------|
| `agent` | The Agent that triggered the call |
| `tool_call` | Unified-shape tool call `{ id?, type?, function: { name, arguments } }` |
| `tool` | The matched registered tool (`undefined` if not registered) |
| `function_call` | Compatibility field, equivalent to `tool_call.function` |
| `parsedArgs` | JSON-parsed argument dictionary |
| `resultMessage` | The tool result message |
| `isPreventDefault` | Whether to prevent the next conversation round |
| `parseError` | JSON parse error message |
| `signal` | Abort signal for this tool's execution |
| `preventDefault()` | Mark to stop automatically proceeding to the next round |

## Plugins — the only extension point

```ts
import { Agent, Message } from "@ai-zen/agents-core";
import type { AgentPlugin, SendContext, ToolCallContext, UnknownToolContext } from "@ai-zen/agents-core";

const guard: AgentPlugin = {
  onBeforeSend(ctx: SendContext) {
    if (ctx.content.includes("secret")) return "This content is not allowed.";
  },
  onToolCall(ctx: ToolCallContext) {
    if (ctx.tool_call.function?.name === "rm") return `Tool "rm" is rejected.`;
  },
  onUnknownTool(ctx: UnknownToolContext) {
    return `Tool "${ctx.toolCall.function?.name}" is unavailable.`;
  },
};

agent.use(guard);
await agent.init();
```

### Hooks and their "returns string" semantics

| Hook | Argument | Semantics of returning string |
|------|------|---------------------|
| `onInit` | — | initialization, no short-circuit |
| `onBeforeSend` | `SendContext` | reject send (throw) |
| `onAfterSend` | `SendContext` | only short-circuits subsequent plugins |
| `onInnerLoopStart` | `SendContext` | interrupt this round (throw) |
| `onInnerLoopEnd` | `SendContext` | only short-circuits subsequent plugins |
| `onInnerLoopsStart` | `SendContext` | interrupt the whole group (throw) |
| `onInnerLoopsEnd` | `SendContext` | only short-circuits subsequent plugins |
| `onToolCall` | `ToolCallContext` | reject that tool; the reason is returned to the LLM as the tool result |
| `onUnknownTool` | `UnknownToolContext` | return as a tool result; `undefined` falls through to the default hint |

`HookResult = string | void | Promise<string | void>`. Multiple plugins are called in registration order; the first to return a string short-circuits.

## Event system

Events are **non-blocking** notifications (they do not affect the flow; use plugins if intervention is needed). Event names use **kebab-case** and are emitted internally by `dispatchHook` and `run`.

```ts
agent.events.on("before-send", (ctx: SendContext) => {});
agent.events.on("tool-call", (ctx: ToolCallContext) => {});
agent.events.on("unknown-tool", (ctx: UnknownToolContext) => {});

// Streaming / lifecycle
agent.events.on("open", () => {});
agent.events.on("chunk", (chunk) => {});
agent.events.on("chunk-parsed", (receiver, chunk) => {});
agent.events.on("parsed", (receiver) => {});
agent.events.on("error", (error) => {});
agent.events.on("finally", () => {});

// Sub-Agent
agent.events.on("sub-agent", ({ agent, ctx }) => {});
agent.events.on("sub-agent-end", ({ agent, ctx }) => {});
```

Event names corresponding to hooks: `before-send` / `after-send` / `inner-loop-start` / `inner-loop-end` / `inner-loops-start` / `inner-loops-end` / `tool-call` / `unknown-tool`.

## Abort

```ts
agent.abort();  // Abort all in-progress inner-loop tasks for the current round
```

## Related documentation

- [Quick Start](getting-started.md)
- [Architecture](architecture.md)
- [`packages/core/README.md`](../../packages/core/README.md) — the English README maintained in the core package (more complete examples)
- [`packages/core/CHANGELOG.md`](../../packages/core/CHANGELOG.md) — version and breaking-change history
