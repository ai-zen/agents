# Capabilities

What an agent can use is decided by two things: which files exist in the directories (capabilities) and what `permissions` allows (permissions). The first is data, the second is configuration. Neither requires changing code.

The four kinds, their unit and where they live:

| Capability | A unit is | File name |
|---|---|---|
| Tool | An ES module exporting a tool object | `tools/<name>.js` or `.mjs` |
| Skill | A directory with `SKILL.md` and optional attachments | `skills/<id>/SKILL.md` |
| Sub-agent | An agent definition with a `function` field | `sub-agents/<id>.json` |
| MCP | One server definition | `mcp.json` |

## Directory layers

The nearer layer wins on a name collision. The layers shared by the first three kinds, nearest first:

1. `<project>/.ai-zen/skills`
2. `<project>/.agents/{skills,tools,sub-agents}`
3. `<data root>/{skills,tools,sub-agents}`
4. `~/.agents/skills`

`.ai-zen` belongs to this runtime, so it only carries skills; the conventional directories for the other kinds live under `.agents`, shared with other tools. MCP has its own layers, see [MCP](mcp.md).

When a nearer layer disables an entry, or its file cannot be read, the outcome differs per kind: tools claim their name before loading, skills and sub-agents claim it only after a successful read. That is each discovery function's own rule and the assembly layer does not flatten it.

## Tools

A tool is one file exporting one object. The minimal form has only `function` and `exec`:

```js
// tools/echo.mjs
export default {
  function: {
    name: "echo",
    description: "Return the input unchanged",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  async exec(args, ctx) {
    return args.text;
  },
};
```

The return value is what the model sees: a string is passed through, an array of content sections (text, image, file) is returned section by section, anything else is serialised as JSON.

Three export shapes are accepted: a `Tool` instance, the object above as the default export, or a named `{ function, exec }` / `{ function, callback }`.

The file is evaluated with `import()`, which means loading it runs code. Three constraints therefore apply:

- `process.exit()` and `process.abort()` become exceptions; they cannot take the host down
- `console.log` / `info` / `debug` are redirected to stderr and do not corrupt the interface
- A file that has not finished loading within five seconds is abandoned

What cannot be stopped: a synchronous infinite loop at the top level, or a call such as `process.kill(process.pid)` that ends the process directly. For that isolation, use MCP.

## Skills

A skill is a guidance document for the model plus optional attachments:

```markdown
---
name: handoff
description: Write a task handoff document — when you stop work and leave the session…
---

# Handoff Document Writing Standard
…
```

- `name` and `description` come from the frontmatter; `id` is the directory name
- The body does not live in the context: it is expanded at `load_skill`, which also returns the skill directory's absolute path and its file list so the model can read the attachments
- A skill whose frontmatter says `subAgent: true` can run in sub-agent mode (`call_skill_sub_agent`): it executes with a context of its own and the parent receives only the result

A factory `handoff` skill is released to `<data root>/skills/handoff/`. The nine-section format and the writing rules for the handoff document live there and can be edited.

## Sub-agents

An agent definition with a `function` field becomes a tool on the parent. Fields, template injection, event forwarding and usage accounting are described in [the sub-agent section of Agent](agent.md#sub-agents).

## Permissions

`permissions` has four dimensions, each written as either `allow` or `deny`:

```json
"permissions": {
  "tools": { "deny": ["rm", "exec"] },
  "skills": { "allow": ["*"] },
  "mcps": { "allow": ["fs-server"] },
  "subagents": { "allow": [] }
}
```

- `*` is supported; setting both `allow` and `deny` on one dimension is an error
- A dimension that is absent means everything in it is denied
- Names outside the list never appear in the model's tool list. The model does not see them and therefore does not call them — this is not a rejection after the call happens
- The skill, MCP and sub-agent entry points check the list again themselves: `load_skill` on a denied skill returns "not available" rather than relying on the enum not listing it

Beyond these four dimensions there is one more layer, decided by the assembling side and not read from the definition file: a one-shot agent has no session tools such as `post_message` and neither background tool; a session opened by another session has no `create_session`.

## Progressive disclosure

Skills already work this way: the tool list carries one `load_skill` entry point, and the body is read into the context only when the model needs it. The same approach is extended to two more kinds of capabilities — MCP servers and sub-agents — each with a single entry point as well.

The tool list is sent with every request, so its length is the number of loaded capabilities. None of these three kinds put their content in the list; they contribute one entry point each:

| Entry point | When it enters the context |
|---|---|
| `load_skill` | When a procedure is needed: the skill body, its directory path and its file list |
| `call_skill_sub_agent` | When that skill should run in a context of its own |
| `load_mcp` | When a server is needed: connect and fetch its tools, resources, prompts and skills |
| `call_mcp_tool` | Calling a concrete tool on that server |
| `read_mcp_resource` · `get_mcp_task_result` | Reading a resource, fetching the result of a long task |
| Each sub-agent's own entry point | Delegating: the sub-agent runs in its own context |

However many MCP servers and skills are configured, the length of the tool list does not change. Candidate names are enums, so the model selects instead of guessing; when there are no candidates, the parameter degrades to free text and the description says so.

## When changes take effect

After editing files in the directories:

- With the SDK directly, call `scope.refresh()` to re-read the configuration and rediscover
- In a host, `autoRefreshTools` in `config.json` decides:

| Value | Timing |
|---|---|
| `inner-loop-start` (default) | Before every request. Each tool round sees newly installed capabilities |
| `outer-loop-start` | At the start of each batch. Takes effect the next time the agent is woken; cheapest |
| `off` | No automatic refresh; only `/reload` |

`refresh()` re-reads the configuration and lets each plugin rediscover. It does not rebuild the `Scope`, so a request that is in flight does not lose its capabilities.

## Built-in tools

There are 22, instantiated with the `Scope`, no configuration needed:

| Group | Tools |
|---|---|
| Directories and files | `cwd`, `ls`, `exist`, `read`, `inspect_file`, `write`, `edit`, `batch_edit`, `find_text`, `glob`, `mkdir`, `rm`, `rename`, `copy`, `download_file` |
| Commands | `exec`, `spawn`, `sleep`, `async_exec`, `async_timeout` |
| Images | `generate_image`, `view_image` |

When a single tool output exceeds `maxToolOutput` (default 32768 characters), the excess does not enter the context whole: tools such as `exec` write the full text to a file and return a head/tail preview with its path.

To replace a built-in tool, register your own tool plugin and use the same name in its candidate set: on a name collision the later-registered plugin wins, and inside `allInOne` user tools are registered after `builtin`, so a user tool can override a built-in one.
