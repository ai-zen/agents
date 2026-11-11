---
title: Wire Protocol
description: WebSocket + JSON-RPC 2.0 — one WS message is one JSON-RPC message, integer ids in 0…2^32-1, the first 4 bytes of a binary frame carry the request id and a binary frame always comes after its request, six cases drop the connection (either ceiling / a handshake-time version mismatch / three binary-frame anomalies), the 64 MiB / 8 MiB ceilings and the order they are judged in, no batch, object-form params only, notifications from the client are dropped in silence, the hello handshake (flat result) with its frozen field names and where they are declared, the error-code mapping and the mandatory data.code (including bad-frame and the five invalid-request cases), the id rule for error responses, 15 events behind one session.event method, the stateful questions and per-session / global notices plus the shape of their elements, the binary channel behind content.upload, and 48 methods.
outline: deep
---

# Wire Protocol

This page is the item-by-item specification for anyone implementing a client. The transport is **WebSocket**; the messages are **JSON-RPC 2.0**. The protocol version is `2`: a version that does not match means no connection.

The clauses answer only "is this allowed"; they do not answer "does anything send it" — that is the implementation's call.

## Transport

- The server sends and receives over one **WebSocket** connection.
- **One WebSocket message is exactly one complete JSON-RPC 2.0 message**, in both directions.
- The WebSocket message boundary is the only source of framing: a text frame carries **no trailing newline**, and one message begins and ends inside one WS message.

## Message classification

Which class a message belongs to depends only on whether it has `method` and `id`:

| Shape | What it is |
|---|---|
| has `method` | a request (with `id` it is a call and gets a response) |
| no `method`, has `id` | a response |
| has `method`, no `id` | a notification (receives no response) |

`session.event` is the notification the server sends: it has `method`, has no `id`, and the client does not reply.

**A notification coming from the client is dropped in silence**: a message with `method` and no `id` is neither dispatched nor answered — not even with an error response — and the connection stays as it was. This is what JSON-RPC 2.0 itself prescribes: a notification is by definition the class that expects no receipt, and the server MUST NOT reply to a Notification; answering one with an error would be a departure from the standard. Dropping it does not touch the connection state either: it does not count as "the first request", and the handshake gate is still waiting for the next `hello` that carries an `id`.

In this version the server does not initiate requests, so a client never receives a response and must not send one: a message the server receives that has **no `method`** is an invalid request (see "the five cases `invalid-request` covers" below).

## `id`

`id` is an **integer in `0 … 2³²-1`** (both ends inclusive).

JSON-RPC 2.0 allows a string or a number for `id`, and `null` as well; this version allows integers only. The reason is that a binary frame (below) carries the `id` in the first four bytes of the message, and a string does not fit there.

## Text frames and binary frames

| Frame | Content |
|---|---|
| text frame | one JSON-RPC 2.0 message (request / response / notification) |
| binary frame | the payload of one request |

Layout of a binary frame:

```
bytes 0…3      the request's JSON-RPC id (big-endian, unsigned)
bytes 4…end    the raw payload (no separator, no encoding)
```

- The first four bytes are that request's JSON-RPC `id` (big-endian, unsigned); everything after them is raw bytes. This is where the `0 … 2³²-1` limit on `id` comes from.
- The payload is associated **by those four bytes alone**, never by "which frame it happens to follow": several requests carrying payloads can be in flight on one connection at the same time, and each binary frame finds its own request through those four bytes.
- Bytes never travel inside JSON: `params` carries no bytes, bytes travel only in binary frames. Images and files that have to reach the server travel this way (`content.upload`, see the next section).
- One request carries **at most one** binary frame.

### Ordering: a binary frame comes after its request frame

WebSocket is **ordered on a single connection**: what is sent first arrives first. That gives one order you may rely on — **a binary frame always comes after its request frame**: the request frame arrives first and the server registers it as in flight; the bytes arrive afterwards and find that same request through their first four bytes.

The other way round is a violation: **a binary frame arriving before its request frame → the connection is dropped**. It can only come from an implementation error (a wrong `id`, or no request sent at all).

This order is what the criterion in the next section rests on: since the bytes always arrive afterwards, "the `id` matches no in-flight request" has exactly one explanation left — the two ends already disagree about which bytes belong to which request — and not "the request is still on its way". So there is nothing to wait for, to buffer, or to retry.

