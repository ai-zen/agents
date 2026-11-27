# Skills

A skill is a guidance document for the model. Unlike a tool it is not a callable function; it is a procedure that is read into the context only when it is needed.

## What a skill is

```
skills/
└── handoff/
    ├── SKILL.md
    └── references/
        └── template.md
```

A skill is a directory whose name is its id. It must contain `SKILL.md` and may contain any attachments. The model receives two things: the body of `SKILL.md`, and the list of files in that directory.

## Frontmatter

`SKILL.md` starts with a YAML block:

```markdown
---
name: handoff
description: Write a task handoff document — when you stop work and leave the session…
license: MIT
compatibility: needs the read and write tools
sub-agent: true
metadata:
  custom: "false"
---

# Handoff Document Writing Standard
…
```

| Field | Rule |
|---|---|
| `name` | Required. Lowercase letters, digits and hyphens; no leading, trailing or doubled hyphens; at most 64 characters; must equal the directory name |
| `description` | Required, at most 1024 characters. It appears in the `load_skill` parameter description, and the model uses it to decide which skill to read |
| `license` | Optional |
| `compatibility` | Optional, at most 500 characters |
| `sub-agent` | When `true`, the skill can run in sub-agent mode; see below |
| `metadata` | Optional key-value pairs. A factory skill uses `custom: "true"` to mean "user-owned, do not overwrite me" |

A file without `name` is not treated as a skill and is skipped during discovery. Validation failures (name too long, name not matching the directory, empty `description`, and so on) write one line to the log sink, and the skill is still collected — validation tells a human what is wrong, it is not an admission gate.

## Where they live

Skills share the same four directory layers as tools and sub-agents; the nearest one wins on a name collision:

1. `<project>/.ai-zen/skills`
2. `<project>/.agents/skills`
3. `<data root>/skills`
4. `~/.agents/skills`

`.ai-zen/skills` comes first: that directory belongs to this runtime, so it wins when both define the same name.

## How the model uses them

Skills take no space in the tool list. The list carries two entry points:

| Tool | When it is used |
|---|---|
| `load_skill` | When a procedure is needed: reads that skill's body, the directory's absolute path and its file list |
| `call_skill_sub_agent` | When the skill should carry out the whole task in a context of its own (only offered for `sub-agent: true` skills) |

The `load_skill` parameter is an enum of skill ids; skills filtered out by permissions never appear in it, and naming one anyway returns "not available" rather than loading it. The result includes the directory path and the file list, so when the body says "read references/template.md" the model knows which directory that means.

## Sub-agent mode

A skill marked `sub-agent: true` can take on a whole task:

1. It builds a one-shot agent whose system message is the skill body and whose user message is the delegated task
2. Tools are inherited from the parent, minus three things: `call_skill_sub_agent` itself (against recursion), the three PeerSession tools, and `async_exec` / `async_timeout` — the results of the last two arrive at some later moment, by which time that one-shot agent has already finished and nobody is there to receive them
3. The parent's abort signal is passed straight into its `runOnce`; event forwarding and usage accounting work as for any delegation

The parent model receives only the content of the last message.

## Factory skills

`bootstrap()` releases the `handoff` skill to `<data root>/skills/handoff/SKILL.md`. The nine-section format and the writing rules for handoff documents live there.

It is managed by the factory sync: unless `metadata.custom` is `"true"`, every `bootstrap()` overwrites it with the current version. To keep your own edits, set that field to `"true"`.

If the skill cannot be read from disk, writing a handoff falls back to a built-in template — a fuse, not a second source of truth.

## Permissions

Which skills an agent may use is decided by `permissions.skills` in the agent definition:

```json
"permissions": { "skills": { "deny": ["handoff"] } }
```

Both entry points check the list again: `load_skill` and `call_skill_sub_agent` operate on the filtered set, and naming a denied skill fails.

## When changes take effect

A newly added directory becomes visible after discovery:

- With the SDK directly, call `scope.refresh()`
- In a host, `autoRefreshTools` in `config.json` decides (before every request / at the start of each batch / only on `/reload`)

## Writing your own

```
<project>/.agents/skills/release-notes/SKILL.md
```

```markdown
---
name: release-notes
description: Turn a batch of commits into user-facing release notes. Use when asked to "write the changelog".
---

# How to write release notes

1. Run `git log --oneline <previous tag>..HEAD` with `exec` to get the batch of commits.
2. Group them into "Added / Fixed / Internal"; merge several commits about one thing into one line.
3. Only describe changes a user can notice; refactors, tests and dependency bumps go under "Internal" as one line.
4. Write in English, one sentence per line, no nesting beyond the group headings.
```

After a refresh, the model reads it on its own when a request like "write the changelog" comes in.
