# @ai-zen/agents-core

## What it is

`@ai-zen/agents-core` is the layer that talks to the model and refuses to know about anything
else. Hand it an `OpenAI` client, a model name and an array of messages, and it sends the requests,
runs the tools the model asks for, and keeps that array as the only copy of the conversation. What
happens along the way — a message appearing, a stream fragment, a tool call, an interruption, a
failure — is reported as an event a caller can subscribe to.

It has no storage, no interface, no copy, no permissions and no configuration: where messages are
written, what a user sees and which model to pick are decided above it. It does not retry, does not
classify errors and does not tidy up after a crash. A failure stays a fact on the message it
happened to.

## How to use

```bash
pnpm add @ai-zen/agents-core
```

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({ apiKey: "sk-…", baseURL: "https://api.deepseek.com/v1" });
const agent = new Agent({
  client, model: "deepseek-chat",
  messages: [Message.System("Answer in one sentence.")],
  lifetime: "one-shot",
});

const messages = await agent.runOnce({ content: "What does this package do?", priority: "low", source: { kind: "user" } });

console.log(messages.at(-1)?.content);
```

Replace `baseURL`, `apiKey` and `model` with your own endpoint and the code runs unchanged.

Two lines carry the weight. `lifetime: "one-shot"` says this agent does its work once and is then
gone; `runOnce()` exists only on such an agent, and it closes the agent and hands back the messages
when the work is done. Inside the call, `priority: "low"` means "take it when the loop is ready for
a new batch" (`"high"` may jump into one already running), and `source` says who is speaking —
`{ kind: "user" }` is the person, `{ kind: "agent", label }` and `{ kind: "system", label }` are
another agent or a host, a timer, an outside system.

An agent that should stay alive and take one more message at any time is not built this way; that
shape is what the next section is about.

## How it is put together

Everything below follows from one decision: the messages array is the state, and the rest is events
about it. There is no shadow model of the conversation, no snapshot, no diff to reconcile. A caller
that renders or stores messages has all of it already, and core never has to guess what a display
needs.

### The queue is both the inbox and the wake-up

A separate notify channel — a condition variable, a timer, a polling thread — would have to be kept
in step with the queue, and the two drift apart at the first bug. So there is only one structure:
the queue notifies on send, and while it is empty the loop is parked on that notification. Nothing
else is ever signalled.

```ts
for await (const batch of inbox.asTakeAll()) {
  // a batch is in hand
}
```

```text
start() → outer loop
 └─ wait on the output switch                     ← once, before taking anything
    for await (batch of inbox.asTakeAll())
        state = "working"
        repair history                          ← the only place that looks back
        land this batch (one user message per entry with content, nothing for a key)
        report inboxTaken
        onOuterLoopStart → inner loop → onOuterLoopEnd
        queue empty → state = "idle"
        wait on the output switch                 ← once per batch, at the tail