### Binary-frame anomalies

Four cases: three drop, one does not.

| Case | Result | Why |
|---|---|---|
| the `id` in the first four bytes **matches no in-flight request** | **connection dropped** | the error belongs to no request — there is not even a "reply to whom" to aim at, so there is nothing to reply with. Bytes always come after their request frame (see "Ordering" above), so such a frame can only come from an implementation error: the two ends already disagree about which bytes belong to which request |
| a **second binary frame for the same `id`** | **connection dropped** | one request carries one payload block. A second one means the two ends disagree about how requests pair with payloads; same as above, there is nothing to reply to |
| **fewer than 4 bytes** (not even the `id` can be read) | **connection dropped** | with no `id` readable it belongs to no request — the same class as "the `id` matches nothing": there is nothing to reply to, and it can only come from an implementation error |
| an **empty payload** (only those four bytes, nothing after them) | the connection **stays open** | this frame is **aligned**: the boundary is perfectly readable, the content is simply empty. Whether an empty payload is legal is the method's call — `content.upload` answers `bad-params` |

One sentence to separate them: the three drop cases are all "these bytes belong to no request" (the `id` cannot be read / the `id` matches nothing / a second block for the same `id`); the one that survives is "the bytes match a request and are merely empty".

## `content.upload` and the binary channel

`content.upload` **keeps its name**; it is still a method, still in the `content.*` namespace. Exactly one thing changed:

- **Its bytes no longer hang behind the request frame with a length declared in `params`**; they travel in **a separate binary frame** whose first four bytes are that request's `id`.
- The shape is "one call, two WS messages": first a text frame, an ordinary `content.upload` request (with an `id`); then a binary frame whose first four bytes are the same `id`, followed by the raw bytes. The server pairs the two by `id` and dispatches one call.
- **Bytes never enter JSON**: `params` only says what this thing is, and carries no length field at all — the payload is exactly as long as the binary frame is.
- One request pairs with one binary frame, no more and no fewer (a second one → connection dropped; an empty one → the method decides, see the previous section).

`params` has exactly three fields, **all required**:

| Field | Type | Required | What it is |
|---|---|---|---|
| `sessionId` | string | yes | which session this content is headed for (the endpoint and the vision capability are decided by the model that session is actually using) |
| `mime` | string | yes | the MIME of the bytes (`image/png` / `application/pdf` …) |
| `filename` | string | yes | the file name (used both for the Files API upload and for the `filename` of a `file` block) |

It is **the only real use of the binary channel**: the server's binary-method list holds nothing else, and that list is the only evidence that "this call puts extra bytes on the wire" — such a method is not dispatched before its bytes arrive.

## Size ceilings

| Ceiling | Value | Applies to |
|---|---|---|
| WebSocket `maxPayload` | **64 MiB** | one WebSocket message (text or binary) |
| text frame | **8 MiB** | one JSON-RPC text message |

They are judged **WebSocket layer first, implementation layer second**; each covers one side and neither pollutes the other:

1. The WebSocket layer applies `maxPayload` = **64 MiB** first: any WS message (text or binary) over it is over the ceiling. This layer does not know what is inside.
2. Text frames are then capped separately at **8 MiB** in the **implementation layer**: one JSON-RPC text message over it is over the ceiling.
3. **A binary frame may go up to 64 MiB** and is not subject to that 8 MiB line — there is no reason for image or file bytes to be capped by a rule about text messages.

Going over a ceiling means **the connection is dropped outright, with no error response sent first**. This is not the same kind of thing as "not valid JSON": that one is "the content of this message does not hold up", this one is "this message is not accepted for its size" — the 64 MiB tier is refused while the WS layer is still assembling it, so a complete message never existed and there is nothing to reply to; the 8 MiB tier is over the line the moment its length is measured in the implementation layer. Neither tier has a "fix the request and try again" recovery path (the same content sent again is just as large), so dropping is the only outcome both ends can settle on.

## No batch

This version does not support JSON-RPC batches: a message whose top level is an array is not a valid request, and the server answers with **one** `-32600` error response (`data.code: "invalid-request"`) rather than expanding it item by item, and **does not drop the connection**.

