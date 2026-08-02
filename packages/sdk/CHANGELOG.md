# Changelog

## [0.5.2] - 2026-08-03

### 🚀 新功能

- **`AgentPlugin` 新增 `onInnerLoopsStart` / `onInnerLoopsEnd` 钩子** — 对应 Core 3.2.0 的整组内循环起止钩子（一次 send 各触发一次）。`SdkAgent.send()` 在委托 `super.send()` 前后将这两个钩子包装为插件遍历调用，与单轮 `onInnerLoopStart` / `onInnerLoopEnd` 同构。插件可通过 `ctx` 拿到当前 agent、发送内容与消息快照

## [0.5.1] - 2026-08-03

### 🛠 优化

- **依赖 `@ai-zen/agents-core` 升级并改为范围版本** — 从 `workspace:*`（发布时替换为精确版本 `3.0.1`）改为 `workspace:^`（发布为 `^3.1.0`）。core 3.1.0 起 `Message` 构造自动生成 `id`，SDK 透传的消息随之携带稳定 id；范围版本使 core 后续 minor/patch 升级不再需要 SDK 单独发版跟进

## [0.5.0] - 2026-07-29

### 💥 破坏性变更

- **内置工具全部类化** — 17 个内置工具从单例 `CallbackTool` 实例改为类（`CwdTool`、`ReadFileTool`、`WriteFileTool`、`ExecTool` 等，PascalCase 命名），继承新抽象基类 `SdkCallbackTool`。`BUILTIN_TOOLS` 单例注册表替换为 `BUILTIN_TOOL_CLASSES` 类注册表（`Array<new (env: ToolEnv) => SdkCallbackTool>`）
- **`generateImage` 类化为 `GenerateImageTool`** — 删除工厂函数 `createGenerateImageTool(config)`，构造签名与其它内置工具统一为 `(env: ToolEnv)`。仍按 `config.defaultImageModel` 条件注册，不进入 `BUILTIN_TOOL_CLASSES` 静态注册表
- **`discoverBuiltinTools` 签名变更** — 从 `discoverBuiltinTools(config: AppConfig)` 改为 `discoverBuiltinTools(env: ToolEnv)`，用 `env` 实例化工具类
- **`Provider` 新增 `cwd` 与 `env`** — `cwd` 默认 `process.cwd()`，是相对路径解析的基准；`env: ToolEnv`（`{ cwd, config }`）在构造时建立，`refresh()` 用它实例化内置工具。**工具不再依赖全局 `process.cwd()`**，每个 Provider 可绑定不同工作目录
- **删除会话/草稿产品层** — `Conversation` / `Draft` 类型、`ConversationRepository`、`DraftRepository`、`AutoDraftPlugin` 及其测试全部移除。会话、草稿持久化下放给各端（CLI/Desktop）自行实现（可复用 `EntityRepository`）
- **`index.ts` 导出变更** — 移除 `Conversation`/`Draft`/`ConversationRepository`/`DraftRepository`/`AutoDraftPlugin`/`BUILTIN_TOOLS`/`execAsyncTool`/`sleepTool`/`createGenerateImageTool`；新增 `ToolEnv`、`SdkCallbackTool`、`BUILTIN_TOOL_CLASSES`、`GenerateImageTool` 及 17 个工具类

### 🚀 新功能

- **`ToolEnv` 接口** — 工具环境 `{ cwd, config }`，在工具构造时注入，作为相对路径解析与配置读取的基准
- **`SdkCallbackTool` 抽象基类** — `env` 构造注入 + 子类实现 `call()` + `exec()` 桥接 + `resolve()` 相对路径解析（public，便于测试直调）

### 🎯 优化

- **多会话并行支持** — `cwd` 下沉到 Provider（`ToolEnv.cwd`），多个 Provider 可并行服务不同工作目录的会话，互不干扰
- **工具实例 per-Provider** — 每个 Provider 通过 `discoverBuiltinTools(env)` 实例化自己的一套工具，消除全局单例状态

## [0.4.0] - 2026-07-29

### 💥 破坏性变更