```

The wait on the output switch exists twice — once before entering and once at the tail of every batch.
That is what "nothing is taken between batches" means in practice: entries that arrive while the
switch is on stay in the queue, are visible as a count, can be persisted, and can be restored later.

The inner loop repeats while the last response asked for tools. It is a `while`, not recursion: each
level of recursion adds a stack frame and a private copy of local state, and "which iteration is it
in" becomes unanswerable. Inside one batch the tools of a response run in parallel and their result
messages land in call order, not in completion order.

A batch that has already been taken counts as started. `pauseOutput()` takes effect from the next
batch and does not put the current one back: it may already have landed messages and be halfway
through its tools.

### Living and working are two different questions

Someone who says "stop" almost always means one of four things: finish and be gone, be gone now,
hold everything for later, or cut what is running but stay alive. One verb would hide that, so the
actions are built from two orthogonal answers — does the agent still have a life afterwards, and is
in-flight work cut right now.

| Action | What it does |
|---|---|
| `start()` | Starts waiting for entries. Returns a promise that resolves only when the agent is dead, and never rejects |
| `stop()` | Closes the input switch, lets the entries already queued drain, then dies |
| `pauseOutput()` | Turns the output switch on: nothing is taken from the next batch on. In-flight work is not touched |
| `abort()` | Cuts the in-flight request and tools, then turns the output switch on, then reports `aborted` |
| `resumeOutput()` | Turns the output switch off. Only that flag is flipped; `state` is not touched |
| `kill()` | Hard landing: dead immediately, everything queued is discarded |

| | Let it finish by itself | Cut in-flight work now |
|---|---|---|
| **Do not run again** (queue emptied or voided) | `stop()` | `kill()` |
| **Do not run yet** (queue kept) | `pauseOutput()` | `abort()` |

- `stop()` and `kill()` act on the whole life; `pauseOutput()` and `abort()` act on the next batch.
- `abort()` always implies "no more taking" (work cannot continue after being cut); the converse does
  not hold: `pauseOutput()` does not abort anything.
- `kill()` is not a faster `stop()`. It is a `stop()` that discards whatever has not been processed.
- Repeating any of the six is a no-op. Only delivery throws (`send()` on a closed agent, `restore()`
  on a closed or incomplete one).
- Neither `stop()` nor `kill()` can be undone: a dead agent is dead, and reviving it means
  constructing a new one.
- `start()`'s promise never rejects. A failed request is one failed request — it lands on that
  message's `error` and on the `failed` event, and the loop waits for the next entry.

The output switch is released from both sides: `resumeOutput()` flips it, and `stop()` / `kill()` also
release whatever waits on it. Otherwise a loop parked while paused would wait for a `resumeOutput()`
that never comes, and the promise from `start()` would never resolve.

### Three answers, three places

Whether there is work in hand, whether an entry may still be delivered, and whether anything may
still be taken are three independent facts, and callers ask about them separately. Folded into one
enum, "paused" would mean five different things and every reader would have to guess which. So each
fact lives in its own place, and none of them speaks for another.

| Place | Member | Says | Changed by | Events |
|---|---|---|---|---|
| Outward state | `state: "working" \| "idle"` | whether there is work in hand | the loop position only | `state:working` / `state:idle` |
| Output switch | `isOutputPaused` | whether entries are still taken (`true` = not from the next batch on) | `pauseOutput()` / `resumeOutput()` | `output:paused` / `output:resumed` |
| Input switch | `isInputPaused` | whether entries are still accepted (`true` = `send()` is refused) | `pauseInput()` / `resumeInput()`; `stop()` / `kill()` are producers of it | `input:paused` / `input:resumed` |

One sentence separates the switches: the input switch blocks delivery, the output switch blocks taking.
With the input switch closed, `send()` throws `closed` while the queue and the batch in hand stay
untouched. With the output switch on, nothing is taken while delivery still works and entries stay
queued. Neither switch takes part in `state`, so "the batch that arrived while output was paused has
finished" and "output is still paused" are two facts that can both be reported.

`state` is decided by the position of the loop and by nothing else: a batch is taken → `working`;
the batch is done and the queue is really empty → `idle`.

`stop()` and `kill()` close the input switch themselves and it never opens again afterwards: once the
queue has declared that no further entries will arrive, letting one in would hand it to a queue
nobody takes from.

- `pauseOutput()` takes effect from the next batch: the batch in hand finishes.
- `abort()` cuts in-flight work (the request and the tools) and reports `aborted`; the agent does not
  die, the output switch is simply on. Dying is `kill()`'s business.
- Each switch has its own pair of events, and its current value is read from the live object
  (`agent.isOutputPaused` / `agent.isInputPaused`), not carried in the event payload.
- There is no "errored" state: an error is a fact on a message, read from its `status` / `error`.
  There is no "dead" state either: dead means there is no agent object.

### One-shot and resident are different capabilities

A result that arrives at a future moment needs a receiver at that moment. On a one-shot agent the
call stack has returned by then and nobody is there, so the difference between the two lifetimes is
not how long the object lives — it is what it can do at all.

| | Resident | One-shot |
|---|---|---|
| How it is started | `start()`, then it waits for entries | `runOnce()`, its life sits inside the call stack |
| Who feeds it | anyone, any number of times (`send()`) | the one caller that started it, once |
| How it closes | `stop()` when nobody sends any more | closed on its own: a second `send()` throws `closed` |
| Tools whose result arrives later | supported | not supported |

The last row is the hard one, and the assembly step has to refuse such tools up front rather than
discovering it at delivery time.

A resident session also has no "deliver and wait": it can be sent to from any trigger at any time, so
"I wait until it is idle" has nothing to attach to. Only a one-shot agent has one causal chain — the
caller's own call.

### Entries are data, not references

Entries are stored and read back, so both of their shapes are plain data with no live references,
and an agent reference is refused in `source` for the same reason: an agent carries a client and its
own message array, neither of which survives a round trip through storage.

```ts
// an entry with content: lands as one user message
interface InboxEntryWithContent {
  messageId?: string;                 // chosen by the sender, so a client can echo optimistically
  createdAt: string;                  // filled by core: the moment it arrived
  priority: "high" | "low";           // high: takeable inside the inner loop; low: outer loop only
  source: AgentNS.MessageSource;
  content: AgentNS.MessageContent;
}

