---
title: Core API
description: The kernel — how to get it running, the boundary, the six methods, one-shot versus resident, the two loops, the two switches, the inbox and its three events, repair at the head of the loop, the event table, hooks, AgentError, and what it does not do.
outline: deep
---

# Core API

`@ai-zen/agents-core` is the kernel. It produces two things: the one message array an `Agent` holds, and the facts that happen while it runs, handed out as events. No storage, no UI, no copy, no permissions, no configuration.

It runs on the official `openai` package: an `OpenAI` client, a model name and an array of messages are everything needed to construct an `Agent`.

```bash
pnpm add @ai-zen/agents-core
```

## How to use

Construct one, send an entry, wait for the batch — twenty lines:

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

agent.send({ content: "What does this package do?", priority: "low", source: { kind: "user" } });

void agent.start();  // resolves only when the agent is dead
await idle;          // the batch in hand finished
agent.stop();        // drain what is queued, then die
offFinished();
console.log(agent.messages.at(-1)?.content);
```

Construction takes three things: an `OpenAI` client, a model name and the messages to start from. `send()` puts one entry in the queue and returns; it does not wait. `start()` runs the loop, and the promise it returns resolves only when the `Agent` dies, so it cannot be awaited before `stop()`; waiting for one batch means waiting for `state:idle`, whose payload only says which value it reached — the current value is read from `agent.state`. To finish, `stop()` drains the queue and dies.

What gets added next usually follows this order: one run and done is `runOnce()` (see [One-shot versus resident](#one-shot-versus-resident)); a tool is a subclass of `Tool` handed to the constructor; to persist, subscribe to `inboxAdded`, `messageFinished` and `failed`; capability discovery, model resolution, handoff and waking belong one layer up, in the [SDK](sdk.md) — for capabilities without the runtime, see [Core and Scope alone](scope.md).

## What it knows and does not know

| Must know | Must not know |
|---|---|
| messages, tools, model requests, streams, usage, interruption, queueing, delegation | storage, multiple clients, i18n, permissions, UI, who is listening, how capabilities are assembled, how a model is resolved, how assets are materialised |

This table is the ruler for any "should the kernel know X" question: look at the left column. Anything from the right column that gets in will grow the kernel into an application along that line.

The test tightens to one sentence: delete the sdk and the host, keep only the kernel with a fake model client, and an `Agent` still runs a full round — take the entries, make the request, read the stream, run the tools, emit the events, go back to idle.

It does not even know its own name: it is constructed with an `id`, and the kernel uses it only in error messages and logs, never in any decision.

## The six methods

| Method | What it does |
|---|---|
| `start()` | start waiting for `InboxEntry`s. Returns a promise that resolves only when the `Agent` dies, and never rejects |
| `stop()` | close the input, let what is already queued finish, then die |
| `pauseOutput()` | turn the output switch up: no more taking from the next batch on. Nothing in flight is touched |
| `abort()` | abort the request and tools in flight, then turn the output switch up, then report `aborted` |
| `resumeOutput()` | turn the output switch back down. Touches that one switch only, not `state` |
| `kill()` | die at once, everything queued is dropped, no cleanup at all |

Stopping is a combination of two orthogonal questions: is there any life left after this, and should what is in flight be aborted now.

| | Let it wind down | Abort in flight now |
|---|---|---|
| Never run again (queue drained or dropped) | `stop()` | `kill()` |
| Not running for now (queue kept) | `pauseOutput()` | `abort()` |

- `stop()` and `kill()` act on the whole life; `pauseOutput()` and `abort()` act on the next batch.
- `abort()` necessarily implies "no more taking": nothing can continue after an abort. The reverse does not hold — `pauseOutput()` aborts nothing.
- `kill()` is not a faster `stop()`; it is a `stop()` that skips the cleanup.
- All six are no-ops when repeated. Only `send()` and `restore()` throw: `send()` throws `closed` once the queue is closed and `input_paused` while the input is temporarily shut; `restore()` throws when the queue is closed or an `InboxEntry` is incomplete.
- `stop()` and `kill()` cannot be undone: dead is dead, and coming back means constructing a new one.
- The promise `start()` returns never rejects. One failed request is one failed request — it lands on that message's `error` and on the `failed` event, and the loop waits for the next `InboxEntry`.

The output switch releases from both ends: `resumeOutput()` turns it down, and `stop()` and `kill()` release everything waiting on it. Without that second half, a loop parked on a pause would wait for a `resumeOutput()` that never comes and the `start()` promise would never resolve.

The order inside `stop()` and `kill()` is fixed: close the switches and the queue first, then run the hooks, and only then say "dead". So by the time a subscriber hears `stopped` or `killed`, the switch, the queue and `state` all already look the way they should after death.

## One-shot versus resident

Lifetime is fixed at construction (`lifetime: "resident" | "one-shot"`, resident by default). It is not only about how long the thing lives; it is also about what it can do.

| | Resident | One-shot |
|---|---|---|
| How it starts | `start()`, then it waits for `InboxEntry`s | `runOnce()`, with the lifetime inside the call stack |
| Who may send to it | anyone, any number of times (`send()`) | only the caller that started it, and only once |
| How it ends | `stop()` when nobody sends any more | it ends itself: a second `send()` throws `closed` |
| Tools whose result arrives later | supported | not supported |

That last row is hard: a result that arrives at some future moment needs someone still there to receive it. A one-shot `Agent`'s call stack has already returned by then, and nobody is there. Such tools can therefore only be attached to a resident `Agent`, and the assembly side has to refuse them up front rather than discover it at run time.

There is no "send one in, then wait for it to go idle" on a resident `Agent`. `sendAndWait()` and `runOnce()` always throw on one: a resident `Agent` may be sent to by any trigger at any moment, and "wait until it is idle" has nothing to hang on. Only a one-shot `Agent` has a causal chain — the caller's own call.

| Entry point | What it does | Waits |
|---|---|---|
| `send(input?)` | put one `InboxEntry` in the inbox and return; throws `closed` when closed; no `input` = turn the key only | no |
| `sendAndWait(input?, { signal })` | start if needed, send, wait until idle, hand back `messages` (does not close) | yes |
| `runOnce(input?, { signal })` | start, `sendAndWait`, close, wait until dead, hand back `messages` | yes |

`runOnce()` is not a seventh method: it is `sendAndWait` with a cleanup wrapped around it, and `sendAndWait` itself is `start` + `send` + wait-for-idle. When it returns, that `Agent` is gone.

`sendAndWait()` and `runOnce()` refuse any `Agent` whose `lifetime` is not `"one-shot"`. `runOnce()` also refuses an `Agent` that has already been `start()`ed, and refuses a call whose `messages` are empty and whose input carries no content — a key with no fuel makes an empty request. Both are the caller's code being wrong, so they throw a plain `Error` rather than an `AgentError`: those codes are for failures that land on `message.error` and get read back from storage.

## The loop

```ts
for await (const batch of inbox.asTakeAll()) {
  // a batch is in hand
}
```

The queue is both the inbox and the wake-up signal: when it is empty the loop hangs on the queue's own push notification, so no second signal has to be invented. That one `for await` is the outer loop; the queue itself is internal to the `Agent`, and the point is that there is no second wake-up mechanism besides it — two of them guarantee one will forget to wake. `asTakeAll()` comes from `@ai-zen/async-queue`: it is the generator view of `takeAll()`, hanging while empty and taking everything at once when there is something.

```text
start() → outer loop
 └─ wait on the output switch                    ← once, before taking anything
    for await (batch of inbox.asTakeAll())
        state = "working"
        repair history                          ← the only place that looks back
        land this batch (one user message per entry with content, nothing for a key)
        report inboxTaken
        onOuterLoopStart → inner loop → onOuterLoopEnd
        queue empty → state = "idle"
        wait on the output switch               ← once per batch, at the tail
