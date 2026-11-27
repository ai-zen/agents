# Agent

An agent is a JSON file on disk plus the directories used to assemble it. `core` only knows the assembled object: a queue, a model client, messages, tools. It does not read configuration files and does not write to disk.

## Definition file

`<data root>/agents/<id>.json`, where the file name is the id.

| Field | Meaning |
|---|---|
| `id` | Unique identifier, matching the file name |
| `name` | Display name |
| `messages` | Preset messages, usually one `system` message. It is the head of the runtime history |
| `modelId` | Bound model. When absent, `defaultModel` in `config.json` applies |
| `modelParams` | Request parameter overrides, shallow-merged over the model's `defaultParams` |
| `permissions` | Four-dimension capability whitelist, see [Capabilities](capabilities.md) |
| `function` | With this field the definition is a sub-agent: it becomes a tool on the parent |
| `custom` | When `true`, SDK initialisation will not overwrite the definition with the factory one |

The model is resolved in three levels: session override > `modelId` in the definition > `defaultModel` in `config.json`. When all three are empty, assembly fails with the `agentId` in the message. It does not fall back to a factory model — otherwise the interface says A while the request and the bill go to B.

`modelParams` does not interpret key names; it is a shallow merge. The same model can therefore carry `{"thinking":{"type":"enabled"},"reasoning_effort":"max"}` for a coding agent and `{"thinking":{"type":"disabled"}}` for a chat agent, without touching the model definition.

`messages` is copied at assembly time: the runtime history is a separate array, so appending, pruning or marking `omit` never reaches the definition file.

## Two lifetimes

| | `resident` (default) | `one-shot` |
|---|---|---|
| Started by | `start()`, then it waits for deliveries | `runOnce()` or `sendAndWait()` |
| Deliveries | Any number | One. A second delivery throws `closed` |
| After finishing | Still there, accepts more | Terminated, cannot be reused |
| Background tools | `async_exec`, `async_timeout` | None: by the time a result arrives the call stack is gone |
| Session tools | `post_message` and the others | None: it belongs to no session |

## Delivery

```ts
agent.send("look at this directory");                // one sentence, high priority, source user
agent.send({ content: rows, priority: "low", source: { kind: "system", label: "cron" } });
agent.send();                                        // no body: wake only, no message is added
```

`send()` returns as soon as the entry is queued. When it cannot be queued it throws, and the two reasons are distinguishable:

| Code | Meaning |
|---|---|
| `closed` | The agent has terminated; waiting longer will not help |
| `input_paused` | The input switch is temporarily off; `resumeInput()` reopens it |

When an entry is taken depends on priority:

- `high`: may be taken at the boundary between tool executions inside the current batch. Messages from another session and results of background tasks arrive this way
- `low`: only seen when the outer loop fetches the next batch, that is after the current batch has fully finished

An entry without a body only wakes an idle agent: nothing is added to the history. It exists for the case where the input is already in `messages` and only a trigger is missing, as with a delegated sub-agent.

## Queue and two switches

An agent has exactly one queue, and it is simultaneously the inbox, the outbox and the source of three states:

| State | Read as | Changed by |
|---|---|---|
| Working or idle | `agent.state` | The loop: taking a batch makes it `working`; a finished batch with an empty queue makes it `idle` |
| Still accepting deliveries | `agent.isInputPaused` | `pauseInput()` / `resumeInput()`; `stop()` and `kill()` close it |
| Still taking entries | `agent.isOutputPaused` | `pauseOutput()` / `resumeOutput()`; `abort()` turns it on |

The two switches are independent: entries delivered while output is paused still belong to a batch that runs, and the agent still reports idle afterwards. Reporting idle does not mean it is still accepting deliveries.

The three termination actions:

| Action | In-flight request | Queued entries | After |
|---|---|---|---|
| `abort()` | Interrupted | Kept, no longer taken | `resumeOutput()` starts taking again |
| `stop()` | Runs to completion | Drain is processed | Terminates; deliveries throw `closed` |
| `kill()` | Interrupted | Discarded (`clearInbox()`) | Terminates at once |

