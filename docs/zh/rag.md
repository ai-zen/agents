---
title: 检索与 RAG
description: AI-Zen Agents 的检索能力现状 —— RAG 与检索基础设施已从 core 移除，检索改由搜索工具承担。
outline: deep
---

# 检索与 RAG

> 本文记录框架在**传统 RAG（检索增强生成）**这一问题上的真实现状与设计取舍，避免使用者依据过时描述误以为存在隐式 RAG 管线。

## 当前状态：RAG 已移除

自 `@ai-zen/agents-core` **4.0.0**（2026-08-14）起，框架**移除了完整的 RAG 与检索基础设施**。被删除的模块包括：

- `Rag` / `Rags/EmbeddingSearch`（检索增强生成基类）
- `KnowledgeBase`（知识库）
- `VectorDatabase`（内存向量数据库）
- `EmbeddingModel` / `TextEmbeddingAda002_2`（嵌入模型相关）
- `AgentContext.rag` 字段与 `Message.rewrite()` / `Message.raw_content`（仅服务于被删除的 RAG 重写流程）

**设计决策**（依据仓库根 `TODO.md` 的整理）：

> 传统 RAG 的「隐式检索注入」被认定为低价值设计。检索能力应由**搜索工具**承担，而不是对每次请求做隐式的 prompt 重写。

因此当前框架**没有**内置向量检索 / embedding / 知识库管线。若未来需要知识检索，应作为**工具**提供（如 `search` 工具），而非隐式 RAG。

## 现状：检索由搜索工具承担

当前可用的检索相关能力是 core 的 **`IndexedSearchTool`** —— 一种**基于关键词**的本地搜索工具：

```ts
import { IndexedSearchTool } from "@ai-zen/agents-core";

const tool = new IndexedSearchTool({
  entries: [
    { keywords: ["price", "fee"], text: "This product costs $99/month" },
    { keywords: ["support", "warranty"], text: "One-year free warranty is provided" },
  ],
});
```

- 工具名：`indexedSearch`
- 输入：以条目关键词为 `enum` 的参数（当只有一个关键词时，允许模型误传字符串而非数组，`exec` 内会归一化）。
- 输出：匹配到条目的 `JSON.stringify` 结果。

它并不做向量相似度或语义检索，仅做**关键词命中匹配**。对于需要文件系统搜索的场景，SDK 另有 `findText` / `glob` 等搜索类内置工具。

## 全局检索能力（SDK）

在 SDK 层，`Provider` 的**能力发现**会在 `refresh()` 时扫描文件系统，将可用的知识源（用户工具、Skill、MCP、SubAgent）纳入候选集，再由权限过滤与实例化装配。这同样属于「以工具/能力的粒度提供检索」，而非隐式 RAG。

具体可用的检索相关工具（取决于权限与配置）：

| 工具 | 来源 | 说明 |
|------|------|------|
| `indexedSearch` | core | 关键词本地搜索（`IndexedSearchTool`） |
| `glob` / `findText` | SDK 内置 | 文件系统通配扫描 / 文本与正则搜索 |
| `load_skill` / `call_skill_sub_agent` | SDK 动态 | 按需加载 Skill / 以 Skill 启动子 Agent |
| `load_mcp` / `call_mcp_tool` / `read_mcp_resource` | SDK 动态 | 按需连接 MCP 服务器并调用其工具 / 资源 |

## 需要人工复核的不确定点

以下描述基于源码与 `TODO.md` / `CHANGELOG` 的取证，但仍建议人工复核：

1. `README.md`（仓库根）的 core 包描述仍写作「Agent, Messages, Tools, Models, Endpoints, **RAG, Vector Database**」，与该版本真实实现不一致（RAG/向量库已在 core 4.0.0 删除）。`README.zh.md`（仓库根）仍描述旧的 RAG 版本。这两处 README 已**过时**，文档编写时未采纳其 RAG 描述。
2. `TODO.md` 中「知识库检索如未来需要，应作为工具而非隐式 RAG」是**规划**而非已实现功能。当前没有知识库检索工具。

## 相关文档

- [Core API](core.md) —— `IndexedSearchTool` 与搜索类工具
- [SDK](sdk.md) —— 能力发现与过滤、内置搜索工具
- [`packages/core/CHANGELOG.md`](../../packages/core/CHANGELOG.md) —— 4.0.0 移除 RAG 的变更记录