```

Waiting on the output switch happens twice — once before going in, once at the tail of every batch. That is what "no taking between batches" actually means: entries that arrive while the switch is up stay in the queue, their count is visible, they can be persisted, and they can be restored later.

`state` is decided by the position of the loop and nothing else: a batch taken → `working`; that batch finished and the queue empty → `idle`. The output switch takes no part in it, so "the batch that arrived while output was paused has finished" and "output is still paused" are two facts, both reportable.

A batch already taken counts as started. `pauseOutput()` applies from the next batch and does not take it back: it may already have landed messages, and tools may be half run; stuffing it back at the head of the queue would only duplicate. To stop at once, use `abort()`.

The inner loop continues when "the response just made asked for tools". It is a `while`, not recursion: every recursive level adds a stack frame and a private slice of local state, and "which level are we on now" stops being answerable. Within one batch the tools of one response run in parallel, and their result messages go into `messages` in call order, not completion order.

The inner loop has exactly one taking point: the moment the previous request has just finished and the next has not begun, and it looks only at `InboxEntry`s with `priority: "high"`. Low-priority entries and keys it does not even look at; those are left to the outer loop.

## State and the two switches

Three places, three answers, none of them speaking for another.

| Place | Member | What it says | Who changes it | Events |
|---|---|---|---|---|
| The outward one | `state: "working" \| "idle"` | is there work in hand | only the position of the loop | `state:working` / `state:idle` |
| Output | `isOutputPaused` | taking or not (`true` = not from the next batch on) | `pauseOutput()` / `resumeOutput()` | `output:paused` / `output:resumed` |
| Input | `isInputPaused` | accepting sends or not (`true` = `send()` is refused) | `pauseInput()` / `resumeInput()`; `stop()` / `kill()` also produce it | `input:paused` / `input:resumed` |

One sentence separates the two switches: the input switch holds `send()` back, the output switch holds taking back. While the input is shut, `send()` is refused (`closed` after the queue is closed, `input_paused` while it is only temporarily shut) and neither the queue nor the batch in hand moves; once the output switch is up nothing is taken, sends are still accepted and the `InboxEntry`s stay in the queue. Neither switch takes part in `state`.

`stop()` and `kill()` shut the input themselves, and it never opens again: the queue has already declared there will be no new entries, and letting one in at that point would hand it to a queue nobody takes from.

- `pauseOutput()` applies from the next batch: the one in hand finishes.
- `abort()` aborts what is in flight (the request and the tools) and reports `aborted`; the `Agent` does not die, the output switch is simply up. Dying is `kill()`'s job.
- Each switch has its own pair of events, and the current value is read from the live object (`agent.isOutputPaused` / `agent.isInputPaused`) rather than carried in the payload. Neither event stands in for the other.
- There is no "failed" cell: failure is a fact, read the message's `status` and `error`. There is no "dead" cell either: dead means the `Agent` object no longer exists.

Everything else is read from the live object; there is no second copy of the state and no reliance on "not a single event may be missed": whether it is working is `state`; whether it still takes and still accepts sends are those two reads; what it is thinking about and which tools it waits for are in the messages themselves.

## inbox

`InboxEntry` has two shapes. Both are plain data — no live references — because they have to be stored and read back.

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

Entries with content split two ways by `priority` and three ways by `source`. `source` is all text: `{ kind: "user" }`, `{ kind: "agent", label }` for another session, `{ kind: "system", label }` for the host, a timer or an external system. Every `role: user` message carries one — including hidden messages injected by the host — so "the user said this" has exactly one test: `source.kind === "user"`.

A `source` may never hold a live `Agent` reference: messages get persisted, and an `Agent` carries a client, event subscriptions and its own message array, so serialisation would go round in circles. "Jump into that session" needs the session id, and that belongs to the host.

For every source other than `user`, the kernel puts one comment line in front of the content when the entry lands — exactly the line below:

```text
// 这条消息来自 <label> 自动推送（<createdAt>）

