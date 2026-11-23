---
title: MCP
description: What someone configuring an MCP server needs to know — the five configuration files and the merge order, the three transports and their fields, what happens on enable and disable, how a server description reaches the model, the OAuth fields that exist without an implementation, the five on-demand tools, and tasks (status pushed, result pulled by task id).
outline: deep
---

# MCP

Everything on the MCP (Model Context Protocol) side lives in `@ai-zen/agents-sdk`, under `scope/plugins/mcp/`: discovery that merges five configuration files into one list, `McpConnectionManager` for connecting and disconnecting, the layer that turns servers into five tools, and where a task status gets delivered.

This page is for someone configuring MCP servers: where the configuration lives, how to write it, when a change takes effect, what parameters the five tools take, and what shape a task has.

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." },
      "description": "GitHub repository and issue operations"
    },
    "postgres": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." },
      "description": "PostgreSQL data access"
    }
  }
}
```

## Five configuration files

One list comes from five files, nearest first, and a nearer file wins for the same name.

| Layer | File | Who writes it |
|---|---|---|
| Project root | `<project>/.mcp.json` | file only — this one is shared with other tools |
| Project | `<project>/.ai-zen/mcp.json` | the UI may write it |
| Project | `<project>/.agents/mcp.json` | file only |
| User | `<data root>/mcp.json` (default `~/.ai-zen/mcp.json`) | the UI may write it |
| User | `~/.agents/mcp.json` | file only |

In code these five layers are these five names: `workspace`, `workspaceAiZen`, `workspaceAgents`, `user`, `userAgents`.

Only the project `.ai-zen` file and the one in the user data root are written by the host; the other three live in someone else's repository or in another tool's directory, and writing those means editing the contents of a repository that is not ours. A write touches only the one entry named: keys this version does not know, and keys another tool put there, are all kept; removing an entry that this layer does not contain reports `not_found`, because the entry came from a farther layer and deleting it here deletes nothing.

Merging has exactly four rules:

- For the same name the nearer layer wins, and the farther entry is not even read.
- A nearer `disabled: true` still counts as that layer having spoken: it cancels the definition in a farther file, rather than meaning "this layer never mentioned it".
- An entry that is not an object does not even claim the name.
- A file that cannot be parsed gets one log line and is then treated as empty — the servers defined there quietly disappear from the list, and that log line is the only place the reason can be said.

## Three transports

| Transport | Fields | What it is |
|---|---|---|
| `stdio` | `command`, `args`, `env` | spawn a subprocess and talk over stdin / stdout |
| `http` | `url`, `headers` | Streamable HTTP: POST to send, an optional SSE stream back |
| `sse` | `url`, `headers` | the older HTTP + SSE: GET opens an SSE stream, POST sends |

The transport can be written as `type`, and `transport` and `transportType` are accepted as aliases; when none of the three is written it is inferred from the fields: a `command` means `stdio`, a `url` means `http`. Writes go back with only the standard key `type` — once a file carries both `type` and `transport`, whichever one a person edits may not take effect.

Two things that are easy to get wrong:

- `args` is an array of strings and every element is one argument; no shell is involved (the subprocess is spawned with `shell: false`). So `"--flag value"` inside `args` passes one argument containing a space, not two; write two elements for two arguments. To run shell syntax, spell it out as `["-c", "..."]` or similar.
- A spawned server inherits only a small set of environment variables by default (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`; a different set on Windows), and `env` from the configuration is layered on top with the same names overridden. Put a token in `env` rather than assuming it is already in the parent process environment.

## Enabling and disabling

There is one switch for disabling: `disabled: true` on that entry. Nothing else records "this server is off right now".

What happens next depends on whether the capability container receives the change. The host tells the runtime that the configuration moved, the runtime lets every already-built container read it again, and the container lets the MCP plugin discover once more and reconcile against the definitions:

| In this discovery | What happens to the connection |
|---|---|
| it disappeared (deleted, or cancelled by `disabled: true`) | disconnected, together with its cached state and manifest |
| its definition changed | disconnected; the next call connects lazily under the new definition |
| it is new | nothing connects on its own — no call, no process, no connection |
| not a byte changed | untouched; connection and manifest stay as they were |

The "definition" counts connection facts: the transport and its parameters (`command` / `args` / `env` / `url` / `headers` / `oauth`). `description` is not part of that fingerprint — it only affects the text `load_mcp` shows the model, and changing it should not break a working connection.

So "disabling disconnects" is what follows the container receiving the change, not what a click on the UI does directly; and re-enabling does not start a process right away: connections are lazy, and one is made under the new definition the next time the model asks for that server.

A few things about a connection itself: the connect timeout defaults to 60 seconds, after which it disconnects and throws, so a wrong address cannot leave a tool hanging forever; the idle timeout is 30 minutes for stdio and 5 for http and sse, renewed by every call; a transport that drops marks the server disconnected and writes one log line instead of reconnecting on its own — the reconnect happens the next time the server is needed, and a stale manifest is never shown as current. The state is one of four: `disconnected`, `connecting`, `connected`, `error`.

## The server description is for the model