## `params` is object-form only

`params` accepts the object form (by-name) only. The array form (by-position) is answered with `-32602` (`data.code: "bad-params"`).

## Direction

In this version the server only sends notifications; it does not initiate requests. The client initiates requests, the server replies and pushes `session.event`.

## Handshake

The handshake method is `hello`, and it is an ordinary method in the method table (not a separate class of frame): it is sent with an `id`, and the server answers it like any other request.

Request (client → server):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "hello",
  "params": {
    "protocol": 2,
    "client": { "name": "ai", "version": "1.4.0" }
  }
}
```

Response (server → client, on success):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "name": "agents-server",
    "version": "0.1.0",
    "protocol": 2,
    "pid": 48213,
    "startedAt": "2025-01-01T00:00:00.000Z"
  }
}
```

`result` is **flat** and has no `server` level: there is no `ok` any more in this version — success is spelled by "`result` or `error`" — and once nothing has to be kept apart from an `ok`, there are no sibling fields left that a namespace would separate, so one more level would be one level too many.

The field names are frozen:

| Where | Field | Type | What it is |
|---|---|---|---|
| `params` | `protocol` | number | the protocol version the client supports (`2` in this version) |
| `params` | `client.name` | string | the client's name (used for logs and local debugging only, not for authentication) |
| `params` | `client.version` | string | the client's version |
| `result` | `name` | string | the server's name |
| `result` | `version` | string | the server's version |
| `result` | `protocol` | number | the protocol version on the server's side (`2` in this version) |
| `result` | `pid` | number | the server's process id |
| `result` | `startedAt` | string | when the server started (an ISO time string) |

These two shapes are declared in `packages/server/src/protocol/messages.ts` as `HelloParams` / `HelloResult` — `hello` is one entry in the method table (`MethodApi`), on the same request / response path as every other method.

Rules:

- **The first message must be a request to `hello`**. Calling any method before the handshake → the server answers `-32000` with `data.code: "handshake-required"`, and **the connection stays open**; sending `hello` then makes that same connection usable.
- **`params` is not an object** (including no `params` at all) → the server answers `-32602` with `data.code: "bad-params"`, and **the connection stays open**. It is not a version mismatch: that one says "the two ends do not speak the same generation", this one says "the shell of this request is wrong, fix it and send it again".
- A protocol version mismatch → `data.code: "version-mismatch"` (`-32000`), and the connection is **dropped** afterwards. A missing or non-numeric `params.protocol` lands here too — if the peer's version cannot be read, it does not match.
- **Sending another `hello` after the handshake** → the server answers `-32600` with `data.code: "invalid-request"`, and **the connection stays open** (it falls into the fifth row of "the five cases `invalid-request` covers" below).
- There is no exception: even though this version has no authentication yet, the handshake still comes first. Adding authentication later then changes the handshake, not how every client connects.

## Errors

