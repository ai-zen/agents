# @ai-zen/agents-core

Core framework for building LLM agents, providing the base abstractions needed to build intelligent agents. Works in both Node.js and browser environments.

## Installation

```bash
npm install @ai-zen/agents-core
```

## Core Concepts

### Agent

`Agent` is the core class. It extends `AgentContext` and manages the conversation lifecycle, supporting streaming, tool calls, and multi-round recursive conversations.

```typescript
import { Agent, Message, ChatGPT, OpenAI } from "@ai-zen/agents-core";

// 1. Create an endpoint
const endpoint = new OpenAI({
  api_key: "sk-xxx",
  openai_endpoint: "https://api.openai.com/v1",
});

// 2. Create a model
const model = new ChatGPT({
  request_config: await endpoint.chatCompletion("gpt-4"),
  model_config: { temperature: 0.7 },
});

// 3. Create an Agent
const agent = new Agent({ model });

// 4. Add a system message
agent.append(Message.System("You are an AI assistant."));

// 5. Send a message and await the reply
await agent.send("Hello, please introduce yourself.");

// 6. Get the reply
console.log(agent.messages.at(-1)?.content);
```

### AgentContext

`AgentContext` is the base class of every Agent and holds the following core configuration:

```typescript
interface AgentContext {
  model: ChatCompletionModel;      // Chat model
  model_config: any;               // Model parameters
  messages: AgentNS.Message[];     // Message list
  tools: Tool[];                   // Tool list
  rag?: Rag;                       // RAG retrieval augmentation
  allowJsonParseError: boolean;    // Whether JSON parse errors are allowed (default true)
}
```

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

Abstract base class that extends the Agent's capabilities. Custom tools must extend `Tool` and implement the `exec()` method:

```typescript
import { Tool, ToolCallContext } from "@ai-zen/agents-core";

class WeatherTool extends Tool {
  constructor() {
    super({
      function: {
        name: "get_weather",
        description: "Query the weather",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
          },
          required: ["city"],
        },
      },
    });
  }

  async exec(ctx: ToolCallContext) {
    const { city } = ctx.parsed_args;
    return `The weather in ${city} today is sunny, 22°C.`;
  }
}

// Register on an Agent
const agent = new Agent({ model, tools: [new WeatherTool()] });
```

### Built-in Tools

#### CallbackTool
Define a tool quickly via a callback function. Inside the `callback`, `this` refers to the `ToolCallContext` instance.

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
  callback(parsedArgs) {
    // this points to ToolCallContext
    return parsedArgs.a + parsedArgs.b;
  },
});
```

#### CodeTool
Define tool logic using string code, executed dynamically via `new Function`. Parameter names must match the keys in `parameters.properties`.

```typescript
import { CodeTool } from "@ai-zen/agents-core";

