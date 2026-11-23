---
title: Core API
description: The kernel's public face — the boundary, the six lifecycle actions, the one-shot versus resident difference, the two loops, the two gates, the inbox and its three facts, repair at the head of the loop, the event table, hooks, AgentError, and what it does not do.
outline: deep
---

# Core API

`@ai-zen/agents-core` is the kernel. It produces two things: the one message array an agent holds, and the facts that happen while it runs, handed out as events. No storage, no UI, no copy, no permissions, no configuration.

It runs on the official `openai` package: an `OpenAI` client, a model name and an array of messages are everything needed to construct one.

This page is ordered for someone building their own thing on top of the kernel: what it knows, then lifetime, the loop, state, the inbox, events, hooks, errors, and last what it does not do.

```bash
pnpm add @ai-zen/agents-core
```

## What it knows and does not know

| Must know | Must not know |
|---|---|
| messages, tools, model requests, streams, usage, interruption, queueing, delegation | storage, multiple clients, i18n, permissions, UI, who is listening, how a capability container is assembled, how a model is resolved, how assets are materialised |

This table is the ruler for any "should the kernel know X" question: look at the left column. Anything from the right column that gets in will grow the kernel into an application along that line.

The test compresses into one sentence: delete the sdk and the host, keep the kernel and hand it a fake model client, and one agent must still run to the end — take entries, send a request, receive the stream, run tools, emit events, come back to idle.

It does not even know its own name: an `id` is handed in at construction, and the kernel only uses it for error messages and logs, never in a decision.

## The six lifecycle actions

| Action | What it does |
|---|---|
| `start()` | Starts waiting for entries. Returns a promise that resolves only when the agent is dead, and never rejects |
| `stop()` | Closes the input gate, lets the entries already queued drain, then dies |
| `pauseOutput()` | Turns the output gate on: nothing is taken from the next batch on. In-flight work is not touched |
| `abort()` | Cuts the in-flight request and tools, then turns the output gate on, then reports `aborted` |
| `resumeOutput()` | Turns the output gate off. Only that flag is flipped; `state` is not touched |
| `kill()` | Dead immediately, everything queued is discarded, nothing is drained |

"Stop" is the combination of two orthogonal questions: whether the agent still has a life afterwards, and whether in-flight work is cut right now.

| | Let it finish by itself | Cut in-flight work now |
|---|---|---|
| Do not run again (queue emptied or voided) | `stop()` | `kill()` |
| Do not run yet (queue kept) | `pauseOutput()` | `abort()` |

- `stop()` and `kill()` act on the whole life; `pauseOutput()` and `abort()` act on the next batch.
- `abort()` always implies "no more taking" (work cannot continue after being cut); the converse does not hold: `pauseOutput()` does not abort anything.
- `kill()` is not a faster `stop()`. It is a `stop()` that discards whatever has not been processed.
- Repeating any of the six is a no-op. Only delivery throws: `push()` on a closed agent throws `closed`, `restore()` throws on a closed agent or on an incomplete entry.
- Neither `stop()` nor `kill()` can be undone: a dead agent is dead, and reviving it means constructing a new one.
- `start()`'s promise never rejects. A failed request is one failed request — it lands on that message's `error` and on the `failed` event, and the loop waits for the next entry.

The output gate is released from both sides: `resumeOutput()` flips it, and `stop()` / `kill()` also release whatever waits on it. Without that second half, a loop parked while paused would wait for a `resumeOutput()` that never comes, and the promise from `start()` would never resolve.

The order inside `stop()` and `kill()` is fixed: gates and queue first, then the hooks, and only then the word "dead". So by the time a subscriber hears `stopped` / `killed`, the gates, the queue and `state` all already look the way they should after death.

## One-shot versus resident

The lifetime is decided at construction (`lifetime: "resident" | "one-shot"`, resident by default). It is not only a difference in how long the object lives, it is a difference in what it can do.

| | Resident | One-shot |
|---|---|---|
| How it is started | `start()`, then it waits for entries | `runOnce()`, its life sits inside the call stack |
| Who feeds it | anyone, any number of times (`push()`) | the one caller that started it, once |
| How it closes | `stop()` when nobody pushes any more | closed on its own: a second `push()` throws `closed` |
| Tools whose result arrives later | supported | not supported |

