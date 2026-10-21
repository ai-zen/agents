---
title: MCP
description: AI-Zen Agents SDK's support for the Model Context Protocol — connection lifecycle, configuration, dynamic tool loading, and permissions.
outline: deep
---

# MCP

AI-Zen Agents provides complete support for the **Model Context Protocol (MCP)** at the **SDK layer** (`@ai-zen/agents-sdk`), based on the official `@modelcontextprotocol/sdk` `Client` + `Transport`.

## Capability overview

| Capability | Description |
|------|------|
| Server discovery | Scans `mcpServers` in the MCP configuration file |
| Connection management | `McpConnectionManager` full lifecycle (connect / reconnect / idle timeout / OAuth) |
| Lazy loading | Triggered on demand via `load_mcp` / `call_mcp_tool` / `read_mcp_resource` |
| Permissions | **server-level trust**: once connected, all of its tools / resources are available (no tool-level permissions) |
| Transports | `stdio` → `StdioClientTransport` (subprocess); `http` → `StreamableHTTPClientTransport` (Streamable HTTP: POST messages + optional SSE stream); `sse` → `SSEClientTransport` (legacy HTTP+SSE: GET opens the SSE stream, POST sends messages) |

## MCP configuration

MCP server configuration format (`mcp.json`):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." },
      "description": "GitHub repository and issue operations"
    },
    "postgres": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." },
      "description": "PostgreSQL data access"
    }
  }
}
```

Field descriptions:

| Field | Description |
|------|------|
| `command` / `args` / `env` | stdio (subprocess) configuration |
| `url` / `headers` | http / sse configuration |
| `description` | Server description, passed through by `load_mcp` for the LLM's reference |
| `disabled` | Set to `true` to skip this server |

**Transport inference**: the `type` / `transport` / `transportType` fields take precedence; otherwise `command` → `stdio`, and `url` → `http`. `disabled: true` skips; parse failures are logged and skipped.

Configuration file paths (decided by each client / `ConfigManager`):

```
~/.ai-zen/mcp.json     ← user-level MCP (factory default includes the socket-pty terminal and chrome-devtools)
<project-root>/.mcp.json ← project-shared MCP (can be committed to git)
```

## McpConnectionManager (connection lifecycle)

```ts
import { McpConnectionManager } from "@ai-zen/agents-sdk";

const mcpManager = new McpConnectionManager();
await mcpManager.connect("github", serverConfig, { idleTimeoutMs: 30 * 60 * 1000 });
```

| Method | Description |
|------|------|
| `getState(name)` | Returns `disconnected` / `connecting` / `connected` / `error` |
| `getManifest(name)` | Returns `McpServerManifest` (tools / resources / prompts) |
| `getClient(name)` | Returns the underlying `Client` |
| `connect(name, config, options?)` | Establishes a connection, returns the manifest |
| `disconnect(name)` | Disconnects the specified server |
| `disconnectAll()` | Disconnects all |
| `touch(name)` | Active heartbeat, resets the idle timer |

`McpConnectOptions`:

| Option | Description |
|------|------|
| `idleTimeoutMs` | Idle timeout (default stdio 30min, http/sse 5min) |
| `autoReconnect` | Automatically reconnect on failure |
| `maxRetries` | Max retry count (default 3) |
| `isConfigError` | Determines which errors are configuration errors (no retry) |

**Key behaviors**:

- **On-demand invocation**: after connecting, only call `listTools` / `listResources` / `listPrompts` for the capabilities declared by the Server, to avoid Method not found.
- **Reconnect**: exponential backoff `1s→2s→4s→8s→16s→30s` (capped); configuration errors are not retried.
- **Idle timeout**: each operation calls `touch()` to extend; the timer `unref()` does not keep the process alive.
- **list_changed**: server push changes → automatically refresh the local registry.
- **Test injection**: the constructor accepts custom transport / client factories.

State machine:

```
                     ┌──────────┐
          connect ──>│connecting│<────────┐
                     └────┬─────┘         │
                          │               │
              ┌─────fail──┴──success──┐  │
              ▼                       ▼  │
         ┌────────┐             ┌─────────┐
         │  error │────────────>│connected│
         └────────┘  (retry)    └────┬────┘
                                    │
                          ┌─idle timeout┼─active disconnect
                          ▼        ▼
                    disconnect & cleanup    disconnect & cleanup
```

## Dynamic tools (lazy loading)

MCP tools are **not pre-registered**; instead, "loader tools" are registered, which the LLM triggers on demand at runtime:

| Tool | Description |
|------|------|
| `load_mcp` | Parameters `server` (enum = all allowed servers, with descriptions) and optional `include_manifest` (default `true`); returns structured JSON `{ tools, resources }`; with `include_manifest=false` it only establishes the connection and returns a summary `{ server, connected, tools: n, resources: n }` without tool/resource definitions (useful when the manifest is already in the context); if already connected, `touch` extends and returns the manifest; if not connected, `mcpManager.connect()` |
| `call_mcp_tool` | Parameters `server` + `tool` + `arguments`; if not connected, prompts "use load_mcp to connect first"; `isError` → error text; **only text is output-guarded** (when the text exceeds `maxToolOutput`, default 32768 chars, the full text is dumped to `result.txt` and only head/tail previews are returned). Images / audio / binary resources become content blocks whose transport depends on the **endpoint capabilities**: endpoints declaring `capabilities.filesApi` upload first and reference the result by `file_id`, everything else inlines base64 (see "Local file → content block" in [SDK](sdk.md)); a failed conversion degrades to a text note instead of dropping the block |
| `read_mcp_resource` | Parameters `server` + `uri`; text resources are returned as-is, while binary resources (images / PDFs as `blob`) are **no longer dropped** — they go through the same unified entry and are uploaded or inlined per endpoint capabilities; shares the same output guard as `call_mcp_tool` (oversized text dumped to `result.txt` with head/tail previews, media blocks kept in place) |

Whether these tools are registered is controlled by the `tools` permission dimension (e.g. disabling `call_mcp_tool` cuts off the entire MCP invocation channel).

## Permission notes

(See the permission model in [SDK](sdk.md).) MCP uses **server-level trust**: once a server is allowed, all of its tools / resources are available to the Agent. The `mcps` dimension matches by server name (e.g. `github` / `postgres`).

## In depth

The SDK package maintains more detailed MCP documentation:

- [`packages/sdk/docs/mcp-architecture.md`](../../packages/sdk/docs/mcp-architecture.md) — MCP architecture
- [`packages/sdk/docs/mcp-basic-lifecycle.md`](../../packages/sdk/docs/mcp-basic-lifecycle.md) — connection lifecycle
- [`packages/sdk/docs/mcp-client.md`](../../packages/sdk/docs/mcp-client.md) — client
- [`packages/sdk/docs/mcp-server.md`](../../packages/sdk/docs/mcp-server.md) and `mcp-server-*.md` — server / tools / resources / prompts
- [`packages/sdk/docs/mcp-spec.md`](../../packages/sdk/docs/mcp-spec.md) — protocol specification

## Related documentation

- [SDK](sdk.md) — `Scope` and MCP manager integration
- [Core API](core.md) — low-level runtime
- [Architecture](architecture.md) — layering and dependency direction
