# @ai-zen/agents-core

Core framework for building LLM agents, providing the base abstractions needed to build intelligent agents. Works in both Node.js and browser environments.

The agent runtime is **plugin-driven** and runs directly on the **official OpenAI SDK** (`openai` package) — no in-house request layer.

## Installation

```bash
npm install @ai-zen/agents-core
```

## Core Concepts

### Agent

`Agent` is the core class. It extends `AgentContext` and manages the conversation lifecycle, supporting streaming, tool calls, and multi-round recursive conversations.

```typescript
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

// 1. Create an OpenAI SDK client (any OpenAI-compatible endpoint via baseURL)
const client = new OpenAI({
  apiKey: "sk-xxx",
  baseURL: "https://api.openai.com/v1",
});

// 2. Create an Agent
const agent = new Agent({
  client,
  model: "gpt-4o",
  modelConfig: { temperature: 0.7 },
});

// 3. Add a system message
agent.append(Message.System("You are an AI assistant."));

// 4. Send a message and await the reply
await agent.send("Hello, please introduce yourself.");

// 5. Get the reply
console.log(agent.messages.at(-1)?.content);
```

The `client` is an `openai` SDK instance — any OpenAI-compatible vendor (OpenAI, DeepSeek, Zhipu BigModel, Azure OpenAI via a compatible endpoint, etc.) is supported through `baseURL`.

### AgentContext

`AgentContext` is the base class of every Agent and holds the following core configuration:

```typescript
interface AgentContext {
  client: OpenAI;                    // openai SDK client
  model: string;                     // Model name sent to the API
  modelConfig: Record<string, unknown>; // Model params (temperature etc.), spread into the request; may include vendor-specific fields (e.g. DeepSeek `thinking`)
  messages: AgentNS.Message[];       // Message list
  tools: Tool[];                     // Tool list
  allowJsonParseError: boolean;      // Whether JSON parse errors are allowed (default true)
}
```

- `append(message)` — appends a message to the message list and returns it
- Extension happens through **plugins** (`agent.use(plugin)`), not constructor hooks

### Message

Create messages for various roles using static factory methods:

```typescript
import { Message, AgentNS } from "@ai-zen/agents-core";

// System message
Message.System("You are an assistant.");

// User message (plain text)
Message.User("Hello");

// User message (multimodal: text + image)
Message.User([
  { type: "text", text: "What is this?" },
  { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
]);

// User message (text + image with detail level: low / high / original / auto)
Message.User([
  { type: "text", text: "Read the text in this screenshot" },
  { type: "image_url", image_url: { url: "https://example.com/img.jpg", detail: "high" } },
]);

// User message (text + file referenced by file_id via the Files API)
Message.User([
  { type: "text", text: "What is in this image?" },
  { type: "file", file_id: "file-api-xxxxxxxxxxxxxxxx" },
]);

// Assistant message (Pending by default, waiting for the AI reply)
Message.Assistant();

// Tool call result
Message.Tool(toolCall, "execution result");

// Function call result
Message.Function(functionCall, "execution result");
```

Message status enum:

| Status | Description |
|--------|-------------|
| `Pending` | Waiting for processing |
| `Writing` | AI is generating |
| `Completed` | Done |
| `Error` | An error occurred |
| `Aborted` | Aborted |

### Tool

Abstract base class that extends the Agent's capabilities. Custom tools must extend `Tool`, declare a `function` definition, and implement the `exec()` method:

```typescript
import { Tool, ToolCallContext } from "@ai-zen/agents-core";

class WeatherTool extends Tool {
  // Tool definition lives with its implementation (class-body field)
  function = {
    name: "get_weather",
    description: "Query the weather",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
  };

  async exec(ctx: ToolCallContext) {
    const { city } = ctx.parsedArgs;
    return `The weather in ${city} today is sunny, 22°C.`;
  }
}

// Register on an Agent
const agent = new Agent({ client, model: "gpt-4o", tools: [new WeatherTool()] });
```

`exec()` returns `AgentNS.MessageContent` — either a plain string (text result) or an array of content sections (multimodal result). Returning content sections lets a tool hand structured content back to the model, e.g. an image:

```typescript
async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent> {
  // 文本结果
  return `The weather in ${city} today is sunny.`;

  // 图片/文件结果：模型直接看到
  return [
    { type: "text", text: "当前截图：" },
    { type: "image_url", image_url: { url: "https://example.com/shot.png" } },
  ];
}
```

### Built-in Tools

#### CallbackTool
Define a tool quickly via a callback function. The callback receives `(parsedArgs, ctx)` — use `ctx` (a `ToolCallContext`) to access the agent, abort signal, etc.

```typescript
import { CallbackTool } from "@ai-zen/agents-core";

const tool = new CallbackTool({
  function: {
    name: "calculator",
    description: "Calculate the sum of two numbers",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  callback(parsedArgs, ctx) {
    // ctx: ToolCallContext — e.g. ctx.agent, ctx.signal, ctx.preventDefault()
    return parsedArgs.a + parsedArgs.b;
  },
});
```