Response shape (`error` and `result` are mutually exclusive, never both):

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32000,
    "message": "handshake required",
    "data": { "code": "handshake-required" }
  }
}
```

- `code` is a **number** taken from the JSON-RPC standard codes; `message` is **for humans** and the client must not decide anything from it; `data.code` is the **stable string code** the client decides from.

### The numeric mapping

| `data.code` | `code` | When it appears |
|---|---|---|
| `bad-frame` | `-32700` | the text frame **is not valid JSON** (the only case that uses this code) |
| `invalid-request` | `-32600` | it is valid JSON but **not a valid request object** (top-level array / missing `method` / missing `jsonrpc: "2.0"` / an out-of-range `id` / another `hello` after the handshake) |
| `unknown-method` | `-32601` | the method name is not known |
| `bad-params` | `-32602` | the parameter shape is wrong |
| `internal` | `-32603` | an internal server error |
| everything else (the business codes, plus `bad-handshake` / `version-mismatch` / `handshake-required`) | `-32000` | a business failure, or a request-level handshake failure |

The full table of string codes is in the server's `packages/server/src/protocol/errors.ts`.

### `bad-frame`: invalid JSON is a recoverable error

A text frame that is not valid JSON → the server answers `-32700` with `data.code: "bad-frame"` and **does not drop the connection**.

The reason is precisely the assumption that changed with the transport: **the message boundary is now provided by WebSocket**. In the line-framed days "where the frame ends" and "whether it parses" were the same question — a line that would not parse left you unable to tell where the next one began, and every byte after it was read wrong; that is what stream misalignment meant. Not any more: where a WS message ends has nothing to do with what is inside it, and the next one can be read right after this one with full confidence.

So "not valid JSON" is one message whose content does not hold up, not a broken stream. Punishing a recoverable error by dropping would also throw away every other request in flight on that connection — a cost wildly out of proportion to the error itself.

### The five cases `invalid-request` covers

One string code covers five things; all five are `-32600` with `data.code: "invalid-request"`, and **none of them drops the connection**:

| Case | Why it lands here |
|---|---|
| the top level is an **array** (this version has no batch) | an array is not a valid request object |
| valid JSON but **missing `method`** | the server initiates no requests in this version, so the client never receives a response and must not send one; a message with no `method` is therefore nothing at all |
| **missing `jsonrpc: "2.0"`** | the shell is not JSON-RPC 2.0: this message was not written by these rules, so its `id` and `method` cannot be read by them either |
| an **out-of-range `id`** (not an integer / negative / above 2³²-1) | only that range of integers is usable (see "`id`"): nothing outside it can be tied back to a request, and it does not fit the four-byte prefix of a binary frame |
| **another `hello` after the handshake is complete** | `hello` only means something at handshake time; the second one is not a valid call |

What the five share: **the stream is still aligned** — every message begins and ends cleanly on a WS boundary, so the next one can be read right after it, and there is no reason to drop. They are merely "this message is not a valid call", which is exactly what an error response is for.

The `id` splits in two: the first four cannot be tied back to any request at all (not even "what are you asking about" can be read out), so they are answered with `id: null`; the fifth arrives as a request that is traceable, so the error goes back on its own `id` (see the next section).

`bad-frame` means one thing only: "not valid JSON". Anything that parses into an object is never called `bad-frame`.

### The `id` of an error response

An error response carries an `id` just like a success response; there are only two cases:

| When | `id` |
|---|---|
| the top level is an array, `method` is missing, `jsonrpc: "2.0"` is missing, or the `id` is out of range | `null` |
| every other error response (including another `hello` after the handshake) | a number — the `id` of the request that caused it |

`null` is what JSON-RPC 2.0 prescribes for "the id cannot be determined": in these cases the message is not a request at all and belongs to no `id`. Every other error response traces back to one specific request, so its `id` is always a number — including a second `hello` after the handshake, since that `hello` was sent with an `id`.

The client-side mirror rule: **discard responses whose `id` is not in your own in-flight table**. That table holds integer ids only, so an error response with `id: null` falls into the same slot — it says "the message you just sent is not a valid request", but with no matching in-flight call there is no caller to hand it to; drop it, change no connection state, treat it as nothing fatal.

### `data.code` is mandatory

In JSON-RPC 2.0 `error.data` is optional; in this version **every error response carries `data.code`**, and it is the only error identity a client may rely on.

A client must tolerate string codes it does not know: **hand them to the caller as they are**, neither treat them as fatal nor drop the connection over them. New codes are additions, never renames of old ones.

## Events

All 15 events travel behind **one method, `session.event`**. It is a notification (no `id`), and `params` is the event object itself, distinguished by its `event` field:

| `event` | Produced by | What it is |
|---|---|---|
| `open` | core | a turn starts |
| `chunk` | core | body text delta |
| `parsed` | core | a message has been parsed |
| `tool-call-end` | core | a tool result has settled |
| `error` | core | something failed |
| `finally` | core | the turn's wrap-up |
| `sub-agent-start` | core | a sub-agent starts |
| `sub-agent-end` | core | a sub-agent ends |
| `session-phase` | server | the phase changed |
| `session-turn-end` | server | the turn ended |
| `session-notice` | server | a notice inside the session |
| `session-question` | server | a question |
| `session-id-changed` | server | the session id changed |
| `session-title-changed` | server | the session title changed |
| `server-notice` | server | a global notice (belongs to no session) |

The remaining fields of `params` are decided by that event's type. Shape example (only the necessary part):

```json
{ "jsonrpc": "2.0", "method": "session.event", "params": { "event": "chunk" } }
```

### Ordering

- Events are **ordered on a single connection**: the order a connection receives them in is the order the server sent them in.
- The order carries meaning: `open` → `chunk` … → `parsed` → `tool-call-end` → `finally`.
- Two more are hard: `error` comes before `finally`, and `finally` comes before `session-turn-end`. `finally` and `session-turn-end` are two different events, not a rename.

## Stateful notices and questions

Questions, per-session notices and global notices are all **stateful slots with a lifetime**, not broadcasts that vanish once sent: when nobody is connected they are still recorded, whoever connects later can catch up, and they go away only once acknowledged.

| Thing | Belongs to | Lives as long as | On disk | Query entry point |
|---|---|---|---|---|
| questions | the session | the session | not persisted | `pendingQuestions` of `session.snapshot` |
| per-session notices | the session | the session | not persisted | `pendingNotices` of `session.snapshot` |
| global notices | the server process | the process | not persisted | `notice.list` |

Three rules they share:

- **Explicit acknowledgement is the only way out**: no timer ever removes one automatically.
- **One piece of state**: any client acknowledging it removes it; the server does not keep a per-client read marker.
- **Ids are UUIDs**: question ids and notice ids are UUIDs, unique across processes, daemons and restarts. They are not the request `id` — a request `id` is an integer in `0 … 2³²-1`.

The slots hold **the event objects themselves**; there is no separate "slot element" structure invented alongside them. Both kinds of notice carry an `id` (UUID) in their payload, so the pushed one and the one in the slot share the same id. The only extra field is the global notice's `createdAt`: it has nothing else to hang a stamp on.

### Questions

A question arrives as one `session-question` event.

`pendingQuestions` of `session.snapshot` is a `SessionQuestionEvent[]`; each element carries:

| Field | Type | What it is |
|---|---|---|
| `event` | `"session-question"` | the discriminating literal |
| `sessionId` | string | which session it belongs to |
| `questionId` | string (UUID) | the id that comes back with the answer |
| `kind` | `SessionQuestionKind` | which kind of question (the client looks up its own dictionary and dispatch table by it) |
| `input` | `"select"` / `"text"` | how to answer: pick one, or fill in a value |
| `options?` | `string[]` | the option ids when `input: "select"` (the wording lives on the client) |
| `params` | object | the facts needed to render the title |
| `allowSkip` | boolean | whether the user may decline to answer |
| `fallback` | `string \| null` | the value the server will use if no answer arrives |

A question is answered with `session.answer`, whose parameters are just two fields:

```json
{ "jsonrpc": "2.0", "id": 12, "method": "session.answer",
  "params": { "questionId": "<uuid>", "choice": "<one option>" } }
