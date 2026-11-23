---
title: Architecture
description: Why the split is where it is — what each of the four layers owns and the four criteria, the four questions and five criteria for live objects, facts rising while materials come down, the four parts of an event, the single write path, and observation as a bypass.
outline: deep
---

# Architecture

This page answers "why the split is where it is". Which actions and classes live inside a layer is
[Core API](core.md) and [SDK](sdk.md); how the host process exists is [Deployment](deploy.md).

## What each of the four layers owns

| Layer | Package | Owns | Strictly does not |
|---|---|---|---|
| Kernel | `@ai-zen/agents-core` | All the behaviour of one Agent: the outer loop that takes InboxEntries in batches, the inner loop that sends a request and runs tools, the two state values, isInputPaused and isOutputPaused with their methods, the lifetime, the event bus, plugin mounting | Sessions and workspaces, storage, network and credentials, language and copy, reading config files, capability discovery |
| Capability face and runtime | `@ai-zen/agents-sdk` | Capability face: a Scope per directory holding tools, skills, SubAgents, MCP servers and the three PeerSession tools; three-level model resolution; handoff. Runtime: wake an Agent, keep the register of what is alive, post() to another session, dispose a container by directory | Storage, connections, credentials, language and user-visible copy, session rows — a session is an opaque identity here |
| Host | `@ai-zen/agents-host` | Rows and tables, connections and credentials, client odds and ends (notices, assets, questions, search), user-visible text and language, the single-instance discovery file, the command line | Build an Agent, keep the register of what is alive, decide when a Scope is disposed, judge whether a config is valid, merge MCP configuration, manage connecting and reconnecting |
| Connection layer | `@ai-zen/agents-client` | Launching a host, discovery (the discovery file and the credential delivery file), credential sources, reconnect | Be published (`private: true`); be imported by `core` or `sdk` |

Two more packages sit outside the four layers, each existing for one job: `@ai-zen/agents-logger`
(one process, one log file, zero dependencies, constructed only at the assembly root) and
`@ai-zen/fake-llm` (an OpenAI-compatible fake endpoint, used only by tests and never in a
production dependency graph).

## The four criteria for the split

1. Code that says "who is alive", "who knows whom", "when to build and when to tear down" belongs to
   the runtime (sdk), not the host.
2. Code that exists in the host only so that "another agent must see it too" belongs to the runtime.
3. An `as unknown as`, or a fake instance built to satisfy an interface from the sdk, means a port is
   missing; the port is declared by the sdk and implemented by the host.
4. The other direction: code that only reads and writes files, writes rows, relays events, validates
   credentials or renders copy belongs to the host, and must not be moved into the sdk.

The four become one executable test: delete the host, and the kernel plus the sdk alone still assemble
agents that are event-driven, resident and able to talk to each other. If they cannot, the split is
wrong and gets fixed first; the host is not allowed to fill the gap.

## Facts rise, materials come down

| Aspect | Kernel | sdk | Host |
|---|---|---|---|
| Creation | `new Agent` (history as an argument) | `createAgent` plus the runtime's `wake` | None — it only hands out a new identity |
| Observation | `on()` emits facts | the runtime forwards them and lets other agents subscribe | subscribe → write rows → push to the wire |
| Persistence | emits facts, never persists | same as the kernel: facts only | the one write path; it hands the recovery materials to `wake` |
| Communication | `send()` into the inbox | `post()` to another session | relays what a client sent inward without interpreting it |
| Switches | `pauseInput()` / `pauseOutput()` plus two readers | pass-through | turned into procedures and wire events |
| Lifetime | `start` / `stop` / `kill` | `wake` / reclaim | turned into procedures |

All three keep one rule: facts rise from the bottom up, materials come from the top down, and nothing
in between holds a second copy of the same thing.

Reverse the direction and it breaks in a specific way: a host that keeps its own register of who is
alive holds a second truth that will drift, and a lower layer that reads the database turns "the
database is recovery material" into "the database is the truth".

## Live objects: four questions and five criteria