#### CodeTool
> **Deprecated** — string-code tools (defined via `new Function`) lack type safety and clear parameter mapping. Prefer `CallbackTool` or a custom `Tool` subclass. Kept for backward compatibility.

#### AgentTool
Expose a sub-Agent as a tool, enabling nested Agent calls. The sub-Agent has its own client, model, message list, and tools.

```typescript
import { AgentTool, Message } from "@ai-zen/agents-core";

const tool = new AgentTool({
  function: {
    name: "general_assistant",
    description: "Delegate complex tasks to a general assistant",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task to handle" },
      },
      required: ["task"],
    },
  },
  client,            // Reuse the main Agent's client, or use a dedicated one
  model: "gpt-4o",   // The sub-Agent's model name
  messages: [
    Message.System("You are a general assistant good at completing various tasks independently."),
    Message.User("Please complete the following task: {{task}}"), // {{variable}} is substituted at call time
  ],
  tools: [], // Tools available to the sub-Agent
});
```

> **Note**: The last message in an AgentTool's message list must be a User message, where `{{variableName}}` placeholders are automatically replaced with `parsedArgs` at call time.

#### AgentToolLazy
Like `AgentTool`, but the sub-Agent is not built at construction time — it is built lazily via a `buildAgent(parsedArgs, ctx)` callback at execution time. This avoids recursive construction issues when building tool lists (SubAgent → build tool list → SubAgent → …).

```typescript
import { AgentToolLazy, Agent, Message } from "@ai-zen/agents-core";

const tool = new AgentToolLazy({
  function: { /* ... */ },
  messages: [Message.System("..."), Message.User("...")],
  async buildAgent(parsedArgs, ctx) {
    // ctx.agent gives access to the parent Agent
    return new Agent({
      client: ctx.agent.client,
      model: parsedArgs.model ?? "gpt-4o",
      tools: [/* ... */],
    });
  },
});
```

#### IndexedSearchTool
A keyword-based local search tool that automatically extracts keywords from entries as the enum.

```typescript
import { IndexedSearchTool } from "@ai-zen/agents-core";

const tool = new IndexedSearchTool({
  entries: [
    { keywords: ["price", "fee"], text: "This product costs $99/month" },
    { keywords: ["support", "warranty"], text: "One-year free warranty is provided" },
  ],
});
```

### Plugins — the only extension point

`AgentContext` no longer provides any `onXxx` constructor hooks. **Plugins are the only way to extend the Agent.** Register a plugin with `agent.use(plugin)`, then `await agent.init()`.

```typescript
import { Agent, Message } from "@ai-zen/agents-core";
import type { AgentPlugin, SendContext, ToolCallContext, UnknownToolContext } from "@ai-zen/agents-core";

const guard: AgentPlugin = {
  // Fired before send(); a string rejects this send (throws)
  onBeforeSend(ctx: SendContext) {
    if (ctx.content.includes("secret")) {
      return "This content is not allowed.";
    }
  },

  // Fired before every tool call; a string rejects the tool (reason returned to the LLM)
  onToolCall(ctx: ToolCallContext) {
    if (ctx.tool_call.function?.name === "rm") {
      return `Tool "rm" is rejected: requires explicit user authorization.`;
    }
    // undefined = allow
  },

  // Fired when the LLM calls an unregistered tool; a string is used as the tool result
  onUnknownTool(ctx: UnknownToolContext) {
    return `Tool "${ctx.toolCall.function?.name}" is unavailable.`;
  },
};

const agent = new Agent({ client, model: "gpt-4o", tools: [weatherTool] });
agent.use(guard);
await agent.init();
```

#### AgentPlugin hooks

| Hook | Arguments | Returning a string means |
|------|-----------|--------------------------|
| `onInit` | — | initialization, no short-circuit |
| `onBeforeSend` | `SendContext` | reject the send (throws) |
| `onAfterSend` | `SendContext` | short-circuit later plugins only |
| `onInnerLoopStart` | `SendContext` | interrupt this round (throws) |
| `onInnerLoopEnd` | `SendContext` | short-circuit later plugins only |
| `onInnerLoopsStart` | `SendContext` | interrupt the whole group (throws) |
| `onInnerLoopsEnd` | `SendContext` | short-circuit later plugins only |
| `onToolCall` | `ToolCallContext` | reject the tool, the reason is returned to the LLM |
| `onUnknownTool` | `UnknownToolContext` | used as the tool result; `undefined` → default hint |

#### HookResult — unified short-circuit semantics

Every hook returns `HookResult = string | void | Promise<string | void>`:

- **string** → short-circuits (reject / interrupt / provide a result, per the table above)
- **undefined / void** → passes through (continue with later plugins or the default behavior)

Multiple plugins run in registration order; the first to return a string short-circuits.

#### dispatchHook — unified entry for events + plugins

Internally every hook goes through `dispatchHook`: it first emits a **non-blocking** kebab-case event (`agent.events`), then **blockingly** invokes plugin hooks in order. So you can either observe via events (non-blocking, cannot affect the flow) or intervene via plugins (blocking, can short-circuit).

