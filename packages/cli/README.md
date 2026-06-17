# @ai-zen/agents-cli

AI Agent 命令行界面（CLI），基于 `@ai-zen/agents-core` 构建，提供交互式对话终端。

## 安装

```bash
npm install -g @ai-zen/agents-cli
```

## 快速使用

```bash
# 进入交互式主菜单
aiz

# 直接开始对话（参数作为初始提示）
aiz 你好，请介绍一下你自己。

# 查看版本
aiz --version
```

## 交互式菜单

运行 `aiz` 进入主菜单：

```
🤖 欢迎使用 AI-Zen CLI

? 请选择操作:
  💬 开始新对话
  📂 继续已保存的对话
  📋 管理已保存的对话
  🤖 管理 Agents
  ⚙️  配置管理
  ❌ 退出
```

### 💬 开始新对话

进入对话模式，输入消息与 AI 交互：

- 输入 `/help` 查看聊天命令帮助
- 输入 `/tools` 查看当前可用工具
- 输入 `/image` 生成图片
- 输入 `/save` 保存当前对话
- 输入 `/back` 返回主菜单

### 📂 继续已保存的对话

浏览和管理已保存的对话历史，选择继续之前的对话。

### ⚙️ 配置管理

通过交互式向导管理以下配置：

| 配置项 | 说明 |
|--------|------|
| **端点管理** | 配置 API 端点（OpenAI、智谱AI、DeepSeek 等） |
| **模型管理** | 配置可用模型及默认参数 |
| **Agent 管理** | 创建和管理自定义 Agent |
| **子 Agent 管理** | 配置可被主 Agent 调用的子 Agent（工具） |
| **MCP 服务器** | 配置 MCP（Model Context Protocol）服务器 |
| **图片模型** | 配置图片生成模型 |
| **切换默认模型** | 设置默认对话模型 |
| **切换默认 Agent** | 设置默认使用的 Agent |

## 配置文件

配置文件存储在 `~/.ai-zen/config.json`，对话记录存储在 `~/.ai-zen/conversations/` 目录下。

首次启动会自动生成包含默认端点（OpenAI、智谱AI、DeepSeek）和模型的配置。

## MCP 服务器支持

支持通过 MCP（Model Context Protocol）集成外部工具服务器：

```json
{
  "mcpServers": [
    {
      "id": "my-server",
      "name": "我的 MCP 服务器",
      "transport": "stdio",
      "command": "node",
      "args": ["server.js"],
      "enabled": true
    }
  ]
}
```

### 传输方式

- **stdio**: 通过标准输入/输出与子进程通信，需要提供 `command` 和可选的 `args`
- **SSE**: Server-Sent Events（开发中）

## 内置端点

| 端点 | ID | 说明 |
|------|----|------|
| OpenAI | `openai` | OpenAI API 兼容接口 |
| 智谱AI (BigModelCN) | `bigmodelcn` | 智谱AI 大模型平台 |
| DeepSeek | `deepseek` | DeepSeek API |

## 内置模型

| 模型 | 端点 | 说明 |
|------|------|------|
| GPT-5.5 | OpenAI | 最新旗舰模型 |
| GLM-5.1 | 智谱AI | 旗舰模型，支持长程任务 |
| GLM-5V-Turbo | 智谱AI | 多模态编码模型 |
| GLM-4.7-Flash | 智谱AI | 免费轻量模型 |
| DeepSeek-V4-Pro | DeepSeek | 旗舰模型（默认） |
| DeepSeek-V4-Flash | DeepSeek | 经济高效模型 |

## 图片生成

支持在对话中生成图片（需配置图片模型），内置模型：

| 模型 | 端点 | 说明 |
|------|------|------|
| CogView-4 | 智谱AI | 默认图片模型 |
| GLM-Image | 智谱AI | 高清图片生成 |
| CogView-3-Flash | 智谱AI | 快速图片生成 |

## 自定义 Agent

可以创建多个 Agent，每个 Agent 有自己的系统提示词和行为配置。Agent 也可以在对话中被其他 Agent 作为子工具调用。

## 开发

```bash
# 克隆项目后，在根目录安装依赖
pnpm install

# 先构建 core 包
pnpm build-core

# 构建 CLI
pnpm --filter @ai-zen/agents-cli build

# 运行测试
pnpm --filter @ai-zen/agents-cli test

# 启动开发模式
pnpm --filter @ai-zen/agents-cli start
```

## 测试

```bash
pnpm test
```

## 许可

ISC