The last row is the hard one: a result that arrives at some future moment needs a receiver at that moment. A one-shot agent's stack has returned by then, so nobody is there. Such tools can only be mounted on a resident agent, and the assembly side has to refuse them up front rather than discover them at the first call.

A resident session has no "deliver and wait". `send()` and `runOnce()` throw on it: a resident agent can be pushed from any trigger at any time, so "I wait until it is idle" has nothing to attach to. Only a one-shot agent has one causal chain — the caller's own call.

| Entry | What it does | Waits? |
|---|---|---|
| `push(input?)` | Puts one entry in the inbox and returns; throws `closed` on a closed agent; no `input` = turn the key only | no |
| `send(input?, { signal })` | Starts if needed, pushes, waits until idle, returns `messages` (does not close) | yes |
| `runOnce(input?, { signal })` | Starts, `send`, closes, waits until dead, returns `messages` | yes |

`runOnce()` is not a seventh lifecycle action: it is `send` with an ending wrapped around it, and `send` is `start` + `push` + wait-until-idle composed. After it returns, the agent is gone.

`send()` and `runOnce()` refuse anything whose `lifetime` is not `"one-shot"`. `runOnce()` also refuses an agent that has already been started, and refuses an empty `messages` array with no input content — a key with no fuel would send an empty request. Those are mistakes in the calling code, so they throw a plain `Error` rather than an `AgentError`: the error codes exist for failures that end up on `message.error` and are read back from storage.

## The loop

```ts
for await (const batch of inbox.asTakeAll()) {
  // a batch is in hand
}
```

The queue is both the inbox and the wake-up signal: while it is empty the loop is parked on the queue's own push notification, so nothing else has to be signalled. That one `for await` is the outer loop; the queue itself is internal to `Agent`, and the point is that no second wake-up mechanism exists besides it — two mechanisms always end with one of them forgetting to wake the loop.

```text
start() → outer loop
 └─ wait on the output gate                     ← once, before taking anything
    for await (batch of inbox.asTakeAll())
        state = "working"
        repair history                          ← the only place that looks back
        land this batch (one user message per entry with content, nothing for a key)
        report inboxTaken
        onOuterLoopStart → inner loop → onOuterLoopEnd
        queue empty → state = "idle"
        wait on the output gate                 ← once per batch, at the tail
```

The wait on the output gate exists twice — once before entering and once at the tail of every batch. That is what "nothing is taken between batches" means in practice: entries that arrive while the gate is on stay in the queue, are visible as a count, can be persisted, and can be restored later.

`state` is decided by the position of the loop and by nothing else: a batch is taken → `working`; the batch is done and the queue is really empty → `idle`. The output gate does not take part in that decision, so "the batch that arrived while output was paused has finished" and "output is still paused" are two facts that can both be reported.

A batch that has already been taken counts as started. `pauseOutput()` takes effect from the next batch and does not put the current one back: it may already have landed messages and be halfway through its tools, and pushing it back to the head of the queue would only land it twice. Use `abort()` to stop right now.

The inner loop repeats while the last response asked for tools. It is a `while`, not recursion: each level of recursion adds a stack frame and a private copy of local state, and "which iteration is it in" becomes unanswerable. Inside one batch the tools of a response run in parallel and their result messages land in call order, not in completion order.

The inner loop has exactly one take point: after a request finishes and before the next one starts, and it looks only at entries with `priority: "high"`. Low-priority entries and keys it does not even look at, which is what leaves them to the outer loop.

## State and the two gates

Three separate places, three separate answers. None of them speaks for another.

| Place | Member | Says | Changed by | Events |
|---|---|---|---|---|
| Outward state | `state: "working" \| "idle"` | whether there is work in hand | the loop position only | `state:working` / `state:idle` |
| Output gate | `isOutputPaused` | whether entries are still taken (`true` = not from the next batch on) | `pauseOutput()` / `resumeOutput()` | `output:paused` / `output:resumed` |
| Input gate | `isInputPaused` | whether entries are still accepted (`true` = `push()` is refused) | `pauseInput()` / `resumeInput()`; `stop()` / `kill()` are producers of it | `input:paused` / `input:resumed` |

