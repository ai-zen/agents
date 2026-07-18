# AI-ZEN Agents

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

基于 `@ai-zen/agents-core` 的模块化 LLM Agent 框架。

## 项目结构

本项目采用 pnpm workspace 管理，包含以下子包：

| 包名 | 说明 | 版本 |
|------|------|------|
| [`@ai-zen/agents-core`](./packages/core) | 核心框架 — Agent、消息、工具、模型、端点、RAG、向量数据库抽象 | [![version](https://img.shields.io/badge/version-2.4.0-blue)] |
| [`@ai-zen/agents-sdk`](./packages/sdk) | SDK — 共享业务逻辑（能力管线、权限、MCP、插件） | [![version](https://img.shields.io/badge/version-0.1.0-blue)] |

### 外部项目

以下项目原为本 monorepo 的子包，已迁移至独立仓库：

| 包名 | 仓库 | 说明 |
|------|------|------|
| [`@ai-zen/cli`](https://github.com/ai-zen/cli) | `git@github.com:ai-zen/cli.git` | 命令行界面 — 交互式对话终端，内置文件工具、MCP 支持、草稿恢复（原名 `@ai-zen/agents-cli`） |
| Web UI | — | 已停止维护 |

## 快速开始

### 前置要求

- Node.js 18+
- pnpm 8.0.0+（或运行 `corepack enable`）

### 安装

```bash
git clone <your-repo-url>
cd agents
pnpm install
```

### 构建 core 包

```bash
pnpm build-core
```

## 🧩 @ai-zen/agents-core

TypeScript 核心库，可在 Node.js 和浏览器环境中使用。提供构建 LLM Agent 的核心抽象。

**核心类**：

| 类 | 说明 |
|------|------|
| **Agent** | 对话管理与生命周期控制，支持流式解析、工具调用、多轮对话、事件系统、`onBeforeSend` 钩子 |
| **AgentContext** | Agent 上下文基类，持有 model、messages、tools、rag、`onBeforeSend` 等配置 |
| **Message** | 消息模型，支持文本/图片等多模态内容，提供静态工厂方法 |
| **Tool** | 工具抽象基类，自定义工具需实现 `exec()` 方法 |
| **CallbackTool** | 通过回调函数快速定义工具 |
| **CodeTool** | 使用字符串代码定义工具逻辑（通过 `new Function` 执行） |
| **AgentTool** | 将一个子 Agent 暴露为工具，实现 Agent 嵌套调用 |
| **IndexedSearchTool** | 基于关键词索引的本地搜索工具 |
| **Endpoint** | API 端点抽象（构建 HTTP 请求），支持 OpenAI / Azure OpenAI / 智谱AI / 通用 |
| **ChatCompletionModel** | 对话模型抽象，定义 `createStream()` 和 `createCompletion()` |
| **EmbeddingModel** | 嵌入模型抽象，定义 `createEmbedding()` |
| **ImageGenerationModel** | 图片生成模型抽象，定义 `generate()` |
| **Rag** | 检索增强生成基类，通过改写用户消息注入上下文 |
| **VectorDatabase** | 内存向量数据库，基于余弦相似度检索 |
| **KnowledgeBase** | 知识库（嵌入模型 + 向量数据库） |
| **FunctionCallContext** | 函数调用上下文，解析参数、提供 `preventDefault()` |

**内置实现**：
- **模型**: `ChatGPT`（兼容 OpenAI 接口的对话模型）、`TextEmbeddingAda002_2`（嵌入模型）、`ZhipuImage`（智谱AI 图片生成）
- **端点**: `OpenAI`、`AzureOpenAI`、`Zhipu`（已废弃）、`CommonEndpoint`（通用端点，适用于任意 OpenAI 兼容接口）
- **RAG**: `EmbeddingSearch`（基于嵌入向量检索的知识库增强）

[查看 core 完整文档 →](./packages/core/README.md)

## 📦 @ai-zen/agents-sdk

基于 `@ai-zen/agents-core` 构建的 SDK 层，为 CLI 和 Desktop 应用提供共享业务逻辑：

- **Capabilities** — 三阶段工具装配（发现、过滤、实例化）+ 权限模型
- **MCP** — 完整的连接生命周期管理（连接、重连、OAuth、空闲超时）
- **Skill** — 发现、frontmatter 解析、惰性加载
- **插件** — autoMigrate、autoDraft、autoRefreshTools
- **Provider** — 全局上下文，持有配置、路径和模型工厂

[查看 SDK 文档 →](./packages/sdk/docs/sdk-design.md)

## 脚本命令

| 命令 | 说明 |
|------|------|
| `pnpm build-core` | 构建 `@ai-zen/agents-core` |
| `pnpm build-sdk` | 构建 `@ai-zen/agents-sdk` |
| `pnpm test` | 运行全部测试（core + sdk） |
| `pnpm --filter @ai-zen/agents-core test` | 仅运行 core 测试 |
| `pnpm --filter @ai-zen/agents-sdk test` | 仅运行 SDK 测试 |

## 许可

本项目基于 MIT 许可。详见 [LICENSE](./LICENSE) 文件。
