# AI-ZEN Agents

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

一个模块化的 LLM Agent 框架，提供从核心库到命令行界面再到 Web 应用的全栈解决方案。

## 项目结构

本项目采用 pnpm workspace 管理，包含以下子包：

| 包名 | 说明 | 版本 |
|------|------|------|
| [`@ai-zen/agents-core`](./packages/core) | 核心框架 | [![version](https://img.shields.io/badge/version-2.3.0-blue)] |
| [`@ai-zen/agents-cli`](./packages/cli) | 命令行界面 | [![version](https://img.shields.io/badge/version-0.5.0-blue)] |
| [`@ai-zen/agents-webui`](./packages/webui) | Web 用户界面（Vue3） | [![version](https://img.shields.io/badge/version-2.0.0-blue)] |

## 快速开始

### 前置要求

- Node.js 16.20+
- pnpm 8.0.0+（或运行 `corepack enable`）

### 安装

```bash
git clone https://github.com/ai-zen/agents.git
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

或直接使用全局安装的 CLI：

```bash
aiz
```

### 启动 Web 应用

```bash
pnpm dev
```

## 🧩 @ai-zen/agents-core

TypeScript 核心库，可在 Node.js 和浏览器环境中使用。提供构建 LLM Agent 的核心抽象：

- **Agent** — 对话管理与生命周期控制
- **Message** — 消息模型，支持文本、图片等多模态内容
- **Tool** — 工具抽象，内置 CallbackTool、CodeTool、AgentTool、IndexedSearchTool
- **Endpoint** — API 端点适配（OpenAI、Azure OpenAI、智谱AI 等）
- **Model** — 模型抽象（对话、嵌入、图片生成）
- **RAG** — 检索增强生成基类
- **VectorDatabase** — 内存向量数据库，基于余弦相似度检索
- **KnowledgeBase** — 知识库管理

[查看完整文档 →](./packages/core/README.md)

## 💻 @ai-zen/agents-cli

交互式命令行工具，提供完整的对话体验：

- 交互式主菜单与对话管理
- 多端点支持（OpenAI、智谱AI、DeepSeek）
- Agent 管理与自定义
- MCP（Model Context Protocol）服务器集成
- 图片生成支持
- 对话保存与历史管理
- 交互式配置向导

[查看完整文档 →](./packages/cli/README.md)

## 🌐 @ai-zen/agents-webui

基于 Vue 3 + Element Plus 的 Web 应用：

- 可视化 Agent 对话界面
- 会话、场景、工具、知识库管理
- 使用 IndexedDB 持久化数据
- 无需后端服务，浏览器独立运行

## 脚本命令

| 命令 | 说明 |
|------|------|
| `pnpm build-core` | 构建 core 包 |
| `pnpm dev` | 启动 Web 开发服务器 |
| `pnpm cli` | 构建并启动 CLI |

## 运行测试

```bash
# 测试 core 包
pnpm --filter @ai-zen/agents-core test

# 测试 cli 包
pnpm --filter @ai-zen/agents-cli test
```

## 许可

本项目基于 MIT 许可。详见 [LICENSE](./LICENSE) 文件。