One sentence separates the gates: the input gate blocks delivery, the output gate blocks taking. With the input gate closed, `push()` is turned back (`closed` once the agent is finished, `input_paused` while the gate is only paused) and neither the queue nor the batch in hand is touched. With the output gate on, nothing is taken while delivery still works and entries stay queued. Neither gate takes part in `state`.

`stop()` and `kill()` close the input gate themselves and it never opens again afterwards: once the queue has declared that no further entries will arrive, letting one in would hand it to a queue nobody takes from.

- `pauseOutput()` takes effect from the next batch: the batch in hand finishes.
- `abort()` cuts in-flight work (the request and the tools) and reports `aborted`; the agent does not die, the output gate is simply on. Dying is `kill()`'s business.
- Each gate has its own pair of events, and its current value is read from the live object (`agent.isOutputPaused` / `agent.isInputPaused`), not carried in the event payload. Neither pair speaks for the other.
- There is no "errored" state: an error is a fact, read from a message's `status` and `error`. There is no "dead" state either: dead means there is no agent object.

Everything else is read from the live object; there is no second copy of state and nothing depends on every event arriving: whether it is working is `state`; whether it still takes entries and still accepts delivery are the two live readings; what it is thinking and which tools it is waiting on are read from the messages themselves.

## inbox

An entry has one of two shapes. Both are plain data — no live references — because entries are stored and read back.

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

An entry with content splits two ways by `priority` and three ways by `source`. Every `source` is text: `{ kind: "user" }`, `{ kind: "agent", label }` for another session, `{ kind: "system", label }` for a host, a timer or an external system. Every `role: user` message carries one — a host-injected hidden message included — so "the user said this" has exactly one test: `source.kind === "user"`.

A live `Agent` reference is not allowed in `source`: messages are stored, and an agent carries a client, its subscriptions and its own message array, which serialises into a cycle. Looking into that session needs a session id, which is the host's property.

For every source other than `user`, the kernel puts one comment line in front of the text when the entry lands — this is the literal line it writes:

```text
// 这条消息来自 <label> 自动推送（<createdAt>）

<the content, unchanged>
```

For content given as an array of sections the comment becomes a leading `text` section and every other section stays where it was: joining it into a string would throw the image sections away. The timestamp is the entry's own `createdAt`, not "now": an external notification may describe something that happened long ago, and the model needs to be able to tell.

Reading the queue without taking anything:

| Member | What it gives |
|---|---|
| `inboxPending` | the entries not taken yet, in arrival order — a copy of the array, the same entry objects |
| `inboxSize` | how many are queued |

`restore(entries)` puts stored entries back unchanged: same `createdAt`, no defaults invented, and no `inboxAdded` (the row is already in storage, restoring is not a new change). It refuses a one-shot agent (its life is on the call stack, there is no "keep waiting after a restart"), a closed or killed agent, and an entry whose shape is incomplete — a half entry is rejected on the spot, and one bad entry keeps all of them out.

Three facts are reported, and every change of the inbox means one of them:

| Event | Payload | When |
|---|---|---|
| `inboxAdded` | `entry` | an entry was pushed |
| `inboxTaken` | `entries` | these entries left the queue and their messages are already landed |
| `inboxCleared` | `entries` | the queue was voided (`clearInbox()`), not taken from |

Clearing goes through the queue's own `clear()` and looks at neither gate: voiding and taking are two different openings. Taking looks at the output gate (nothing is handed out while paused, the entries are only queued); voiding does not, so a queue can still be cleared while the output gate is on.

There is one order of writing storage that cannot lose anything. On the delivery path, write first and `push()` second: the other way round, a crash between the two steps leaves the entry in memory only, and a process that dies never had it; writing first costs at worst taking the same entry again, and that duplicate is recognisable (its `messageId` is in the history). On the take path it is the other way round: the message lands in `messages` first, and `inboxTaken` is reported after. Both directions are one rule — a duplicate is better than a loss. The kernel knows nothing about storage; it only puts the three cut points in place so that the persisting side has exactly one order that works.

## Repair at the head of the loop