Event names: `before-send` / `after-send` / `inner-loop-start` / `inner-loop-end` / `inner-loops-start` / `inner-loops-end` / `tool-call` / `unknown-tool`.

**Unknown tool fallback**: the Agent keeps a simple built-in hint. Smarter hints come from the `onUnknownTool` plugin (e.g. the SDK's `UnknownToolHintPlugin` for MCP guidance, registered explicitly by the caller). Plugins have the highest priority; an `undefined` return falls back to the built-in hint.

### ToolCallContext

A single class spanning **interception decision → execution**. The same instance is passed to both the `onToolCall` hook (pre-execution interception) and `Tool.exec(ctx)` (actual execution).

| Property | Description |
|----------|-------------|
| `agent` | The Agent instance that triggered the call |
| `tool_call` | Unified tool call shape (`{ id?, type?, function: { name, arguments } }`) |
| `tool` | The matched registered tool (undefined if not registered) |
| `function_call` | Compatibility field, equal to `tool_call.function` (legacy shape) |
| `parsedArgs` | The JSON-parsed argument dictionary |
| `resultMessage` | The tool result message — execution result / rejection reason / parse error are written here |
| `isPreventDefault` | Whether the automatic continuation of the conversation is blocked |
| `parseError` | JSON parse error info (when `allowJsonParseError=true`) |
| `signal` | Abort signal for this tool execution (fires on `abort()`; tools can listen to truly interrupt) |
| `preventDefault()` | Marks the conversation to stop auto-continuing to the next round |

## How the Agent Works

### Conversation Flow

```
send(content)
  ├── onBeforeSend hook → may reject
  ├── Appends a User message
  └── run()
        ├── onInnerLoopsStart hook (once per send)
        ├── Inner loop (repeats while tool calls continue)
        │     ├── Appends an Assistant placeholder (Pending) at the start
        │     ├── onInnerLoopStart hook (before each request)
        │     ├── client.chat.completions.create(...) — streaming via the official SDK
        │     ├── parseStreamData() → content / reasoning_content / tool_calls
        │     ├── handleToolCall() → executes tool calls
        │     │     ├── onToolCall interception hook → may reject
        │     │     ├── onUnknownTool plugin (may provide a hint) → built-in fallback
        │     │     └── Tool.exec(ctx) executes the matched tool
        │     └── onInnerLoopEnd hook
        ├── onInnerLoopsEnd hook
        └── returns this.messages
  └── onAfterSend hook
```

### Tool Call Handling

- When the model returns `tool_calls`, the Agent automatically executes the matching tools (in parallel)
- Tool execution results are appended to the message list as Tool role messages
- If all tools succeed and `preventDefault()` was not called, the Agent automatically starts a new round (feeding the results back to the model)
- If `allowJsonParseError = true` (default), parse failures automatically send the error back to the AI for correction
- Unregistered tools go through `onUnknownTool` plugins (any string is used as the tool result), falling back to a simple built-in hint

### Event System

The Agent provides an event bus. Events are non-blocking notifications (they cannot affect the flow — use plugins to intervene):

```typescript
// Lifecycle events (payload = the corresponding hook ctx)
agent.events.on("before-send", (ctx: SendContext) => {});
agent.events.on("after-send", (ctx: SendContext) => {});
agent.events.on("inner-loop-start", (ctx: SendContext) => {});
agent.events.on("inner-loop-end", (ctx: SendContext) => {});
agent.events.on("inner-loops-start", (ctx: SendContext) => {});
agent.events.on("inner-loops-end", (ctx: SendContext) => {});
agent.events.on("tool-call", (ctx: ToolCallContext) => {});
agent.events.on("unknown-tool", (ctx: UnknownToolContext) => {});

// Streaming / lifecycle events
agent.events.on("open", () => {});                       // connection established
agent.events.on("chunk", (chunk) => {});                 // raw streamed chunk
agent.events.on("chunk-parsed", (receiver, chunk) => {});// chunk merged into the receiver message
agent.events.on("parsed", (receiver) => {});             // full response parsed
agent.events.on("error", (error) => {});                 // an error occurred
agent.events.on("finally", () => {});                    // run finished (success or failure)

// Sub-Agent events
agent.events.on("sub-agent", ({ agent, ctx }) => {});    // an AgentTool sub-agent started
agent.events.on("sub-agent-end", ({ agent, ctx }) => {});// sub-agent ended
```

### Aborting

```typescript
agent.abort(); // Abort all in-flight inner-loop tasks of the current round
```

## More Examples

### Multi-round Conversation with Tools

```typescript
const agent = new Agent({
  client,
  model: "gpt-4o",
  tools: [new WeatherTool(), new CalculatorTool()],
  allowJsonParseError: true, // Let the AI auto-correct argument format errors
});

// Add a system prompt
agent.append(Message.System("You are a weather assistant. You can use tools to query the weather."));

// Send a message; the Agent automatically handles tool calls and multi-round conversations
await agent.send("What is the weather like in Beijing and Shanghai today?");
```

## Testing

```bash
pnpm test
```

## License

MIT