// a key: wakes the loop up and lands nothing
interface InboxKey {
  createdAt: string;
  priority: "low";                    // the inner loop only looks at high, so a key is never taken there
  content?: undefined;
}
```

`source` has three kinds, all of them text: `{ kind: "user" }`, `{ kind: "agent", label }` for
another agent, `{ kind: "system", label }` for a host, a timer or an external system. Every
`role: user` message carries one — including a host-injected hidden message — so "the user said
this" has exactly one test: `source.kind === "user"`.

For every source other than `user`, core puts one comment line in front of the text when the entry
lands — this is the literal line it writes:

```text
// 这条消息来自 <label> 自动推送（<createdAt>）

<the content, unchanged>
```

For content given as an array of sections the comment becomes a leading `text` section and every
other section stays where it was. The timestamp is the entry's own `createdAt`, not "now": an
external notification may describe something that happened long ago, and the model needs to be able
to tell.

Three facts are reported, and every change of the inbox means one of them:

| Event | Payload | When |
|---|---|---|
| `inboxAdded` | `entry` | an entry was sent |
| `inboxTaken` | `entries` | these entries left the queue and their messages are already landed |
| `inboxCleared` | `entries` | the queue was voided (`clearInbox()`), not taken |

`inboxTaken` is reported after the messages land, not before. If the process dies between the two,
"message written, entry still queued" is a duplicate that can be deduplicated by `messageId`, while
the other order is a message that disappears.

### Repair at the head of the loop, not the tail

Before the loop takes its next batch it repairs the history once. Repairing at the head rather than
right after an interruption is what lets the interface show the truth: the half-sentence and the tool
that never answered stay visible until the agent really starts again. It is the only place that looks
back, and it does three things: it types leftover `writing` / `pending` messages, it deletes whatever
the "drop" strategy does not keep, and it fills unpaired tool results according to the "fill"
strategy.

The judgement uses two things only — the message `status`, and the pairing between `tool_calls` and
tool messages — so an interruption, a failure and a crash all look the same here. Both strategies
are constructor options; the table is in the details.

### Events are facts, hooks are positions

An event says what happened and cannot be stopped; a hook names a position in the loop and, at four
of those positions, may refuse. They are separate because they answer different questions: "show me
what it is doing" and "decide whether this may happen". Merging them would make every subscriber a
potential veto.

There are four refusing hooks, and they fail closed — a switch that lets work through when its guard is
broken is not a switch. Every other hook fails open and is treated as not having spoken. Both report
`failed`; a thrown plugin must not leave an agent that looks alive and does nothing.

`onOuterLoopStart` cannot refuse: the batch has already been taken out of the queue, and a refusal
would leave it without an owner. A decision about a batch belongs before delivery.

## Details

### The three ways in

| Entry | What it does | Waits? |
|---|---|---|
| `send(input?)` | Puts one entry in the inbox and returns; throws `closed` on a closed agent; no `input` = turn the key only | no |
| `sendAndWait(input?, { signal })` | Starts if needed, sends, waits until idle, returns `messages` (does not close) | yes |
| `runOnce(input?, { signal })` | Starts, `send`, closes, waits until dead, returns `messages` | yes |

`send()` and `runOnce()` refuse anything whose `lifetime` is not `"one-shot"`. `runOnce()` also
refuses an agent that has already been started, and refuses an empty `messages` array with no input
content — a key with no fuel would send an empty request. Those are mistakes in the calling code, so
they throw a plain `Error` rather than an `AgentError`: the error codes exist for failures that end
up on `message.error` and are read back from storage.

Reading the queue without taking anything:

| Member | What it gives |
|---|---|
| `inboxPending` | the entries not taken yet, in arrival order — a copy of the array, the same entry objects |
| `inboxSize` | how many are queued |

`restore(entries)` puts stored entries back unchanged: same `createdAt`, no defaults invented, and no
`inboxAdded` (the row is already in storage, restoring is not a new change). It refuses a one-shot
agent (its life is on the call stack, there is no "keep waiting after a restart"), a closed or
killed agent, and an entry whose shape is incomplete — a half entry is rejected on the spot rather
than sent into the queue.

### Repair strategies

| Member | Values | Default | Decides |
|---|---|---|---|
| `abortedToolRoundStrategy` | `"fill"` / `"drop"` | `"fill"` | an interrupted tool round: keep it and fill the missing result (`abortedToolRoundReason`), or remove the whole group |
| `abortedMessageStrategy` | `"drop"` / `"keep"` | `"drop"` | an interrupted assistant message: delete it, or keep the part that was already written |

Both are constructor options. "Drop" really deletes — memory and storage both — and reports
`messageRemoved`; `omit` means something else (a message that stays but is no longer sent).

### Events

Every event carries `agent`, `seq` (this agent's own counter, from 1, only increasing) and `at`.
Wherever an event carries a message, an entry or a stream fragment, it is the live object itself,
never a copy.

| Event | What happened | Payload |
|---|---|---|
| `started` / `stopped` / `killed` | it started / it drained and died / it was killed | — |
| `state:working` / `state:idle` | the outward state reached that value | `from` |
| `output:paused` / `output:resumed` | taking stopped from the next batch on / started again | — (read `agent.isOutputPaused`) |
| `input:paused` / `input:resumed` | delivery closed / opened again | — (read `agent.isInputPaused`) |
| `aborted` | someone pressed stop | — (whether anything was cut is read from the message `status`) |
| `inboxAdded` / `inboxTaken` / `inboxCleared` | an entry arrived / these were taken / the queue was voided | the entries themselves |
| `messageAdded` / `messageChanged` / `messageRemoved` | a message appeared / changed in place / was deleted | that message |
| `messageFinished` | this version of a message is final and will not change | that message |
| `delta` | a raw stream fragment arrived | `chunk` + `source` (`{ message }` or `{ subAgent, toolCall }`) |
| `requestSent` / `responseFinished` | the request went out / this response ended | the request body / the finished message |
| `turnStarted` / `turnFinished` | one request and the tools it caused began / ended | the assistant placeholder, the same instance in both |
| `toolStarted` / `toolFinished` | a tool began / ended | the tool call / the result message |
| `subAgentStarted` / `subAgentFinished` | a delegation began / ended | the sub-agent and the tool call |
| `denied` | a hook refused, so this iteration never ran | `hook`, `reason`, structural `detail` |
| `failed` | it ran and failed | an `AgentError` and, when there is one, the message |
| `observerFailed` | a subscriber threw | the event name and the error |

`seq` is what lets a subscriber detect a duplicate or a gap. `denied` and `failed` are separate
names because the history looks different afterwards: `denied` leaves not a single character,
`failed` leaves a half assistant message with `status: "error"`.

A subscriber is a bypass. `on(type, handler)` returns an unsubscribe function; a handler that throws
is caught on the spot, reported as `observerFailed`, and does not disturb the agent — a full disk
should not kill the request that was being watched.

### Hooks

`use(plugin)` mounts a plugin. A hook names a position in the loop, not a fact (facts are events).

| Hook | Can refuse | Position |
|---|---|---|
| `onInit` | no | after registration, unrelated to lifecycle |
| `onStart` / `onStop` / `onKill` | no | the edges of the life |
| `onOutputPaused` / `onOutputResumed` | no | the output switch flipped |
| `onAbort` | no | someone pressed stop (sent even when the switch was already on) |
| `onIdle` | no | the outward state became `idle` |
| `onOuterLoopStart` / `onOuterLoopEnd` | no | a batch began / ended |
| `onInnerLoopStart` | yes | before the assistant placeholder exists; also allowed to rewrite the request body |
| `onInnerLoopEnd` | no | the request ended |
| `onToolStart` | yes | the tool exists; asks whether to run it |
| `onUnknownTool` | yes | the tool does not exist; asks what to answer the model |
| `onToolEnd` | no | the tool ran (only for tools that exist) |
| `onSubAgentStart` / `onSubAgentEnd` | start only | the delegation boundary |

A string returned by a refusing hook is the body of the tool message or the reason of the denial;
core does not wrap it in its own wording. `onInnerLoopStart` runs before the assistant placeholder
is created, so a refusal leaves no message stuck in `pending`.

Hooks run before events at the same position, with one exception: the `state:*` event is emitted by
the state setter before `onIdle`, and `started` before `onStart`, because the setter is a synchronous
boundary and the subscriber has to be able to see that value before the hook runs.

### Errors

One class, one instance in two places.

```ts
export type AgentErrorCode =
  | "request-failed"   // could not connect / no response
  | "stream-failed"    // a response came, but the stream broke or did not fit
  | "closed"           // the agent is finished: sending will never be taken again
  | "input_paused";    // the input switch is closed right now: wait and send again

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string, options?: { cause?: unknown });
}
```

The same instance is the payload of the `failed` event and the `error` of the message it belongs to.
`{ code, message }` is enough to rebuild it from storage (`AgentError.fromJSON()`), with `cause` and
`stack` left to whoever writes the row.

Error text never goes into `content`. `content` is what the model said; with the "keep" strategy in
play, a stored `ECONNREFUSED` would come back to the model as something it said itself. A `role:
tool` message is the exception: its `content` is the result the model is meant to read.

Core classifies only the dimension it knows (which part failed). It does not decide whether an error
is retryable, does not translate a 401 into "wrong key", does not back off, does not retry.

### Exports

| Export | What it is |
|---|---|
| `Message` | the message class; `Message.System()`, `Message.User()`, `Message.Assistant()`, `Message.Tool()` build one, `id` and `createdAt` are filled by the constructor |
| `Tool` | the abstract tool: subclass it and implement `exec(ctx): Promise<MessageContent>`; the definition lives on `function` |
| `CallbackTool` | a tool defined by one callback instead of a subclass |
| `ToolCallContext` | what a tool receives: `agent`, `tool_call`, `parsedArgs`, `parseError`, `resultMessage`, `signal` |
| `AgentToolLazy` | an agent as a tool: build it on demand, forward its events to the parent, run it once and hand back what it said |
| `applyChunk` | one stream fragment applied to a message in place — the only implementation of that |
| `formatContent` | content sections reduced to the fields the model knows; `__` keys and unknown sections are dropped |
| `sumUsage` / `addUsage` / `ZERO_USAGE` | token usage summed over messages: a message's own `usage` plus a tool message's `subAgentUsage` |

`Tool.exec` cannot stop the loop: whatever it returns is one tool message handed back to the model.
The two ways to stop are a hook refusing and `abort()`.

### What it does not do

| Not done | Why |
|---|---|
| retrying, classifying, downgrading | product policy; a retry loop in the engine would need to understand networks, vendors and idempotency |
| normalising vendor error codes | every new provider would mean changing core |
| i18n | engine-level text is English; languages belong to the host |
| knowing about assets, endpoints or storage | it would grow into an application along that line |
| idle collection, reference counting, timers | the life only follows the six actions |
| a recursive inner loop | each level adds a stack and blurs "which iteration is it in" |
| a global "aborted" flag or "errored" state | a global flag is how an agent ends up needing manual revival; an error is a fact on a message |
| error text in `content` | the model would read it as something it said |
| tools whose result arrives later on a one-shot agent | nobody is left to receive it |

## Testing

```bash
npm run pretest      # tsc --noEmit over src and the tests
npx vitest run       # the suite
```

Both are run from `packages/core`. The suite needs no network and no API key: the model client is
handed in, so a test supplies its own.

## License

MIT
