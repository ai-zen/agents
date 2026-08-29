---
title: SDK
description: @ai-zen/agents-sdk 的公开 API：Provider、能力管线、权限模型、内置工具、插件与任务迁移。
outline: deep
---

# SDK

`@ai-zen/agents-sdk` 是建立在 `@ai-zen/agents-core` 之上的**引擎 / 能力层**，为 CLI / Desktop 提供统一 Agent 运行时。

- **安装**：`npm install @ai-zen/agents-sdk`（依赖 `@ai-zen/agents-core`，以 `workspace:^` 关联）。
- **设计真相源**：[`packages/sdk/docs/sdk-design.md`](../../packages/sdk/docs/sdk-design.md)。

## Provider —— 全局上下文 + 能力管线

`Provider` 是 SDK 的**唯一入口对象**。持有配置、路径、工作目录、模型工厂与 MCP 管理器，并整合「发现 → 过滤 → 实例化」三阶段。

```ts
import { Provider } from "@ai-zen/agents-sdk";

const provider = await Provider.create({
  config,                 // AppConfig（来自 ConfigManager）
  cwd: "/path/to/workspace",
  agentsDir: "~/.ai-zen/agents",
  subAgentsPaths: ["~/.ai-zen/sub-agents"],
  skillsPaths: ["~/.ai-zen/skills"],
  toolsPaths: ["~/.ai-zen/tools"],
  mcpPaths: ["~/.ai-zen/mcp.json"],
});
```

关键字段与方法：

| 成员 | 说明 |
|------|------|
| `config` | 应用配置（端点、模型等） |
| `cwd` | 当前工作目录 —— 相对路径解析基准，也是 `ToolEnv.cwd` 的来源 |
| `env` | 工具环境 `{ cwd, config }`，实例化内置工具时注入 |
| `mcpManager` | MCP 连接管理器（有 MCP 配置时存在） |
| `async refresh()` | 重新执行全局能力发现（重新扫描文件系统） |
| `filter(definition, options?)` | 阶段 2：按权限 + exclude + `isAvailable` 过滤，返回名称列表 |
| `instantiate(filtered)` | 阶段 3：名称 → Tool 实例 |
| `buildTools(definition, options?)` | `filter` + `instantiate` 一步完成 |

每个 `Provider` 对应一个工作目录；多个 Provider 可并行服务不同目录的会话，互不干扰。

## createAgent / SdkAgent

```ts
import { createAgent } from "@ai-zen/agents-sdk";

const agent = await createAgent(provider, config.defaultAgent ?? "default");
// agent 是 SdkAgent，可直接注册插件、发送消息
```

- `SdkAgent extends Agent`（来自 core），额外携带 `provider` 与 `definition`（含权限 `permissions`）。
- 权限统一从 `definition.permissions` 读取，不单独持有。

## 权限模型

四维度独立，`allow` / `deny` 互斥，无命中即拒绝。**权限即披露**：deny 掉的项对 LLM 完全不可见。

```
Agent.permissions
  ├── tools:      { allow: string[] } | { deny: string[] }
  ├── skills:     { allow: string[] } | { deny: string[] }
  ├── mcps:       { allow: string[] } | { deny: string[] }
  └── subagents:  { allow: string[] } | { deny: string[] }
```

规则：

1. 整个 `permissions` 缺失时，所有维度等同 `deny: ['*']`（全部拒绝）。
2. 存在时各维度独立判断；未配置的子维度 = 该维度 `deny: ['*']`。
3. `allow` 与 `deny` 不能同时配置（运行时抛错）。
4. 无命中 = 拒绝。
5. 通配符 `*` 匹配任意字符串。
6. 每个 Agent 的权限完全独立，不继承、不传递（`call_skill_sub_agent` 创建的临时 Skill 子 Agent 继承父权限，是有意的例外）。

匹配维度：`tools` 按工具名（如 `rm`）、`skills` 按 skill id、`mcps` 按 server 名、`subagents` 按 `function.name`。

## 内置工具（19 个类）

所有内置工具都是 `SdkCallbackTool` 子类，由 Provider 用 `ToolEnv` 实例化（每个 Provider 一套实例，注入其 `cwd`）。相对路径一律以 `ToolEnv.cwd` 解析，不依赖全局 `process.cwd()`。