An object whose lifetime is bound to the process or to an entity has no table behind it. Today
those are the two: `Agent` and `Scope`.

Four questions have to be answered before the code is written:

| Question | What has to be answered |
|---|---|
| Creation | who builds it, who holds it afterwards, when it becomes visible outside |
| Observation | what the one-shot snapshot is; which events report its changes; how a subscriber tells a duplicate from a gap |
| Persistence | which part is stored, where the cut points are, what is used to assemble it back on recovery |
| Disposal | who tears it down, what the order is before that, and what stays in the database afterwards |

The five criteria:

1. Creation reports an event, and the event precedes visibility. Built → announced → then the
   snapshot read can see it. The other order hands a subscriber something it does not recognise yet.
2. The snapshot covers the events. Whatever an event can express must come back whole when the object
   is opened or listed; otherwise one lost event leaves a hole in the interface and nobody notices.
3. Persistence has cut points, not improvisation. A live object does not know about the database: it
   emits facts, and a third party subscribes, flushes and recovers. Everything stored needs a matching
   event, and everything storable needs a way back in; data written with no way back in is only
   baggage.
4. Disposal is ordered: report the last facts → report "I am going away" → unsubscribe → void. After
   that the object emits nothing. Unsubscribing first means a subscriber never learns what it missed.
5. Memory is the truth, the database is recovery. Read memory while the object is alive; read the
   database only when it is gone, and then the database is all there is. Reads happen at recovery,
   writes happen at the event.

Four things do not follow this: rows with a table behind them (SessionRecord, messages, NoticeRecord, AssetRecord),
one-shot processes (handoff), connections, and questions. None of them has the pair "memory is the
truth, the database is only recovery material", and each has its own facts.

The criterion for adding one field: events, snapshot, storage and recovery change together. If they
cannot, that field has two shapes.

## The four parts of an event

Every event carries the same four things:

- `type`: what happened;
- `seq`: this live object's own monotonic counter, from 1 — a subscriber uses it to detect duplicates
  and gaps, and to answer where to continue writing;
- `at`: the moment;
- the payload: the whole of that object at that moment, not a difference, and the attribution
  (which object, which level of delegation, which tool call) along with it.

Facts come in three kinds, and each lands differently:

| Kind | Example | Who persists it |
|---|---|---|
| something happened | a new message, a new InboxEntry | one row at first appearance |
| something changed | a text delta, a structural change, a status flip | the subscriber decides how fine, its throttle window is its own policy |
| something is final | this version of a message is the last one, a request finished | always written, read-only afterwards |

Without the "final" kind a subscriber has only two bad choices: write the whole row on every fragment,
or write once at the end and lose the text when the process dies.

## One write path

Writing rows happens in the host only: the kernel and the SDK's capability face emit facts and write
nothing; the host subscribes to those facts, writes at its own cut points, and turns the same batch
into wire events for clients. A failed write must not hold the push back.

Recovery is the same road in reverse: the host reads the history and the entries nobody took last time
out of the database, assembles them into `WakeMaterials` and hands them to `wake`. That single port is
why "close it and open it again, the memory and the queue are still there" holds — not two places each
saving their own copy.

## Observation is a bypass

A subscriber that throws is isolated and turned into its own `observerFailed`; the observed object
keeps running. A full disk does not kill the request that was being watched.

Interception uses hooks, observation uses subscriptions. The hooks that can refuse (the four that
decide whether work may begin) fail closed and return a verdict; every other hook fails open, returns
nothing and takes part in no decision. The two never share one port: a broken guard that lets work
through is no guard, and a broken bystander must not change what it is watching.

Policy does not go downwards: how fine to write, how often to flush, how to open a transaction are the
subscriber's business; the live object only offers cut points and facts.

## Reading on

- [Core API](core.md) — the kernel's actions: the inbox, the two loops, the two switches, the event names,
  the plugin hooks
- [SDK](sdk.md) — Scope, model resolution, handoff, the runtime's wake and post
- [Deployment](deploy.md) — how the host process exists: instances, ports, credentials, the data root,
  upgrades
