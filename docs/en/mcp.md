# MCP

MCP servers connect on demand: discovery only reads the configuration files and establishes nothing; a connection is made when the model calls `load_mcp`.

## Configuration

One `mcp.json`, keyed by `mcpServers`. Each entry is one server, and its key is the id:

```json
{
  "mcpServers": {
    "fs-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": { "LOG_LEVEL": "warn" },
      "description": "Read-only view of /data"
    },
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "X-Team": "infra" }
    },
    "legacy": {
      "type": "sse",
      "url": "https://old.example.com/sse",
      "disabled": true
    }
  }
}
```

| Field | Meaning |
|---|---|
| `type` | `stdio`, `http` or `sse`. When omitted it is inferred: `command` means `stdio`, `url` means `http`. The aliases `transport` and `transportType` are also accepted |
| `command`, `args`, `env` | `stdio`: the child process and its environment |
| `url`, `headers` | `http` / `sse`: address and request headers |
| `oauth` | Only for `http`: `authorizationUrl`, `tokenUrl`, `clientId`, `clientSecret`, `scope` |
| `description` | What the model is told about this server; it is listed in `load_mcp`'s parameter description |
| `disabled` | `true` disables the entry. A disabled entry still claims the name, so a nearer `disabled` cancels a farther definition of the same name |

## Five files, merged as layers

The nearer layer wins, nearest first:

| Layer | File | Writable by the host |
|---|---|---|
| Project root | `<project>/mcp.json` | No: that file belongs to other tools |
| Project host directory | `<project>/.ai-zen/mcp.json` | Yes |
| Project shared directory | `<project>/.agents/mcp.json` | No |
| User level | `<data root>/mcp.json` | Yes |
| Home shared directory | `~/.agents/mcp.json` | No |

Only those two layers are written, because the other three sit either in someone else's repository or in another tool's directory. Merging is "nearest wins", and the files are re-read on every call with no cache: users edit them whenever they like.

Disabling, aliases and "log the file that failed to parse" are handled inside the discovery function; the host layer only answers which five files there are and which two are writable.

## At runtime

Tools on an MCP server do not enter the tool list. The list holds five entry points:

| Tool | What it does |
|---|---|
| `load_mcp` | Connects to a server and returns its tools, resources, prompts and skills. With `include_manifest=false` it connects without fetching the manifest |
| `call_mcp_tool` | Calls a concrete tool on that server |
| `read_mcp_resource` | Reads a resource uri |
| `get_mcp_task_result` | Fetches the result of a long task |
| `cancel_mcp_task` | Cancels a long task |

The server name in `load_mcp` is an enum drawn from the permission-filtered set: a server denied by `permissions.mcps` never appears there and cannot be connected by name either.

Connections live per directory: the `Scope` owns the connection manager, all sessions in one working directory share it, and `dispose()` closes everything. A failed connect rethrows the original error; retry policy is not this layer's business — which errors are worth retrying, and how long to wait, is known only to the caller.

## Long tasks

A server may declare how a tool handles tasks: `execution.taskSupport` is `forbidden` (default), `optional` or `required`. A tool that supports tasks may return a task id instead of a result.

When the task reaches a terminal state (`completed`, `failed`, `cancelled`), a notice is delivered to the queue of the session that made the call, and the notice body points at `get_mcp_task_result`. It travels the same path as background commands: high priority, arriving at that session's next fetch.

If there is nothing to deliver to, the notice is dropped and one line is logged: no waking, no creating, no half entry — a notice pushed by a server must not bring a dead session back.

## Servers asking the user

During `tools/call` a server may send `elicitation/create` asking for a form. That request has to land on the session that made the call:

- The host installs `McpElicitationPlugin` on sessions; before asking, it records who can answer and under which session
- `call_mcp_tool` pushes that record before sending the request and pops it afterwards
- With no record — a one-shot agent, `runOnce`, a call with no question board — the answer is always `cancel`: nobody makes the decision, which is what that means. `decline` is reserved for a user's explicit refusal

Tool calls within one batch run in parallel, so with two `call_mcp_tool` calls in flight the record holds the one pushed last. Parallel calls within one session are unaffected (the same session answers); parallelism across sessions is what may land on the other one.

## Skills extension

If a server declares the MCP Skills extension, the manifest from `load_mcp` carries a skill list as well. A skill is identified by server plus `uri`, and its body still travels through `resources/read`, so the list includes the uris of attachments — when the model sees a relative path in the body, it needs to turn that into a readable uri.

## Troubleshooting

| Symptom | Look at |
|---|---|
| No server connects at all | Whether `mcpPaths` is empty. With no paths the plugin never creates a connection manager, so an `mcp.json` on disk connects nothing and reports nothing |
| Every server in one file disappeared | That file failed to parse. The discovery function logs one line to the log sink; with no sink nothing is recorded |
| A nearer change does not take effect | The name is claimed by a nearer layer; or `autoRefreshTools` is `outer-loop-start` / `off`, so the next refresh is needed |
