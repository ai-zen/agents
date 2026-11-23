# @ai-zen/fake-llm

An OpenAI-compatible fake endpoint. Hand it one target message — the message a provider would
have sent — and it streams back the delta sequence that message would have arrived as.

No network, no API key, no model: the content, the split points and the timing are all decided by
the caller, so assertions can use `toBe` instead of `not.toBeEmpty`. Zero runtime dependencies
(`node:http` only), so it can be started inside any test process or a plain script.

## Installation

```bash
pnpm add -D @ai-zen/fake-llm
```

## Quick start

```typescript
import { startFakeLlm } from "@ai-zen/fake-llm";

const llm = await startFakeLlm({
  reply: "The local endpoint received this line.",
  chunks: 3,
  chunkDelayMs: 80,
});

// Point any OpenAI-compatible client at llm.baseUrl, e.g. an `openai` SDK instance
const response = await fetch(`${llm.baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "fake-model",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  }),
});

console.log(await response.text()); // data: {...}\n\ndata: {...}\n\ndata: [DONE]\n\n

await llm.close();
```

`baseUrl` looks like `http://127.0.0.1:PORT/v1` (the port is assigned by the system). The endpoint
answers `POST <baseUrl>/chat/completions`; the path is not otherwise inspected, so a client that
appends `/v1` once more still reaches it.

`close()` must be called when the endpoint is no longer needed, otherwise the process stays alive.

## Describing a stream with one message

The target message has the shape of an assistant message in OpenAI's API: `content` is either a
string or an array of content parts, plus `reasoning_content`, `tool_calls`, `usage` and
`finish_reason`. Nothing else is needed to describe a stream — the endpoint reverses the order of
events:

```typescript
import { startFakeLlm } from "@ai-zen/fake-llm";

const llm = await startFakeLlm({
  chunkSize: 3,
  reply: {
    reasoning_content: "先确认路径存在",
    content: "读一下这个文件",
    tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    usage: { prompt_tokens: 128, completion_tokens: 24 },
  },
});
```

That one message turns into this sequence of `choices[0].delta` values (frame envelopes are
elided):

| #   | delta                                                                                                                          | why                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | `{ role: "assistant", content: "" }`                                                                                           | every stream opens with the role and empty content                         |
| 2   | `{ reasoning_content: "先确认" }`                                                                                              | reasoning is cut into pieces at `chunkSize`                                |
| 3   | `{ reasoning_content: "路径存" }`                                                                                              | …                                                                          |
| 4   | `{ reasoning_content: "在" }`                                                                                                  | the last piece is shorter                                                  |
| 5   | `{ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } }] }`               | the first frame of a tool call carries `index`, `id` and the function name |
| 6   | `{ tool_calls: [{ index: 0, function: { arguments: "{\"p" } }] }`                                                              | arguments follow in increments, split verbatim                             |
| 7   | …                                                                                                                              | … until the whole argument string has been sent                            |
| 8   | `{ content: "读一下" }`                                                                                                        | content is cut the same way                                                |
| 9   | …                                                                                                                              | …                                                                          |
| 10  | `{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 128, completion_tokens: 24, total_tokens: 152 } }` | the closing frame: no delta, just why it stopped and what it cost          |

Rules that the table does not show:

- **Order.** Without `stream_order` the three groups go out one after another: reasoning, tool
  calls, content. Give `stream_order: ["reasoning", "content"]` to interleave them — the endpoint
  takes the next frame of the named group in turns and skips a group that has nothing left.
  Groups missing from `stream_order` are appended at the end, so content cannot disappear by
  accident.
- **Tool calls.** `function.arguments` is a string here and stays a string: it is cut at
  `chunkSize` (or into `chunks` pieces) and never parsed, so whitespace and key order survive the
  round trip. A tool call without `id` gets `call_<index>`; `index` defaults to the position in the
  array.