- **`load_mcp` 返回值从纯文本改为结构化 JSON** — 现在返回 `{ tools, resources }`，其中 tools 包含完整的 `inputSchema`（参数 JSON Schema），resources 包含 `uri`、`name`、`description`、`mimeType`。LLM 可获得精确的参数结构信息，不再需要靠描述文字猜测参数格式
- **`load_mcp` 不再返回 `prompts` 字段** — prompts 属于 UI 层用途，不对 Agent 暴露
- **`createLogger()` 替换为全局单例 `getLogger()` / `setLogger()`** — 日志不再支持多例，SDK 内部所有模块统一通过 `getLogger()` 获取同一实例
- **`index.ts` 导出变更** — `createLogger` → `getLogger` / `setLogger`

### 🎯 优化

- **`load_mcp` 连接成功后在日志中打印完整 manifest** — 包含 tools、resources、prompts 的完整 JSON，便于调试排查
- **SDK 内部日志统一** — `mcps.ts`、`skills.ts`、`usertools.ts`、`McpConnectionManager.ts` 中的 `console.warn`/`console.error` 全部改为 `getLogger().warn`/`getLogger().error`

## [0.3.4] - 2026-07-27

### 🎯 优化

- **`AutoMigratePlugin` 钩子重命名** — `onHandoff` → `onMigrated`，语义更清晰：迁移前用 `onBeforeMigrate`（此时 `agent.messages` 仍是完整旧历史），迁移完成后用 `onMigrated`（交接文档已注入）
- **`conversation-runner.ts` 保存逻辑修正** — 将保存旧对话从 `onMigrated`（原 `onHandoff`）移至 `onBeforeMigrate`，确保保存的是完整的旧对话历史，而非迁移后的新消息

## [0.3.3] - 2026-07-27

### 🎯 优化

- **默认 SubAgent System Prompt 新增两条强制性要求**：
  1. 信息不明确/模糊/缺失时拒绝执行，要求补充
  2. 存在自相矛盾信息时指出矛盾，要求澄清
- **默认 Agent System Prompt 新增原则**："有矛盾就问 — 如果用户指令中存在自相矛盾之处，应指出矛盾并请求澄清，而不是自行取舍"
- **默认 SubAgent `function.description` 和 `task` 参数描述**同步更新，强调不明确信息将导致拒绝执行

## [0.3.2] - 2026-07-26

### 💥 破坏性变更

- **`EntityRepository` 所有方法改为异步** — `list()`、`read()`、`write()`、`delete()` 现在返回 `Promise`，需 `await`
- **`DraftRepository` 所有方法改为异步** — `read()`、`write()`、`delete()` 需 `await`
- **`ConfigManager` 所有方法改为异步** — `read()`、`write()`、`ensureDirs()`、`ensureDefaultAgent()`、`ensureDefaultSubAgent()`、`ensureDefaultConfig()`、`bootstrap()` 均需 `await`
- **`createAgent()` 恢复为 `async`** — 因底层仓储改为异步，`createAgent(provider, agentId)` 需 `await`
- **`AutoDraftPlugin.checkDraftForRestore()` 改为异步** — 需 `await`

### 🎯 优化

- **全面消除同步文件 IO** — 所有生产代码中的 `existsSync`、`readFileSync`、`writeFileSync`、`readdirSync`、`mkdirSync`、`unlinkSync`、`renameSync` 全部替换为 `fs.promises` 异步 API，避免事件循环阻塞
- **`skillTools.ts` — 工具回调中的 `readdirSync` 替换为 `fs.promises.readdir`**

### ✅ 测试

- 7 个测试文件同步更新为 `async`/`await`，测试辅助函数也使用 `fs.promises`

## [0.3.1] - 2026-07-26

### 💥 破坏性变更

- **`Provider` 移至 `runtime`，合并 `Capabilities`** — 删除 `capabilities/Capabilities.ts` 和原 `runtime/Provider.ts`，Provider 直接暴露 `filter()`、`buildTools()`、`instantiate()`、`refresh()`
- **去除 `getMcpManager()` 方法** — `mcpManager` 从 lazy getter 改为构造时直接 `new McpConnectionManager()`（有 mcpPaths 时），`readonly` 属性
- **字段重命名** — `builtinInstances` → `builtinTools`，`userInstances` → `userTools`，`subagentDefs` → `subagents`
- **`createModel` 签名变更** — 从 `createModel(config, modelId)` 改为 `createModel(provider, modelId)`，调用方不再需要 `.config` 解构
- **`SdkAgent` 去掉 `caps` 字段** — 只保留 `provider`