| 工具 | 说明 |
|------|------|
| `cwd` / `readFile` / `writeFile` / `mkdir` / `rm` / `glob` / `ls` / `exist` / `rename` / `copy` / `findText` | 文件系统操作 |
| `exec` / `exec_async` | 执行命令（`exec` 支持 `timeout`；`exec_async` 异步立即返回，支持 shell 重定向/管道） |
| `downloadFile` | 从 URL 下载并保存 |
| `batchEdit` / `edit` | 批量 / 单次替换文件文本 |
| `sleep` | 等待指定毫秒 |

按配置 / 模型条件注入的工具：

| 工具 | 注入条件 |
|------|----------|
| `generateImage` | 仅当配置了 `defaultImageModel` |
| `viewImage` | 仅视觉模型（该 Agent 的 `modelId` 解析到 `Model.vision === true`） |

工具的可用性由各工具自己的 `isAvailable(config, definition)` 声明，在 `buildTools` / `filter` 阶段过滤；发现层不做任何过滤。

`SdkCallbackTool` 抽象基类：

```ts
abstract class SdkCallbackTool extends Tool {
  readonly env: ToolEnv;
  isAvailable?(config: AppConfig, definition: AgentDefinition): boolean;
  abstract call(input: unknown, ctx?: ToolCallContext): unknown | Promise<unknown>;
  async exec(ctx: ToolCallContext): Promise<AgentNS.MessageContent>;  // string 原样 / 内容块透传 / 其余 JSON 序列化
  resolve(p: string): string;   // 相对路径解析到 env.cwd
}
```

## 核心实体类型

| 实体 | 说明 | 存储 |
|------|------|------|
| `Endpoint` | API 端点（baseUrl + apiKey） | `config.json` |
| `Model` | 模型配置，绑定一个 Endpoint | `config.json` |
| `ImageModel` | 图片生成模型配置 | `config.json` |
| `AgentDefinition` | 可对话 AI 人格（提示词、权限、可选工具签名）；有 `function` 即视为 SubAgent | `agents/*.json` |
| `ToolEnv` | `{ cwd, config }`，内置工具构造时注入 | 内存态 |
| `SdkCallbackTool` | 内置工具抽象基类 | 内存态 |

## 内置插件

| 插件 | 说明 |
|------|------|
| `AutoMigratePlugin` | 上下文超限时自动触发任务迁移；实际迁移委托给注入的 `TaskMigrationService` |
| `AutoRefreshToolsPlugin` | 每次 `send()` 前重新刷新工具列表 |
| `ContextGuardPlugin` | 上下文安全护栏；超硬上限（`maxTokens × ratio`）时在请求前抛 `ContextOverflowError` |
| `UnknownToolHintPlugin` | 未知工具的 MCP 智能提示（显式 `agent.use` 注册） |

## ConfigManager 与出厂默认

```ts
import { ConfigManager } from "@ai-zen/agents-sdk";

const mgr = new ConfigManager("~/.ai-zen/config.json");
const { config, agent, subAgent } = await mgr.bootstrap();   // 一键初始化（幂等）
```

- 预置端点（OpenAI / 智谱 / DeepSeek）、7 个模型（含视觉模型 `vision: true`）、3 个图片模型、默认选项。
- 出厂默认 MCP 服务器（`socket-pty`）首启写入 `~/.ai-zen/mcp.json`，已存在不覆盖。
- 所有 `ensure*` 操作对已存在文件不覆盖，用户配置永不丢失。

## 任务迁移（TaskMigrationService）

迁移服务只负责「怎么迁移」，复用传入 `agent` 自身模型生成交接文档；`AutoMigratePlugin` 只负责「何时触发」。

```ts
import { TaskMigrationService, AutoMigratePlugin } from "@ai-zen/agents-sdk";

agent.use(new AutoMigratePlugin({
  service: new TaskMigrationService({ onMigrated: (mctx) => { /* 保存旧历史 */ } }),
  maxTokens: 250_000,
}));
```

- 策略 `strategy`：`omit`（默认，标记历史 `omit: true` 保留可审计）/ `prune`（物理剔除）。
- 在 `migrate()` 单次调用中可覆盖默认策略。
- 不重建 Agent，只重建消息列表；迁移失败不丢失原消息。

## 消费模式（完整）

详见 [`packages/sdk/docs/sdk-design.md`](../../packages/sdk/docs/sdk-design.md) 的「消费模式（完整示例）」与「与 Core 的边界」章节。

## 相关文档

- [快速开始](getting-started.md)
- [架构](architecture.md)
- [Core API](core.md) —— 运行时底层 API
- [MCP](mcp.md) —— SDK 的 MCP 连接管理
- [`packages/sdk/docs/sdk-design.md`](../../packages/sdk/docs/sdk-design.md) —— SDK 设计真相源