<the content, unchanged>
```

When the content is an array of sections, that line becomes a leading `text` section and the other sections keep their positions: joining them into one string would throw the image sections away. The timestamp is the entry's own `createdAt`, not "now": an external notice may be about something that happened long ago, and the model has to be able to tell.

Taking nothing, only looking at what is in the queue:

| Member | What it gives |
|---|---|
| `inboxPending` | the `InboxEntry`s not yet taken, in arrival order — the array is a copy, the entries are the same objects |
| `inboxSize` | how many are in the queue |

`restore(entries)` puts stored entries back as they were: `createdAt` unchanged, no defaults filled in, and no `inboxAdded` emitted (the row is already in storage; restoring is not a new change). It refuses a one-shot `Agent` (its lifetime is in the call stack, there is no "restart and keep waiting" there), a closed or killed `Agent`, and incomplete `InboxEntry`s — a half entry is refused on the spot, and one bad entry means none go back.

Three facts are reported, one per change to the inbox:

| Event | Payload | When |
|---|---|---|
| `inboxAdded` | `entry` | one was put in |
| `inboxTaken` | `entries` | these left the queue and their messages are already in `messages` |
| `inboxCleared` | `entries` | the queue was dropped (`clearInbox()`), not taken from |

Clearing goes through the queue's own `clear()` and ignores both switches: dropping and taking are two different doors. Taking consults the output switch (nothing is handed over while it is up, the goods keep queueing), dropping does not — it still empties while the switch is up.

Only one ordering of the two writes loses nothing. On the `send()` path, persist first and enqueue second: the other way round, a crash between the two leaves the entry in memory only, and a dead process means it never happened; persisting first costs at worst a duplicate take, and that duplicate is recognisable (its `messageId` is in the history). The taking path is the reverse: the messages go into `messages` first, then `inboxTaken` is reported. Both directions add up to one rule — rather duplicate than lose. The kernel knows nothing about storage; it just places those three cut points so that the persisting side has only one ordering to choose from.

## Repair at the head of the loop

Before taking the next batch, the outer loop repairs the history once. This is the only place that looks back, and it does three things: give leftover `writing` / `pending` messages their final shape, delete what should not stay according to the "drop" strategy, and fill in the unpaired tool results according to the "fill" strategy. Only two things are consulted — the message's `status`, and the pairing of `tool_calls` with tool messages — so an interruption, a failure and a crash all look the same here.

| Member | Values | Default | What it decides |
|---|---|---|---|
| `abortedToolRoundStrategy` | `"fill"` / `"drop"` | `"fill"` | a batch of tool calls that was interrupted: keep it and fill the missing result (`abortedToolRoundReason`), or delete the whole batch |
| `abortedMessageStrategy` | `"drop"` / `"keep"` | `"drop"` | the interrupted assistant message: delete it, or keep the part already written |

Both are constructor options. "Drop" really deletes — from memory and from storage — and reports `messageRemoved`; `omit` is a different thing (the message stays, it just stops being sent).

Repairing at the head rather than the tail has three consequences. It is written once: loading a history that crashed needs no special handling, and the host does not even have to remember to call it. What goes in is always clean: building the request body, counting usage and checking pairings inside the inner loop may assume it unconditionally. The user still sees the truth: the interface keeps "cut off mid-sentence" and "the tool never answered" until the `Agent` really starts again, rather than quietly rewriting them into finished the moment stop is pressed.

## Events

Every event carries `agent`, `seq` (that `Agent`'s own counter, starting at 1, increasing only) and `at`. Anything carrying a message, an `InboxEntry` or a stream delta carries that live object itself, not a copy — a copy is a second version of the truth and starts going stale the moment it is handed out.

| Event | What happened | Payload |
|---|---|---|
| `started` / `stopped` / `killed` | it started / it died after draining / it was killed | — |
| `state:working` / `state:idle` | the outward cell reached this value | `from` |
| `output:paused` / `output:resumed` | nothing is taken from the next batch on / taking resumed | — (read `agent.isOutputPaused`) |
| `input:paused` / `input:resumed` | sends are shut / they are open again | — (read `agent.isInputPaused`) |
| `aborted` | someone pressed stop | — (whether anything was aborted is on the message's `status`) |
| `inboxAdded` / `inboxTaken` / `inboxCleared` | one arrived / these were taken / the queue was dropped | the `InboxEntry`s |
| `messageAdded` / `messageChanged` / `messageRemoved` | a message appeared / changed in place / was deleted | that message |
| `messageFinished` | this version of the message is final and will not change | that message |
| `delta` | one raw stream fragment arrived | `chunk` + `source` (`{ message }` or `{ subAgent, toolCall }`) |
| `requestSent` / `responseFinished` | the request went out / this response ended | the request body / the finalised message |
| `turnStarted` / `turnFinished` | one request and the tools it triggered began / ended | the assistant placeholder, the same instance on both sides |
| `toolStarted` / `toolFinished` | one tool began / ended | the tool call / the result message |
| `subAgentStarted` / `subAgentFinished` | one delegation began / ended | the `SubAgent` and the tool call |
| `denied` | a hook refused and nothing ran at all | `hook`, `reason`, a structured `detail` |
| `failed` | it ran and failed | an `AgentError`, plus the message when there is one |
| `observerFailed` | one subscriber threw | the event name and the error |

`seq` lets a subscriber detect duplicates and gaps. `denied` and `failed` are two names because the history afterwards differs: `denied` leaves not a byte, `failed` leaves a half-written assistant message with `status: "error"`. `reason` is the wording for the model or the person; `detail` is the part for programs.

Subscription is a side channel. `on(type, handler)` returns the unsubscribe function; a handler that throws is caught on the spot and reported as `observerFailed` without disturbing the `Agent` — a full disk should not kill the request being observed. Events are only a notification, not the only source of truth: arriving late, repeating or missing one does not affect correctness, because reading the live object heals it.

## Hooks

`use(plugin)` attaches a plugin. A hook names a position in the loop, not a fact (facts are events).

| Hook | May it refuse | Position |
|---|---|---|
| `onInit` | no | after registration, unrelated to lifetime |
| `onStart` / `onStop` / `onKill` | no | the two ends of the lifetime |
| `onOutputPaused` / `onOutputResumed` | no | the output switch moved |
| `onAbort` | no | someone pressed stop (fires even if the switch was already up) |
| `onIdle` | no | the outward cell became `idle` |
| `onOuterLoopStart` / `onOuterLoopEnd` | no | a batch began / ended |
| `onInnerLoopStart` | yes | before the assistant placeholder exists; may also rewrite the request body |
| `onInnerLoopEnd` | no | that request ended |
| `onToolStart` | yes | the tool exists; asks whether to run it |
| `onUnknownTool` | yes | the tool does not exist; asks what to reply to the model |
| `onToolEnd` | no | the tool finished (only for tools that exist) |
| `onSubAgentStart` / `onSubAgentEnd` | only start may | the boundaries of a delegation |

Only four may refuse. `onOuterLoopStart` is not among them: the batch has already left the queue, and refusing it would leave it owned by nobody. Judgements about a batch belong before the send.

When a hook throws, the four that may refuse fail closed — they are doors, and a bad door that opens is not a door — and the rest fail open, treated as having said nothing, and the next plugin is asked. Both report `failed`; a throwing plugin must not leave behind an `Agent` that looks alive but into which nothing moves.

When a refusing hook returns a string, that string is the body of the tool message or the reason for the refusal; the kernel does not wrap it in wording of its own — that text is meant for the model. `onInnerLoopStart` runs before the assistant placeholder is created, so a refusal leaves no message stuck in `pending`. The `body` it receives is the request about to go out, not `agent.messages`: what gets sent and what is alive are not the same thing, and a hook may edit the former.

At any one position, hooks run before events, with one exception: `state:*` is emitted by the state setter before `onIdle`, and `started` before `onStart` — the setter is the synchronous boundary, and a subscriber has to be able to see the value before the hooks run.

## Errors

One class, the same instance appearing in two places.

```ts
export type AgentErrorCode =
  | "request-failed"   // could not connect / no response
  | "stream-failed"    // a response came, but the stream broke or did not fit
  | "closed"           // the agent is finished: sending will never be taken again
  | "input_paused";    // input is closed right now: wait and send again

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string, options?: { cause?: unknown });
}
```

The four codes each describe one thing in the world. The last two are the ones that must be kept apart: `input_paused` says wait and it can still be sent, `closed` says send somewhere else — folded into one code, the sender can only keep trying against a queue that will never take it again.

The same instance is both the payload of the `failed` event and the `error` of the message it belongs to. `toJSON()` gives `{ code, message }`, enough to rebuild it from storage (`AgentError.fromJSON()`); whether to store `stack` and `cause` is decided by whoever writes the row.

Error text never goes into `content`. `content` is what the model said; with the "keep" strategy, a stored `ECONNREFUSED` would come back to the model in the role of something the model itself said. Messages with `role: tool` are the exception: their `content` is exactly what the model is meant to read.

The kernel classifies only the one dimension it knows (which part failed). Whether an error is retryable, whether a 401 means "wrong key", whether to back off, whether to retry — none of that is decided here. Any of it getting in would force the kernel to understand networks, vendors and idempotency.

## Parts

| Export | What it is |
|---|---|
| `Message` | the message class; `Message.System()`, `Message.User()`, `Message.Assistant()`, `Message.Tool()` build one, `id` and `createdAt` filled by the constructor |
| `Tool` | the abstract tool base class: extend it and implement `exec(ctx): Promise<MessageContent>`; the definition lives on `function` |
| `CallbackTool` | a tool defined by a callback instead of a subclass |
| `ToolCallContext` | what a tool receives: `agent`, `tool_call`, `parsedArgs`, `parseError`, `resultMessage`, `signal` |
| `AgentToolLazy` | an `Agent` as a tool: build it on demand, forward its events to the parent, run it once and hand back what it said |
| `applyChunk` | one stream fragment applied to a message in place — the only implementation of that |
| `formatContent` | content sections reduced to the fields the model knows; `__` keys and unknown sections are dropped |
| `sumUsage` / `addUsage` / `ZERO_USAGE` | token usage summed over messages: a message's own `usage` plus a tool message's `subAgentUsage` |
| `reconcileAbortedToolRounds` / `reconcileAbortedMessages` | the two halves of repair, exported so they can be reused and tested |

`Tool.exec` cannot stop the loop: whatever it returns is one tool message handed back to the model. The two ways to stop are a hook refusing and `abort()`. Bad arguments, a throw inside the tool and a tool that does not exist are the same thing — no valid result — and become one tool message handed back to the model, with the loop neither stopping nor retrying.

## What it does not do

| Does not | Why |
|---|---|
| retry, classify, degrade | product policy; a retry loop inside the engine would have to understand networks, vendors and idempotency |
| normalise vendor error codes | every new provider would mean touching the kernel again |
| i18n | the engine's wording is English; language belongs to the host |
| know about assets, endpoints or storage | that line grows into an application on its own |
| idle collection, refcounts, timers | lifetime follows the six methods only |
| recursion in the inner loop | one more stack per level, and "which level are we on" stops being answerable |
| a global "aborted" flag or an "error" state | a global flag is the beginning of an `Agent` that needs reviving by hand; errors are facts on messages |
| error text in `content` | the model would read it as something it said itself |
| tools whose result arrives later on a one-shot `Agent` | nobody is left there to receive it |
| `sendAndWait()` / `runOnce()` on a resident `Agent` | it has no causal chain of its own to wait on; `send()` is all there is |

## Reading on

- [Getting Started](getting-started.md) — an `Agent` without a host
- [Core and Scope alone](scope.md) — capabilities (tools, skills, MCP) without the runtime
- [Architecture](architecture.md) — why the cut is where it is, the four questions for live objects, where events and persistence land
- [SDK](sdk.md) — capabilities and the runtime on top of the kernel: `Scope`, model resolution, handoff, waking and sending
