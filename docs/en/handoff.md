# Handoff

When the context fills up, this runtime does not summarise and compress. It stops, writes a markdown document, and replaces the memory with "the original template plus one breakpoint message pointing at that document".

## Two thresholds

Thresholds live on the model definition (`tokenThresholds`) and can be overridden per session:

| Threshold | Meaning | Who reads it |
|---|---|---|
| `handoff` | Soft line. Once crossed, the agent hands off when it becomes idle | `AutoMigratePlugin`, comparing the `prompt_tokens` of the last request |
| `guard` | Hard line. Compared before every request; crossing it rejects that request | `ContextGuardPlugin`, returning a reason from `onInnerLoopStart` |

The factory values are 40% and 80% of the window. Both are absolute numbers: whatever the configuration says is what applies, with no multiplier arithmetic. Above the hard line no request is sent at all — better an error than paying for a request that cannot succeed.

On the session row, `handoffThreshold` / `guardThreshold` of `null` follow the model definition. `autoHandoff` of `true` hands off with the `self` executor directly; anything else asks first, and an answer of "do not hand off" is remembered for that session so it is not asked again.

## Two kinds

| Kind | What it does |
|---|---|
| `swap` (default) | Write the document, then replace this session's memory with a new one; the old memory becomes a separate archived session |
| `document` | Write the document only. Memory, archived sessions and the agent's identity stay untouched |

The document-only kind exists for "use it as an export": the handoff round is something that really happened in this session, so it is persisted normally. The swap kind does not persist during the handoff — that memory is about to be replaced, so writing it would be pointless.

## Two executors

| Executor | Who writes | Characteristics |
|---|---|---|
| `self` (default) | The original agent, in its own session | Full context, can use tools to verify the real state; best quality, at the cost of 1–2 extra full-input requests |
| `summary` | One independent model call that summarises the serialised history | Cheap and deterministic; no original context and no tools, so fidelity is low |

There is no automatic transition between them: whichever is requested is executed, and failure is reported as failure. Switching executors and carrying on would make a failed handoff look like a successful one.

## The sequence

1. **Trigger**: the soft line is crossed, or the user invokes handoff explicitly
2. **Ask once** (only when no executor was given): a three-way choice — `self`, `summary`, or no handoff. One session holds at most one pending question; if one is already waiting, later callers wait for the same answer. "No handoff" is remembered and that session keeps the same disposition without being asked again; this record is in memory only, so a restart asks again
3. **Enter the handoff state**: the session is marked as handing off, and the interface offers only abort
4. **Write the document**: the agent stops the unfinished work, verifies the real state, then writes
5. **Replace the memory** (`swap`): the old messages leave, and the new memory is "the original template plus one breakpoint message"
6. **Close**: leave the handoff state, emit a notice, and deliver a "go read that document" instruction to this session

That instruction carries the source label `handoff-resume`, separate from the label on the handoff instruction itself: the guard recognises the latter as "this batch carries a handoff instruction" and closes the output switch accordingly, and merging the two would make the guard act at the wrong moment.

## The document

It is written to `<project>/.ai-zen/handoffs/<timestamp>.md`. The writing rules are a factory skill (`<data root>/skills/handoff/SKILL.md`); the core constraints:

- Stop advancing: no new features, no unfinished tasks, no drive-by bug fixes, no refactoring
- No questions to the user, no discussion of approaches, no request for confirmation
- Only two things: verify the real state, then write the document
- Read-only operations are allowed (`read`, `ls`, `glob`, `find_text`, `inspect_file`, `cwd`, and read-only commands such as `git status`, `git diff`, `git log`); no source changes, no installs, no commits
- Write it in one pass; do not read large files; do not paste long code into the document
- Anything that cannot be verified must be marked `⚠️ Unverified`; speculation is forbidden

Nine sections, fixed order:

| Section | Content |
|---|---|
| Conversation breakpoint | What the user last asked for, what you last delivered |
| Task goal | What the user actually wants and how it will be judged, not a checklist of steps taken |
| Current state | Branch and commit, uncommitted changes, whether tests pass, whether ports are open, whether dependencies are installed |
| Completed | For each item: what was done, the output path, and how to verify it really took effect |
| Not completed | What is left, and where it is stuck |
| Key decisions | Which trade-offs were made, and why |
| Constraints and preferences | The rules of the user and of this repository |
| File index | Which files were changed, and what each one is |
| First step for the next agent | What the successor should do first |

A document smaller than 400 bytes counts as not written: only the file size is checked, not the content — "was it written" does not require understanding what it says.

## After the swap

The memory becomes "the original template plus one breakpoint message". That message is `role: system` with `hidden`: not shown to people, but sent to the model like any other. It carries only the document path, never the full text — whoever needs details reads the file, and inlining would put it into every subsequent request. The new memory does not include a cwd message either: the `cwd` tool answers that whenever it is needed.

Where the old memory goes:

| Context | Old memory |
|---|---|
| Host (`swap` kind) | Attached whole as a separate archived session, keeping the original name, with `nameSource` set to `handoff`; both thresholds and the lineage are copied |
| SDK directly | Marked `omit`, left in the array, never sent to the model again, still readable |

The archived session is labelled as an archive in lists and is not confused with the original. The original keeps the same identity and the same `agentId`; only the memory was replaced.

## Traceability beyond the document

The host records one handoff as three rows in the database:

1. The breakpoint message carrying only the document path (the head that remains after the old memory is removed)
2. A notice saying "handoff document written to `<path>`"
3. An archived session row with `nameSource` set to `handoff`

So "when the handoff happened, where the original session is, where the document is" can be answered afterwards.

## Cancellation and failure

- The user aborts: `HandoffAbortedError` is thrown, the whole handoff round is cut from the messages, the document created by this run is not kept, and the session leaves the handoff state. Once the document has been written and validated, cancellation no longer applies. There is no retry and no downgrade to `summary` — treating "the user aborted" as "the model failed to write" would burn an extra full-input request
- The handoff cannot start (this session is already handing off, there is no live agent, no model is reachable, a question is pending): one notice is emitted. The command returned long ago, so a notice is the only way the user learns why
- Writing fails, or the document is too short: reported as failure, and the memory is not replaced

## Continuing in any tool

The handoff document is plain markdown and the breakpoint message carries only its path, so continuing does not depend on this runtime. A different developer, a different coding agent, a different machine — reading that document is enough to carry on. That is the fundamental difference from summarising compression: the document can be opened, two handoffs can be diffed, it can go into version control, and it can be reviewed by someone else.
