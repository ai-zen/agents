---
title: MCP
description: What someone configuring an MCP server needs to know — how to get one server connected, the five configuration files and the merge order, the three transports and their fields, what happens on enable and disable, how a description reaches the model, the OAuth fields that exist without an implementation, the five on-demand tools, and tasks (status pushed, result pulled by task id).
outline: deep
---

# MCP

Everything on the MCP (Model Context Protocol) side lives in `@ai-zen/agents-sdk`, under `scope/plugins/mcp/`: discovery that merges five configuration files into one list, `McpConnectionManager` for connecting and disconnecting, the layer that turns servers into five tools, and where a task status gets delivered.

This page is for someone configuring MCP servers: where the configuration lives, how to write it, when a change takes effect, what parameters the five tools take, and what shape a task has.

## How to use

Connecting one server is three things: write an entry, let it be discovered, let the model use it.

Only two files can be written by an interface: `<data root>/mcp.json` (default `~/.ai-zen/mcp.json`) for the user layer, `<project>/.ai-zen/mcp.json` for the project layer. The other three belong to someone else's repository or another tool's directory and are taken as they are (see the next section). One entry looks like this:

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

To let it be discovered: when a `Scope` starts, and whenever `scope.reload` is called, every container already built re-reads the configuration (on the host side the entry points are `/reload` and the runtime's `refreshAll()`). A server that is new is not connected on its own — no call, no process, no link.

To let the model use it: it holds `load_mcp` (connect, hand back the manifest) and `call_mcp_tool` (call one tool), plus three more for resources and tasks (see [The five on-demand tools](#the-five-on-demand-tools)). `description` does its work here too: it goes into the parameter description of `load_mcp`, which is how the model decides whether the server is worth connecting.

When a change takes effect, what disabling disconnects, and what the timeouts are: see [Enabling and disabling](#enabling-and-disabling).

## Five configuration files

One list comes from five files, nearest first, and a nearer file wins for the same name.

| Layer | File | Who may write |
|---|---|---|
| project root | `<project>/.mcp.json` | taken as it is — shared with other tools |
| project | `<project>/.ai-zen/mcp.json` | an interface may write it |
| project | `<project>/.agents/mcp.json` | taken as it is |
| user | `<data root>/mcp.json` (default `~/.ai-zen/mcp.json`) | an interface may write it |
| user | `~/.agents/mcp.json` | taken as it is |

Those five layers appear in the code under exactly these five names: `workspace`, `workspaceAiZen`, `workspaceAgents`, `user`, `userAgents`.

Only the project's `.ai-zen` file and the one in the data root are written by the host; the other three live in someone else's repository or another tool's directory, and writing those would be editing someone else's files. A write keeps the file as it was apart from the named entry — keys this version does not know, keys another tool put there, all stay; deleting an entry that is not in this layer reports `not_found`, because it came from a farther layer and deleting here deletes nothing.

The merge rules are four:

- For the same name the nearer layer wins, and the farther entry is not even read.
- A `disabled: true` in a near layer still counts as that layer speaking: it cancels the same name further away rather than counting as "this layer never mentioned it".
- An entry that is not an object does not even occupy the name.
- A file that cannot be parsed as JSON gets one log line and then counts as empty — those servers quietly disappear from the list, and that one line is the only place the reason can come from.

## Three transports

| Transport | Fields | What it is |
|---|---|---|
| `stdio` | `command`, `args`, `env` | spawn a child process, talk over stdin / stdout |
| `http` | `url`, `headers` | Streamable HTTP: POST to send, optionally an SSE stream back |
| `sse` | `url`, `headers` | the older HTTP + SSE: GET opens an SSE stream, POST sends |

The transport can be written explicitly as `type`; `transport` and `transportType` are accepted as aliases. With none of the three, it is inferred from the fields: a `command` means `stdio`, a `url` means `http`. Writing back always writes only the standard key, `type` — once a file carries both `type` and `transport`, whichever a person edits may be the one that does not take effect.

Two things that are easy to get wrong:

- `args` is an array of strings, and each element is one argument, passed without a shell (the child is spawned with `shell: false`). So `"--flag value"` inside `args` passes one argument that contains a space, not two; two arguments means two elements. To run shell syntax, write it as `["-c", "..."]` or similar.
- The child's environment starts with a small set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`, a different set on Windows), and `env` from the configuration is layered on top, overriding by name. Put tokens in `env` rather than expecting them to already be in the parent's environment.

## Enabling and disabling

There is one switch for disabling: `disabled: true` on that entry. Nowhere else records "this server is off right now".

What happens after disabling depends on whether the `Scope` received that change. The host tells the runtime about the change, the runtime makes every container already built re-read the configuration, and each container makes the MCP plugin discover again and reconcile by definition:

| In this discovery | What happens to the connection |
|---|---|
| it disappeared (deleted, or cancelled by `disabled: true`) | disconnect; the cached status and manifest go with it |
| its definition changed | disconnect; the next call connects lazily under the new definition |
| it is new | not connected on its own — no call, no process, no link |
| not one byte changed | untouched; the connection and the manifest stay |

"Definition" means the connection facts: the transport and its parameters (`command` / `args` / `env` / `url` / `headers` / `oauth`). `description` is not part of that fingerprint — it only affects the text `load_mcp` shows the model, and changing it should not drop a healthy connection.

So "disabling disconnects" is a consequence of the container receiving the change, not something an interface does by pressing a button; and "enabling again" does not mean a process starts right away: connections are lazy, and the next time the model picks that server it connects under the new definition.

A few things about connections themselves: the connect timeout defaults to 60 seconds, and on timeout the connection is dropped with an error, so a mistyped address cannot hang a tool forever; the idle timeout is 30 minutes for stdio and 5 minutes for http and sse, renewed on every call; when the transport drops, that server is marked disconnected and one log line is written — it does not reconnect on its own, since reconnecting happens the next time somebody needs it, and a stale manifest is never presented as the current one. The status has four values: `disconnected`, `connecting`, `connected`, `error`.

## `description` is for the model

`description` is not a comment. It goes into the parameter description of `load_mcp`: each allowed server takes one line, written `id: description`, and a server without one gets a single "no description" line. That is how the model knows what the server is for and whether it is worth connecting — without that text it can only guess from the name.

It is also the only definition field that does not affect the connection: changing it disconnects nothing, and the new text is there at the next assembly.

## OAuth: the fields are there, nothing is implemented

`oauth` recognises this shape: `{ authorizationUrl, tokenUrl, clientId, clientSecret?, scope? }`, meaningful for http only. The discovery layer carries it into `McpServerDefinition` as it stands, and the connection layer never looks at it.

So the fields exist, and configuring them connects nothing; do not pretend otherwise. For a server that needs authorisation today, the only way is to put the token in `headers` yourself.

## The five on-demand tools

MCP tools are not registered up front — how many tools a server has is only known once it is connected. The model therefore holds five tools, loaded on demand:

| Tool | Parameters | What it does |
|---|---|---|
| `load_mcp` | `server` (the enum is exactly the allowed servers), `include_manifest` (default `true`) | connect to that server and hand back its manifest `{ tools, resources }`; with `include_manifest: false` it only connects and returns a summary `{ server, connected, tools: count, resources: count }`, for when the manifest is already in context; an already-connected server is renewed once and the same manifest is handed back |
| `call_mcp_tool` | `server`, `tool`, `arguments`, optional `task` | call a tool on a connected server; if it is not connected, reply "connect with `load_mcp` first" |
| `read_mcp_resource` | `server`, `uri` | read one resource; text comes back as it is, images and binaries are uploaded or inlined according to what the endpoint can do, and no section is dropped |
| `get_mcp_task_result` | `server`, `task_id` | fetch the result of one task by its id (see the next section) |
| `cancel_mcp_task` | `server`, `task_id` | ask the server to stop a task already started |

`load_skill` and `call_skill_sub_agent` are not MCP tools: they come from the skills side and have nothing to do with servers; do not fold them into this table.

Permissions have two places to look at. These five tool names always register under the `tools` dimension, so "no MCP at all" can be a clean cut; which servers count is the `mcps` dimension, matched by server name. `call_mcp_tool`, `read_mcp_resource` and the two task tools also check the server name against this container's own allow-list: the connection manager is shared globally, and judging only by "is it connected" would open a server any `Agent` connected to every container.

Text is protected, media is not. When the text of one whole answer adds up to more than `maxToolOutput` (32768 characters by default), all of it is written to `result.txt` and the model gets an explanation plus the first and last 1000 characters; the judgement uses the total character count, not a per-section one — per-section, several 30k sections together would flood the request. Images and audio are not subject to this rule: they are uploaded as `file_id` or inlined as base64 according to what the endpoint can do, in their original positions.

## Tasks

A task is the long-running shape of an MCP call. It is not a thing whose result comes back on its own; it is two things: the status is pushed by the server, and the result is pulled by task id.

A tool declares in its manifest how it treats tasks, `execution.taskSupport`, in three notches:

| Notch | How it goes |
|---|---|
| `forbidden` | called synchronously as usual; the `task` parameter does nothing |
| `optional` | the caller passing `task: true` makes it a task, otherwise it is synchronous |
| `required` | always started with the task parameter (without it the server refuses) |

A tool that does not declare this counts as `forbidden` — the default in the specification.

On a task call, `call_mcp_tool` hands back a handle at once instead of waiting for the result:

```json
{ "task": true, "taskId": "...", "status": "working", "hint": "..." }
```

The status is pushed by the server (`notifications/tasks/status`). Only terminal states are delivered — `completed` / `failed` / `cancelled`, the three cells that matter; an intermediate state is not "something needs a person", and delivering each one is a flood. The delivery port is `McpTaskNoticePort`, implemented by the host: `sessionOf(agent)` says which session the `Agent` that made the call belongs to, and `deliver(sessionId, notice)` puts the notice into that session's inbox. Delivery neither creates nor revives a session: if nobody is there any more, the notice is dropped with one log line.

The result itself is pulled by task id: `get_mcp_task_result`. What the server stores is the result of one tool call, so it goes through the same media mapping and the same text protection as `call_mcp_tool`. To give up, `cancel_mcp_task`, which returns the cell the task is in at that moment; a cancellation is also terminal, and its notice arrives as usual.

A few boundaries:

- A task id is unique only on its own server, so the correspondence is kept by "server + task id".
- That correspondence lives only in the connection manager: when the process goes, it goes — the task itself lives on the server, so there is nothing to restore; and statuses the server pushes after a reconnect have no session to go to and are simply dropped. When a connection drops, every task correspondence on that server goes with it.
- If the call was made by a delegated `SubAgent` or by a one-shot `Agent`, `sessionOf` returns `undefined`: the handle is still available and the result can still be pulled, there is just no "your task finished" notice — there is no session to report it to.
- The client declares `tasks: { cancel: {} }` in capability negotiation: only what is actually used is declared, and the server judges from that whether the other side can hold a task.

## Reading on

- [SDK](sdk.md) — which `Scope` these five tools hang on, how the four permission dimensions are judged, when a container is disposed
- [Core API](core.md) — how tools are called inside the kernel, how the result gets back to the model
- [Deployment](deploy.md) — where the data root is, and where the two user-level configuration files sit inside it