```

- `choice` is `string | null`: `null` means skip, and it is available **only when** `allowSkip` is true.
- It takes `questionId` only and **no `sessionId`** — a question id is a UUID, so it locates itself.
- A question that has not been answered stays in the **session's slot**, and the `pendingQuestions` of `session.snapshot` lists it.

### Per-session notices

A per-session notice arrives as one `session-notice` event.

`pendingNotices` of `session.snapshot` is a `SessionNoticeEvent[]`; each element carries:

| Field | Type | What it is |
|---|---|---|
| `event` | `"session-notice"` | the discriminating literal |
| `sessionId` | string | which session it belongs to |
| `id` | string (UUID) | this notice's id, used when acknowledging (via `notice.ack`) |
| `level` | `"info"` / `"warn"` / `"error"` | severity |
| `code` | `SessionNoticeCode` | which notice (the client looks up its own dictionary by it) |
| `params?` | object | the variable parts of the wording (the client substitutes its own template) |

One that has not been acknowledged stays in the **session's slot**, and the `pendingNotices` of `session.snapshot` lists it; acknowledging goes through `notice.ack`, the same method as for global notices (see the next section).

The `id` comes from the same UUID set as a global notice's. **Live push and the slot are two exits of the same thing, with the same id** — so a `session-notice` that arrived by push can be handed straight to `notice.ack`, with no need to go back and fetch the list first.

### Global notices

A global notice arrives as one `server-notice` event, and it **belongs to no session** — which is why it hangs off the process rather than off a session, and switching sessions does not take it away. The payload of the pushed `server-notice` event also carries `id` (UUID), the same one as the slot returned by `notice.list` — for the same reason: push and slot are two exits of the same thing.

Querying and acknowledging are a separate pair:

- `notice.list` returns the ones that have not disappeared yet;
- `notice.ack { ids }` acknowledges them by id.

The result of `notice.list` is `notices: GlobalNoticeSlot[]`; each element carries:

| Field | Type | What it is |
|---|---|---|
| `id` | string (UUID) | this notice's id, used when acknowledging; the pushed event and the slot carry the same id |
| `level` | `"info"` / `"warn"` / `"error"` | severity |
| `code` | the same code set as `server-notice` | which notice |
| `params?` | object | the variable parts of the wording |
| `createdAt` | string (ISO time string) | when it was recorded |

```json
{ "jsonrpc": "2.0", "id": 13, "method": "notice.ack", "params": { "ids": ["<uuid>", "<uuid>"] } }
```

`ids` may mix ids of **global notices and per-session notices**: an id is a UUID and globally unique, so the server looks in the global table first and then scans each session's notice table — both are accepted, which is why per-session notices need no separate acknowledgement method.

The result of `notice.ack` is `{ acked: string[] }` — **the ids that were actually deleted** (of either kind). An id that never existed, or that someone else had already acknowledged, does **not** appear in it; that is how a client learns which ones are still there, instead of receiving a bare "OK".

`notice.list` / `notice.ack` are a **separate `notice.*` namespace**, declared in `packages/server/src/protocol/notice.ts` (`notice.list` lists the global ones only — per-session notices have something to hang off, so they come through the snapshot; acknowledging, on the other hand, is the single `notice.ack` shared by both kinds).

Counting `hello` and these two, the wire carries **48** methods (45 + `hello` + `notice.list` + `notice.ack`) and still **15** events.

### Live push and catching up are two parallel paths

- **Live push**: the moment one is produced, one notification is pushed (`session-question` / `session-notice` / `server-notice`), so a connected client need not wait for the next query.
- **Catching up**: the slots and query entry points are the fallback — nobody connected at the time, a reconnect, another connection, or even another client machine later all obtain the ones that have not disappeared through `session.snapshot` (questions, per-session notices) or `notice.list` (global notices).

Both paths read the same state, so "was pushed" and "is still there" are two different things: one that was pushed may already have been acknowledged by someone else, and one that was never pushed (no one was connected when it was produced) may still be there.

## When the connection is dropped

The complete list is below, and it holds **six** cases:

| # | Situation | Result |
|---|---|---|
| ① | one WS message over `maxPayload` (**64 MiB**, the same line for text and binary) | the **WebSocket layer** drops it outright, **with no error response sent first** |
| ② | one **text** message over **8 MiB** (the tier the implementation layer caps on its own) | connection dropped, **with no error response sent first** |
| ③ | a protocol version mismatch during the handshake | `version-mismatch` is returned first, then the connection is dropped — a generation break, no best-effort interpretation |
| ④ | a binary frame whose `id` matches no in-flight request | connection dropped |
| ⑤ | a second binary frame for the same `id` | connection dropped |
| ⑥ | a binary message **shorter than 4 bytes** (not even the `id` can be read) | connection dropped |

What the six share: **in these situations this connection can never go on.** ①② are a message that was not accepted for its size (the same content sent again is just as large, so there is no "fix the request and try again" recovery path); ③ means the two ends do not speak the same generation, so no later message's shape can be trusted; ④⑤⑥ mean the two ends' views of the bytes have diverged, or the bytes cannot be attributed at all — all three belong to no request, so there is not even a "reply to whom".

Nothing else drops the connection: invalid JSON (`bad-frame`), an unknown method, a wrong `params` shape, `hello` with a non-object `params` (`bad-params`), calling another method before the handshake (`handshake-required`), another `hello` after it, a top-level array, a message with no `method`, a missing `jsonrpc: "2.0"`, an out-of-range `id`, a business failure, an empty-payload binary frame, a notification coming from the client (dropped in silence, not even an error goes back) — **none of them drop it**; on the client side an unknown `data.code` is handed to the caller as it is, connection kept too.