`clearInbox()` discards the queue, which is a different door from taking entries: it works even while output is paused. `restore(entries)` puts saved entries back in their original order, which is what a process restart uses.

## Event stream

`agent.on(name, handler)` returns an unsubscribe function. Subscription is a side channel: a throwing subscriber never interrupts the agent, and the error itself is reported as `observerFailed`.

| Group | Events |
|---|---|
| Lifecycle | `started`, `stopped`, `killed`, `state:working`, `state:idle` |
| Switches and interruption | `output:paused`, `output:resumed`, `input:paused`, `input:resumed`, `aborted` |
| Queue | `inboxAdded`, `inboxTaken`, `inboxCleared` |
| Messages and stream | `messageAdded`, `messageChanged`, `messageRemoved`, `messageFinished`, `delta` |
| One request | `turnStarted`, `requestSent`, `responseFinished`, `turnFinished` |
| Tools and delegation | `toolStarted`, `toolFinished`, `subAgentStarted`, `subAgentFinished` |
| Failures | `denied`, `failed`, `observerFailed` |

Every event carries three fields: `agent`, `seq` (this agent's monotonic counter, starting at 1) and `at` (ISO 8601). `seq` is how a subscriber detects duplicates and gaps, and how it answers "resume from where".

Payloads carry live objects, not copies: a message received through `messageAdded` keeps changing its `status` and `content` as the stream arrives. For a snapshot of this moment, read `agent.messages`.

## Async results coming back

A tool call can return at once while its result arrives later. Three cases share one path:

| When the result arrives | What is delivered |
|---|---|
| An `async_exec` command finishes | Output and exit status; killed by timeout is stated |
| `async_timeout` reaches its deadline | A deadline notice |
| An MCP server-side task reaches a terminal state | A notice pointing at `get_mcp_task_result` |

Delivery goes through `send()` with source `{ kind: "system", label: <tool name> }` and high priority. The one waiting for the result is often polling, and a low-priority entry waits for the end of the batch — which is exactly where the polling sits, so the result could never get in.

If nobody can receive it — the session has no agent, or its queue is closed — delivery throws, the result is dropped and one line is logged. It never revives a session.

## Sub-agents

A definition with a `function` field becomes a tool on the parent, with the parameters declared there:

```json
{
  "id": "sub-agent-default",
  "messages": [
    { "role": "system", "content": "You are a general-purpose sub-agent…" },
    { "role": "user", "content": "{{task}}" }
  ],
  "function": {
    "name": "sub_agent_default",
    "description": "General-purpose sub-agent…",
    "parameters": {
      "type": "object",
      "properties": { "task": { "type": "string" } },
      "required": ["task"],
      "additionalProperties": false
    }
  }
}
```

On a call:

1. Deep-copy the `messages` template and replace `{{key}}` inside string bodies with `parsedArgs[key]`
2. The sub-agent is one-shot and runs `runOnce()`; the parent's abort signal is passed straight down
3. The sub-agent's events are forwarded to the parent with two extra fields: `subAgent` (who it happened to) and `via` (which delegation caused it). `state` is not forwarded: the parent's own state field answers for the parent only
4. Token usage of the sub-agent and its descendants is accumulated onto the tool result message as `subAgentUsage` and persisted with it

The parent model receives only the content of the sub-agent's last message. The dozens of tool calls in between never enter the parent's context.

## History after an interruption

An interrupted request leaves messages that are not final. Before every new batch the agent reconciles them with two strategies:

| Setting | Value | Meaning |
|---|---|---|
| `abortedMessageStrategy` | `keep` (factory) | Keep the partial answer, restored to `completed`; the next request continues from it |
| | `drop` (core default) | Discard it, leave it `aborted`, keep it out of the next request |
| `abortedToolRoundStrategy` | `fill` (factory) | Keep the whole round: the assistant message is restored to `completed`, missing tool results get a reason |
| | `drop` | Drop the whole round: neither the assistant message nor its results are sent again |

Both live in `config.json` and can also be passed explicitly to `createAgent()`. Providers require tool calls and results to pair up, which is why `fill` is the factory value.