### 🚀 新功能

- **用户工具 ESM 支持** — 移除 `node:vm` 沙箱，统一使用 `import()` 加载 `.js` / `.mjs` 文件，每次 `refresh()` 加时间戳 querystring 防止缓存
- **`CallbackTool` 替代 `createToolFromObject`** — `{ function, exec }` 格式直接映射为 `CallbackTool`

### 🎯 优化

- **默认 Agent 系统提示词更新** — 精简为五条原则：开动脑筋、实事求是、一切行动听指挥、安全第一、能打胜仗
- **默认 SubAgent `function.description` 优化** — 强调主 Agent 必须提供完整任务上下文

### 🗑 移除

- 删除 `capabilities/Provider.ts`（已移回 `runtime/Provider.ts`）
- 删除 `createToolFromObject` 工具函数
- 删除 `TODO.md`、`TODO2.md`
- 测试 fixture 从 `.js` 迁移为 `.mjs`

## [0.2.6] - 2026-07-20

### 🔧 修复

- **默认 SubAgent 函数名和描述不足以让 LLM 识别为子 Agent** — `function.name` 从 `general_assistant` 改为 `sub_agent_default`，`function.description` 重写为详细描述，明确子 Agent 身份和能力边界。参数名 `query` → `task` 与设计规范统一，system prompt 明确角色定位
- **`DEFAULT_SUBAGENT_ID` 从 `general-assistant` 改为 `sub-agent-default`** — 文件名与函数名对应，便于识别

## [0.2.5] - 2026-07-20

### 🔧 修复

- **`DEFAULT_SUBAGENT_DEFINITION` 缺少 `permissions` 配置** — 默认 SubAgent `general-assistant` 未配置权限，导致所有维度等同于 `deny: ['*']`，完全无法使用任何工具/skill/MCP/SubAgent。现已按设计规范补全，仅 `subagents` 维度设为 `deny: ['*']` 防止递归调用

## [0.2.4] - 2026-07-20

### 🔧 修复

- **`load_skill` 不再注入 System 消息** — 改为在工具返回值中直接返回完整 SKILL.md 内容和 Skill 目录路径、文件列表，LLM 完全透明可见
- **`SkillInfo` 新增 `dirPath` 字段** — 记录 SKILL.md 所在目录的绝对路径
- **`McpConnectionManager.doConnect` 按 Server capabilities 按需调用** — 仅对声明了的能力调用对应方法，避免未声明时返回 Method not found
- **`McpConnectionManager.doConnect` 各 list 调用加 try/catch 保护** — 单个能力获取失败不影响其他能力

## [0.2.3] - 2026-07-20

### 🔧 修复

- **`AgentRepository` — 使用 `EntityRepository` 替代直接文件操作** — 采用基础仓储统一逻辑

## [0.2.2] - 2026-07-20

### 🔧 修复

- **`SdkAgent.send()` — `ctx.messages` 不再直接引用 `this.messages`** — 改为浅拷贝快照，确保消息数组仅由 agent 作为唯一维护者
- **`AutoMigratePlugin` — 不再创建新 Agent 实例** — 直接替换 `agent.messages` 数组，保留所有引用、插件绑定和事件监听
- **`AutoMigratePlugin` — 迁移前增加日志提示** — 使用 `log.warn` 输出迁移开始通知

### 🎯 优化

- **`AutoMigratePlugin` — `onHandoff` 签名简化** — 从 `(doc, oldAgent, newAgent)` 改为 `(doc, agent)`，因为 agent 是同一对象
- **`TaskMigrationService.createPrompt()` — 精简提示词** — 明确要求只输出交接文档，不做任何解释

### ✅ 测试

- 补充迁移前后消息数组**长度精确断言**（迁移前 3 条 → 迁移后 2 条）
- 补充迁移失败时消息数组**长度和内容不变**的断言
