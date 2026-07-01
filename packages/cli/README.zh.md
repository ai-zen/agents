# @ai-zen/agents-cli

AI Agent 命令行界面，基于 `@ai-zen/agents-core` 构建。提供交互式对话终端，内置 15 个文件系统操作、命令执行、图片生成等工具，支持 MCP 协议集成外部工具。

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
# 交互式主菜单
aiz

# 快速对话（参数作为初始消息）
aiz 你好，请介绍一下你自己。
```

## 主菜单

运行 `aiz` 进入主菜单：

```
🤖 欢迎使用 AI-Zen CLI

? 请选择操作:
  ▶️  继续上次未完成的对话  （如有草稿）
  💬 开始新对话
  📂 继续已保存的对话
  📋 管理已保存的对话
  🤖 管理 Agents
  ⚙️  配置管理
  ❌ 退出
```

### 草稿恢复（v0.7.0 新增）

如果退出对话时没有保存（或进程被强制杀死），对话内容会**自动保存为草稿**。下次启动 `aiz` 时会看到：

```
▶️  继续上次未完成的对话 (12 条消息, 2025/1/1 12:00:00)
💬 开始新对话（放弃草稿）
```

### 对话命令

对话中输入的所有命令以 `/` 开头：

| 命令 | 说明 |
|------|------|
| `/exit` `/quit` | 退出对话（会提示是否保存） |
| `/save` | 保存当前对话 |
| `/new` | 重置会话（清空历史） |
| `/back` | 撤回消息（回退到指定位置并可编辑后重发） |
| `/editor` | 使用系统编辑器（vim/nano）输入长消息 |
| `/clear` | 清屏 |
| `/help` | 显示可用命令 |

### 任务迁移

当上下文接近 Token 上限时，系统会自动生成**交接文档**，汇总已完成任务、待办事项和关键决策，然后创建新会话并将交接文档注入为上下文，实现无缝衔接。

迁移提示词模板包含：
- **对话断点** — 最后一段对话原文引用
- **已完成的任务** — 任务标题和产出路径
- **未完成的任务** — 描述、进度、下一步
- **重要记忆** — 技术偏好、踩坑记录、架构决策
- **文件索引** — 关键文件及用途说明
- **接手指令** — 先读文件验真、再对状态、后行动的 SOP

### Shell 兜底钩子

当你在终端输入一个不存在的命令时，自动转发给 AI 处理：

```bash
# 安装钩子
aiz hook install

# 之后随便输入点什么：
> 今天天气怎么样？
# 这条消息会被转发给 AI，而不是显示 "command not found"

# 卸载钩子
aiz hook uninstall
```

## 配置管理

配置文件存储在 `~/.ai-zen/config.json`（或 `$AI_ZEN_DIR/config.json`）。

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
  "defaultModel": "deepseek-v4-flash",
  "defaultAgent": "default",
  "mcpServers": []
}
```

### 环境变量

- `AI_ZEN_DIR` — 覆盖配置目录路径（用于测试和沙箱隔离）

## 文件系统自动发现

所有用户资源通过文件系统自动发现，无需手动注册：

```
~/.ai-zen/                    ← 全局（所有项目共享）
├── config.json               ← 端点、模型、MCP 配置
├── agents/                   ← 普通 Agent（预设角色）
│   └── default.json
├── sub-agents/               ← 子 Agent（作为工具被调用）
│   └── general-assistant.json
├── skills/                   ← Skill 提示词（.md）
│   └── git-operations.md
├── tools/                    ← 用户自定义工具（.js）
│   └── my-tool.js
├── conversations/            ← 已保存的对话记录
└── draft.json                ← 自动保存的草稿（崩溃恢复用）

/path/to/project/
└── .ai-zen/                  ← 项目级（覆盖全局同名资源）
    ├── agents/
    ├── sub-agents/
    ├── skills/
    └── tools/
```

## 内置工具（15 个）

| 工具 | 说明 |
|------|------|
| `cwd` | 获取当前工作目录 |
| `readFile` | 读取文件内容 |
| `writeFile` | 写入文件 |
| `batchEdit` | 批量编辑文本 |
| `mkdir` | 创建目录 |
| `rm` | 删除文件或目录 |
| `glob` | 通配符扫描文件 |
| `ls` | 列出目录 |
| `exist` | 检查路径是否存在 |
| `exec` | 执行 shell 命令 |
| `findText` | 在文件中查找文本 |
| `downloadFile` | 从 URL 下载文件 |
| `generateImage` | 根据描述生成图片 |
| `rename` | 重命名或移动文件 |
| `copy` | 复制文件或目录 |

## MCP 服务器支持

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

## 预置端点

| ID | 名称 | 默认 Base URL |
|----|------|--------------|
| `openai` | OpenAI | `https://api.openai.com/v1` |
| `bigmodelcn` | BigModelCN (智谱AI) | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` |

## 预置模型

| ID | 名称 | 端点 |
|----|------|------|
| `gpt-5.5` | GPT-5.5 | OpenAI |
| `glm-5.1` | GLM-5.1 | 智谱AI |
| `glm-5v-turbo` | GLM-5V-Turbo | 智谱AI |
| `glm-4.7-flash` | GLM-4.7-Flash | 智谱AI |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | DeepSeek |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | DeepSeek（**默认模型**） |

## 开发

```bash
# 项目根目录
pnpm install

# 构建 core 包（CLI 依赖 core）
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
# 单元测试
pnpm --filter @ai-zen/agents-cli test

# 端到端测试（需在 .env.local 中配置 API Key）
# 编辑 packages/cli/.env.local 填入你的 Key，然后：
pnpm --filter @ai-zen/agents-cli test -- src/__tests__/e2e.test.ts
```

## 许可

ISC
