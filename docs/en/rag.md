---
title: Retrieval & RAG
description: The current state of retrieval in AI-Zen Agents — RAG and the retrieval infrastructure have been removed from core; retrieval is now handled by search tools.
outline: deep
---

# Retrieval & RAG

> This document records the actual state and design trade-offs of the framework's stance on **traditional RAG (retrieval-augmented generation)**, to prevent users from mistakenly assuming an implicit RAG pipeline based on outdated descriptions.

## Current status: RAG has been removed

Since `@ai-zen/agents-core` **4.0.0** (2026-08-14), the framework **removed the complete RAG and retrieval infrastructure**. The removed modules include:

- `Rag` / `Rags/EmbeddingSearch` (retrieval-augmented generation base classes)
- `KnowledgeBase` (knowledge base)
- `VectorDatabase` (in-memory vector database)
- `EmbeddingModel` / `TextEmbeddingAda002_2` (embedding model related)
- The `AgentContext.rag` field and `Message.rewrite()` / `Message.raw_content` (which existed only to serve the removed RAG rewrite flow)

**Design decision** (based on the repository root `TODO.md`):

> The "implicit retrieval injection" of traditional RAG was judged to be a low-value design. Retrieval capability should be provided by **search tools**, rather than performing implicit prompt rewriting on every request.

Therefore, the current framework has **no** built-in vector retrieval / embedding / knowledge-base pipeline. If knowledge retrieval is needed in the future, it should be provided as a **tool** (such as a `search` tool), not as implicit RAG.

## Current state: retrieval is handled by search tools

The currently available retrieval-related capability is core's **`IndexedSearchTool`** — a **keyword-based** local search tool:

```ts
import { IndexedSearchTool } from "@ai-zen/agents-core";

const tool = new IndexedSearchTool({
  entries: [
    { keywords: ["price", "fee"], text: "This product costs $99/month" },
    { keywords: ["support", "warranty"], text: "One-year free warranty is provided" },
  ],
});
```

- Tool name: `indexedSearch`
- Input: a parameter whose `enum` is the entry keywords (when there is only one keyword, the model is allowed to pass a string instead of an array; `exec` normalizes it).
- Output: the `JSON.stringify` result of the matched entries.

It does not perform vector similarity or semantic retrieval; it only does **keyword hit matching**. For filesystem-search scenarios, the SDK additionally provides search-oriented built-in tools such as `findText` / `glob`.

## Global retrieval capability (SDK)

At the SDK layer, `Provider`'s **capability discovery** scans the filesystem during `refresh()` and brings available knowledge sources (user tools, Skills, MCP, SubAgents) into the candidate set, then assembles them via permission filtering and instantiation. This likewise provides retrieval at the granularity of tools/capabilities, rather than implicit RAG.

The specific retrieval-related tools that may be available (depending on permissions and configuration):

| Tool | Source | Description |
|------|------|------|
| `indexedSearch` | core | keyword local search (`IndexedSearchTool`) |
| `glob` / `findText` | SDK built-in | filesystem wildcard scan / text & regex search |
| `load_skill` / `call_skill_sub_agent` | SDK dynamic | load a Skill on demand / start a sub-Agent with a Skill |
| `load_mcp` / `call_mcp_tool` / `read_mcp_resource` | SDK dynamic | connect to an MCP server on demand and call its tools / resources |

## Points that need human review

The following descriptions are based on forensics from the source code and `TODO.md` / `CHANGELOG`, but a human review is still recommended:

1. The core package description in `README.md` (repository root) still reads "Agent, Messages, Tools, Models, Endpoints, **RAG, Vector Database**", which is inconsistent with the actual implementation of this version (RAG/vector database were removed in core 4.0.0). `README.zh.md` (repository root) still describes the old RAG version. Both READMEs are **outdated**; the RAG descriptions were not adopted when writing the documentation.
2. The statement in `TODO.md` that "if knowledge-base retrieval is needed in the future, it should be a tool rather than implicit RAG" is a **plan**, not an implemented feature. There is currently no knowledge-base retrieval tool.

## Related documentation

- [Core API](core.md) — `IndexedSearchTool` and search-oriented tools
- [SDK](sdk.md) — capability discovery and filtering, built-in search tools
- [`packages/core/CHANGELOG.md`](../../packages/core/CHANGELOG.md) — the change record that removed RAG in 4.0.0