Before the loop takes its next batch it repairs the history once. That is the only place that looks back, and it does three things: it types leftover `writing` / `pending` messages, it deletes whatever the "drop" strategy does not keep, and it fills unpaired tool results according to the "fill" strategy. The judgement uses two things only — the message `status`, and the pairing between `tool_calls` and tool messages — so an interruption, a failure and a crash all look the same here.

| Member | Values | Default | Decides |
|---|---|---|---|
| `abortedToolRoundStrategy` | `"fill"` / `"drop"` | `"fill"` | an interrupted tool round: keep it and fill the missing result (`abortedToolRoundReason`), or remove the whole group |
| `abortedMessageStrategy` | `"drop"` / `"keep"` | `"drop"` | an interrupted assistant message: delete it, or keep the part that was already written |

Both are constructor options. "Drop" really deletes — memory and storage both — and reports `messageRemoved`; `omit` means something else (a message that stays but is no longer sent).

Repairing at the head rather than at the end has three consequences. It is written once: loading a history that crashed needs no special handling, and the host does not even have to remember to call anything. What goes in is always clean: building the request body, counting usage and checking pairing inside the inner loop may assume a clean history unconditionally. And the user still sees the truth: the half sentence and the tool that never answered stay visible until the agent really starts again, instead of being quietly rewritten the moment stop was pressed.

## Events

