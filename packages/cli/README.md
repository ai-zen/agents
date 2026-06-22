# @ai-zen/agents-cli

AI Agent 命令行界面（CLI），基于 `@ai-zen/agents-core` 构建，提供交互式对话终端。内置文件系统操作、命令执行、图片生成等 15 个工具，支持 MCP 协议集成外部工具。

## 安装

### 全局安装

```bash
npm install -g @ai-zen/agents-cli
```

### 从源码构建

```bash
git clone <your-repo-url>
cd agents
pnpm install
pnpm build-core
cd packages/cli
pnpm build
npm install -g .
```

## 快速使用

```bash
# 进入交互式主菜单
aiz

# 直接开始对话（将参数作为初始消息）
aiz 你好，请介绍一下你自己。
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

进入对话模式，输入消息与 AI 交互。对话过程中支持以下命令：

| 命令 | 说明 |
|------|------|
| `exit` / `quit` | 退出对话（会提示是否保存） |
| `save` | 保存当前对话 |
| `clear` | 清屏 |
| `back` | 撤回/修改消息（可回退到指定位置并编辑后重发） |

### 📂 继续已保存的对话

浏览和管理已保存的对话历史，选择继续之前的对话。

### 📋 管理已保存的对话

查看和删除已保存的对话记录。

### 🤖 管理 Agents

创建和管理自定义 Agent。每个 Agent 包含系统提示词预设，可快速切换不同角色和风格。

Agent 以独立 JSON 文件存储在 `~/.ai-zen/agents/` 目录下，每个文件一个 Agent。

### ⚙️ 配置管理

通过交互式向导管理以下配置：

| 配置项 | 说明 |
|--------|------|
| **查看当前配置** | 显示完整配置总览 |
| **设置默认对话模型** | 从已配置的模型中选择默认模型 |
| **设置默认图片生成模型** | 从已配置的图片模型中选择默认模型 |
| **设置 API Key** | 为各端点设置 API Key |
| **编辑 API** | 修改端点的名称、Base URL、API Key、描述 |
| **查看所有 API** | 列出所有已配置的端点 |
| **查看对话模型** | 列出所有对话模型 |
| **查看图片生成模型** | 列出所有图片生成模型 |
| **管理 MCP 服务器** | 添加、编辑、删除 MCP 服务器 |

## 文件系统发现机制

CLI 中的所有用户资源均通过文件系统自动发现，无需手动注册。

### 目录结构

```
~/.ai-zen/                    ← 全局（所有项目共享）
├── config.json               ← 端点、模型、MCP 等配置
├── agents/                   ← 普通 Agent
│   └── default.json          ← 首次运行自动创建
├── sub-agents/               ← 子 Agent
│   └── general-assistant.json
├── skills/                   ← Skill 提示词
│   └── git-operations.md
├── tools/                    ← 用户自定义工具
│   └── my-tool.js
└── conversations/            ← 对话记录

/path/to/project/
└── .ai-zen/                  ← 项目级（覆盖全局同名）
    ├── agents/
    ├── sub-agents/
    ├── skills/
    └── tools/
```

### 资源说明

| 资源 | 目录 | 格式 | 说明 |
|------|------|------|------|
| **普通 Agent** | `agents/` | `.json` | 对话时可选的预设角色，包含 system prompt |
| **子 Agent** | `sub-agents/` | `.json` / `.js` | 注册为主 Agent 的工具，由 LLM 按需调用 |
| **Skill** | `skills/` | `.md` | 任务指导文档，通过 `load_skill` 工具按需加载 |
| **用户自定义工具** | `tools/` | `.js` | 扩展 Agent 能力，和内置工具一样被 LLM 调用 |

### 用户自定义工具示例

```javascript
// ~/.ai-zen/tools/weather.js
export default {
  name: "get_weather",
  description: "获取指定城市的天气信息",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称" }
    },
    required: ["city"]
  },
  callback: async (args) => {
    // 调用天气 API...
    return `${args.city} 的天气是晴天，25°C`;
  }
};
```

### 子 Agent 示例（JSON）

```json
{
  "id": "code-reviewer",
  "name": "代码审查员",
  "description": "审查代码变更",
  "system": "你是资深代码审查者，擅长发现潜在 bug、性能问题和安全漏洞。",
  "tools": ["readFile", "findText", "glob", "exec"]
}
```

### Skill 示例

```markdown
# Git 操作

## 查看状态
使用 `exec` 工具执行 `git status`

