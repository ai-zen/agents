# Cost

Model calls are billed per request. There are only two sources of cost: how many requests are made, and how long each request's input is.

The second one is the easiest to overlook here: every request resends the whole history, so the cost of a session grows with the length of that history rather than with the number of turns. Keeping the history from growing without bound and keeping each request from growing are therefore two separate problems, and they are listed separately below.

## Keeping each request short

| Mechanism | Fact | What it saves |
|---|---|---|
| Prefix caching | Request bodies are rebuilt from a whitelist: only `role`, `content`, `tool_calls`, `tool_call_id`, `function_call`, `reasoning_content` survive. Message ids and timestamps are dropped, so the prefix sent for one conversation is byte-for-byte stable | When the provider hits the cache, the cached prefix is billed at a lower rate |
| Stable context identity | When an endpoint declares `providerSessionHeader` (such as `x-opencode-session`), every request of a live agent carries the same identifier. The host uses the session id, unchanged across restarts; a delegated sub-agent gets its own | The provider routes requests of one context together, which is what makes cache hits possible |
| Progressive disclosure | Skill bodies, remote MCP tools and sub-agent details never enter the tool list; only entry points do | Dozens of MCP servers and skills leave the list length unchanged |
| Tool output ceiling | When a single tool output exceeds `maxToolOutput` (default 32768 characters), the excess does not enter the context whole: tools such as `exec` write the full text to a temporary directory and the model gets a head/tail preview with the path | Tens of thousands of lines of `pnpm test` output do not become content that every later request must resend |
| Delegation isolation | A sub-agent has its own history and tools; the parent receives only its last message plus accumulated `subAgentUsage` | The dozens of tool calls inside the sub-agent never enter the parent's context |
| Separate helper requests | Automatic session naming and handoff summaries go through `completeOnce`: not streamed, no tools, and a cheaper model can be named for them. Naming sends only the last 2000 characters | A few dozen tokens of work does not need a full-input request from the main model |

## Keeping the history bounded

| Mechanism | Fact | What it saves |
|---|---|---|
| Two thresholds | `handoff` soft line and `guard` hard line, factory values 40% and 80% of the window | Handing off before the history becomes two or three times as long, instead of when it no longer fits |
| No request past the hard line | Above the hard line `ContextGuardPlugin` returns a reason from `onInnerLoopStart` and the request is never sent | Paying nothing for a request that cannot succeed |
| Handoff | The memory becomes "the template plus one short breakpoint message carrying a path" | Every request afterwards carries only the template and one short message |
| Interruption does not redo work | `abortedMessageStrategy: keep` keeps the partial answer and the next request continues from it; `abortedToolRoundStrategy: fill` keeps the whole tool round instead of redoing it | Inputs already paid for are not wasted by an interruption |

## Keeping the request count low

| Mechanism | Fact | What it saves |
|---|---|---|
| Results come back | Results of `async_exec`, `async_timeout` and MCP long tasks are delivered into the session and wake the agent from idle | No polling with `sleep`, and every poll is a full-input request |
| The queue does not lose deliveries | Messages arriving mid-run wait in the queue by priority | No user-side retry loop of "wait until it finishes, then send again" |

## Observability

Every assistant message carries the token usage of the request that produced it (`usage`); when a delegation finishes, the accumulated usage of the sub-agent and its descendants is recorded on that tool result message as `subAgentUsage`. Sum with `sumUsage()`: adding up all messages in a session gives its actual consumption.

## The trade-off

A `self` handoff costs 1–2 extra full-input requests; those inputs are longer than usual. What they replace is a history that keeps growing, but the cost itself is real and does not disappear because the operation is called a handoff.

The `summary` executor is cheap and deterministic, but it has neither the original context nor tools, so its fidelity is low. It does not automatically stand in for a failed `self` handoff: treating "the model failed to write the document" as "let someone else write it" would make a failed handoff look like a successful one.