Every event carries `agent`, `seq` (this agent's own counter, from 1, only increasing) and `at`. Wherever an event carries a message, an entry or a stream fragment, it is the live object itself, never a copy — a copy is a second fact and starts going stale the moment it is handed out.

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

`seq` is what lets a subscriber detect a duplicate or a gap. `denied` and `failed` are separate names because the history looks different afterwards: `denied` leaves not a single character, `failed` leaves a half assistant message with `status: "error"`. `reason` is copy for a model or a person; `detail` is what a program reads.

A subscriber is a bypass. `on(type, handler)` returns an unsubscribe function; a handler that throws is caught on the spot, reported as `observerFailed`, and does not disturb the agent — a full disk should not kill the request that was being watched. Events are a notification, not the only source of truth: late, repeated or missing, correctness is unaffected, because reading the live object heals it.

## Hooks

`use(plugin)` mounts a plugin. A hook names a position in the loop, not a fact (facts are events).

| Hook | Can refuse | Position |
|---|---|---|
| `onInit` | no | after registration, unrelated to lifecycle |
| `onStart` / `onStop` / `onKill` | no | the edges of the life |
| `onOutputPaused` / `onOutputResumed` | no | the output gate flipped |
| `onAbort` | no | someone pressed stop (sent even when the gate was already on) |
| `onIdle` | no | the outward state became `idle` |
| `onOuterLoopStart` / `onOuterLoopEnd` | no | a batch began / ended |
| `onInnerLoopStart` | yes | before the assistant placeholder exists; also allowed to rewrite the request body |
| `onInnerLoopEnd` | no | the request ended |
| `onToolStart` | yes | the tool exists; asks whether to run it |
| `onUnknownTool` | yes | the tool does not exist; asks what to answer the model |
| `onToolEnd` | no | the tool ran (only for tools that exist) |
| `onSubAgentStart` / `onSubAgentEnd` | start only | the delegation boundary |

Exactly four can refuse. `onOuterLoopStart` is not one of them: the batch has already been taken out of the queue, and a refusal would leave it without an owner. A decision about a batch belongs before delivery.

When a hook throws, the four that can refuse fail closed — they are gates, and a broken guard that lets work through is no guard — while every other hook fails open and is treated as not having spoken, and the next plugin is asked. Both report `failed`; a thrown plugin must not leave an agent that looks alive and does nothing when something is pushed in.

A string returned by a refusing hook is the body of the tool message or the reason of the denial; the kernel does not wrap it in its own wording — that sentence is what the model is meant to read. `onInnerLoopStart` runs before the assistant placeholder is created, so a refusal leaves no message stuck in `pending`. The `body` it receives is the request about to be sent, not `agent.messages`: the copy that goes out and the live one are different things, and a hook may rewrite it.

Hooks run before events at the same position, with one exception: the `state:*` event is emitted by the state setter before `onIdle`, and `started` before `onStart`, because the setter is a synchronous boundary and the subscriber has to be able to see that value before the hook runs.

## Errors

One class, one instance in two places.

```ts
export type AgentErrorCode =
  | "request-failed"   // could not connect / no response
  | "stream-failed"    // a response came, but the stream broke or did not fit
  | "closed"           // the agent is finished: pushing will never be taken again
  | "input_paused";    // the input gate is closed right now: wait and push again

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string, options?: { cause?: unknown });
}
```

Each of the four codes describes one thing in the world. The two that must stay apart are the last two: `input_paused` says waiting and pushing again will work, `closed` says deliver somewhere else — folded into one code, the delivering side can only retry into a queue that will never be taken from again.

The same instance is the payload of the `failed` event and the `error` of the message it belongs to. `toJSON()` gives `{ code, message }`, enough to rebuild it from storage (`AgentError.fromJSON()`); `stack` and `cause` are decided by whoever writes the row.

Error text never goes into `content`. `content` is what the model said; with the "keep" strategy in play, a stored `ECONNREFUSED` would come back to the model as something it said itself. A `role: tool` message is the exception: its `content` is the result the model is meant to read.

The kernel classifies only the dimension it knows (which part failed). It does not decide whether an error is retryable, does not translate a 401 into "wrong key", does not back off, does not retry — once those get in, the kernel has to understand networks, vendors and idempotency.

## Parts

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
| `reconcileAbortedToolRounds` / `reconcileAbortedMessages` | the two halves of repair, exported so they can be reused and tested |

`Tool.exec` cannot stop the loop: whatever it returns is one tool message handed back to the model. The two ways to stop are a hook refusing and `abort()`. Bad arguments, a throw inside the tool and a tool that does not exist are the same thing — no valid result — and become one tool message handed back to the model, with the loop neither stopping nor retrying.

## Minimal example

```ts
import OpenAI from "openai";
import { Agent, Message } from "@ai-zen/agents-core";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.openai.com/v1",
});

const agent = new Agent({
  client,
  model: "gpt-4o",
  messages: [Message.System("Answer in one sentence.")],
});

// on() returns the unsubscribe function; the handler receives the live message
const offFinished = agent.on("messageFinished", ({ message }) => {
  if (message.role === "assistant" && message.content) console.log(message.content);
});

// resolve when one batch is done and the queue is empty
const idle = new Promise<void>((resolve) => {
  const offIdle = agent.on("state:idle", () => {
    offIdle();
    resolve();
  });
});

agent.push({ content: "What does this package do?", priority: "low", source: { kind: "user" } });

void agent.start();  // resolves only when the agent is dead
await idle;          // the batch in hand finished
agent.stop();        // drain what is queued, then die
offFinished();
console.log(agent.messages.at(-1)?.content);
```

`start()` returns a promise that resolves at death, so it cannot be awaited before `stop()`. Waiting for one batch means waiting for `state:idle`: the payload of that event only says which value it reached, the current value is read from `agent.state`.

## What it does not do

| Not done | Why |
|---|---|
| retrying, classifying, downgrading | product policy; a retry loop in the engine would need to understand networks, vendors and idempotency |
| normalising vendor error codes | every new provider would mean changing the kernel |
| i18n | engine-level text is English; languages belong to the host |
| knowing about assets, endpoints or storage | it would grow into an application along that line |
| idle collection, reference counting, timers | the life only follows the six actions |
| a recursive inner loop | each level adds a stack and blurs "which iteration is it in" |
| a global "aborted" flag or "errored" state | a global flag is how an agent ends up needing manual revival; an error is a fact on a message |
| error text in `content` | the model would read it as something it said |
| tools whose result arrives later on a one-shot agent | nobody is left to receive it |
| `send()` / `runOnce()` on a resident agent | it has no causal chain of its own to wait on; there, delivery is `push()` |

## Reading on

- [Getting Started](getting-started.md) — one agent without a host
- [Architecture](architecture.md) — why the line is drawn there, the four questions for live objects, where events and persistent state land
- [SDK](sdk.md) — capabilities and the runtime on top of the kernel: capability containers, model resolution, handoff, wake and post