## 提交代码
1. 使用 `exec` 执行 `git add -A`
2. 使用 `exec` 执行 `git commit -m "<message>"`
```

在对话中，AI 可以通过 `load_skill` 工具按需加载 Skill 内容。

## onBeforeSend 钩子

每次 LLM 请求前，CLI 会自动扫描文件系统，刷新以下资源：

1. **用户自定义工具** — `~/.ai-zen/tools/` 和项目 `.ai-zen/tools/`
2. **子 Agent** — `~/.ai-zen/sub-agents/` 和项目 `.ai-zen/sub-agents/`
3. **Skill 列表** — `load_skill` 工具的可用枚举

这意味着你在对话过程中新增或修改了文件，下一次 AI 回复时就能感知到。MCP 工具是长连接，只在启动时连接一次，不在此刷新。

## 配置文件

配置文件存储在 `~/.ai-zen/config.json`，主要包含端点、模型、MCP 等基础设施配置。

### 配置结构

```jsonc
{
  "endpoints": [
    {
      "id": "openai",
      "name": "OpenAI",
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.openai.com/v1"
    }
  ],
  "models": [
    {
      "id": "gpt-5.5",
      "name": "GPT-5.5",
      "endpointId": "openai",
      "modelName": "gpt-5.5"
    }
  ],
  "agents": [],       // ← 已迁移到 ~/.ai-zen/agents/ 目录
  "subAgents": [],    // ← 已迁移到 ~/.ai-zen/sub-agents/ 目录
  "defaultModel": "deepseek-v4-flash",
  "defaultAgent": "default",
  "imageModels": [ ... ],
  "defaultImageModel": "cogview-4",
  "mcpServers": []
}
```

### 配置迁移

从旧版本升级时，`config.json` 中的 `agents` 和 `subAgents` 数据会自动迁移到文件系统目录中。已存在的文件不会被覆盖。

## 内置工具

CLI 启动时会自动注册以下 15 个内置工具到 Agent：

| 工具名称 | 说明 |
|----------|------|
| `cwd` | 获取当前工作目录 |
| `readFile` | 读取文件内容 |
| `writeFile` | 写入文件内容 |
| `batchReplace` | 批量替换文件中的文本 |
| `mkdir` | 创建目录 |
| `rm` | 删除文件或目录 |
| `glob` | 使用 glob 模式扫描文件 |
| `ls` | 列出目录内容 |
| `exist` | 检查文件或目录是否存在 |
| `exec` | 执行 shell 命令 |
| `findText` | 在文件中查找文本 |
| `downloadFile` | 从 URL 下载文件到本地 |
| `generateImage` | 根据文字描述生成图片 |
| `rename` | 重命名或移动文件/目录 |
| `copy` | 复制文件或目录 |

### 图片生成

`generateImage` 工具会根据配置中的图片模型自动选择服务，支持以下图片模型：

| 模型 ID | 说明 | 默认尺寸 |
|---------|------|---------|
| `cogview-4` | 智谱AI CogView-4 图片生成 | 1024x1024 |
| `glm-image` | 智谱AI GLM-Image 高清图片生成 | 1280x1280（仅 hd 质量） |
| `cogview-3-flash` | 智谱AI CogView-3-Flash 快速生成 | 1024x1024 |

生成的图片返回临时 URL（有效期约 30 天），可配合 `downloadFile` 工具保存到本地。

## MCP 服务器支持

支持通过 MCP（Model Context Protocol）集成外部工具服务。支持 **stdio**（本地子进程）传输方式，SSE（远程 HTTP）方式开发中。

### 配置示例

```json
{
  "mcpServers": [
    {
      "id": "my-server",
      "name": "我的 MCP 服务器",
      "transport": "stdio",
      "command": "node",
      "args": ["server.js"],
      "env": { "KEY": "value" },
      "enabled": true
    }
  ]
}
```

MCP 服务器会在 Agent 启动时自动连接，获取工具列表并注册为 Agent 工具。单个服务器连接失败不影响其他服务器。

## 预置端点

| 端点 ID | 名称 | 默认 Base URL |
|---------|------|--------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (智谱AI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

所有端点均使用 OpenAI 兼容接口协议，可通过配置向导修改 Base URL 接入其他兼容服务。

## 预置模型

| 模型 ID | 名称 | 端点 |
|---------|------|------|
| `gpt-5.5` | GPT-5.5 | OpenAI |
| `glm-5.1` | GLM-5.1 | 智谱AI |
| `glm-5v-turbo` | GLM-5V-Turbo | 智谱AI |
| `glm-4.7-flash` | GLM-4.7-Flash | 智谱AI |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | DeepSeek |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | DeepSeek（**默认模型**） |

## 对话管理

- 对话记录以 JSON 格式保存在 `~/.ai-zen/conversations/` 目录
- 支持保存、加载、删除对话
- 对话保存时自动包含模型 ID、Agent ID 等元信息
- 对话列表按更新时间倒序排列

## 常见问题

### API Key 未设置

首次使用时会提示输入 API Key，可选择保存以便下次使用。也可通过 `aiz` 进入主菜单 → 配置管理 → 设置 API Key 来配置。

### 如何添加自定义工具？

在 `~/.ai-zen/tools/` 或项目 `.ai-zen/tools/` 目录下创建 `.js` 文件，导出 `{ name, description, parameters, callback }` 即可。CLI 会自动发现并注册。

### 如何添加 Skill？

在 `~/.ai-zen/skills/` 或项目 `.ai-zen/skills/` 目录下创建 `.md` 文件。AI 在对话中可以通过 `load_skill` 工具按需加载这些技能指导。

### Agent 和子 Agent 有什么区别？

- **Agent**：对话时用户主动选择的预设角色，包含 system prompt
- **子 Agent**：注册为主 Agent 的工具，由 LLM 在对话中按需自动调用，用于处理子任务

## 开发

```bash
# 在项目根目录
pnpm install

# 构建 core 包（CLI 依赖 core）
pnpm build-core

# 构建 CLI
pnpm --filter @ai-zen/agents-cli build

# 运行测试
pnpm --filter @ai-zen/agents-cli test

# 启动开发模式（构建 + 运行）
pnpm --filter @ai-zen/agents-cli start
```

## 测试

```bash
pnpm --filter @ai-zen/agents-cli test
```

## 许可

ISC