const tool = new CodeTool({
  function: {
    name: "add",
    description: "Add two numbers",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
  code: "return a + b;", // a and b are directly available as variables
});
```

#### AgentTool
Expose a sub-Agent as a tool, enabling nested Agent calls. The sub-Agent has its own model, message list, and tools.

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
  model: chatModel, // Reuse the main Agent's model, or use a dedicated one
  messages: [
    Message.System("You are a general assistant good at completing various tasks independently."),
    Message.User("Please complete the following task: {{task}}"), // {{variable}} is substituted at call time
  ],
  tools: [], // Tools available to the sub-Agent
});
```

> **Note**: The last message in an AgentTool's message list must be a User message, where `{{variableName}}` placeholders are automatically replaced with `parsed_args` at call time.

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

### Endpoint

Defines how to connect to an API, building the URL, Headers, and Body of HTTP requests.

```typescript
import { OpenAI, AzureOpenAI, CommonEndpoint } from "@ai-zen/agents-core";

// OpenAI standard API
const endpoint = new OpenAI({
  api_key: "sk-xxx",
  openai_endpoint: "https://api.openai.com/v1",  // optional, defaults to https://api.openai.com/v1/
  organization: "org-xxx",                         // optional
  headers: { "X-Custom": "value" },                // optional extra request headers
  body: { user: "user-id" },                       // optional extra request body fields
});

// Azure OpenAI
const azureEndpoint = new AzureOpenAI({
  azure_endpoint: "https://xxx.openai.azure.com",
  api_key: "xxx",
  api_version: "2024-02-15-preview",
});

// Common endpoint (any OpenAI-compatible API)
const commonEndpoint = new CommonEndpoint({
  url: "https://your-api.com/v1/chat/completions",
  headers: { Authorization: "Bearer sk-xxx" },
});

// Build a request
const config = await endpoint.chatCompletion("gpt-4");
// config.url => "https://api.openai.com/v1/chat/completions"
// config.headers => { "Content-Type": "application/json", "Authorization": "Bearer sk-xxx", ... }
// config.body => { model: "gpt-4", ... }
```

**Built-in endpoints**:

| Class | Static property `title` | Description |
|-------|-------------------------|-------------|
| `OpenAI` | `"OpenAI"` | OpenAI standard API, also compatible with any OpenAI-format API |
| `AzureOpenAI` | `"Azure OpenAI"` | Azure OpenAI service; note the second argument is the deployment name, not the model name |
| `CommonEndpoint` | `"Common"` | Common endpoint: specify the full URL directly, minimal customization |
| `Zhipu` | `"Zhipu"` | ZhipuAI (deprecated; prefer connecting via the OpenAI-compatible API) |

### Model

#### ChatCompletionModel
```typescript
import { ChatGPT } from "@ai-zen/agents-core";

const model = new ChatGPT({
  model_config: {
    temperature: 0.7,
    max_tokens: 2048,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  },
  request_config: await endpoint.chatCompletion("gpt-4"),
});

// Streaming generation
const stream = model.createStream({
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
  onOpen: () => console.log("Connection established"),
  onError: (err) => console.error(err),
  onFinally: () => console.log("Done"),
});

for await (const chunk of stream) {
  console.log(chunk.choices?.[0]?.delta?.content);
}

// Non-streaming generation
const response = await model.createCompletion({
  messages: [{ role: "user", content: "Hello" }],
  tools: [],
});
```

Capability flags:

| Property | Description |
|----------|-------------|
| `IS_SUPPORT_FUNCTION_CALL` | Whether function calls are supported (legacy) |
| `IS_SUPPORT_TOOLS_CALL` | Whether tool calls are supported (modern) |
| `IS_SUPPORT_IMAGE_CONTENT` | Whether image input is supported |
| `INPUT_MAX_TOKENS` | Maximum input tokens |
| `OUTPUT_MAX_TOKENS` | Maximum output tokens |

#### EmbeddingModel
```typescript
import { TextEmbeddingAda002_2 } from "@ai-zen/agents-core";

const model = new TextEmbeddingAda002_2({
  request_config: await endpoint.embedding("text-embedding-ada-002"),
});

const vector = await model.createEmbedding("text to embed");
// returns number[], dimension 1536
```

#### ImageGenerationModel
```typescript
import { ZhipuImage } from "@ai-zen/agents-core";

const model = new ZhipuImage({
  request_config: await endpoint.imageGeneration("cogview-4"),
});

const result = await model.generate({
  prompt: "A cute cat",
  size: "1024x1024",
  quality: "hd",
});
// result.data => [{ url: "https://..." }, ...]
```

### Model Registry

All built-in model classes can be referenced via the `Models` object:

```typescript
import { Models } from "@ai-zen/agents-core";
// Models.ChatGPT
// Models.TextEmbeddingAda002_2
// Models.ZhipuImage
```

### RAG (Retrieval-Augmented Generation)

Improve answer quality by rewriting user messages to inject context information.

```typescript
import { Rag } from "@ai-zen/agents-core";

class MyRag extends Rag {
  async rewrite(questionMessage, messages) {
    const context = await fetchExternalData(questionMessage.content);
    // Rewrite the user message to inject reference information
    Message.rewrite(
      questionMessage,
      `Reference information: ${context}\n\nUser question: ${questionMessage.content}`
    );
  }
}

const agent = new Agent({ model, rag: new MyRag() });
```

The built-in `EmbeddingSearch` implementation retrieves from a knowledge base via embedding vectors and injects the matched reference text into the user question:

```typescript
import { EmbeddingSearch, KnowledgeBase } from "@ai-zen/agents-core";

const rag = new EmbeddingSearch({
  knowledge_bases: [knowledgeBaseInstance],
});
```

### VectorDatabase

An in-memory vector retrieval database based on cosine similarity:

```typescript
import { VectorDatabase } from "@ai-zen/agents-core";

interface MyRecord {
  vector: number[];
  title: string;
  text: string;
}

const db = new VectorDatabase<MyRecord>();
db.insert({ vector: [0.1, 0.2, 0.3], title: "Sample", text: "..." });

const results = db.search(targetVector, topN = 5, minScore = 0.5);
```

### KnowledgeBase

Automatically integrates an embedding model with a vector database:

```typescript
import { KnowledgeBase } from "@ai-zen/agents-core";

const kb = new KnowledgeBase({
  model: embeddingModel,
  data: [
    { vector: [...], title: "Document 1", text: "Content 1" },
  ],
});

const results = kb.search(targetVector, topN = 5, minScore = 0.8);
```

### Lifecycle Hooks

The Agent provides several lifecycle hooks to customize behavior at runtime.

```typescript
const agent = new Agent({
  model,
  // Fired before each inner loop starts; useful for refreshing tool definitions, RAG, etc.
  onInnerLoopStart: () => {
    console.log("Inner loop started");
  },
  // Fired after each inner loop ends; useful for post-processing
  onInnerLoopEnd: () => {
    console.log("Inner loop ended");
  },
  // Fired when the LLM calls a tool that is not registered
  onUnknownTool: (ctx) => {
    return `Tool "${ctx.toolCall.function?.name}" is unavailable.`;
  },
});
```

#### onUnknownTool — Unknown Tool Hook

When the LLM calls a tool that the Agent has not registered, the `onUnknownTool` hook is triggered.

**Signature**:
```typescript
onUnknownTool?: (ctx: UnknownToolContext) => string | Promise<string>;

interface UnknownToolContext {
  toolCall: AgentNS.ToolCall;    // The tool call request from the LLM
  availableTools: Tool[];        // All currently registered tools (shallow copy)
}
```

**Return value**: The returned string is passed back to the LLM as the tool execution result.

**Default behavior**: When unset, it returns the fixed prompt `"Unknown tool: {name}, no matching tool implementation was found."`

**Use cases**:
- Custom error messages that provide more useful context
- Recommend similar tools to the LLM based on the available tool list
- Asynchronously log audit events or call external monitoring services

**Examples**:
```typescript
// Synchronous — recommend available tools
const agent = new Agent({
  model,
  tools: [weatherTool, calculatorTool],
  onUnknownTool: (ctx) => {
    const names = ctx.availableTools.map(t => t.function.name).join(", ");
    return `Sorry, the tool "${ctx.toolCall.function?.name}" is unavailable. Available tools: [${names}].`;
  },
});

// Asynchronous — log an audit event
const agent = new Agent({
  model,
  tools: [fileReadTool],
  onUnknownTool: async (ctx) => {
    await auditService.log({
      event: "unknown_tool_call",
      toolName: ctx.toolCall.function?.name,
      timestamp: new Date(),
    });
    return `Tool "${ctx.toolCall.function?.name}" does not exist; the action was recorded.`;
  },
});
```

#### onToolCall — Tool Call Interception Hook

Fired before every tool call execution. Can **reject** a single tool call.

**Signature**:
```typescript
onToolCall?: (ctx: ToolCallContext) => string | undefined | Promise<string | undefined>;
```

**Return value**:
- A string → reject: the tool is **not executed**, and the string (rejection reason) is returned to the LLM as the tool result; the conversation continues to the next round.
- `undefined` → allow: the tool executes normally.

The `ctx` received by the hook is the **same `ToolCallContext` instance** passed to `Tool.exec(ctx)`.

**Example**:
```typescript
const agent = new Agent({
  model,
  tools: [fileTool],
  onToolCall: (ctx) => {
    if (ctx.tool_call.function?.name === "rm") {
      return `Tool "rm" is rejected: requires explicit user authorization.`;
    }
    return undefined; // allow
  },
});
```

### ToolCallContext

A single class spanning **interception decision → execution**. The same instance is passed to both the `onToolCall` hook (pre-execution interception) and `Tool.exec(ctx)` (actual execution).

| Property | Description |
|----------|-------------|
| `agent` | The Agent instance that triggered the call |
| `tool_call` | Unified tool call shape (`{ id?, type?, function: { name, arguments } }`); legacy `function_call` is wrapped as an id-less `{ function }` |
| `tool` | The matched registered tool (undefined if not registered) |
| `function_call` | Compatibility field, equal to `tool_call.function` (legacy shape) |
| `parsed_args` | The JSON-parsed argument dictionary |
| `result_message` | The tool result message — execution result / rejection reason / parse error are written here |
| `is_prevent_default` | Whether the automatic continuation of the conversation is blocked |
| `parse_error` | JSON parse error info (when `allowJsonParseError=true`) |
| `signal` | Abort signal for this tool execution (fires on `abort()`; tools can listen to truly interrupt) |
| `preventDefault()` | Marks the conversation to stop auto-continuing to the next round |

## How the Agent Works

### Conversation Flow

```
send(content)
  ├── Creates a User message and appends it to the message list
  ├── Creates an Assistant message (Pending status)
  ├── RAG.rewrite() rewrites the user question
  └── run()
        ├── formatHistory() → filters and formats messages
        ├── formatTools() → formats tool definitions
        ├── emits the "run" event
        ├── model.createStream() → streaming request
        ├── parseStreamData() → parses the streamed response (content/reasoning/tool_calls)
        ├── emits "chunk" / "chunk-parsed" / "parsed" events
        ├── handleToolCall() → executes tool calls
        │     ├── iterates over tool_calls / function_call
        │     ├── creates Tool or Function result messages
        │     ├── instantiates ToolCallContext
        │     ├── onToolCall() hook → may reject (reason sent back to the LLM)
        │     ├── executes the matching tool's exec(ctx)
        │     └── returns whether to continue the conversation
        └── if continuing → appends a new Assistant message → recurses into run()
```

### Tool Call Handling

- When the model returns `tool_calls` or `function_call`, the Agent automatically executes the matching tools
- Tool execution results are appended to the message list as Tool/Function role messages
- If all tools succeed and `preventDefault()` was not called, the Agent automatically starts a new round (feeding the results back to the model)
- If `allowJsonParseError = true` (default), parse failures automatically send the error back to the AI for correction

### Event System

The Agent provides an event bus that lets you listen to key stages of the run:

```typescript
// Run started (with the formatted messages and tools)
agent.events.on("run", (messages, tools) => {});

// Streaming connection established
agent.events.on("open", () => {});

// Raw streamed data chunk received
agent.events.on("chunk", (chunk: AgentNS.StreamResponseData) => {});

// Chunk parsed (merged into the receiver message)
agent.events.on("chunk-parsed", (receiver, chunk) => {});

// Full response parsed
agent.events.on("parsed", (receiver) => {});

// An error occurred
agent.events.on("error", (error) => {});

// Run finished (success or failure)
agent.events.on("finally", () => {});

// Sub-Agent started (when an AgentTool executes)
agent.events.on("sub-agent", ({ agent, ctx }) => {});

// Sub-Agent ended
agent.events.on("sub-agent-end", ({ agent, ctx }) => {});
```

### Aborting

```typescript
agent.abort(); // Abort all pending conversations
```

## More Examples

### Multi-round Conversation with Tools

```typescript
const agent = new Agent({
  model,
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