`description` is not a comment. It goes into `load_mcp`'s parameter description: every allowed server takes one line, written as `id: description`, and a server without one gets "no description". That text is how the model knows what the server is for and whether it is worth connecting — without it, the model can only guess from the name.

It is also the only definition field that has nothing to do with connecting: changing the description disconnects nothing, and the new one is in place at the next assembly.

## OAuth: the fields are there, nothing is implemented

`oauth` recognises this shape: `{ authorizationUrl, tokenUrl, clientId, clientSecret?, scope? }`, and it only means anything for http. Discovery carries it into the configuration object unchanged; the connecting side never looks at it.

So: the fields are kept, configured or not it will not connect, and it should not be advertised as supported. For a server that needs authorization today, put the token in `headers` yourself.

## The five on-demand tools

MCP tools are not registered up front — how many tools a server has is only known once it is connected. What the model holds instead are five tools, loaded on demand:

| Tool | Parameters | What it does |
|---|---|---|
| `load_mcp` | `server` (the enum is the allowed servers), `include_manifest` (default `true`) | connects to that server and returns its manifest `{ tools, resources }`; with `include_manifest: false` it only connects and returns a summary `{ server, connected, tools: n, resources: n }`, for when the manifest is already in the context; an already-connected server is touched and the same manifest returned |
| `call_mcp_tool` | `server`, `tool`, `arguments`, optional `task` | calls a tool on a connected server; when it is not connected the answer is "connect it with `load_mcp` first" |
| `read_mcp_resource` | `server`, `uri` | reads one resource; text comes back as-is, images and binary are uploaded or inlined per endpoint capabilities, never dropped |
| `get_mcp_task_result` | `server`, `task_id` | fetches the result of a task by its id (see the next section) |
| `cancel_mcp_task` | `server`, `task_id` | asks the server to stop a task that was started |

`load_skill` and `call_skill_sub_agent` are not MCP tools: they come from the skills side and have nothing to do with a server, so do not mix them into that table.

Permissions have two separate halves. Those five tool names are always reported on the `tools` dimension, so "no MCP calls" is one clean cut; which servers count is the `mcps` dimension, matched by server name. `call_mcp_tool`, `read_mcp_resource` and the two task tools each check the server name against this container's allow-list as well: the connection manager is shared process-wide, and judging only by "is it connected" would open every server any agent connected to every other container.

Text is output-guarded; media is not. When all the text in one answer exceeds `maxToolOutput` (32768 characters by default), the full text is written to `result.txt` and the model gets a note plus a head and tail preview of 1000 characters each; the decision uses the total character count, not block by block — block by block would let a few 30k blocks add up and flood the request. Images and audio are outside that gate: they are uploaded as a `file_id` or inlined as base64 depending on endpoint capability, with their positions kept.

## Tasks

A task is the long-running shape of an MCP call. It is not something whose result comes back on its own; it is two things — status pushed by the server, result pulled by task id.

A tool declares how it treats tasks, in `execution.taskSupport`, one of three:

| Value | How the call goes |
|---|---|
| `forbidden` | called synchronously as before; the `task` parameter makes no difference |
| `optional` | runs as a task when the caller passes `task: true`, synchronously otherwise |
| `required` | always started with the task parameter (without it the server refuses) |

A tool that does not declare it counts as `forbidden`, which is the specification's default.

On the call that runs as a task, `call_mcp_tool` hands back a handle at once instead of waiting for the result:

```json
{ "task": true, "taskId": "...", "status": "working", "hint": "..." }
```

Status is pushed by the server (`notifications/tasks/status`). Only a terminal status is delivered — `completed` / `failed` / `cancelled`; the intermediate ones are not "something a person needs to act on", and delivering each of them would be a flood. The port is `McpTaskNoticePort`, implemented by the host: `sessionOf(agent)` says which session the agent that started the call belongs to, and `deliver(sessionId, notice)` puts the notice in that session's inbox. A delivery neither creates nor revives a session: if nobody is there any more, the notice is dropped and one log line is written.

The result itself is pulled by task id with `get_mcp_task_result`. What the server stored is the result of one tool call, so it goes through the same media mapping and output guard as `call_mcp_tool`. To give up, `cancel_mcp_task` returns the task in whatever state it is in; a cancellation is terminal too, so that notice still arrives.

A few edges:

- A task id is unique only on its own server, so the correspondence is keyed by server plus task id.
- That correspondence lives in the connection manager alone: it is gone when the process is. The task itself is on the server, so there is nothing to restore, and a status pushed after a reconnect has no session to go to and is dropped. A disconnect drops every task correspondence of that server.
- When the caller is a delegated subagent or a one-shot agent, `sessionOf` returns `undefined`: the handle and the result still work, but there is no "the task ended" notice, because there is no session to report to.
- The client declares `tasks: { cancel: {} }` in capability negotiation: only the part it actually uses, since the server decides from that whether the other side can hold a task.

## Reading on

- [SDK](sdk.md) — which container those five tools hang on, how the four permission dimensions judge, when a container is disposed
- [Core API](core.md) — how a tool is called inside the kernel and how its result gets back to the model
- [Deployment](deploy.md) — where the data root is, and where the two user-level configuration files sit inside it
