# AI-ZEN Agents

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

一个模块化的 LLM Agent 框架，提供从核心库到命令行界面再到 Web 应用的全栈解决方案。

## 项目结构

本项目采用 pnpm workspace 管理，包含以下子包：

| 包名 | 说明 | 版本 |
|------|------|------|
| [`@ai-zen/agents-core`](./packages/core) | 核心框架 — Agent、消息、工具、模型、端点、RAG、向量数据库抽象 | [![version](https://img.shields.io/badge/version-2.3.0-blue)] |
| [`@ai-zen/agents-cli`](./packages/cli) | 命令行界面 — 交互式对话终端，内置文件/代码执行等工具 | [![version](https://img.shields.io/badge/version-0.5.0-blue)] |
| [`@ai-zen/agents-webui`](./packages/webui) | Web 用户界面（Vue 3 + Element Plus） | [![version](https://img.shields.io/badge/version-2.0.0-blue)] |

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

### 启动 CLI

```bash
pnpm cli
```

或直接使用全局安装的 CLI（需先构建）：

```bash
cd packages/cli
pnpm build
npm install -g .
aiz
```

### 启动 Web 应用

```bash
pnpm dev
```

## 🧩 @ai-zen/agents-core

TypeScript 核心库，可在 Node.js 和浏览器环境中使用。提供构建 LLM Agent 的核心抽象。

**核心类**：

| 类 | 说明 |
|------|------|
| **Agent** | 对话管理与生命周期控制，继承 AgentContext，支持流式解析、工具调用、多轮对话、事件系统 |
| **AgentContext** | Agent 上下文基类，持有 model、messages、tools、rag 等配置 |
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

## 💻 @ai-zen/agents-cli

交互式命令行工具，提供完整的 AI 对话体验：

- 交互式主菜单与对话管理
- 多端点支持（OpenAI、智谱AI、DeepSeek 等任意 OpenAI 兼容接口）
- Agent 管理与自定义（系统提示词预设）
- 子 Agent 工具注册（可被主 Agent 按需调用的子任务）
- MCP（Model Context Protocol）服务器集成
- 图片生成（通过智谱AI CogView / GLM-Image）
- 内置文件系统工具（读/写/搜索/执行命令等）
- 对话保存与历史管理
- 交互式配置向导

**内置工具**：`cwd`、`readFile`、`writeFile`、`batchReplace`、`mkdir`、`rm`、`glob`、`ls`、`exist`、`exec`、`findText`、`downloadFile`、`generateImage`、`rename`、`copy`（共 15 个工具）

[查看 CLI 完整文档 →](./packages/cli/README.md)

## 🌐 @ai-zen/agents-webui

基于 Vue 3 + Element Plus + Vite 的 Web 应用：

- 可视化 Agent 对话界面
- 智能体（Agent）、子智能体（AgentTool）、工具、知识库、端点、模型管理
- 使用 IndexedDB 持久化数据
- 无需后端服务，浏览器独立运行

**路由**：`/chat`（聊天）、`/agent/*`（Agent 管理）、`/agent-tool/*`（子 Agent 管理）、`/tool/*`（工具管理）、`/knowledge-base/*`（知识库管理）、`/endpoint/*`（端点管理）、`/model/*`（模型管理）

## 脚本命令

| 命令 | 说明 |
|------|------|
| `pnpm build-core` | 构建 core 包 |
| `pnpm dev` | 构建 core 后启动 Web 开发服务器 |
| `pnpm cli` | 构建 core 后启动 CLI |
| `pnpm --filter @ai-zen/agents-core test` | 运行 core 包测试 |
| `pnpm --filter @ai-zen/agents-cli test` | 运行 cli 包测试 |

## 许可

本项目基于 MIT 许可。详见 [LICENSE](./LICENSE) 文件。
