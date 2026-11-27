# AI-Zen Agents Documentation

A self-hosted runtime for LLM agents. These pages are ordered the way you would use the framework: get one call running, make the agent resident, add capabilities, then put a host under it. A term explained on an earlier page is not re-explained later.

| Page | Contents |
|---|---|
| [Getting started](getting-started.md) | Install the terminal client, start a host, first conversation; the smallest example without a host |
| [Agent](agent.md) | Fields of a definition file, delivery and stopping, the event stream, async results, sub-agents |
| [Capabilities](capabilities.md) | Four kinds of files: tools, skills, sub-agents, MCP; directory layers; four permission dimensions; progressive disclosure |
| [Skills](skills.md) | What a skill is, frontmatter fields and validation, how the model reads one, sub-agent mode, factory skills |
| [MCP](mcp.md) | Writing `mcp.json`, five merged layers, the five runtime tools, tasks and elicitation |
| [Host](host.md) | Sessions and history, waking versus delivering, sessions talking to each other, credentials, public instances |
| [Handoff](handoff.md) | Two thresholds, two kinds, two executors, the nine-section document, archiving and cancellation |
| [Cost](cost.md) | Where the money goes, and what each of the nine mechanisms saves |

Package APIs live in the package READMEs:

- `packages/core/README.md` — Agent methods and events, plugin hooks, message and tool shapes
- `packages/sdk/README.md` — `Scope`, `ConfigManager`, `AgentRuntime`, `HandoffService`, tool factories
- `packages/host/README.md` — module layout of the host
- `packages/fake-llm/README.md` — the fake model server used in tests

The repository root has `README.md` for an overview and `PRINCIPLES.md` for design principles. `dev-docs/` is internal and not written for users.