- **Content parts.** When `content` is an array, each part becomes one frame carrying its own
  `index` (that is how a client knows which part a text increment belongs to). `chunkSize` still
  applies inside text parts; `chunks` does not.
- **finish_reason.** Taken from the message; when it is omitted, a message with tool calls ends
  with `tool_calls` and everything else ends with `stop`.
- **usage.** `usage` on the message wins, otherwise the endpoint option `usage` is used, otherwise
  a fixed pair (21 / 7). It always lands on the closing frame; `stream_options.include_usage` is not
  required.
- **Non-streaming requests** (`stream` absent or false) return the whole message at once, shaped
  like OpenAI's `chat.completion`: `choices[0].message` carries the same fields, plus
  `finish_reason` and `usage`.

## Scripts

`reply` decides what a given request gets back. It can be:

```typescript
// 1. one message, every request gets it
startFakeLlm({ reply: { content: "固定答复" } });

// 2. a string: content is that sentence, no tool calls
startFakeLlm({ reply: "就这一句" });

// 3. an array: picked by request number, sticks on the last entry
startFakeLlm({ reply: ["第一句", "第二句"] });

// 4. a function: the request body is handed over as is, so the script reads `messages`
startFakeLlm({
  reply: (request, index) => {
    const system = String(request?.messages?.[0]?.content ?? "");
    return system.includes("curator") ? "归档完成" : `第 ${index + 1} 次请求`;
  },
});
```

The function form receives the parsed request body (nothing is normalized) and the request number,
counted from 0 in arrival order — the same number `failOn` uses.

## Failure injection and observation

```typescript
const llm = await startFakeLlm({
  reply: "一二三四五六七八",
  chunks: 4,
  chunkDelayMs: 80, // wait between frames
  jsonDelayMs: 200, // wait before a non-streaming reply
  breakAfter: 3, // drop the connection after 3 frames
  failWith: { status: 500, message: "上游炸了" }, // answer with an error instead
  failOn: 1, // …but only for request number 1
});
```

| Option                 | What it does                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chunks` / `chunkSize` | how finely the message is cut (piece count / characters per piece)                                                                                  |
| `chunkDelayMs`         | gap between two frames; the window a test needs to look at a stream mid-flight                                                                      |
| `jsonDelayMs`          | gap before a non-streaming reply; the window a test needs to cancel a request in flight                                                             |
| `breakAfter`           | after that many frames the socket is dropped: no closing frame, no `[DONE]`. The only way to reproduce "the reply started and then the stream died" |
| `failWith`             | respond with that status and message in OpenAI's error shape                                                                                        |
| `failOn`               | restrict `failWith` to one request number (0-based); other requests answer normally                                                                 |
| `usage`                | the usage reported on the closing frame when the target message does not carry one                                                                  |

What can be observed afterwards:

| Field                     | Meaning                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.baseUrl`             | root address, goes straight into an endpoint config                                                                                                            |
| `llm.requests`            | every request received, in arrival order: `method`, `path`, parsed `body`                                                                                      |
| `llm.requests[i].aborted` | the client hung up before the response was finished (a real cancel reached the socket). Requests where the endpoint itself dropped the connection stay `false` |
| `await llm.close()`       | stop listening                                                                                                                                                 |

## API

```typescript
export { startFakeLlm, buildDeltas, cutText, splitReply, DEFAULT_CHUNKS };
export type {
  FakeLlm,
  FakeLlmOptions,
  FakeLlmRequest,
  FakeLlmReply,
  FakeLlmMessage,
  FakeLlmDelta,
  FakeLlmToolCall,
  FakeLlmFunctionCall,
  FakeLlmContentSection,
  FakeLlmUsage,
  FakeLlmFinishReason,
  FakeLlmStreamPart,
  FakeLlmChunking,
};
```

`buildDeltas(message, chunking)` is the reversal itself: it returns the deltas that follow the
opening frame, without any HTTP involved. Use it when a test needs to assert on the split points
themselves rather than on the wire.

## License

MIT
